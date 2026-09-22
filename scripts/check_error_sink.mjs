/**
 * 前端异常兜底守卫：scripts/check_error_sink.mjs
 *
 * 为什么盯这个契约：偶发的 RangeError（Maximum call stack size exceeded）过去只在气泡里留一句
 * 「请求失败/发送失败: …」，栈迹当场丢掉，没法定位是哪一层展开或递归炸的。error_sink 是
 * 目前唯一的取证通道，一旦被改回静默 catch、或者上报通道自己变成新的故障源，问题立刻退回不可查。
 *
 * 四条不变量：
 * ① 真功能：reportError 要发得出 POST，同现场去重、噪音过滤、单次会话限量三条护栏都要生效；
 * ② 不外泄凭据：URL 只留 origin+path，query 里的 slate_lan_token 绝不能进日志；
 * ③ 发送链路的每个 catch 都要留痕（首轮生成/工具后续轮/自动续写/重新生成/发送链路）；
 * ④ 已知爆栈点不得回退：whiteboard 里不许再出现 Math.min(.../Math.max(... 的参数展开。
 * 直接 import 真实现（不复制代码），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = p => readFileSync(new URL(p, import.meta.url), "utf8");
const SINK_SRC = read("../frontend/js/services/error_sink.js");
const CHAT_SRC = read("../frontend/js/components/chat.js");
const BOARD_SRC = read("../frontend/js/components/whiteboard.js");
const APP_SRC = read("../frontend/js/app.js");
const MAIN_SRC = read("../backend/main.py");
const SINK_PY = read("../backend/routers/diagnostics.py");

// ── 1. 源码级：兜底自身不许抛错，不许改行为 ──
assert.match(SINK_SRC, /export function installErrorSink/, "必须导出 installErrorSink");
assert.match(SINK_SRC, /export function reportError/, "必须导出 reportError");
assert.match(SINK_SRC, /addEventListener\("error"/, "要接住未捕获异常");
assert.match(SINK_SRC, /addEventListener\("unhandledrejection"/, "要接住未处理的 Promise 拒绝");
assert.match(SINK_SRC, /function send\(entry\)[\s\S]*?\} catch \{/, "send 自身要包 try/catch，诊断通道不能变成新故障源");

// ── 2. 功能级：在 Node 里喂桩环境，跑真实 reportError ──
const sent = [];
globalThis.window = {
  location: { origin: "http://127.0.0.1:8912", pathname: "/index.html", search: "?slate_lan_token=SECRET-TOKEN" },
  addEventListener(type, fn) { (globalThis.__listeners ||= {})[type] = fn; },
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-guard" }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { querySelector: () => null };
globalThis.fetch = async (url, opts) => {
  assert.equal(url, "http://127.0.0.1:8912/api/diagnostics/js-error", "上报地址要带 /api 前缀");
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ code: 0 }), catch: () => {} };
};

const sink = await import("../frontend/js/services/error_sink.js?v=20260922-002");

sink.installErrorSink();
assert.deepEqual(Object.keys(globalThis.__listeners || []).sort(), ["error", "unhandledrejection"], "两个全局兜底都要装上");
sink.installErrorSink();
assert.equal(Object.keys(globalThis.__listeners).length, 2, "重复安装不得叠加监听");

const boom = new RangeError("Maximum call stack size exceeded");
boom.stack = "RangeError: Maximum call stack size exceeded\n    at focusBoardContent (whiteboard.js:1913)\n    at cb (whiteboard.js:1892)";
sink.reportError(boom, "发送链路");
assert.equal(sent.length, 1, "首次异常要落一条");
assert.equal(sent[0].message, "[发送链路] Maximum call stack size exceeded", "message 要带环节前缀");
assert.match(sent[0].stack, /focusBoardContent/, "栈帧必须带上，否则取证无意义");
assert.equal(sent[0].url, "http://127.0.0.1:8912/index.html", "url 只留 origin+path");
assert.ok(!JSON.stringify(sent[0]).includes("SECRET-TOKEN"), "LAN token 严禁进日志");

sink.reportError(boom, "发送链路");
assert.equal(sent.length, 1, "同现场不得重复上报");

// 栈截断：只留最近的帧，别把整段求值栈灌进日志
const huge = new RangeError("deep");
huge.stack = Array.from({ length: 500 }, (_, i) => `    at f${i} (a.js:1:${i})`).join("\n");
sink.reportError(huge, "截断测试");
assert.ok(sent[1].stack.split("\n").length <= 24, "栈要截断");
assert.ok(sent[1].stack.includes("f0") && !sent[1].stack.includes("at f499 "), "保留最近帧、丢掉尾部");

const noiseBase = sent.length;
for (const noise of [
  "Failed to fetch",
  "ResizeObserver loop limit exceeded",
  "signal is aborted without reason",
  "网络连接失败：浏览器无法连接到 SLATE 后端或模型代理。\n诊断：请检查后端是否仍在运行",
  "请求超时（180s）：上游没有及时响应。",
]) {
  sink.reportError(new Error(noise), "噪音");
}
assert.equal(sent.length, noiseBase, "网络中断/超时/观察器噪音不该占日志");

// 上报通道自身故障不能外溢：fetch 抛错、响应异常都得静默
const before = sent.length;
globalThis.fetch = async () => { throw new Error("backend down"); };
sink.reportError(new Error("通道故障"), "静默测试");
globalThis.fetch = async () => ({ ok: true, catch: () => { throw new Error("rejected"); } });
sink.reportError(new Error("响应异常"), "静默测试2");
assert.equal(sent.length, before, "上报失败不得抛回调用方");

// 上报上限：循环报错不得把日志灌满
globalThis.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, catch: () => {} }; };
for (let i = 0; i < 60; i += 1) sink.reportError(new TypeError(`boom-${i}`), "刷屏");
assert.ok(sent.length <= 31, `上报要有单次会话上限，实际 ${sent.length}`);
assert.ok(sent.length >= 25, "上限不能低到把正常异常也吞掉");

// ── 3. 发送链路留痕：五个 catch 站点都要接上 ──
for (const label of ["首轮生成", "工具后续轮", "自动续写", "重新生成", "发送链路"]) {
  assert.ok(
    new RegExp(`reportError\\(\\s*err\\s*,\\s*"${label}"`).test(CHAT_SRC),
    `chat.js 的「${label}」catch 丢了 reportError，异常又会变成一句文案`,
  );
}
assert.match(CHAT_SRC, /import \{ reportError \} from "\.\.\/services\/error_sink\.js\?v=/, "chat.js 要引入 error_sink");
assert.match(APP_SRC, /^installErrorSink\(\);$/m, "app.js 要在模块顶层就装兜底，别等 init");
assert.match(BOARD_SRC, /reportError\(e, "Mermaid 渲染"\)/, "Mermaid 渲染失败要留栈（大图会抛 RangeError）");

// ── 4. 已知爆栈点回退守卫 ──
assert.doesNotMatch(BOARD_SRC, /Math\.(min|max)\(\s*\.\.\./, "whiteboard 里的 Math.min(...xs) 会在笔迹上万点时抛 Maximum call stack size exceeded");
assert.match(BOARD_SRC, /function maxOf\(values, floor = -Infinity\) \{\n  let m = floor;\n  for \(const v of values\)/, "极值要遍历求，不得展开实参");
assert.match(BOARD_SRC, /strokes\.forEach\(stroke => \(stroke\.points \|\| \[\]\)\.forEach/, "focusBoardContent 要逐点扫描，不得再复制大数组");
assert.match(BOARD_SRC, /Math\.abs\(point\.x - last\.x\) < 0\.5/, "笔迹采样要丢亚像素重复点，否则存档无界增长");

// ── 5. 后端：路径定死、有长度与体积上限、永不把 500 抛回前端 ──
assert.match(MAIN_SRC, /app\.include_router\(diagnostics\.router, prefix="\/api"\)/, "diagnostics 路由要注册");
assert.match(SINK_PY, /LOG_PATH = DATA_DIR \/ "js_errors\.log"/, "日志路径要定死，不接路径参数");
assert.match(SINK_PY, /MAX_STACK_CHARS = 6000/, "栈长度要有上限");
assert.match(SINK_PY, /def _rotate_if_needed/, "日志要轮转，不能无限增长");
assert.match(SINK_PY, /except OSError:\n        pass/, "写盘失败必须静默");
assert.match(SINK_PY, /@router\.get\("\/js-error"\)/, "要能回读，否则排查还得开文件");

console.log("error_sink 兜底与取证链：通过");
