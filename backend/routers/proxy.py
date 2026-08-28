"""LLM API 代理路由：转发请求到各模型提供商，支持流式输出。

优化要点（参考 Agent 工程四层理论）：
- Context Engineering: 渐进式加载，按需构建请求体
- Harness Engineering: 共享连接池，统一超时与重试策略
- Loop Engineering: 请求追踪 ID，可观测性日志
- Graph Engineering: 多 provider 路由，统一接口抽象
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/proxy", tags=["proxy"])
logger = logging.getLogger(__name__)

# 分段超时：connect 快失败，read 为两包数据间隔上限（流式长思考模型不误杀）
STREAM_TIMEOUT = httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=10.0)
REQUEST_TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=10.0)

# ── 共享 httpx 客户端池（连接复用，避免每次请求重建 TCP 连接） ─────────
# Harness Engineering: 构建稳定的执行环境，减少连接开销
_http_clients: dict[str, httpx.AsyncClient] = {}


def _compact_error_text(text: str, max_len: int = 1200) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:max_len] + "…" if len(text) > max_len else text


async def _read_response_text(resp: httpx.Response) -> str:
    try:
        await resp.aread()
        return resp.text
    except Exception:
        return ""


def _diagnose_status(status: int) -> str:
    if status in (401, 403):
        return "鉴权失败：请检查 API Key、Base URL、账号权限或服务商访问权限。"
    if status == 404:
        return "接口或模型不存在：请检查模型 ID、Base URL，以及是否误用了 Responses API。"
    if status == 408 or status == 504:
        return "上游响应超时：可能是网络波动、模型排队或代理链路过慢。"
    if status == 413:
        return "请求体过大：请压缩上下文、减少附件或降低历史消息数量。"
    if status == 429:
        return "触发限流或额度不足：请稍后重试，或检查服务商额度。"
    if status >= 500:
        return "上游服务器错误：通常不是本地输入问题，可稍后重试或切换模型。"
    if status == 400:
        return "请求格式被拒绝：常见原因是模型不支持当前参数、消息格式异常或 Responses API 不兼容。"
    return "上游请求失败。"


def _sse_error(message: str, *, trace_id: str = "", status: int | None = None, code: str = "upstream_error") -> str:
    payload = {
        "error": {
            "message": message,
            "type": code,
            "status": status,
            "trace_id": trace_id,
        }
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _sse_error_from_response(resp: httpx.Response, *, trace_id: str, api_name: str) -> str:
    text = _compact_error_text(await _read_response_text(resp))
    message = f"{api_name} 返回 HTTP {resp.status_code} {resp.reason_phrase or ''}。{_diagnose_status(resp.status_code)}"
    if text:
        message += f" 上游详情：{text}"
    logger.warning("[%s] %s", trace_id, message)
    return _sse_error(message, trace_id=trace_id, status=resp.status_code, code="http_error")


def _sse_error_from_exception(exc: Exception, *, trace_id: str, api_name: str) -> str:
    if isinstance(exc, httpx.ConnectTimeout):
        msg = f"{api_name} 连接超时：无法在限定时间内连接到上游 Base URL。请检查网络、代理/VPN、防火墙和 Base URL。"
        code = "connect_timeout"
    elif isinstance(exc, httpx.ReadTimeout):
        msg = f"{api_name} 读超时：已连接上游，但长时间没有收到新数据。可能是模型排队、长思考或代理链路中断。"
        code = "read_timeout"
    elif isinstance(exc, httpx.ConnectError):
        msg = f"{api_name} 连接失败：无法连接到上游。请检查 Base URL、DNS、代理/VPN、防火墙或本地模型服务是否启动。"
        code = "connect_error"
    elif isinstance(exc, httpx.RemoteProtocolError):
        msg = f"{api_name} 协议错误：上游提前断开或返回了不完整的流式响应。"
        code = "protocol_error"
    elif isinstance(exc, httpx.HTTPError):
        msg = f"{api_name} HTTP 客户端错误：{exc}"
        code = "http_client_error"
    else:
        msg = f"{api_name} 代理异常：{exc}"
        code = "proxy_error"
    logger.exception("[%s] %s", trace_id, msg)
    return _sse_error(msg, trace_id=trace_id, code=code)


async def _json_or_error(resp: httpx.Response, *, trace_id: str, api_name: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """读取非流式响应；失败时返回统一诊断对象。"""
    if resp.status_code >= 400:
        text = _compact_error_text(resp.text)
        message = f"{api_name} 返回 HTTP {resp.status_code} {resp.reason_phrase or ''}。{_diagnose_status(resp.status_code)}"
        if text:
            message += f" 上游详情：{text}"
        logger.warning("[%s] %s", trace_id, message)
        return None, {"code": -1, "data": None, "message": message}
    try:
        return resp.json(), None
    except json.JSONDecodeError:
        text = _compact_error_text(resp.text)
        message = f"{api_name} 返回了非 JSON 响应。请检查 Base URL 是否指向正确 API 端点。"
        if text:
            message += f" 响应片段：{text}"
        logger.warning("[%s] %s", trace_id, message)
        return None, {"code": -1, "data": None, "message": message}


def _get_client(base_url: str) -> httpx.AsyncClient:
    """获取或创建共享的 httpx 客户端（按 base_url 分组，复用连接池）。"""
    if base_url not in _http_clients:
        _http_clients[base_url] = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            timeout=REQUEST_TIMEOUT,
        )
    return _http_clients[base_url]


def _get_stream_client(base_url: str) -> httpx.AsyncClient:
    """获取或创建流式专用客户端（更长 read 超时）。"""
    key = f"{base_url}__stream"
    if key not in _http_clients:
        _http_clients[key] = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
            timeout=STREAM_TIMEOUT,
        )
    return _http_clients[key]

# ── 模型注册表（2026-08 时效性校验） ──────────────────────────

MODEL_REGISTRY: dict[str, list[dict[str, Any]]] = {
    "international": [
        {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True},
        {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True},
        {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True},
        {"id": "claude-fable-5", "name": "Claude Fable 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000},
        {"id": "claude-opus-5", "name": "Claude Opus 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000},
        {"id": "claude-sonnet-5", "name": "Claude Sonnet 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000},
        {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576},
        {"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576},
        {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash-Lite", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576},
    ],
    "domestic": [
        {"id": "deepseek-chat", "name": "DeepSeek-V4-Pro", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 131072},
        {"id": "deepseek-v4-flash-vision-exp", "name": "DeepSeek-V4-Flash-Vision-Exp", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 131072},
        {"id": "deepseek-v4-flash", "name": "DeepSeek-V4-Flash", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 131072, "supports_responses": True},
        {"id": "kimi-k3", "name": "Kimi K3", "provider": "openai",
         "base_url": "https://api.moonshot.cn/v1", "context_window": 1048576},
        {"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code", "provider": "openai",
         "base_url": "https://api.moonshot.cn/v1", "context_window": 262144},
        {"id": "qwen3.8-max", "name": "Qwen3.8-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072, "supports_responses": True},
        {"id": "qwen3.7-max", "name": "Qwen3.7-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072, "supports_responses": True},
        {"id": "qwen3.7-plus", "name": "Qwen3.7-Plus", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072, "supports_responses": True},
        {"id": "glm-5.2", "name": "GLM-5.2", "provider": "openai",
         "base_url": "https://open.bigmodel.cn/api/paas/v4", "context_window": 131072},
        {"id": "doubao-seed-2-1-pro-260628", "name": "Doubao-Seed-2.1-Pro-260628", "provider": "openai",
         "base_url": "https://ark.cn-beijing.volces.com/api/v3", "context_window": 262144},
        {"id": "doubao-seed-2-1-turbo-260628", "name": "Doubao-Seed-2.1-Turbo-260628", "provider": "openai",
         "base_url": "https://ark.cn-beijing.volces.com/api/v3", "context_window": 262144},
        {"id": "minimax-m3", "name": "MiniMax M3", "provider": "openai",
         "base_url": "https://api.minimax.chat/v1", "context_window": 1048576},
        {"id": "ernie-5.1", "name": "ERNIE 5.1", "provider": "openai",
         "base_url": "https://qianfan.baidubce.com/v2", "context_window": 131072},
    ],
    "local": [
        {"id": "local", "name": "本地模型 (Ollama/LM Studio)", "provider": "openai",
         "base_url": "http://localhost:11434/v1", "context_window": 8192},
    ],
}


@router.get("/models")
async def list_models() -> dict[str, Any]:
    """返回所有预设模型列表。"""
    return {"code": 0, "data": MODEL_REGISTRY, "message": "ok"}


def _find_model(model_id: str, base_url: str | None = None) -> dict[str, Any] | None:
    """在注册表中查找模型配置，未找到时构建自定义配置。"""
    for category_models in MODEL_REGISTRY.values():
        for m in category_models:
            if m["id"] == model_id:
                return m
    # 自定义模型
    if base_url:
        return {
            "id": model_id,
            "name": model_id,
            "provider": "openai",
            "base_url": base_url,
            "context_window": 32768,
        }
    return None


def _build_openai_request(body: dict[str, Any]) -> dict[str, Any]:
    """构建 OpenAI 兼容格式的请求体。"""
    payload: dict[str, Any] = {
        "model": body["model"],
        "messages": body["messages"],
        "stream": body.get("stream", False),
    }
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    if max_tokens := body.get("max_tokens"):
        payload["max_tokens"] = max_tokens
    return payload


def _build_responses_request(body: dict[str, Any]) -> dict[str, Any]:
    """构建 OpenAI Responses API 格式的请求体。

    Responses API 是 Chat Completions 的演进版：
    - system 消息提取为顶层 instructions 字段
    - 其余消息放入 input 数组（保持 chat 格式兼容）
    - max_tokens → max_output_tokens
    """
    messages = body.get("messages", [])
    instructions_parts = []
    input_messages = []
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content", "")
            if isinstance(content, str):
                instructions_parts.append(content)
            elif isinstance(content, list):
                # 多模态 system 消息，提取文本部分
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        instructions_parts.append(part.get("text", ""))
        else:
            input_messages.append(msg)

    payload: dict[str, Any] = {
        "model": body["model"],
        "input": input_messages,
        "stream": body.get("stream", False),
    }
    if instructions_parts:
        payload["instructions"] = "\n\n".join(instructions_parts)
    if max_tokens := body.get("max_tokens"):
        payload["max_output_tokens"] = max_tokens
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    return payload


def _extract_responses_text(data: dict[str, Any]) -> str:
    """从 Responses API 非流式/完成事件中提取文本。"""
    text = data.get("output_text") or ""
    for item in data.get("output", []) or []:
        if item.get("type") == "message":
            for content in item.get("content", []) or []:
                if content.get("type") in ("output_text", "text"):
                    text += content.get("text", "")
        elif item.get("type") == "output_text":
            text += item.get("text", "")
    return text


def _parse_data_url(url: str) -> tuple[str, str] | None:
    """解析 data:MIME;base64,DATA 格式，返回 (mime, data)，非法时返回 None。"""
    m = re.match(r"^data:([^;]+);base64,(.+)$", url, re.DOTALL)
    if not m:
        return None
    return m.group(1), m.group(2)


def _to_anthropic_content(content: Any) -> Any:
    """将 OpenAI 多模态内容数组转为 Anthropic 格式；纯文本透传。"""
    if isinstance(content, str):
        return content
    parts: list[dict[str, Any]] = []
    for part in content or []:
        ptype = part.get("type")
        if ptype == "text":
            parts.append({"type": "text", "text": part.get("text", "")})
        elif ptype == "image_url":
            parsed = _parse_data_url(part.get("image_url", {}).get("url", ""))
            if parsed:
                mime, data = parsed
                parts.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
    return parts or [{"type": "text", "text": ""}]


def _to_gemini_parts(content: Any) -> list[dict[str, Any]]:
    """将 OpenAI 多模态内容数组转为 Gemini parts；纯文本包装为单 text part。"""
    if isinstance(content, str):
        return [{"text": content}]
    parts: list[dict[str, Any]] = []
    for part in content or []:
        ptype = part.get("type")
        if ptype == "text":
            parts.append({"text": part.get("text", "")})
        elif ptype == "image_url":
            parsed = _parse_data_url(part.get("image_url", {}).get("url", ""))
            if parsed:
                mime, data = parsed
                parts.append({"inline_data": {"mime_type": mime, "data": data}})
    return parts or [{"text": ""}]


def _build_anthropic_request(body: dict[str, Any]) -> dict[str, Any]:
    """构建 Anthropic 格式请求体。"""
    messages = body.get("messages", [])
    system_msg = ""
    chat_messages = []
    for msg in messages:
        if msg["role"] == "system":
            system_msg = msg["content"] if isinstance(msg["content"], str) else _to_anthropic_content(msg["content"])
        else:
            chat_messages.append({"role": msg["role"], "content": _to_anthropic_content(msg["content"])})

    payload: dict[str, Any] = {
        "model": body["model"],
        "messages": chat_messages,
        "max_tokens": body.get("max_tokens", 4096),
        "stream": body.get("stream", False),
    }
    if system_msg:
        payload["system"] = system_msg
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    return payload


async def _stream_openai(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发 OpenAI 兼容 API（共享客户端连接池）。
    标准化 reasoning 字段：delta.reasoning_content / delta.reasoning → delta.reasoning
    """
    client = _get_stream_client(url.rsplit("/", 2)[0])  # 提取 base_url
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Chat Completions")
                yield "data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                if not line:
                    continue
                trimmed = line.strip()
                if not trimmed.startswith("data:"):
                    yield f"{line}\n\n"
                    continue
                data_str = trimmed[5:].strip()
                if data_str == "[DONE]":
                    yield f"{line}\n\n"
                    return
                try:
                    parsed = json.loads(data_str)
                    if parsed.get("error"):
                        yield _sse_error(_compact_error_text(json.dumps(parsed["error"], ensure_ascii=False)), trace_id=trace_id)
                        yield "data: [DONE]\n\n"
                        return
                    delta = parsed.get("choices", [{}])[0].get("delta", {})
                    # 标准化 reasoning 字段
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")
                    if reasoning:
                        delta["reasoning"] = reasoning
                        # 移除原始字段，保持干净
                        for k in ("reasoning_content", "reasoning", "thinking"):
                            if k in delta and k != "reasoning":
                                del delta[k]
                        parsed["choices"][0]["delta"] = delta
                    if delta.get("content") or delta.get("reasoning"):
                        yielded = True
                    yield f"data: {json.dumps(parsed, ensure_ascii=False)}\n\n"
                except json.JSONDecodeError:
                    yield f"{line}\n\n"
            if not yielded:
                yield _sse_error("Chat Completions 连接正常结束，但上游没有返回任何文本增量或完成信号。请检查模型是否支持流式输出、是否被内容过滤，或服务商是否返回了非标准 SSE。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Chat Completions")
        yield "data: [DONE]\n\n"


