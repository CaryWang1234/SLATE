# -*- coding: utf-8 -*-
"""上下文窗口探测守卫：scripts/check_context_probe.py

本地 / 自定义端点（Ollama、LM Studio、llama.cpp、vLLM）的上下文窗口不在内置注册表里，
用户只能在添加模型时手填一个数；填小了浪费、填大了吃上游 400。/proxy/probe-context 按
端点形态去问几个公认入口，取第一个"说得通"的数。

这类代码坏掉的样子不是报错，而是**探到一个错的数**并被存成标称窗口，之后所有派生值
（自动档、封顶、滑杆档位）都跟着错，且没人会再怀疑它。所以这里逐条钉：
① 各家字段的位置差异（带架构前缀的 llama.context_length、schema 里的 num_ctx.default、
   字符串化的 parameters）——少认一个就探不到；
② 服务窗口必须压过训练窗口——把只开 4096 的服务报成 262144 是最坏的一种错；
③ 荒谬值不收（128、几个亿、负数、bool），否则一个 0 分母或天文数字进了覆盖表；
④ 列表端点只认这一条模型自己的对象，别把邻居的窗口当成它的；
⑤ Base URL 的协议围栏与模型名转义——这条路由会替用户发请求，不能变成任意转发器；
⑥ 路由真的挂在 /proxy/probe-context 上。

不发任何网络请求：只喂真实抓回来的响应形状给纯函数。
运行：python scripts/check_context_probe.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.routers import proxy  # noqa: E402

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, detail))


h = proxy._harvest_context_window

# ── 1. 各家的字段形状 ──────────────────────────────────────────
ok("认得带架构前缀的 Ollama 字段（llama.context_length）",
   h({"model_info": {"llama.context_length": 131072}}) == 131072,
   str(h({"model_info": {"llama.context_length": 131072}})))
ok("认得 schema 形状的服务窗口（parameters.num_ctx.default）",
   h({"parameters": '{"type":"object","properties":{"num_ctx":{"type":"integer","default":8192}}}'}) == 8192)
ok("字符串化的 parameters 里直接给数值也认得（老 Ollama 的 Modelfile 形状）",
   h({"parameters": '{"num_ctx": 8192}'}) == 8192)
ok("认得 llama.cpp 的 /props（n_ctx）",
   h({"n_ctx": 4096, "n_ctx_train": 131072}) == 4096)
ok("认得 vLLM 的 max_model_len", h({"max_model_len": 32768}) == 32768)
ok("认得 OpenRouter 的 context_length",
   h({"data": [{"id": "x", "context_length": 200000}]}) == 200000)
ok("parameters 是 dict 而不是字符串时也认得",
   h({"model_info": {"llama.context_length": 131072},
      "parameters": {"num_ctx": {"default": 4096}}}) == 4096)

# ── 2. 服务窗口压过训练窗口（报错数最坏的一种）──────────────────
ok("同时有 num_ctx 与训练 context_length 时取服务窗口",
   h({"model_info": {"llama.context_length": 262144},
      "parameters": '{"properties":{"num_ctx":{"default":4096}}}'}) == 4096,
   str(h({"model_info": {"llama.context_length": 262144}})))
ok("n_ctx 压过 max_position_embeddings（训练长度）",
   h({"n_ctx": 8192, "max_position_embeddings": 131072}) == 8192)
ok("同一优先级里取更小的那个（不把池子里的总量当单模型窗口）",
   h({"n_ctx": 4096, "total_n_ctx": 32768}) == 4096)

# ── 3. 荒谬值不收 ─────────────────────────────────────────────
ok("训练长度字段 n_ctx_train 不参与（它不是服务窗口）",
   h({"n_ctx_train": 131072}) == 0)
ok("max_tokens 是输出上限不是窗口，不收",
   h({"max_tokens": 4096}) == 0)
ok("过小的数不收（128 不是窗口）", h({"context_length": 128}) == 0)
ok("过大的数不收（几个亿明显是别的字段）", h({"context_length": 999_999_999}) == 0)
ok("布尔值不当窗口数（True 会变成 1）", h({"context_length": True}) == 0)
ok("非 JSON 字符串不硬解析", h({"context_length": "128k"}) == 0)
ok("字符串化 JSON 坏掉时不炸", h({"parameters": "{not json"}) == 0)
ok("嵌套过深时收手而不是无限递归",
   h({"a": {"b": {"c": {"d": {"e": {"f": {"g": {"n_ctx": 8192}}}}}}}}) == 0)
ok("键名大小写不敏感（Context-Length 也要认）",
   h({"Context_Length": 131072}) == 131072)

# ── 4. 列表端点只认自己那条 ────────────────────────────────────
LIST = {"data": [{"id": "other", "context_length": 1048576},
                 {"id": "qwen3:8b", "context_length": 32768}]}
ok("列表端点里挑这一条模型自己的对象",
   proxy._pick_model_entry(LIST, "qwen3:8b") == {"id": "qwen3:8b", "context_length": 32768})
ok("列表里没有这一条时返回 None（而不是拿邻居的窗口）",
   proxy._pick_model_entry(LIST, "missing") is None)
ok("邻居的窗口不会串到本模型头上",
   h(proxy._pick_model_entry(LIST, "qwen3:8b")) == 32768)

# ── 5. URL 围栏与转义 ─────────────────────────────────────────
ok("http/https 之外的协议一律拒（file:// 读本地盘）",
   proxy._safe_probe_base("file:///etc/passwd") == "")
ok("有主机名但协议不对也拒（光判 netloc 分不出协议）",
   proxy._safe_probe_base("gopher://127.0.0.1:11434/v1") == ""
   and proxy._safe_probe_base("file://x/etc/passwd") == "")
ok("没有主机名的 URL 拒", proxy._safe_probe_base("http://") == "")
ok("带空白/换行的 URL 拒（防请求头与路径注入）",
   proxy._safe_probe_base("http://a/v1\nX: 1") == "" and proxy._safe_probe_base("http://a /v1") == "")
ok("正常 URL 原样通过", proxy._safe_probe_base("http://127.0.0.1:11434/v1/") == "http://127.0.0.1:11434/v1")
ok("/v1 与站点根拆对（models 在 /v1，props 与 api/show 在根上）",
   proxy._probe_roots("http://localhost:11434/v1") == ("http://localhost:11434/v1", "http://localhost:11434"))
ok("base_url 没写 /v1 时补上，站点根不重复带 /v1",
   proxy._probe_roots("https://api.openai.com") == ("https://api.openai.com/v1", "https://api.openai.com"))
PLAN = proxy._probe_plan("http://h:11434/v1", "http://h:11434", "qwen3:8b")
ok("模型名进路径前被转义（冒号不能裸着拼进 URL）",
   any("/models/qwen3%3A8b" in item[2] for item in PLAN), str([i[2] for i in PLAN]))
ok("探测计划覆盖 Ollama 原生、OpenAI 兼容、llama.cpp 三类入口",
   {item[0] for item in PLAN} >= {"ollama/api/show", "openai/models/{id}", "llama.cpp/props"})

# ── 6. 路由与超时口径（源码级 pin）──────────────────────────────
SRC = (ROOT / "backend/routers/proxy.py").read_text(encoding="utf-8")
ok("探测路由挂在 /proxy/probe-context", '@router.post("/probe-context")' in SRC)
paths = {r.path for r in proxy.router.routes}
ok("路由真的注册进了 app（不是写在类里没挂上）", "/proxy/probe-context" in paths, str(sorted(paths)))
ok("探测用短超时而不是聊天的 180 秒", "PROBE_TIMEOUT = httpx.Timeout(8.0, connect=4.0)" in SRC)
ok("不跟随重定向（跟了就把请求送到别的 host 上）", "follow_redirects=False" in SRC)
ok("探不到时明确回 0 而不是编一个数", '"context_window": 0' in SRC)
ok("探不到的话术说明白要手填", "请按模型文档手填" in SRC)
ok("窗口表把服务窗口排在训练窗口前",
   proxy.CONTEXT_WINDOW_KEYS.index("num_ctx") < proxy.CONTEXT_WINDOW_KEYS.index("context_length"),
   str(proxy.CONTEXT_WINDOW_KEYS))
ok("探测键表不含输出上限 max_tokens", "max_tokens" not in proxy.CONTEXT_WINDOW_KEYS)
PROBE_BODY = SRC[SRC.index("async def probe_context"):SRC.index("def _build_openai_request")]
ok("探测请求带上用户存的 Key（云端端点不带 Key 探不到）",
   '"authorization": f"Bearer {api_key}"' in SRC and '"x-api-key": api_key' in SRC)
ok("API Key 不落日志（探测函数体内不许出现 logger/print）",
   "logger" not in PROBE_BODY and "print(" not in PROBE_BODY,
   "探测函数体里出现了日志调用，Key 会被写进 data/")

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\n上下文探测守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:160]}")
sys.exit(1 if failed else 0)
