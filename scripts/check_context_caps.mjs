/**
 * 每模型上下文预算守卫：scripts/check_context_caps.mjs
 *
 * 「最大上下文」一个控件背后牵着四处必须同意的东西：前端档位表、store 的持久化三条
 * 路（本地 + 共享读写）、后端 settings.py 的 allowed_keys 白名单、以及两个消费者
 * （自动压缩阈值 / 上下文条分母）。其中任何一处掉链子都不会报错——
 * 白名单漏了字段：拖完就没了，且只在重启后显形；
 * 消费者没跟上：条子跟压缩阈值各算各的。
 *
 * 2026-09-28 这轮把语义换了三处，所以这里跟着钉三条新契约：
 * ①「自动」= 标称窗口 ×0.8，**不再吸附到滑杆档位**。吸附会把 200K/256K/128K 压成同一个
 *   数，而小窗口模型（本地 8K、自定义 32K）凑不满最低一档只能返回 0，于是"自动"对它们
 *   等于全额占用窗口——第一条回复没地方写，正是用户报的"本地模型设置不准"。
 * ②手输保留精确值（131072 就是 131072），只做区间夹取，不再吸附。
 * ③探测到的真实窗口存成独立的覆盖表 modelContextWindows，动它等于动"标称窗口"，
 *   所有派生数（档位、自动值、封顶）都要跟着变；探到荒谬值必须被拦住而不是照收。
 *
 * 只用 fs + 真 import 跑解析器，绝不正则匹配被测语义本身。
 * 跑法：node scripts/check_context_caps.mjs
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
const PROXY = read("backend/routers/proxy.py");
const SETTINGS_PY = read("backend/routers/settings.py");

// ── 1. 档位表与解析语义（真跑，不看源码） ────────────────────────
assert.deepEqual(
  store.CONTEXT_CAP_STOPS,
  [0, 100000, 200000, 400000, 600000, 800000, 1000000],
  "滑杆粗档变了：已存的用户偏好与走查读数都要一起迁移"
);
assert.ok(store.CONTEXT_CAP_FINE_STOPS.every(n => n > 0), "细档必须都是正数");

const registry = { guard: [
  { id: "cap-guard-a", context_window: 400000 },
  { id: "cap-guard-b", context_window: 8192 },       // 本地小窗口：以前凑不满一档，自动=全额占用
  { id: "cap-guard-c", context_window: 1048576 },
  { id: "cap-guard-d" },                              // 自定义模型：没有标称窗口
] };
store.setModelRegistry(registry);
store.state.maxTokens = 64000;

// ①自动档按各自窗口留两成余量，不吸附——三个模型必须给出三个不同的数
const autoA = store.defaultContextCap("cap-guard-a");
const autoB = store.defaultContextCap("cap-guard-b");
const autoC = store.defaultContextCap("cap-guard-c");
// 余量先判，再判具体数：这样"取消余量"与"吸附回粗档"两种倒退落在不同判据上
for (const [id, win] of [["cap-guard-a", 400000], ["cap-guard-b", 8192], ["cap-guard-c", 1048576]]) {
  const v = store.defaultContextCap(id);
  assert.ok(v < win, `${id} 的自动值没留输出余量（等于甚至超过窗口 ${win}）`);
  assert.ok(v >= Math.floor(win * 0.8) - 1, `${id} 的自动值比标称窗口的八成还小出一档`);
}
assert.equal(autoA, 320000, "400K 窗口的自动值该是 400000×0.8=320000，不是吸附后的 200K");
assert.equal(autoC, 838860, "1M 窗口的自动值该是 1048576×0.8=838860，不是吸附后的 800K");
assert.equal(autoB, 6553, "8K 窗口的自动值该是 6553：小窗口也得留余量");
assert.ok(new Set([autoA, autoB, autoC]).size === 3, "三个不同窗口的模型算出了同一个自动值");
assert.equal(store.defaultContextCap("cap-guard-d"), 0, "没有标称窗口的模型不该凭空长出默认上限");
assert.equal(store.contextBudgetOf("cap-guard-d"), 64000, "无标称窗口的模型应沿用全局上限");
assert.equal(store.contextBudgetOf("cap-guard-unknown"), 64000, "未知模型预算塌成 0 会让上下文条除零");

assert.equal(store.contextBudgetOf("cap-guard-c"), autoC, "自动档没用上模型自己的默认上限");
assert.equal(store.contextBudgetOf("cap-guard-b"), 6553, "小窗口模型的自动档没吃到余量");

// ②手输保留精确值：滑杆粗档不该把 131072 磨成 100000
store.setModelContextCap("cap-guard-a", 131072);
assert.equal(store.getContextCap("cap-guard-a"), 131072, "手输 131072 被吸附成了别的数");
assert.equal(store.contextBudgetOf("cap-guard-a"), 131072, "精确值没进生效预算");
store.setModelContextCap("cap-guard-a", 180000);
assert.equal(store.getContextCap("cap-guard-a"), 180000, "180K 被吸附成了别的数（旧语义没清干净）");
// 夹取：荒谬的小值与大值不能造出 0 分母或天文数字
store.setModelContextCap("cap-guard-a", 10);
assert.equal(store.getContextCap("cap-guard-a"), store.CONTEXT_CAP_MIN, "手输 10 没夹到下限");
store.setModelContextCap("cap-guard-a", 50000000);
assert.equal(store.getContextCap("cap-guard-a"), store.CONTEXT_CAP_MAX, "手输 5 千万没夹到上限");
// 手动档优先于默认档，且超窗口要封顶，而不是照发出去等上游 400
store.setModelContextCap("cap-guard-c", 100000);
assert.equal(store.contextBudgetOf("cap-guard-c"), 100000, "模型默认档压过了用户手动档");
store.setModelContextCap("cap-guard-c", 0);
assert.equal(store.contextBudgetOf("cap-guard-c"), autoC, "归零后没回到该模型的默认上限");
assert.ok(!("cap-guard-c" in store.state.modelContextCaps), "自动档不该在状态里留残值");
store.setModelContextCap("cap-guard-b", 200000);
assert.equal(store.contextBudgetOf("cap-guard-b"), 8192, "8K 窗口的模型没被标称窗口封顶");
store.setModelContextCap("cap-guard-b", 0);

// ③滑杆档位按这个模型的窗口生成
const stopsB = store.contextCapStops("cap-guard-b");
assert.equal(stopsB[0], 0, "每个模型的档位都要以「自动」打头");
assert.ok(stopsB.every(n => n <= 8192), `8K 窗口的档位超出了窗口本身：${stopsB.join(",")}`);
assert.ok(stopsB.includes(4096), "小窗口模型该有 4K 这一档可拖");
assert.ok(stopsB.includes(autoB), "档位里要有一个等于自动值的点，否则「自动」无法重现");
const stopsC = store.contextCapStops("cap-guard-c");
assert.ok(stopsC.includes(1000000) && stopsC.includes(autoC), "1M 模型的档位缺了满档或自动值");
assert.deepEqual([...stopsC].sort((x, y) => x - y), stopsC, "档位没按升序排，滑杆索引会错位");
assert.equal(new Set(stopsC).size, stopsC.length, "档位有重复值");
assert.ok(store.contextCapStops("cap-guard-d").includes(1000000), "窗口未知时该把所有档都给用户");
assert.equal(store.contextCapStopIndex("cap-guard-c", 0), 0, "自动档的滑杆索引必须是 0");
assert.equal(store.contextCapStopIndex("cap-guard-c", autoC), stopsC.indexOf(autoC), "自动值的索引对不上");
assert.ok(Math.abs(stopsC[store.contextCapStopIndex("cap-guard-c", 130000)] - 130000) <= 20000,
  "手输值落到了很远的档位上，滑杆会与数字框显示自相矛盾");

// ④探测到的窗口是一张独立覆盖表：改了它，派生数要全部跟上
assert.equal(store.contextWindowSource("cap-guard-d"), "unknown");
store.setModelContextWindow("cap-guard-d", 131072);
assert.equal(store.declaredContextWindow("cap-guard-d"), 131072, "探测覆盖没被当成标称窗口");
assert.equal(store.contextWindowSource("cap-guard-d"), "probed", "界面读不出这个窗口是探测来的");
assert.equal(store.defaultContextCap("cap-guard-d"), 104857, "探测覆盖没参与自动值计算");
assert.equal(store.contextBudgetOf("cap-guard-d"), 104857, "探测覆盖没参与生效预算");
store.setModelContextWindow("cap-guard-d", 100);
assert.equal(store.getContextWindow("cap-guard-d"), 0, "荒谬的小窗口该被拦住而不是照收");
store.setModelContextWindow("cap-guard-d", 99999999);
assert.equal(store.getContextWindow("cap-guard-d"), 0, "荒谬的大窗口该被拦住");
assert.equal(store.contextWindowSource("cap-guard-d"), "unknown", "拦下坏值后来源没回到未知");

// ── 1b. 内置注册表每台都要带窗口（少一台，那台的自动档就退回全局 64K）──
const reg = PROXY.slice(PROXY.indexOf("MODEL_REGISTRY"), PROXY.indexOf('@router.get("/models")'));
const entries = [...reg.matchAll(/\{[^{}]*?"id":\s*"([^"]+)"[^{}]*?\}/gs)];
assert.ok(entries.length >= 20, `内置模型条目数异常：${entries.length}`);
const missing = entries.filter((m) => !/"context_window":\s*[1-9]\d{3,}/.test(m[0])).map(m => m[1]);
assert.deepEqual(missing, [], `这些内置模型缺 context_window 默认值：${missing.join("、")}`);

// ── 2. 持久化三条路 + 后端白名单 ────────────────────────────────
assert.match(STORE, /modelContextCaps:\s*state\.modelContextCaps/, "buildPersistentData 漏了 modelContextCaps");
assert.match(STORE, /modelContextWindows:\s*state\.modelContextWindows/, "buildPersistentData 漏了 modelContextWindows");
assert.equal((STORE.match(/modelContextCaps:\s*normalizeContextCaps\(data\.modelContextCaps\)/g) || []).length, 1,
  "共享持久化请求体要对 modelContextCaps 归一化");
assert.equal((STORE.match(/state\.modelContextCaps\s*=\s*normalizeContextCaps\(data\.modelContextCaps\)/g) || []).length, 2,
  "本地与共享两条读盘路径都要归一化 modelContextCaps");
assert.equal((STORE.match(/state\.modelContextWindows\s*=\s*normalizeContextWindows\(data\.modelContextWindows\)/g) || []).length, 2,
  "本地与共享两条读盘路径都要归一化 modelContextWindows（漏一条＝探测结果重启即丢）");
assert.match(SETTINGS_PY, /"modelContextCaps"/, "settings.py 必须放行 modelContextCaps，否则 PUT 时被静默丢弃");
assert.match(SETTINGS_PY, /"modelContextWindows"/, "settings.py 必须放行 modelContextWindows，否则探测结果存不住");

// ── 3. 两个消费者同源，硬编码不许回潮 ────────────────────────────
assert.match(CHAT, /max_tokens:\s*contextBudgetOf\(modelId\)/, "桌面自动压缩没走预算");
assert.match(MCHAT, /max_tokens:\s*contextBudgetOf\(modelId\)/, "移动自动压缩没走预算");
assert.match(METER, /limit:\s*contextBudgetOf\(/, "上下文条分母没走预算");
for (const [rel, src] of [["chat.js", CHAT], ["m-chat.js", MCHAT]]) {
  assert.ok(!/max_tokens:\s*64000/.test(src), `${rel} 又出现硬编码 64000 压缩阈值`);
}
assert.match(CHAT, /subscribe\("modelContextCaps"/, "滑杆改完没接线到用量条重绘");

// ── 4. 控件：滑杆 + 精确框 + 探测，三件都要挂在模型行上 ──────────
assert.match(APP, /slider\.type\s*=\s*"range"/, "设置页滑杆控件没了");
assert.match(APP, /slider\.dataset\.modelCtx\s*=\s*model\.id/, "滑杆要能对应到具体模型（走查与排障都靠它）");
assert.match(APP, /slider\.max\s*=\s*String\(stops\.length\s*-\s*1\)/, "滑杆量程必须按该模型的档位生成");
const inputLine = (APP.split("\n").find(l => l.includes('slider.addEventListener("input"')) || "").trim();
assert.ok(inputLine && !inputLine.includes("setModelContextCap"),
  "拖动过程中不该反复持久化：只有 change 才写回 store");
assert.match(APP, /exact\.type\s*=\s*"number"/, "精确预算输入框没了");
assert.match(APP, /exact\.dataset\.modelCtxInput\s*=\s*model\.id/, "输入框要能对应到具体模型");
assert.ok(APP.includes(`exact.min = "${store.CONTEXT_CAP_MIN}"`),
  "数字框标的下限与 store 的夹取下限不是同一个数（界面会谎报能填多小）");
assert.match(APP, /setModelContextCap\(model\.id,\s*typed\)/, "手输的精确值没写回 store");
assert.match(APP, /probeBtn\.dataset\.modelCtxProbe\s*=\s*model\.id/, "探测按钮要能对应到具体模型");
assert.match(APP, /post\("\/proxy\/probe-context"/, "探测按钮没打后端路由");
assert.match(APP, /setModelContextWindow\(model\.id,\s*found\)/, "探测结果没落到覆盖表");
assert.match(APP, /clearProbe\.addEventListener/, "探测结果没法撤销（探错了就永久顶着错误窗口）");
// 桌面 CSS 没有全局 .hidden：判隐藏只能用 display，且新类必须有规则，否则控件裸奔
assert.match(APP, /clearProbe\.style\.display\s*=/, "撤销按钮的显隐要靠 display（.hidden 在桌面 CSS 里没定义）");
// 只查类名出现在 CSS 里会被副形态骗过（.ctx-cap-exact.is-auto 也含这个名字）：
// 要的是"这条类自己有一条带声明的规则"，也就是基态样式还在。
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const cssRules = CSS_CLEAN.split("}").map((chunk) => {
  const i = chunk.indexOf("{");
  return i < 0 ? null : { sels: chunk.slice(0, i).split(",").map((s) => s.trim()), body: chunk.slice(i + 1).trim() };
}).filter(Boolean);
for (const cls of [".ctx-cap-exact", ".ctx-cap-probe", ".ctx-cap-probe-clear"]) {
  assert.ok(cssRules.some((r) => r.body.includes(":") && r.sels.some((s) => s === cls)),
    `style.css 里没有 ${cls} 的规则（类在 CSS 里 0 条＝控件裸奔）`);
}

// ── 5. 后端探测：路由、字段优先级、URL 围栏 ──────────────────────
assert.match(PROXY, /@router\.post\("\/probe-context"\)/, "没有 /proxy/probe-context 路由");
assert.match(PROXY, /def _harvest_context_window/, "窗口解析没抽成纯函数（守卫只能靠猜）");
const keyOrder = PROXY.slice(PROXY.indexOf("CONTEXT_WINDOW_KEYS"), PROXY.indexOf("CONTEXT_WINDOW_MIN"));
for (const k of ["num_ctx", "n_ctx", "context_length", "max_model_len"]) {
  assert.ok(keyOrder.includes(`"${k}"`), `探测键表缺 ${k}`);
}
assert.ok(keyOrder.indexOf('"num_ctx"') < keyOrder.indexOf('"context_length"'),
  "服务窗口键必须排在训练窗口前，否则会把只开 4096 的本地服务报成 262144");
assert.match(PROXY, /parsed\.scheme not in \("http", "https"\)/, "Base URL 没做协议围栏");
assert.match(PROXY, /follow_redirects=False/, "探测不该跟着重定向跑到别的 host");
assert.match(PROXY, /quote\(model,\s*safe=""\)/, "模型名进 URL 路径前没转义");
assert.match(PROXY, /_pick_model_entry/, "列表端点要只认这一条模型自己的对象，别拿邻居的窗口");

// ── 6. 双语文案齐备 ────────────────────────────────────────────
const DICT = read("frontend/js/services/i18n_dict.js");
for (const key of ["最大上下文", "压缩阈值与上下文条都按 {b} 计算", "超出模型标称窗口，已按 {w} 封顶",
  "按该模型标称窗口 {w} 留两成余量：压缩阈值与上下文条都按 {b} 计算",
  "预算 {b} · 模型窗口 {w}", "点按调整该模型的上下文预算",
  "精确上下文预算", "探测窗口", "重新探测", "探测中…", "窗口为探测所得",
  "清除探测到的窗口，回到端点自带值", "已清除探测到的窗口", "探测到上下文窗口 {w}（来自 {s}）",
  "这个端点没有暴露上下文窗口，请按模型文档手填", "这个模型没有可探测的 Base URL", "探测失败"]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺词条：${key}`);
}
assert.match(STORE, /function defaultContextCap\(/, "store 里没有每模型默认上限的解析器");
assert.match(STORE, /CONTEXT_HEADROOM_RATIO\s*=\s*0\.8/, "默认上限的余量比例没被钉住");
assert.match(APP, /contextBudgetOf\(model\.id\)/, "设置页读数没走同一个预算解析器");

// ── 7. 从用量条直达该模型的控件（预算要看得见也要改得动）──────────
assert.match(CHAT, /class="usage-ctx" role="button" tabindex="0"/,
  "上下文段没有可点/可聚焦语义，键盘用户到不了预算设置");
assert.match(CHAT, /usageBar\?\.addEventListener\("click"/,
  "用量条是动态重绘的，点击必须挂在条上做事件委托");
assert.match(CHAT, /openSettings\(\{ focusCtxModelId:/, "点按没把当前模型带给设置页");
assert.match(APP, /export \{[^}]*\bopenSettings\b/, "app.js 未导出 openSettings，用量条跳不过去");
assert.match(APP, /options\.focusCtxModelId/, "设置页不认 focusCtxModelId，点进来会停在页首");
assert.match(APP, /\[data-model-ctx\]/, "定位要靠 data-model-ctx 找到该模型那一行");
assert.match(CSS, /\.usage-ctx\s*\{[^}]*cursor:\s*pointer/, "上下文段没有 pointer 光标，看不出可点");

// 收尾复原，避免污染后续断言（本文件内）
store.setModelContextCap("cap-guard-b", 0);
store.setModelContextWindow("cap-guard-d", 0);
store.setModelRegistry({});

console.log(`context caps 守卫：通过（粗档 ${store.CONTEXT_CAP_STOPS.length} 个，`
  + `自动值 ${autoA}/${autoB}/${autoC} 各不相同，消费点 3 处，探测键 ${["num_ctx", "n_ctx", "context_length", "max_model_len"].length} 个）`);