async def _stream_responses(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式调用 Responses API，将事件转换为前端已适配的 Chat Completions SSE 格式。"""
    client = _get_stream_client(url.rsplit("/", 2)[0])
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Responses API")
                yield "data: [DONE]\n\n"
                return
            sent_text_delta = False
            saw_completed = False
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    yield "data: [DONE]\n\n"
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # Responses API 流式事件解析
                obj_type = data.get("type", "")
                if obj_type in ("error", "response.failed", "response.incomplete"):
                    err = data.get("error") or data.get("response", {}).get("error") or data
                    yield _sse_error(f"Responses API 返回错误事件：{_compact_error_text(json.dumps(err, ensure_ascii=False))}", trace_id=trace_id)
                    yield "data: [DONE]\n\n"
                    return

                # 文本增量：response.output_text.delta
                if obj_type in ("response.output_text.delta", "response.text.delta"):
                    delta = data.get("delta", "")
                    if delta:
                        sent_text_delta = True
                        chunk = {"choices": [{"delta": {"content": delta}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 思考增量：response.reasoning_text.delta（Responses API）
                elif obj_type in ("response.reasoning_text.delta", "response.reasoning.delta"):
                    delta = data.get("delta", "")
                    if delta:
                        chunk = {"choices": [{"delta": {"reasoning": delta}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                elif obj_type in ("response.output_item.done", "response.content_part.done"):
                    if sent_text_delta:
                        continue
                    item = data.get("item") or data.get("part") or {}
                    text = ""
                    if item.get("type") in ("message", "output_text"):
                        for content in item.get("content", []) or []:
                            if isinstance(content, dict) and content.get("type") in ("output_text", "text"):
                                text += content.get("text", "")
                        if item.get("type") == "output_text":
                            text += item.get("text", "")
                    if text:
                        chunk = {"choices": [{"delta": {"content": text}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 完成信号
                elif obj_type == "response.completed":
                    saw_completed = True
                    response = data.get("response", {}) or {}
                    if not sent_text_delta:
                        final_text = _extract_responses_text(response)
                        if final_text:
                            chunk = {"choices": [{"delta": {"content": final_text}, "index": 0}]}
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                            sent_text_delta = True
                    status = response.get("status", "completed")
                    if status == "completed":
                        chunk = {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                # 兼容旧格式：某些 provider 直接在 data 内嵌 delta 字段
                elif "delta" in data and isinstance(data["delta"], str):
                    chunk = {"choices": [{"delta": {"content": data["delta"]}, "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            if not sent_text_delta and not saw_completed:
                yield _sse_error("Responses API 连接正常结束，但没有收到文本增量或 completed 事件。请确认该模型/服务商是否真正支持 Responses API 流式输出，必要时关闭 Responses API 选项。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Responses API")
        yield "data: [DONE]\n\n"


async def _stream_anthropic(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发 Anthropic API，转换为 OpenAI 兼容 SSE 格式（共享客户端）。"""
    client = _get_stream_client(url.rsplit("/", 2)[0])
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Anthropic")
                yield "data: [DONE]\n\n"
                return
            buffer = ""
            async for line in resp.aiter_lines():
                buffer += line + "\n"
                if line == "" and buffer.strip():
                    # 解析 Anthropic SSE 事件
                    event_type = ""
                    data_str = ""
                    for bline in buffer.strip().split("\n"):
                        if bline.startswith("event:"):
                            event_type = bline[6:].strip()
                        elif bline.startswith("data:"):
                            data_str = bline[5:].strip()
                    buffer = ""
                    if not data_str:
                        continue
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    # 转换为 OpenAI SSE 格式
                    if event_type == "content_block_delta":
                        delta = data.get("delta", {})
                        delta_type = delta.get("type", "")
                        # Anthropic 思考块（Extended Thinking）
                        if delta_type == "thinking_delta":
                            thinking = delta.get("thinking", "")
                            if thinking:
                                chunk = {
                                    "choices": [{"delta": {"reasoning": thinking}, "index": 0}]
                                }
                                yielded = True
                                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        # 普通文本块
                        else:
                            text = delta.get("text", "")
                            if text:
                                chunk = {
                                    "choices": [{"delta": {"content": text}, "index": 0}]
                                }
                                yielded = True
                                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    elif event_type == "message_stop":
                        yield "data: [DONE]\n\n"
                        return
                    elif event_type == "error":
                        yield _sse_error(f"Anthropic 返回错误事件：{_compact_error_text(data_str)}", trace_id=trace_id)
                        yield "data: [DONE]\n\n"
                        return
            if not yielded:
                yield _sse_error("Anthropic 连接正常结束，但没有返回任何文本增量或完成信号。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Anthropic")
        yield "data: [DONE]\n\n"


async def _stream_google(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发 Google Gemini（streamGenerateContent + alt=sse），转换为 OpenAI 兼容 SSE 格式。"""
    client = _get_stream_client(url.rsplit("/models/", 1)[0])
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Google")
                yield "data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                trimmed = line.strip()
                if not trimmed.startswith("data:"):
                    continue
                data_str = trimmed[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                if data.get("error"):
                    yield _sse_error(_compact_error_text(json.dumps(data["error"], ensure_ascii=False)), trace_id=trace_id)
                    yield "data: [DONE]\n\n"
                    return
                candidates = data.get("candidates") or []
                if not candidates:
                    continue
                cand = candidates[0]
                parts = (cand.get("content") or {}).get("parts") or []
                for part in parts:
                    text = part.get("text") or ""
                    if text:
                        yielded = True
                        chunk = {"choices": [{"delta": {"content": text}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                finish = cand.get("finishReason") or ""
                if finish == "STOP":
                    chunk = {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                if finish == "MAX_TOKENS":
                    chunk = {"choices": [{"delta": {}, "finish_reason": "length", "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                if finish in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"):
                    if not yielded:
                        yield _sse_error(f"Gemini 内容被安全策略拦截（finishReason={finish}），未返回任何文本。请调整提问方式。", trace_id=trace_id, code="safety_filter")
                        yield "data: [DONE]\n\n"
                        return
            if not yielded:
                yield _sse_error("Google 连接正常结束，但没有返回任何文本增量。请检查模型 ID、API Key，或输出是否被安全策略拦截。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Google")
        yield "data: [DONE]\n\n"


@router.post("/chat")
async def proxy_chat(request: Request) -> Any:
    """代理聊天请求到对应 LLM API。
    
    Loop Engineering: 每次请求分配唯一 trace_id，用于追踪和日志。
    """
    body = await request.json()
    model_id = body.get("model", "")
    api_key = body.get("api_key", "")
    custom_base_url = body.get("base_url")
    is_stream = body.get("stream", False)
    
    # 生成请求追踪 ID（Loop Engineering: 可观测性）
    trace_id = str(uuid.uuid4())[:8]
    logger.info(f"[{trace_id}] 请求开始: model={model_id}, stream={is_stream}")

    model_cfg = _find_model(model_id, custom_base_url)
    if not model_cfg:
        logger.warning(f"[{trace_id}] 未知模型: {model_id}")
        return {"code": -1, "data": None, "message": f"未知模型: {model_id}"}

    provider = model_cfg["provider"]
    base_url = model_cfg["base_url"]

    # ── Anthropic ──
    if provider == "anthropic":
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        url = f"{base_url}/v1/messages"
        payload = _build_anthropic_request(body)

        if is_stream:
            logger.info(f"[{trace_id}] Anthropic 流式请求: {url}")
            return StreamingResponse(
                _stream_anthropic(url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        client = _get_client(base_url)
        try:
            resp = await client.post(url, json=payload, headers=headers)
            data, error = await _json_or_error(resp, trace_id=trace_id, api_name="Anthropic")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Anthropic")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        content = ""
        if "content" in data and data["content"]:
            content = data["content"][0].get("text", "")
        if not content.strip():
            return {"code": -1, "data": None, "message": "Anthropic 返回成功，但没有可显示文本。可能是内容过滤、工具调用块或服务商返回格式变化。"}
        logger.info(f"[{trace_id}] Anthropic 完成: {len(content)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": content}}],
                "usage": data.get("usage", {}),
            },
            "message": "ok",
        }

    # ── Google ──
    if provider == "google":
        headers = {"content-type": "application/json"}
        messages = body.get("messages", [])
        contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            contents.append({"role": role, "parts": _to_gemini_parts(msg["content"])})
        payload: dict[str, Any] = {"contents": contents}
        if "temperature" in body:
            payload["generationConfig"] = {"temperature": body["temperature"]}

        if is_stream:
            stream_url = f"{base_url}/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}"
            logger.info(f"[{trace_id}] Google 流式请求: {stream_url}")
            return StreamingResponse(
                _stream_google(stream_url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        url = f"{base_url}/models/{model_id}:generateContent?key={api_key}"
        client = _get_client(base_url)
        try:
            resp = await client.post(url, json=payload, headers=headers)
            data, error = await _json_or_error(resp, trace_id=trace_id, api_name="Google")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Google")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        text = ""
        if "candidates" in data and data["candidates"]:
            parts = data["candidates"][0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
        if not text.strip():
            return {"code": -1, "data": None, "message": "Google 返回成功，但没有可显示文本。请检查候选项是否被安全策略拦截，或模型返回格式是否变化。"}
        logger.info(f"[{trace_id}] Google 完成: {len(text)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": data.get("usageMetadata", {}),
            },
            "message": "ok",
        }

    # ── OpenAI 兼容（含国内模型、本地模型） ──
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # Responses API 模式：模型支持且前端请求启用时使用
    use_responses = body.get("use_responses", False) and model_cfg.get("supports_responses", False)

    if use_responses:
        url = f"{base_url}/responses"
        payload = _build_responses_request(body)

        if is_stream:
            logger.info(f"[{trace_id}] Responses API 流式请求: {url}")
            return StreamingResponse(
                _stream_responses(url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        client = _get_client(base_url)
        try:
            resp = await client.post(url, json=payload, headers=headers)
            data, error = await _json_or_error(resp, trace_id=trace_id, api_name="Responses API")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Responses API")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        # 将 Responses API 响应转换为 Chat Completions 格式
        text = _extract_responses_text(data)
        if not text.strip():
            return {"code": -1, "data": None, "message": "Responses API 返回成功，但没有可显示文本。该模型/服务商可能不完整支持 Responses API，建议关闭 Responses API 选项后重试。"}
        logger.info(f"[{trace_id}] Responses API 完成: {len(text)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": data.get("usage", {}),
            },
            "message": "ok",
        }

    # 默认：Chat Completions API
    url = f"{base_url}/chat/completions"
    payload = _build_openai_request(body)

    if is_stream:
        logger.info(f"[{trace_id}] OpenAI 兼容流式请求: {url}")
        return StreamingResponse(
            _stream_openai(url, headers, payload, trace_id),
            media_type="text/event-stream",
        )

    client = _get_client(base_url)
    try:
        resp = await client.post(url, json=payload, headers=headers)
        data, error = await _json_or_error(resp, trace_id=trace_id, api_name="Chat Completions")
        if error:
            return error
    except httpx.HTTPError as exc:
        msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Chat Completions")
        return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not str(content or "").strip():
        return {"code": -1, "data": None, "message": "Chat Completions 返回成功，但没有可显示文本。可能是模型只返回了工具调用、内容过滤，或服务商返回格式变化。"}
    logger.info(f"[{trace_id}] OpenAI 兼容完成")
    return {"code": 0, "data": data, "message": "ok"}
