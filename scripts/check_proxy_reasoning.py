"""上游载荷守卫：scripts/check_proxy_reasoning.py

proxy.py 的四个 provider 分支各自决定「往上游发什么字段」：构建器单测只证明函数本身对，
不证明 proxy_chat 真的把能力与档位传给了它。这里用假 httpx 客户端把 proxy_chat 真跑一遍，
直接钉住落到上游的请求体，并覆盖 Gemini 流式思考 part 的通道归属（曾经整段丢进正文）、
以及上游点名拒绝推理字段时的剥字段重发（覆盖面越广，越不能让猜错字段变成整条链路报错）。

运行：python scripts/check_proxy_reasoning.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.routers import proxy  # noqa: E402

BASE_MSGS = [{"role": "user", "content": "你好"}]

# 我们可能往上游注入的全部推理强度字段：能力未核实时一个都不许出现
REASONING_KEYS = {"reasoning_effort", "thinking", "reasoning", "thinking_level",
                  "enable_thinking", "output_config"}

# 各协议认的"成功且有文本"响应形状：不匹配就会走各自的兜底报错分支
REPLIES = {
    "chat": {"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
    "responses": {"output_text": "ok"},
    "anthropic": {"content": [{"type": "text", "text": "ok"}]},
    "google": {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]},
}


def reply_for(model: str, use_responses: bool = False) -> dict:
    if model.startswith("claude"):
        return REPLIES["anthropic"]
    if model.startswith("gemini"):
        return REPLIES["google"]
    return REPLIES["responses"] if use_responses else REPLIES["chat"]


class _Captured:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def note(self, url: str, payload: dict) -> None:
        self.calls.append({"url": url, "payload": json.loads(json.dumps(payload, default=str))})

    @property
    def payload(self) -> dict:
        assert len(self.calls) == 1, f"期望恰好 1 次上游调用，实际 {len(self.calls)}"
        return self.calls[0]["payload"]


class _FakeResponse:
    def __init__(self, data: dict) -> None:
        self.status_code = 200
        self.reason_phrase = "OK"
        self._data = data

    def json(self) -> dict:
        return self._data

    @property
    def text(self) -> str:
        return json.dumps(self._data, ensure_ascii=False)


class _FakeClient:
    """只实现 proxy_chat 用到的 post()，并把请求体记下来。"""

    def __init__(self, captured: _Captured, reply: dict) -> None:
        self._captured = captured
        self._reply = reply

    async def post(self, url, json=None, headers=None):  # noqa: A002 - 与 httpx 同名
        self._captured.note(url, json or {})
        return _FakeResponse(self._reply)


class _FakeStreamResponse:
    def __init__(self, lines: list[str]) -> None:
        self.status_code = 200
        self.reason_phrase = "OK"
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return b"{}"

    async def atext(self) -> str:
        return ""


class _FakeStreamCtx:
    def __init__(self, captured: _Captured, lines: list[str]) -> None:
        self._captured = captured
        self._lines = lines

    async def __aenter__(self) -> _FakeStreamResponse:
        return _FakeStreamResponse(self._lines)

    async def __aexit__(self, *_exc) -> bool:
        return False


class _StreamClient:
    def __init__(self, captured: _Captured, lines: list[str]) -> None:
        self._captured = captured
        self._lines = lines

    def stream(self, method, url, json=None, headers=None):  # noqa: ARG002
        self._captured.note(url, json or {})
        return _FakeStreamCtx(self._captured, self._lines)


class _FakeRequest:
    def __init__(self, body: dict) -> None:
        self._body = body

    async def json(self) -> dict:
        return self._body


def _call(body: dict) -> tuple[_Captured, dict]:
    """跑一次非流式 proxy_chat，返回（上游请求体，路由响应）。"""
    captured = _Captured()
    reply = body.pop("_reply")
    original = proxy._get_client
    proxy._get_client = lambda base_url: _FakeClient(captured, reply)
    try:
        result = asyncio.run(proxy.proxy_chat(_FakeRequest(body)))
    finally:
        proxy._get_client = original
    return captured, result


def _call_stream(body: dict, lines: list[str]) -> tuple[_Captured, str]:
    """跑一次流式 proxy_chat，返回（上游请求体，转换后回给前端的 SSE 全文）。"""
    captured = _Captured()
    original = proxy._get_stream_client
    proxy._get_stream_client = lambda base_url: _StreamClient(captured, lines)
    try:
        response = asyncio.run(proxy.proxy_chat(_FakeRequest(body)))

        async def _collect() -> str:
            out = []
            async for frame in response.body_iterator:
                out.append(frame if isinstance(frame, str) else frame.decode("utf-8"))
            return "".join(out)

        frames = asyncio.run(_collect())
    finally:
        proxy._get_stream_client = original
    return captured, frames


class _FailResponse:
    """上游 4xx：proxy 只用 status_code / reason_phrase / text 三个属性。"""

    def __init__(self, text: str, status: int = 400) -> None:
        self.status_code = status
        self.reason_phrase = "Bad Request"
        self.text = text

    async def aread(self) -> bytes:
        return self.text.encode("utf-8")


def _call_rejecting(body: dict, reject: str) -> tuple[_Captured, dict]:
    """非流式：第一次上游调用返回 reject 文案（空串表示直接成功），用于验证字段降级。"""
    captured = _Captured()
    reply = body.pop("_reply")
    state = {"n": 0}
    original = proxy._get_client

    class _Client(_FakeClient):
        async def post(self, url, json=None, headers=None):  # noqa: A002
            captured.note(url, json or {})
            state["n"] += 1
            if state["n"] == 1 and reject:
                return _FailResponse(reject)
            return _FakeResponse(reply)

    proxy._get_client = lambda base_url: _Client(captured, reply)
    try:
        result = asyncio.run(proxy.proxy_chat(_FakeRequest(body)))
    finally:
        proxy._get_client = original
    return captured, result


def _call_stream_rejecting(body: dict, reject: str, lines: list[str]) -> tuple[_Captured, str]:
    """流式版：第一次 HTTP 400（文案为 reject），第二次正常吐 SSE。"""
    captured = _Captured()
    state = {"n": 0}
    original = proxy._get_stream_client

    class _OkCtx:
        async def __aenter__(self):
            return _FakeStreamResponse(lines)

        async def __aexit__(self, *_exc) -> bool:
            return False

    class _FailCtx:
        async def __aenter__(self):
            return _FailResponse(reject)

        async def __aexit__(self, *_exc) -> bool:
            return False

    class _Client:
        def stream(self, method, url, json=None, headers=None):  # noqa: ARG002
            captured.note(url, json or {})
            state["n"] += 1
            return _FailCtx() if state["n"] == 1 and reject else _OkCtx()

    proxy._get_stream_client = lambda base_url: _Client()
    try:
        response = asyncio.run(proxy.proxy_chat(_FakeRequest(body)))

        async def _collect() -> str:
            out = []
            async for frame in response.body_iterator:
                out.append(frame if isinstance(frame, str) else frame.decode("utf-8"))
            return "".join(out)

        frames = asyncio.run(_collect())
    finally:
        proxy._get_stream_client = original
    return captured, frames


def upstream(model: str, level: str, **extra: object) -> dict:
    """按模型与档位发一次请求，返回真正到达上游的请求体。"""
    use_responses = bool(extra.get("use_responses"))
    body = {"model": model, "api_key": "sk-test", "messages": BASE_MSGS, "reasoning_effort": level}
    body.update({k: v for k, v in extra.items() if v is not None})
    body["_reply"] = reply_for(model, use_responses)
    captured, result = _call(body)
    assert result.get("code") == 0, f"{model}/{level}: {result}"
    return captured.payload


# ── 1. Chat Completions：档位按能力落成不同字段 ────────────────────
p = upstream("gpt-5.6-sol", "high", tools=[{"type": "function", "function": {"name": "terminal"}}])
assert p["reasoning_effort"] == "high", p
assert p.get("tools"), "原生工具数组必须继续透传"
assert "reasoning_effort" not in upstream("gpt-5.6-sol", "auto"), "auto 不该出现字段"
assert "reasoning_effort" not in upstream("gpt-5.6-sol", "bogus"), "非法档位一律按 auto 处理"

p = upstream("deepseek-v4-pro", "high")
assert p["thinking"] == {"type": "enabled"}, p
assert "reasoning_effort" not in p, "DeepSeek 不认 reasoning_effort，发出去就是 400"
assert upstream("deepseek-v4-pro", "off")["thinking"] == {"type": "disabled"}, p

# 2026-09 核实后的第三方端点：字段名与取值各按各的词表
p = upstream("kimi-k3", "high")
assert p["reasoning_effort"] == "max", f"K3 的词表是 low|high|max，high 档要落成 max：{p}"
assert upstream("kimi-k3", "medium")["reasoning_effort"] == "high"
p = upstream("kimi-k3", "off")
assert not (REASONING_KEYS & p.keys()), f"强制思考端点没有关档，一个字段都不该发：{p}"
p = upstream("glm-5.2", "off")
assert p["reasoning_effort"] == "none", f"GLM 的关档写法是 none：{p}"
assert upstream("glm-5.3", "high")["reasoning_effort"] == "max"
p = upstream("glm-5.3", "off")
assert not (REASONING_KEYS & p.keys()), "GLM-5.3 强制思考，不发给关档"
assert upstream("doubao-seed-2-1-pro-260628", "medium")["reasoning_effort"] == "medium"
assert upstream("local", "low")["reasoning_effort"] == "low", "Ollama 兼容层认 reasoning_effort"
p = upstream("MiniMax-M3", "low")
assert p["thinking"] == {"type": "adaptive"}, f"MiniMax 的开档叫 adaptive：{p}"
assert upstream("MiniMax-M3", "off")["thinking"] == {"type": "disabled"}
p = upstream("qwen3.8-max", "high")
assert p["enable_thinking"] is True and "reasoning_effort" not in p, p
assert upstream("qwen3.8-max", "off")["enable_thinking"] is False
p = upstream("kimi-k2.7-code", "high")
assert not (REASONING_KEYS & p.keys()), f"能力未核实的端点必须一个字段都不发：{p}"

# DashScope 开思考后 max_tokens 上限收紧到 32768，越界是整条 400 而不是截断
assert upstream("qwen3.8-max", "high", max_tokens=65536)["max_tokens"] == 32768
assert upstream("qwen3.8-max", "off", max_tokens=65536)["max_tokens"] == 65536, "关思考不该动用户上限"
assert upstream("gpt-5.6-sol", "high", max_tokens=65536)["max_tokens"] == 65536

# ── 2. Responses API：三个 effort 能力有嵌套 reasoning.effort ───────
p = upstream("gpt-5.6-sol", "medium", use_responses=True)
assert p["reasoning"] == {"effort": "medium"}, p
assert "reasoning_effort" not in p, p
assert "reasoning" not in upstream("gpt-5.6-sol", "auto", use_responses=True)
p = upstream("qwen3.8-max", "high", use_responses=True)
assert "reasoning" not in p, f"enable_thinking 系没有 Responses 侧对应字段，不该发：{p}"

# ── 3. Anthropic：output_config.effort 生效时丢弃 temperature ───────
p = upstream("claude-fable-5", "high", temperature=0.7)
assert p["output_config"] == {"effort": "high"}, p
assert "temperature" not in p, "effort 与 temperature 同时下发会被 Anthropic 拒绝"
p = upstream("claude-fable-5", "auto", temperature=0.7)
assert p.get("temperature") == 0.7 and "output_config" not in p, p

# ── 4. Google：thinking_level 与 temperature 同层 ──────────────────
p = upstream("gemini-3.6-flash", "medium", temperature=0.4)
assert p["generationConfig"] == {"temperature": 0.4, "thinking_level": "medium"}, p
p = upstream("gemini-3.6-flash", "auto", temperature=0.4)
assert p["generationConfig"] == {"temperature": 0.4}, p
p = upstream("gemini-3.6-flash", "auto")
assert "generationConfig" not in p, "没有要下发的字段时不该凭空造 generationConfig"

# ── 5. Gemini 流式：思考 part 走 reasoning，正文走 content ─────────
thought = {"candidates": [{"content": {"parts": [
    {"text": "先拆解问题", "thought": True},
    {"text": "答案是 42"},
]}}]}
captured, frames = _call_stream(
    {"model": "gemini-3.6-flash", "api_key": "k", "messages": BASE_MSGS,
     "stream": True, "reasoning_effort": "low"},
    [f"data: {json.dumps(thought)}"],
)
assert captured.payload["generationConfig"] == {"thinking_level": "low"}, captured.payload
assert '"reasoning": "先拆解问题"' in frames, frames
assert '"content": "答案是 42"' in frames, frames
assert '"content": "先拆解问题"' not in frames, "思考内容不得混进正文"

# 自定义模型打到官方端点：按端点域名回落能力；认不出的域名一律不发字段
assert upstream("my-gpt", "high", base_url="https://api.openai.com/v1")["reasoning_effort"] == "high"
assert upstream("my-qwen", "high", base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")["enable_thinking"] is True
assert upstream("my-glm", "off", base_url="https://open.bigmodel.cn/api/paas/v4")["reasoning_effort"] == "none"
assert upstream("my-m3", "low", base_url="https://api.minimax.io/v1")["thinking"] == {"type": "adaptive"}
p = upstream("my-gpt", "high", base_url="https://llm.example.com/v1")
assert not (REASONING_KEYS & p.keys()), f"未知端点必须一个字段都不发：{p}"

# ── 6. 字段降级：上游点名拒绝我们注入的字段时剥掉重发一次 ──────────
captured, result = _call_rejecting(
    {"model": "kimi-k3", "api_key": "k", "messages": BASE_MSGS,
     "reasoning_effort": "high", "_reply": REPLIES["chat"]},
    '{"error": {"message": "Invalid parameter: reasoning_effort should be one of low/high/max"}}')
assert result.get("code") == 0, f"降级后用户应拿到正常回复：{result}"
assert len(captured.calls) == 2, f"该重发一次，实际 {len(captured.calls)} 次"
assert captured.calls[0]["payload"].get("reasoning_effort") == "max"
assert not (REASONING_KEYS & captured.calls[1]["payload"].keys()), \
    f"重发时必须剥掉上游点名的字段：{captured.calls[1]['payload']}"
assert captured.calls[1]["payload"]["model"] == "kimi-k3", "重发只该少字段，不该改请求内容"

captured, result = _call_rejecting(
    {"model": "kimi-k3", "api_key": "k", "messages": BASE_MSGS,
     "reasoning_effort": "high", "_reply": REPLIES["chat"]},
    '{"error": {"message": "Incorrect API key provided"}}')
assert len(captured.calls) == 1, "与字段无关的 400 重发只会把真实故障藏起来"
assert result.get("code") == -1 and "API key" in result["message"], result

ok_chunk = "data: " + json.dumps({"choices": [{"delta": {"content": "答案"}}]}) + "\n\n"
captured, frames = _call_stream_rejecting(
    {"model": "glm-5.2", "api_key": "k", "messages": BASE_MSGS,
     "stream": True, "reasoning_effort": "off"},
    '{"error": {"message": "unsupported reasoning_effort: none"}}',
    [ok_chunk, "data: [DONE]\n\n"])
assert len(captured.calls) == 2, f"流式也该重发一次，实际 {len(captured.calls)} 次"
assert captured.calls[0]["payload"]["reasoning_effort"] == "none"
assert not (REASONING_KEYS & captured.calls[1]["payload"].keys()), captured.calls[1]["payload"]
assert '"content": "答案"' in frames, frames
assert "http_error" not in frames, f"重发成功后不该把第一次的 400 也吐给前端：{frames}"

captured, frames = _call_stream_rejecting(
    {"model": "glm-5.2", "api_key": "k", "messages": BASE_MSGS,
     "stream": True, "reasoning_effort": "off"},
    '{"error": {"message": "quota exceeded for this workspace"}}',
    [ok_chunk, "data: [DONE]\n\n"])
assert len(captured.calls) == 1, "流式里与字段无关的错误不该触发重发"
assert "http_error" in frames, "上游真实报错必须原样到达前端"

print("proxy_chat 上游字段下发、端点能力回落与 400 字段降级：通过")
