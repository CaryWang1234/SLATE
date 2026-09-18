/**
 * 推理强度档位守卫：scripts/check_reasoning_effort.mjs
 *
 * 输入框的「推理强度」是一个五档 UI（auto/off/low/medium/high），但上游的字段名与
 * 取值域各不相同：OpenAI 用 reasoning_effort（Responses 侧是 reasoning.effort）、
 * Anthropic 新版用 output_config.effort 且没有"关"这一档、Google 用
 * generationConfig.thinking_level、DeepSeek/MiniMax 只有 thinking.type 开关、
 * 通义/文心是布尔 enable_thinking、GLM/豆包/Ollama 用 reasoning_effort 但关档写 none。
 * 前端决定哪些档可选、后端决定真正往请求体里塞什么，两边各写一份 → 迟早出现
 * "UI 能选中、上游 400 或静默无效"。这个守卫盯五件事：
 * ①前端 REASONING_LEVELS_BY_CAP 与后端 REASONING_MAP 的档位集合逐项相等；
 * ②注册表每个模型都有显式 reasoning 能力标注（没有标注=能力未知，一律不下发）；
 * ③自定义模型的端点域名回落表前后端逐条一致，并把每一条真跑进后端；
 * ④各构建函数的真实输出：该发的发对字段，不该发的一个字段都不许出现；
 * ⑤字段降级兜底（流式 + 四条非流式）在位——覆盖面越广，越不能让猜错字段变成整条链路报错。
 * ①②③⑤在 Node 侧读源码正则核对，③④用 python -c 真跑构建函数断言输出。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = readFileSync(join(ROOT, "backend/routers/proxy.py"), "utf8");
const STORE = readFileSync(join(ROOT, "frontend/js/store.js"), "utf8");
const CHAT = readFileSync(join(ROOT, "frontend/js/components/chat.js"), "utf8");
const MCHAT = readFileSync(join(ROOT, "frontend/js/mobile/m-chat.js"), "utf8");
const MSET = readFileSync(join(ROOT, "frontend/js/mobile/m-settings.js"), "utf8");
const DICT = readFileSync(join(ROOT, "frontend/js/services/i18n_dict.js"), "utf8");

// ── 1. 后端 REASONING_MAP：能力 → 档位 → 厂商取值 ────────────────
const mapBlock = /REASONING_MAP: dict\[str, dict\[str, str\]\] = \{([\s\S]*?)\n\}/.exec(PY);
assert.ok(mapBlock, "proxy.py 里必须存在 REASONING_MAP 定义");
const BACKEND_MAP = {};
for (const [, cap, inner] of mapBlock[1].matchAll(/"(\w+)":\s*\{([^}]*)\}/g)) {
  const levels = {};
  for (const [, lvl, val] of inner.matchAll(/"(\w+)":\s*"([^"]*)"/g)) levels[lvl] = val;
  BACKEND_MAP[cap] = levels;
}
for (const cap of ["openai", "anthropic", "gemini", "binary", "effort", "effort_forced", "adaptive", "toggle", "none"]) {
  assert.ok(BACKEND_MAP[cap], `REASONING_MAP 缺少能力 ${cap}`);
}
assert.deepEqual(Object.keys(BACKEND_MAP.none), [], "none 能力必须是空表：能力未知时一个字段都不许下发");

// ── 2. 前端可选档位表：与后端档位集合逐项相等 ────────────────────
// 表放在 store.js：桌面输入框与移动端设置页共用一份，两边各写迟早出现"手机能选到无效档"
const feBlock = /const REASONING_LEVELS_BY_CAP = \{([\s\S]*?)\n\};/.exec(STORE);
assert.ok(feBlock, "store.js 里必须存在 REASONING_LEVELS_BY_CAP 定义");
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
assert.ok(!FRONTEND_MAP.effort_forced.includes("off"),
  "强制思考的家（Kimi K3 / GLM-5.3）传 disabled 或 none 会直接报错，UI 不许给 off 档");

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
// GLM-5.2 / 豆包 / Ollama 的 reasoning_effort：关档写 none，不是 OpenAI 的 minimal
for (const [lvl, val] of Object.entries(BACKEND_MAP.effort)) {
  assert.ok(["none", "low", "medium", "high"].includes(val), `effort.${lvl} 取值 ${val} 非法`);
}
assert.equal(BACKEND_MAP.effort.off, "none", "effort 能力的 off 档必须是 none");
// 强制思考档：只有 low|high|max 三个值，中档收敛到 high
assert.deepEqual(BACKEND_MAP.effort_forced, { low: "low", medium: "high", high: "max" },
  "effort_forced 必须把 UI 的三档映射进厂商的 low/high/max 词表");
// MiniMax 的开关枚举是 disabled|adaptive（enabled 不存在）
for (const [lvl, val] of Object.entries(BACKEND_MAP.adaptive)) {
  assert.ok(["adaptive", "disabled"].includes(val), `adaptive.${lvl} 取值 ${val} 非法：MiniMax 没有 enabled`);
}
// 通义/文心是布尔开关，词表只是内部约定，交给 _reasoning_payload 翻成 true/false
assert.deepEqual(BACKEND_MAP.toggle, { off: "off", low: "on", medium: "on", high: "on" },
  "toggle 能力只能翻成 enable_thinking 布尔值");
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
// 2026-09 按各家官方文档核实后的覆盖面：这几家写的是 reasoning_effort，但词表各不相同
assert.equal(reasoningOf("kimi-k3"), "effort_forced", "Kimi K3 只有 low|high|max，没有关档");
assert.equal(reasoningOf("kimi-k2.7-code"), "none", "K2.7 Code 的 thinking.type 传 disabled 会报错，无可下发档位");
assert.equal(reasoningOf("glm-5.2"), "effort", "GLM-5.2 起支持 reasoning_effort");
assert.equal(reasoningOf("glm-5.3"), "effort_forced", "GLM-5.3 强制思考且只认 max|high|low");
assert.equal(reasoningOf("doubao-seed-2-1-pro-260628"), "effort", "方舟 Chat API 认 reasoning_effort");
assert.equal(reasoningOf("MiniMax-M3"), "adaptive", "MiniMax 的开关枚举是 disabled|adaptive");
assert.equal(reasoningOf("qwen3.8-max"), "toggle", "通义系是布尔 enable_thinking");
assert.equal(reasoningOf("ernie-5.1"), "toggle", "文心系是布尔 enable_thinking");
assert.equal(reasoningOf("local"), "effort", "Ollama 的 OpenAI 兼容层官方支持 reasoning_effort");
const noOff = ["effort_forced", "anthropic"];
for (const [id, cap] of entries.map((e) => [e[1], /"reasoning":\s*"([^"]*)"/.exec(e[0])?.[1]])) {
  if (!noOff.includes(cap)) continue;
  assert.ok(!FRONTEND_MAP[cap].includes("off"), `模型 ${id} 的能力 ${cap} 不该在 UI 暴露 off 档`);
  assert.ok(!BACKEND_MAP[cap].off, `模型 ${id} 的能力 ${cap} 在后端存在 off 取值，会给强制思考端点发关闭请求`);
}

// ── 5. 自定义模型的能力回落：前后端按同一张域名表回落 ─────────────
const pyHosts = new Map();
const hostBlock = /REASONING_HOST_CAPS: tuple\[tuple\[str, str\], \.\.\.\] = \(([\s\S]*?)\n\)/.exec(PY);
assert.ok(hostBlock, "proxy.py 里必须存在 REASONING_HOST_CAPS 定义");
for (const [, prefix, cap] of hostBlock[1].matchAll(/\("(https?:[^"]+)",\s*"(\w+)"\)/g)) {
  assert.ok(!pyHosts.has(prefix), `后端域名表里 ${prefix} 重复，命中顺序会变成隐性行为`);
  pyHosts.set(prefix, cap);
}
const feHosts = new Map();
const feHostBlock = /const REASONING_CAP_BY_HOST = \[([\s\S]*?)\n\];/.exec(STORE);
assert.ok(feHostBlock, "store.js 里必须存在 REASONING_CAP_BY_HOST 定义");
for (const [, prefix, cap] of feHostBlock[1].matchAll(/\["(https?:[^"]+)",\s*"(\w+)"\]/g)) {
  assert.ok(!feHosts.has(prefix), `前端域名表里 ${prefix} 重复`);
  feHosts.set(prefix, cap);
}
assert.ok(pyHosts.size >= 8, `后端域名回落表条目异常（${pyHosts.size}），正则可能失配`);
assert.deepEqual([...feHosts.keys()].sort(), [...pyHosts.keys()].sort(),
  "前后端的端点回落域名集合必须一致：前端漏了档位选择器打不开，后端漏了选了档也不下发");
for (const [prefix, cap] of pyHosts) {
  assert.equal(feHosts.get(prefix), cap, `端点 ${prefix} 的能力标注前后端不一致`);
  assert.ok(BACKEND_MAP[cap], `端点 ${prefix} 回落到的能力 ${cap} 不在 REASONING_MAP 里`);
}
for (const [src, label] of [[PY, "后端"], [STORE, "前端"]]) {
  assert.match(src, /https:\/\/api\.openai\.com/, `${label}缺少 api.openai.com 官方端点回落`);
  assert.match(src, /https:\/\/api\.deepseek\.com/, `${label}缺少 api.deepseek.com 官方端点回落`);
}

// ── 5b. 消费方接线：表在 store 里，但两端都得真的用它 ─────────────
const storeExports = /export \{([\s\S]*?)\n\};/.exec(STORE);
assert.ok(storeExports, "store.js 必须有具名导出块");
for (const name of ["reasoningCapabilityOf", "reasoningLevelsOf", "REASONING_COLLAPSED_CAPS", "setReasoningEffort"]) {
  assert.ok(new RegExp(`\\b${name}\\b`).test(storeExports[1]), `store.js 未导出 ${name}，两端拿不到同一份档位判定`);
}
assert.doesNotMatch(CHAT, /const REASONING_LEVELS_BY_CAP = \{/,
  "档位表只能在 store 一份：桌面再抄一份就会与后端漂移");
assert.match(CHAT, /import \{[^}]*\breasoningCapabilityOf\b[^}]*\} from "\.\.\/store\.js/,
  "桌面必须从 store 取能力判定，本地再抄一份就会与后端漂移");
assert.match(CHAT, /reasoning_effort: state\.reasoningEffort \|\| "auto"/,
  "桌面每条链路都要带上档位，否则 UI 选了等于没选");
assert.match(MCHAT, /reasoning_effort: state\.reasoningEffort \|\| "auto"/,
  "手机遥控发出去的请求必须走同一个档位：不带上游就按模型默认思考");
assert.match(MSET, /\brenderEffortSection\b\([\s\S]*?\breasoningLevelsOf\(/,
  "移动端设置页要有推理强度区块，且档位来自同一张表");
assert.match(MSET, /\bsetReasoningEffort\(lvl\)/, "移动端选档必须写回 store 同一个键");
// 移动端还必须在"模型被别的路径改掉"时重绘档位：只在点行时局部重绘会留下上一个模型的档位表
assert.match(MSET, /subscribe\("model", \(\) => \{[\s\S]{0,200}renderModelSection\(\)/,
  "移动端切模型没重绘推理强度区块，用户会看到上一个模型的档位");
// 档位被静默改掉 = "我偷偷动了你的设置"，切模型那一刻必须回声，且只在切模型时回声
assert.match(CHAT, /echoEffortFallback\(state\.currentModel, dropped\)/,
  "桌面回落档位没回声，用户只会觉得怎么改都不生效");
assert.match(CHAT, /const justSwitched = !!effortControlModel/,
  "开机带回旧档位也弹提示会变成每次启动一条噪声：要区分是不是刚切了模型");
for (const key of ["推理强度：{level}", "该端点只分开关，低/中/高都会按「开」下发", "（不下发）",
  "端点能力未核实，SLATE 不会向它下发该字段", "{model} 不支持「{level}」推理强度，已回落自动"]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺少词条 ${key}，英文界面会露出中文`);
}

// ── 5c. 落盘链路：共享状态读的每个字段，都得有人真的产出它 ─────────
// savePersistent() 把 buildPersistentData() 的结果交给 getSharedPersistentData(data)。
// 若 builder 少产出一个字段，data.X 就是 undefined，归一化后静默变成默认值写回磁盘，
// 用户选的档位/预算会被下一次任意保存覆盖掉——整条链路只在真落盘时才暴露。
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `store.js 找不到 ${name}()，落盘链路的前提没了`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && (depth -= 1) === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}() 括号没闭合`);
}
const builderBody = fnBody(STORE, "buildPersistentData");
const sharedBody = fnBody(STORE, "getSharedPersistentData");
const produced = new Set([...builderBody.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
const consumed = new Set([...sharedBody.matchAll(/\bdata\.(\w+)/g)].map((m) => m[1]));
assert.ok(produced.size > 10 && consumed.size > 10, `字段抽取本身失效了：产出 ${produced.size} 读 ${consumed.size}`);
const dropped = [...consumed].filter((k) => !produced.has(k));
assert.deepEqual(dropped, [],
  `共享状态读这些字段但 buildPersistentData 不产出，每次落盘都会被默认值覆盖：${dropped.join(", ")}`);
assert.ok(produced.has("reasoningEffort"),
  "档位不在 buildPersistentData 里 → 桌面/手机选的推理强度永远进不了 desktop_state.json");

// ── 6. 真跑构建函数：该发的发对字段，不该发的一个字段都不出现 ────
// 域名回落表逐条转成 Python 断言，避免"表里写了但没人验证过命中逻辑"
const hostAsserts = [...pyHosts].map(([prefix, cap]) =>
  `assert _reasoning_capability({"base_url": "${prefix}/chat/completions"}, "openai") == "${cap}", "${prefix}"`).join("\n");
const PY_TEST = `
from backend.routers.proxy import (
    _build_openai_request, _build_responses_request, _build_anthropic_request,
    _reasoning_capability, _reasoning_level, _reasoning_payload, _reasoning_value,
    _rejects_reasoning_field, _without_reasoning, _REASONING_FIELDS,
)

body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.7}

# Chat Completions：openai 走 reasoning_effort，binary 走 thinking.type
assert _build_openai_request(body, "openai", "high")["reasoning_effort"] == "high"
assert _build_openai_request(body, "openai", "off")["reasoning_effort"] == "minimal"
assert _build_openai_request(body, "binary", "low")["thinking"] == {"type": "enabled"}
assert _build_openai_request(body, "binary", "off")["thinking"] == {"type": "disabled"}
# 同样写 reasoning_effort，但词表按能力各走各的
assert _build_openai_request(body, "effort", "off")["reasoning_effort"] == "none"
assert _build_openai_request(body, "effort_forced", "medium")["reasoning_effort"] == "high"
assert _build_openai_request(body, "effort_forced", "high")["reasoning_effort"] == "max"
assert "reasoning_effort" not in _build_openai_request(body, "effort_forced", "off"), "off 不在取值域内就不许下发"
assert _build_openai_request(body, "adaptive", "high")["thinking"] == {"type": "adaptive"}
assert _build_openai_request(body, "adaptive", "off")["thinking"] == {"type": "disabled"}
assert _build_openai_request(body, "toggle", "low")["enable_thinking"] is True
assert _build_openai_request(body, "toggle", "off")["enable_thinking"] is False
assert "reasoning_effort" not in _build_openai_request(body, "toggle", "high")
for cap in ("none", "anthropic", "gemini"):
    p = _build_openai_request(body, cap, "high")
    assert "reasoning_effort" not in p and "thinking" not in p, (cap, p)
assert "reasoning_effort" not in _build_openai_request(body, "openai", "auto")
assert "reasoning_effort" not in _build_openai_request(body, "none", "auto")
assert _build_openai_request(body)["temperature"] == 0.7, "默认参数（不传能力）行为不得变化"

# 开思考后 DashScope 把 max_tokens 上限收紧到 32768，越界是整条 400 而不是截断
wide = {**body, "max_tokens": 65536}
assert _build_openai_request(wide, "toggle", "high")["max_tokens"] == 32768
assert _build_openai_request(wide, "toggle", "off")["max_tokens"] == 65536, "关思考不该动用户的输出上限"
assert _build_openai_request(wide, "openai", "high")["max_tokens"] == 65536
assert _build_openai_request({**body, "max_tokens": 8192}, "toggle", "high")["max_tokens"] == 8192

# Responses：三个 effort 能力都有嵌套 reasoning.effort，其余一个字段都不出现
assert _build_responses_request(body, "openai", "medium")["reasoning"] == {"effort": "medium"}
assert _build_responses_request(body, "effort", "off")["reasoning"] == {"effort": "none"}
assert _build_responses_request(body, "effort_forced", "high")["reasoning"] == {"effort": "max"}
for cap in ("none", "binary", "adaptive", "toggle", "anthropic", "gemini"):
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
assert _reasoning_capability({"base_url": ""}, "openai") == "none"
assert _reasoning_capability({"base_url": "https://llm.example.com/v1"}, "openai") == "none"
# 域名回落表逐条真跑：注册表之外的自定义模型只能靠它认能力
${hostAsserts}

# 降级：上游点名拒绝某个推理字段时，剥掉后请求体里一个推理字段都不该剩下
p = _build_openai_request(body, "effort", "high")
clean, dropped = _without_reasoning(p)
assert dropped == ["reasoning_effort"] and not any(k in clean for k in _REASONING_FIELDS), (dropped, clean)
assert _rejects_reasoning_field(p, "Invalid parameter: reasoning_effort") is True
assert _rejects_reasoning_field(p, "invalid 'reasoning_effort' value is not supported") is True
assert _rejects_reasoning_field(p, "Incorrect API key provided") is False, "鉴权错误不许被掩盖成一次重发"
assert _rejects_reasoning_field(p, "Rate limit reached") is False, "限流不该触发重发"
assert _rejects_reasoning_field({"reasoning_effort": "high"}, "") is False
tp = {"thinking": {"type": "disabled"}, "max_tokens": 100}
tclean, tdropped = _without_reasoning(tp)
assert tdropped == ["thinking"] and tclean == {"max_tokens": 100}
gp, gdropped = _without_reasoning({"generationConfig": {"temperature": 0.7, "thinking_level": "low"}, "contents": []})
assert gdropped == ["generationConfig"] and gp["generationConfig"] == {"temperature": 0.7}
assert _rejects_reasoning_field({"enable_thinking": True}, "enable_thinking is not supported") is True
assert _without_reasoning({"model": "m"})[1] == [], "没加过字段就不该重发"
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

// ── 8. 降级兜底：覆盖面越广，越要保证猜错字段时只是档位不生效 ──────
assert.match(PY, /if can_retry and _rejects_reasoning_field\(payload, err\)/,
  "流式链路必须在上游点名拒绝字段时把错误交给重发逻辑");
assert.equal((PY.match(/await _post_json\(client, url, headers, payload/g) || []).length, 4,
  "四条非流式链路都要走带字段降级的 _post_json，漏一条就是那条模型可能整条报错");
assert.match(PY, /_REASONING_FIELDS = \([^)]*"enable_thinking"[^)]*\)/,
  "enable_thinking 必须登记在待剥字段表里，否则通义系 400 后不会重发");

console.log("推理强度档位映射、注册表能力标注与四协议下发：通过");
