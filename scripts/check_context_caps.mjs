/**
 * 每模型上下文预算守卫：scripts/check_context_caps.mjs
 *
 * 「最大上下文」滑杆一个控件背后牵着四处必须同意的东西：前端档位表、store 的持久化两
 * 条路（本地 + 共享）、后端 settings.py 的 allowed_keys 白名单、以及两个消费者
 * （自动压缩阈值 / 上下文条分母）。其中任何一处掉链子都不会报错——
 * 白名单漏了字段：拖完就没了，且只在重启后显形；
 * 消费者没跟上：条子跟压缩阈值各算各的，正是这次要修的毛病。
 * 所以这里真跑解析器，而不是只 grep：
 * ①档位表 + 吸附语义 + 每模型默认上限（自动档 = 标称窗口留两成余量后吸附档位）
 *   + 按模型窗口封顶（import store.js 实测）；
 * ②内置注册表每台都带 context_window——少一台，那台的自动档就退回全局 64K；
 * ③持久化两头都带 modelContextCaps，且后端白名单放行（跨语言，源码级 pin）；
 * ④两个消费者都经 resolver，且硬编码 64000 不许回潮；
 * ⑤滑杆控件真的存在于设置页模型行；
 * ⑥用量条上的上下文段可点，能直达该模型那一行滑杆（预算要看得见也要改得动）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "../frontend/js/store.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const STORE = read("frontend/js/store.js");
const CHAT = read("frontend/js/components/chat.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const METER = read("frontend/js/services/context_meter.js");
const APP = read("frontend/js/app.js");
const CSS = read("frontend/css/style.css");
const SETTINGS_PY = read("backend/routers/settings.py");

// ── 1. 档位表与解析语义（真跑，不看源码） ────────────────────────
assert.deepEqual(
  store.CONTEXT_CAP_STOPS,
  [0, 100000, 200000, 400000, 600000, 800000, 1000000],
  "滑杆档位变了：设置页读数、已存的用户偏好都要一起迁移"
);
const FIRST = store.state.currentModel?.id || "cap-guard-a";
const registry = { guard: [
  { id: "cap-guard-a", context_window: 400000 },   // 400K × 0.8 = 320K → 向下吸附 200K
  { id: "cap-guard-b", context_window: 8192 },     // 小得凑不满一档 → 落回全局上限
  { id: "cap-guard-c", context_window: 1048576 },  // 1M 级 → 800K
  { id: "cap-guard-d" },                           // 自定义模型：没有标称窗口
] };
store.setModelRegistry(registry);
store.state.maxTokens = 64000;

// 自动档 = 这个模型自己的默认上限：内置模型不再共用全局那一个 64K
// 余量放在最前面查：没余量时默认值会变成 1M/400K，后面的具体档位反而先报错、说不到点上
assert.ok(store.defaultContextCap("cap-guard-c") <= 1048576 * 0.8, "默认上限没按标称窗口留余量");
assert.equal(store.defaultContextCap("cap-guard-c"), 800000, "1M 窗口的默认上限该吸附到 800K");
assert.equal(store.defaultContextCap("cap-guard-a"), 200000, "400K 窗口的默认上限该吸附到 200K");
assert.equal(store.defaultContextCap("cap-guard-b"), 0, "8K 窗口凑不满任何档位，不该硬造默认值");
assert.equal(store.defaultContextCap("cap-guard-d"), 0, "没有标称窗口的模型不该凭空长出默认上限");
assert.equal(store.contextBudgetOf("cap-guard-c"), 800000, "自动档没用上模型默认上限");
assert.equal(store.contextBudgetOf("cap-guard-a"), 200000, "自动档没用上模型默认上限（400K 模型）");
// 落不到默认档的两条：沿用全局「上下文 Token 上限」，且仍按标称窗口封顶
assert.equal(store.contextBudgetOf("cap-guard-b"), 8192, "小窗口模型没被标称窗口封顶");
assert.equal(store.contextBudgetOf("cap-guard-d"), 64000, "无标称窗口的模型应沿用全局上限");
// 默认档不能压过用户：给 1M 模型手动选 100K，生效的就得是 100K 而不是它的默认 800K
store.setModelContextCap("cap-guard-c", 100000);
assert.equal(store.contextBudgetOf("cap-guard-c"), 100000, "模型默认档压过了用户手动档");
store.setModelContextCap("cap-guard-c", 0);
store.setModelContextCap("cap-guard-a", 200000);
assert.equal(store.contextBudgetOf("cap-guard-a"), 200000, "设了 200K 却没用上");
assert.equal(store.getContextCap("cap-guard-a"), 200000);
// 手动档优先于默认档；超出模型标称窗口要封顶，而不是照发出去等上游 400
store.setModelContextCap("cap-guard-a", 1000000);
assert.equal(store.contextBudgetOf("cap-guard-a"), 400000, "1M 档没被 400K 窗口封顶");
store.setModelContextCap("cap-guard-b", 200000);
assert.equal(store.contextBudgetOf("cap-guard-b"), 8192, "8K 窗口的模型没被封顶");
// 非档位值要吸附，不能造出滑杆表达不了的第四种状态
store.setModelContextCap("cap-guard-a", 180000);
assert.equal(store.getContextCap("cap-guard-a"), 200000, "180K 没吸附到 200K");
store.setModelContextCap("cap-guard-a", 120000);
assert.equal(store.getContextCap("cap-guard-a"), 100000, "120K 没吸附到 100K");
// 归零 = 回到自动（= 回到该模型的默认档），且不留残值
store.setModelContextCap("cap-guard-a", 0);
assert.equal(store.getContextCap("cap-guard-a"), 0);
assert.ok(!("cap-guard-a" in store.state.modelContextCaps), "自动档不该在状态里留残值");
assert.equal(store.contextBudgetOf("cap-guard-a"), 200000, "归零后没回到该模型的默认上限");
// 未知模型（无标称窗口）也要有个数，不能 0 分母
assert.equal(store.contextBudgetOf("cap-guard-unknown"), 64000, "未知模型预算塌成 0 会让上下文条除零");

// ── 1b. 内置注册表每台都要带默认上限（少一台，那台就退回全局 64K）──
const PROXY = read("backend/routers/proxy.py");
const reg = PROXY.slice(PROXY.indexOf("MODEL_REGISTRY"), PROXY.indexOf("@router.get(\"/models\")"));
const entries = [...reg.matchAll(/\{[^{}]*?"id":\s*"([^"]+)"[^{}]*?\}/gs)];
assert.ok(entries.length >= 20, `内置模型条目数异常：${entries.length}`);
const missing = entries.filter((m) => !/"context_window":\s*[1-9]\d{3,}/.test(m[0])).map((m) => m[1]);
assert.deepEqual(missing, [], `这些内置模型缺 context_window 默认值：${missing.join("、")}`);


// ── 2. 持久化两头 + 后端白名单 ───────────────────────────────────
assert.match(STORE, /modelContextCaps:\s*state\.modelContextCaps/, "buildPersistentData 漏了 modelContextCaps");
// 三条链路各一处：共享写请求体 + 本地读盘 + 共享读盘，少一条就是"重启后滑杆回到自动"
assert.equal((STORE.match(/modelContextCaps:\s*normalizeContextCaps\(data\.modelContextCaps\)/g) || []).length, 1,
  "共享持久化请求体要对 modelContextCaps 归一化");
assert.equal((STORE.match(/state\.modelContextCaps\s*=\s*normalizeContextCaps\(data\.modelContextCaps\)/g) || []).length, 2,
  "本地与共享两条读盘路径都要归一化 modelContextCaps");
assert.match(SETTINGS_PY, /"modelContextCaps"/, "settings.py 的 allowed_keys 必须放行 modelContextCaps，否则 PUT 时被静默丢弃");

// ── 3. 两个消费者同源，硬编码不许回潮 ────────────────────────────
assert.match(CHAT, /max_tokens:\s*contextBudgetOf\(modelId\)/, "桌面自动压缩没走预算");
assert.match(MCHAT, /max_tokens:\s*contextBudgetOf\(modelId\)/, "移动自动压缩没走预算");
assert.match(METER, /limit:\s*contextBudgetOf\(/, "上下文条分母没走预算");
for (const [rel, src] of [["chat.js", CHAT], ["m-chat.js", MCHAT]]) {
  assert.ok(!/max_tokens:\s*64000/.test(src), `${rel} 又出现硬编码 64000 压缩阈值`);
}
// 条子分母变化要能立刻重算，否则读数滞后一轮
assert.match(CHAT, /subscribe\("modelContextCaps"/, "滑杆改完没接线到用量条重绘");

// ── 4. 控件本身 ────────────────────────────────────────────────
assert.match(APP, /slider\.type\s*=\s*"range"/, "设置页滑杆控件没了");
assert.match(APP, /slider\.dataset\.modelCtx\s*=\s*model\.id/, "滑杆要能对应到具体模型（走查与排障都靠它）");
assert.match(APP, /setModelContextCap\(model\.id/, "滑杆没写回 store");
const inputLine = (APP.split("\n").find(l => l.includes('slider.addEventListener("input"')) || "").trim();
assert.ok(inputLine && !inputLine.includes("setModelContextCap"),
  "拖动过程中不该反复持久化：只有 change 才写回 store");

// ── 5. 双语文案齐备 ────────────────────────────────────────────
const DICT = read("frontend/js/services/i18n_dict.js");
for (const key of ["最大上下文", "自动压缩阈值与上下文条都按 {b} 计算", "超出模型标称窗口，已按 {w} 封顶",
  "自动取该模型的默认上限：标称窗口 {w} 留两成余量，压缩阈值与上下文条都按 {b} 计算",
  "预算 {b} · 模型窗口 {w}", "点按调整该模型的上下文预算"]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺词条：${key}`);
}
// 「自动 = 模型默认」这句契约要在源码里，别只活在 tooltip 文案里
assert.match(STORE, /function defaultContextCap\(/, "store 里没有每模型默认上限的解析器");
assert.match(STORE, /CONTEXT_HEADROOM_RATIO\s*=\s*0\.8/, "默认上限的余量比例没被钉住");
assert.match(APP, /defaultContextCap\(model\.id\)/, "设置页读数不认模型默认档，自动位会显示成全局值");

// ── 6. 从用量条直达该模型的滑杆（预算是个数字，看得见也要改得动）────
assert.match(CHAT, /class="usage-ctx" role="button" tabindex="0"/,
  "上下文段没有可点/可聚焦语义，键盘用户到不了预算设置");
assert.match(CHAT, /usageBar\?\.addEventListener\("click"/,
  "用量条是动态重绘的，点击必须挂在条上做事件委托");
assert.match(CHAT, /openSettings\(\{ focusCtxModelId:/, "点按没把当前模型带给设置页");
assert.match(APP, /export \{[^}]*\bopenSettings\b/, "app.js 未导出 openSettings，用量条跳不过去");
assert.match(APP, /options\.focusCtxModelId/, "设置页不认 focusCtxModelId，点进来会停在页首");
assert.match(APP, /\[data-model-ctx\]/, "定位要靠 data-model-ctx 找到该模型那一行滑杆");
assert.match(CSS, /\.usage-ctx\s*\{[^}]*cursor:\s*pointer/, "上下文段没有 pointer 光标，看不出可点");

// 收尾复原，避免污染后续断言（本文件内）
store.setModelContextCap("cap-guard-b", 0);
store.setModelRegistry({});

console.log(`context caps 守卫：通过（档位 ${store.CONTEXT_CAP_STOPS.length} 个，消费点 3 处）`);
