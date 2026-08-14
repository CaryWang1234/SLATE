"""LLM API 代理路由：转发请求到各模型提供商，支持流式输出。"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/proxy", tags=["proxy"])

# 分段超时：connect 快失败，read 为两包数据间隔上限（流式长思考模型不误杀）
STREAM_TIMEOUT = httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=10.0)
REQUEST_TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=10.0)

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
        {"id": "deepseek-reasoner", "name": "DeepSeek-R1", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 65536},
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
        {"id": "doubao-pro-256k", "name": "Doubao-Pro 256K", "provider": "openai",
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
    if temperature := body.get("temperature"):
        payload["temperature"] = temperature
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
    if temperature := body.get("temperature"):
        payload["temperature"] = temperature
    return payload


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
    if temperature := body.get("temperature"):
        payload["temperature"] = temperature
    return payload


async def _stream_openai(url: str, headers: dict[str, str], payload: dict[str, Any]):
    """流式转发 OpenAI 兼容 API（自管理 client 生命周期）。"""
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", url, json=payload, headers=headers, timeout=STREAM_TIMEOUT) as resp:
            async for line in resp.aiter_lines():
                if line:
                    yield f"{line}\n\n"


async def _stream_responses(url: str, headers: dict[str, str], payload: dict[str, Any]):
    """流式调用 Responses API，将事件转换为前端已适配的 Chat Completions SSE 格式。"""
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", url, json=payload, headers=headers, timeout=STREAM_TIMEOUT) as resp:
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

                # 文本增量：response.output_text.delta
                if obj_type == "response.output_text.delta":
                    delta = data.get("delta", "")
                    if delta:
                        chunk = {"choices": [{"delta": {"content": delta}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 完成信号
                elif obj_type in ("response.completed", "response.output_item.done"):
                    status = data.get("response", {}).get("status", "completed")
                    if status == "completed":
                        chunk = {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                # 兼容旧格式：某些 provider 直接在 data 内嵌 delta 字段
                elif "delta" in data and isinstance(data["delta"], str):
                    chunk = {"choices": [{"delta": {"content": data["delta"]}, "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


async def _stream_anthropic(url: str, headers: dict[str, str], payload: dict[str, Any]):
    """流式转发 Anthropic API，转换为 OpenAI 兼容 SSE 格式（自管理 client）。"""
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", url, json=payload, headers=headers, timeout=STREAM_TIMEOUT) as resp:
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
                        text = delta.get("text", "")
                        if text:
                            chunk = {
                                "choices": [{"delta": {"content": text}, "index": 0}]
                            }
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    elif event_type == "message_stop":
                        yield "data: [DONE]\n\n"


@router.post("/chat")
async def proxy_chat(request: Request) -> Any:
    """代理聊天请求到对应 LLM API。"""
    body = await request.json()
    model_id = body.get("model", "")
    api_key = body.get("api_key", "")
    custom_base_url = body.get("base_url")
    is_stream = body.get("stream", False)

    model_cfg = _find_model(model_id, custom_base_url)
    if not model_cfg:
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
            return StreamingResponse(
                _stream_anthropic(url, headers, payload),
                media_type="text/event-stream",
            )

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        data = resp.json()
        content = ""
        if "content" in data and data["content"]:
            content = data["content"][0].get("text", "")
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
        url = f"{base_url}/models/{model_id}:generateContent?key={api_key}"
        messages = body.get("messages", [])
        contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            contents.append({"role": role, "parts": _to_gemini_parts(msg["content"])})
        payload: dict[str, Any] = {"contents": contents}
        if body.get("temperature"):
            payload["generationConfig"] = {"temperature": body["temperature"]}

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        data = resp.json()
        text = ""
        if "candidates" in data and data["candidates"]:
            parts = data["candidates"][0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
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
            return StreamingResponse(
                _stream_responses(url, headers, payload),
                media_type="text/event-stream",
            )

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        data = resp.json()
        # 将 Responses API 响应转换为 Chat Completions 格式
        text = ""
        for item in data.get("output", []):
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        text += content.get("text", "")
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
        return StreamingResponse(
            _stream_openai(url, headers, payload),
            media_type="text/event-stream",
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
    data = resp.json()
    return {"code": 0, "data": data, "message": "ok"}
