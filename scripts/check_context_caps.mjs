/**
 * 每模型上下文预算守卫：scripts/check_context_caps.mjs
 *
 * 「最大上下文」滑杆一个控件背后牵着四处必须同意的东西：前端档位表、store 的持久化两
 * 条路（本地 + 共享）、后端 settings.py 的 allowed_keys 白名单、以及两个消费者
 * （自动压缩阈值 / 上下文条分母）。其中任何一处掉链子都不会报错——
 * 白名单漏了字段：拖完就没了，且只在重启后显形；
 * 消费者没跟上：条子跟压缩阈值各算各的，正是这次要修的毛病。
 * 所以这里真跑解析器，而不是只 grep：
 * ①档位表 + 吸附语义 + 按模型窗口封顶（import store.js 实测）；
 * ②持久化两头都带 modelContextCaps，且后端白名单放行（跨语言，源码级 pin）；
 * ③两个消费者都经 resolver，且硬编码 64000 不许回潮；
 * ④滑杆控件真的存在于设置页模型行；
 * ⑤用量条上的上下文段可点，能直达该模型那一行滑杆（预算要看得见也要改得动）。
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
const registry = { guard: [{ id: "cap-guard-a", context_window: 400000 }, { id: "cap-guard-b", context_window: 8192 }] };
store.setModelRegistry(registry);
store.state.maxTokens = 64000;

// 自动档 = 全局上限：不动滑杆必须与本次改动之前的压缩行为逐字一致
assert.equal(store.contextBudgetOf("cap-guard-a"), 64000, "自动档应沿用全局「上下文 Token 上限」");
store.setModelContextCap("cap-guard-a", 200000);
assert.equal(store.contextBudgetOf("cap-guard-a"), 200000, "设了 200K 却没用上");
assert.equal(store.getContextCap("cap-guard-a"), 200000);
// 超出模型标称窗口要封顶，而不是照发出去等上游 400
store.setModelContextCap("cap-guard-a", 1000000);
assert.equal(store.contextBudgetOf("cap-guard-a"), 400000, "1M 档没被 400K 窗口封顶");
store.setModelContextCap("cap-guard-b", 200000);
assert.equal(store.contextBudgetOf("cap-guard-b"), 8192, "8K 窗口的模型没被封顶");
// 非档位值要吸附，不能造出滑杆表达不了的第四种状态
store.setModelContextCap("cap-guard-a", 180000);
assert.equal(store.getContextCap("cap-guard-a"), 200000, "180K 没吸附到 200K");
store.setModelContextCap("cap-guard-a", 120000);
assert.equal(store.getContextCap("cap-guard-a"), 100000, "120K 没吸附到 100K");
// 归零 = 回到自动，且不留键
store.setModelContextCap("cap-guard-a", 0);
assert.equal(store.getContextCap("cap-guard-a"), 0);
assert.ok(!("cap-guard-a" in store.state.modelContextCaps), "自动档不该在状态里留残值");
assert.equal(store.contextBudgetOf("cap-guard-a"), 64000);
// 未知模型（无标称窗口）也要有个数，不能 0 分母
assert.equal(store.contextBudgetOf("cap-guard-unknown"), 64000, "未知模型预算塌成 0 会让上下文条除零");

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
  "预算 {b} · 模型窗口 {w}", "点按调整该模型的上下文预算"]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺词条：${key}`);
}

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
