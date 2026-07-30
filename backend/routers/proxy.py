"""LLM API 代理路由：转发请求到各模型提供商，支持流式输出。"""

from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/proxy", tags=["proxy"])

# ── 模型注册表（2026-07 时效性校验） ──────────────────────────

MODEL_REGISTRY: dict[str, list[dict[str, Any]]] = {
    "international": [
        {"id": "gpt-4o", "name": "GPT-4o", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 128000},
        {"id": "o3-mini", "name": "o3-mini", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 200000},
        {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 200000},
        {"id": "claude-3-7-sonnet-20250219", "name": "Claude 3.7 Sonnet", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 200000},
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576},
        {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 2097152},
    ],
    "domestic": [
        {"id": "deepseek-chat", "name": "DeepSeek-V4-Pro", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 131072},
        {"id": "deepseek-reasoner", "name": "DeepSeek-R1", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 65536},
        {"id": "deepseek-v4-flash", "name": "DeepSeek-V4-Flash", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 131072},
        {"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code", "provider": "openai",
         "base_url": "https://api.moonshot.cn/v1", "context_window": 262144},
        {"id": "qwen3.8-max", "name": "Qwen3.8-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072},
        {"id": "qwen3.7-max", "name": "Qwen3.7-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072},
        {"id": "qwen3.7-plus", "name": "Qwen3.7-Plus", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 131072},
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


def _build_anthropic_request(body: dict[str, Any]) -> dict[str, Any]:
    """构建 Anthropic 格式请求体。"""
    messages = body.get("messages", [])
    system_msg = ""
    chat_messages = []
    for msg in messages:
        if msg["role"] == "system":
            system_msg = msg["content"]
        else:
            chat_messages.append({"role": msg["role"], "content": msg["content"]})

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
        async with client.stream("POST", url, json=payload, headers=headers, timeout=120) as resp:
            async for line in resp.aiter_lines():
                if line:
                    yield f"{line}\n\n"


async def _stream_anthropic(url: str, headers: dict[str, str], payload: dict[str, Any]):
    """流式转发 Anthropic API，转换为 OpenAI 兼容 SSE 格式（自管理 client）。"""
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", url, json=payload, headers=headers, timeout=120) as resp:
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
            resp = await client.post(url, json=payload, headers=headers, timeout=120)
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
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})
        payload: dict[str, Any] = {"contents": contents}
        if body.get("temperature"):
            payload["generationConfig"] = {"temperature": body["temperature"]}

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=120)
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
    url = f"{base_url}/chat/completions"
    payload = _build_openai_request(body)

    if is_stream:
        return StreamingResponse(
            _stream_openai(url, headers, payload),
            media_type="text/event-stream",
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload, headers=headers, timeout=120)
    data = resp.json()
    return {"code": 0, "data": data, "message": "ok"}
