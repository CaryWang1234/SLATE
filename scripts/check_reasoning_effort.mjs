/**
 * 推理强度档位守卫：scripts/check_reasoning_effort.mjs
 *
 * 输入框的「推理强度」是一个五档 UI（auto/off/low/medium/high），但四家上游的字段名与
 * 取值域完全不同：OpenAI 用 reasoning_effort（Responses 侧是 reasoning.effort）、
 * Anthropic 新版用 output_config.effort 且没有"关"这一档、Google 用
 * generationConfig.thinking_level、DeepSeek 只有 thinking.type 开关。
 * 前端决定哪些档可选、后端决定真正往请求体里塞什么，两边各写一份 → 迟早出现
 * "UI 能选中、上游 400 或静默无效"。这个守卫盯三件事：
 * ①前端 REASONING_LEVELS_BY_CAP 与后端 REASONING_MAP 的档位集合逐项相等；
 * ②注册表每个模型都有显式 reasoning 能力标注（没有标注=能力未知，一律不下发）；
 * ③四个构建函数的真实输出：该发的发对字段，不该发的一个字段都不许出现。
 * ①②在 Node 侧读源码正则核对，③用 python -c 真跑构建函数断言输出。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = readFileSync(join(ROOT, "backend/routers/proxy.py"), "utf8");
const CHAT = readFileSync(join(ROOT, "frontend/js/components/chat.js"), "utf8");

// ── 1. 后端 REASONING_MAP：能力 → 档位 → 厂商取值 ────────────────
const mapBlock = /REASONING_MAP: dict\[str, dict\[str, str\]\] = \{([\s\S]*?)\n\}/.exec(PY);
assert.ok(mapBlock, "proxy.py 里必须存在 REASONING_MAP 定义");
const BACKEND_MAP = {};
for (const [, cap, inner] of mapBlock[1].matchAll(/"(\w+)":\s*\{([^}]*)\}/g)) {
  const levels = {};
  for (const [, lvl, val] of inner.matchAll(/"(\w+)":\s*"([^"]*)"/g)) levels[lvl] = val;
  BACKEND_MAP[cap] = levels;
}
for (const cap of ["openai", "anthropic", "gemini", "binary", "none"]) {
  assert.ok(BACKEND_MAP[cap], `REASONING_MAP 缺少能力 ${cap}`);
}
assert.deepEqual(Object.keys(BACKEND_MAP.none), [], "none 能力必须是空表：能力未知时一个字段都不许下发");

// ── 2. 前端可选档位表：与后端档位集合逐项相等 ────────────────────
const feBlock = /const REASONING_LEVELS_BY_CAP = \{([\s\S]*?)\n\};/.exec(CHAT);
assert.ok(feBlock, "chat.js 里必须存在 REASONING_LEVELS_BY_CAP 定义");
const FRONTEND_MAP = {};
for (const [, cap, arr] of feBlock[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
  FRONTEND_MAP[cap] = [...arr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
assert.deepEqual(Object.keys(FRONTEND_MAP).sort(), Object.keys(BACKEND_MAP).sort(),
  "前后端的能力集合必须一致");
for (const [cap, levels] of Object.entries(BACKEND_MAP)) {
  assert.deepEqual(FRONTEND_MAP[cap], ["auto", ...Object.keys(levels)],
    `能力 ${cap} 的可选档位不一致：前端多/少档位都会让用户选到无效值`);
}
assert.ok(!FRONTEND_MAP.anthropic.includes("off"),
  "Anthropic 新版 effort 没有「关」这一档，UI 给出 off 就是无效选项");

// ── 3. 厂商取值词表：写错一个字母上游就 400 ──────────────────────
const OPENAI_VALUES = new Set(["minimal", "low", "medium", "high"]);
for (const cap of ["openai", "gemini"]) {
  for (const [lvl, val] of Object.entries(BACKEND_MAP[cap])) {
    assert.ok(OPENAI_VALUES.has(val), `${cap}.${lvl} 取值 ${val} 不在官方档位词表内`);
  }
}
for (const val of Object.values(BACKEND_MAP.anthropic)) {
  assert.ok(["max", "xhigh", "high", "medium", "low"].includes(val), `anthropic 取值 ${val} 非法`);
}
for (const [lvl, val] of Object.entries(BACKEND_MAP.binary)) {
  assert.ok(["enabled", "disabled"].includes(val), `binary.${lvl} 取值 ${val} 必须是开关值`);
}
assert.equal(BACKEND_MAP.openai.off, "minimal", "off 档要映射成 minimal（官方无 none 档时按最低档处理）");

// ── 4. 注册表：每个模型都要显式标注能力 ──────────────────────────
const registryBlock = /MODEL_REGISTRY: dict\[str, list\[dict\[str, Any\]\]\] = \{([\s\S]*?)\n\}/.exec(PY);
assert.ok(registryBlock, "proxy.py 里必须存在 MODEL_REGISTRY 定义");
const entries = [...registryBlock[1].matchAll(/\{"id":\s*"([^"]+)"[\s\S]*?\}/g)];
assert.ok(entries.length >= 20, `注册表条目数异常（${entries.length}），正则可能失配`);
const caps = new Set(Object.keys(BACKEND_MAP));
for (const raw of entries) {
  const id = raw[1];
  const m = /"reasoning":\s*"([^"]*)"/.exec(raw[0]);
  assert.ok(m, `模型 ${id} 必须显式标注 reasoning 能力（未核实就写 none）`);
  assert.ok(caps.has(m[1]), `模型 ${id} 的 reasoning=${m[1]} 不在能力集合内`);
}
const reasoningOf = (id) => {
  const hit = entries.find((e) => e[1] === id);
  return /"reasoning":\s*"([^"]*)"/.exec(hit?.[0] || "")?.[1];
};
assert.equal(reasoningOf("gpt-5.6-sol"), "openai");
assert.equal(reasoningOf("claude-fable-5"), "anthropic");
assert.equal(reasoningOf("gemini-3.6-flash"), "gemini");
assert.equal(reasoningOf("deepseek-v4-pro"), "binary", "DeepSeek 官方只有 thinking.type 开关");
assert.equal(reasoningOf("kimi-k3"), "none", "未核实的第三方端点必须保持 none");
assert.equal(reasoningOf("local"), "none", "本地端点不得下发上游专有字段");

// ── 5. 自定义模型的能力回落：前后端同源 ──────────────────────────
for (const [src, label] of [[PY, "后端"], [CHAT, "前端"]]) {
  assert.match(src, /https:\/\/api\.openai\.com/, `${label}缺少 api.openai.com 官方端点回落`);
  assert.match(src, /https:\/\/api\.deepseek\.com/, `${label}缺少 api.deepseek.com 官方端点回落`);
}

// ── 6. 真跑构建函数：该发的发对字段，不该发的一个字段都不出现 ────
const PY_TEST = `
from backend.routers.proxy import (
    _build_openai_request, _build_responses_request, _build_anthropic_request,
    _reasoning_capability, _reasoning_level, _reasoning_payload, _reasoning_value,
)

body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.7}

# Chat Completions：openai 走 reasoning_effort，binary 走 thinking.type
assert _build_openai_request(body, "openai", "high")["reasoning_effort"] == "high"
assert _build_openai_request(body, "openai", "off")["reasoning_effort"] == "minimal"
assert _build_openai_request(body, "binary", "low")["thinking"] == {"type": "enabled"}
assert _build_openai_request(body, "binary", "off")["thinking"] == {"type": "disabled"}
for cap in ("none", "anthropic", "gemini"):
    p = _build_openai_request(body, cap, "high")
    assert "reasoning_effort" not in p and "thinking" not in p, (cap, p)
assert "reasoning_effort" not in _build_openai_request(body, "openai", "auto")
assert "reasoning_effort" not in _build_openai_request(body, "none", "auto")
assert _build_openai_request(body)["temperature"] == 0.7, "默认参数（不传能力）行为不得变化"

# Responses：只有 openai 能力有嵌套 reasoning.effort
assert _build_responses_request(body, "openai", "medium")["reasoning"] == {"effort": "medium"}
for cap in ("none", "binary", "anthropic", "gemini"):
    assert "reasoning" not in _build_responses_request(body, cap, "high"), cap
assert "reasoning" not in _build_responses_request(body, "openai", "auto")

# Anthropic：output_config.effort 生效时丢弃 temperature（上游会拒）
ap = _build_anthropic_request(body, "anthropic", "high")
assert ap["output_config"] == {"effort": "high"} and "temperature" not in ap
assert _build_anthropic_request(body, "anthropic", "off").get("temperature") == 0.7
assert "output_config" not in _build_anthropic_request(body, "anthropic", "off")
for cap in ("none", "openai", "binary", "gemini"):
    p = _build_anthropic_request(body, cap, "high")
    assert "output_config" not in p and p.get("temperature") == 0.7, cap

# Google：thinking_level 只在 gemini 能力下产出（构建逻辑内联在 proxy_chat，直接断言映射层）
assert _reasoning_payload("google", "gemini", "off") == {"thinking_level": "minimal"}
assert _reasoning_payload("google", "openai", "high") == {}
assert _reasoning_payload("google", "gemini", "auto") == {}

# 归一化与能力回落：取值域外一律 auto；未知端点一律 none
assert _reasoning_level({"reasoning_effort": " HIGH "}) == "high"
assert _reasoning_level({"reasoning_effort": "ultra"}) == "auto"
assert _reasoning_level({}) == "auto"
assert _reasoning_value("openai", "auto") is None
assert _reasoning_value("anthropic", "off") is None
assert _reasoning_value("none", "high") is None
assert _reasoning_capability({"reasoning": "openai"}, "openai") == "openai"
assert _reasoning_capability({"reasoning": "bogus", "provider": "anthropic"}, "anthropic") == "anthropic"
assert _reasoning_capability({}, "google") == "gemini"
assert _reasoning_capability({"base_url": "https://api.openai.com/v1"}, "openai") == "openai"
assert _reasoning_capability({"base_url": "https://api.deepseek.com/v1"}, "openai") == "binary"
assert _reasoning_capability({"base_url": "https://api.moonshot.cn/v1"}, "openai") == "none"
assert _reasoning_capability({"base_url": "http://localhost:11434/v1"}, "openai") == "none"
print("OK")
`;
const run = spawnSync("python", ["-c", PY_TEST], { cwd: ROOT, encoding: "utf8" });
assert.equal(run.status, 0, `后端构建函数断言失败：\n${run.stdout || ""}${run.stderr || ""}`);
assert.match(run.stdout, /OK/);

// ── 7. 四条链路都要接线，且 Gemini 思考走 reasoning 通道 ──────────
for (const proto of ["chat", "responses", "anthropic", "google"]) {
  assert.ok(PY.includes(`_reasoning_payload("${proto}"`), `协议 ${proto} 忘了接推理强度下发`);
}
assert.match(PY, /gen_cfg\.update\(_reasoning_payload\("google", reasoning_cap, reasoning_level\)\)/,
  "Google 分支必须把 thinking_level 合并进 generationConfig");
assert.match(PY, /"reasoning" if part\.get\("thought"\) else "content"/,
  "Gemini 流式思考 part 必须转成 delta.reasoning，不能混进正文");
assert.match(PY, /if part\.get\("thought"\):\s*\n\s*thought_text \+= part_text/,
  "Gemini 非流式也要把思考 part 与正文分开");

console.log("推理强度档位映射、注册表能力标注与四协议下发：通过");
