/**
 * 隐藏轮守卫：scripts/check_hidden_turns.mjs
 *
 * 「发给模型的系统话术」——[系统警告]、[系统自动推进提醒]、工具结果投喂、目标模式前缀——
 * 在界面上必须始终不可见。它本来是对的：addMessage 原样推进数组，重绘入口只画
 * isHiddenContextMessage 判否的那些。唯一会把它画出来的地方是上下文压缩后的线程重建：
 * 那里原本拿后端回传的 keep_messages 当保留段，而 keep_messages 只是
 * {role, content, display} 的**投影副本**（发请求那步就把 hidden/model 洗掉了），
 * 于是压缩一发生，用户就会在助手回复下面看到一条"系统警告"气泡——
 * 而且重载这场对话后又没了（那些轮次根本没入库），极易被误判成"模型自己在念系统提示"。
 *
 * 这里钉三件事：
 * ① compressedThread 的保留段必须是**本地那几只消息对象本身**（身份 + 全部字段）；
 * ② 三个压缩落点都走它，且没有一处再拿投影副本重建线程；
 * ③ 出网方向不许跟着"修"——隐藏轮是真的要送到模型面前的，别拿"不发"当修复。
 *
 * 跑法：node scripts/check_hidden_turns.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compressedThread } from "../frontend/js/services/thread_compress.js?v=20261003-002";
import * as store from "../frontend/js/store.js?v=20261003-002";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const CHAT = read("frontend/js/components/chat.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const ADAPTER = read("frontend/js/services/adapter.js");

// 没有"距离窗口"的函数体取法：从声明处切到顶格的那只收尾花括号——
// 函数体里的嵌套块都带缩进，顶格 `}` 只会是函数自己的结尾。
// 用固定长度窗口会随文件增长把判据挤没（上一轮就是这么假红过一次），
// 切到"下一个 function"则会被函数之间的顶层注释/let 段落带进来。
const fnBody = (src, decl) => {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `找不到 ${decl}`);
  const j = src.indexOf("\n}", i + decl.length);
  return src.slice(i, j < 0 ? src.length : j + 2);
};

// ── 1. 纯函数：保留段是本地对象本身，不是投影副本 ──────────────────
const summary = { role: "system", content: "[历史摘要]: 前情提要" };
const u1 = { role: "user", content: "第一问" };
const a1 = { role: "assistant", content: "答复一" };
const harness = { role: "user", content: "[目标模式 · Agent Loop]\n真实问题", display: "真实问题" };
const nudge = { role: "user", content: "[系统警告] 3/40 轮：你已连续 4 轮只描述计划", hidden: true, model: "[stall_warn]" };
const feed = { role: "user", content: "[工具结果] …", hidden: true, model: "[tool_results]" };
const asst2 = { role: "assistant", content: "答复二" };
const local = [u1, a1, harness, nudge, feed, asst2];

const next = compressedThread(summary, local, 2);
assert.equal(next[0], summary, "摘要条没排在最前");
assert.ok(!next.includes(u1) && !next.includes(a1), "已被摘要的头两条该从保留段里去掉，而不是留着重复一遍");
assert.ok(next.includes(nudge) && next.includes(feed) && next.includes(harness),
  "保留段里少了隐藏轮对象本身（必须是同一只对象，不能是重建的副本）");
assert.equal(next.find((m) => m.model === "[stall_warn]")?.hidden, true,
  "压缩后系统警告丢了 hidden——它会被画成用户气泡，就是用户报的那条");
assert.equal(next.find((m) => m.model === "[tool_results]")?.hidden, true,
  "工具结果投喂也必须保持隐藏");
assert.equal(next.find((m) => m === harness)?.display, "真实问题",
  "display 被抹掉会把目标模式前缀整段暴露在气泡里");
assert.equal(next.length, 5, `保留段条数不对：${next.length}（应为 6-2+摘要1）`);

assert.deepEqual(compressedThread(summary, local, 99), [summary],
  "条数越界按「整场都被摘要」处理：截到数组末尾，既不报错也不留半截重复");
assert.deepEqual(compressedThread(summary, local, 0), [summary, ...local], "0 条被压缩时该原样保留");
assert.deepEqual(compressedThread(summary, local, -3), [summary, ...local], "负数条数不该把整场截没");
assert.deepEqual(compressedThread(summary, local, "abc"), [summary, ...local], "条数不是数字时该保守地全留");
assert.deepEqual(compressedThread(summary, local, "2"), [summary, ...local.slice(2)], "数字字符串要当数字用");
assert.deepEqual(compressedThread(null, local, 1), local.slice(1),
  "没有摘要条时不该塞一个 null 进去（压缩了几条就少几条，摘要位空着）");
assert.deepEqual(compressedThread(summary, null, 1), [summary], "本地数组缺失时只剩摘要，不能崩");
assert.equal(new Set(next).size, next.length, "线程里不该出现同一只对象的重复——被摘要的头几条不能再留一份");

// 写回 store 之后仍在（setMessages 原样存数组，这里钉的是"以后别改成克隆"）
store.setMessages([summary, nudge, feed, asst2], "hidden-guard-conv");
const back = store.messagesOf("hidden-guard-conv");
assert.equal(back.find((m) => m.model === "[stall_warn]")?.hidden, true,
  "setMessages 之后隐藏标记还在——回写这一趟把链闭上");

// ── 2. 三个压缩落点都走同一个纯函数 ───────────────────────────────
assert.match(CHAT, /compressedThread\(summaryMsg, messagesOf\(convId\), compress_count\)/,
  "桌面自动压缩没按本地数组重建保留段");
assert.match(CHAT, /compressedThread\(summaryMsg, state\.messages, res\.data\.compress_count/,
  "桌面手动压缩没按本地数组重建保留段");
assert.match(MCHAT, /compressedThread\(summaryMsg, state\.messages, compress_count\)/,
  "移动端自动压缩没按本地数组重建保留段");
for (const [rel, src] of [["chat.js", CHAT], ["m-chat.js", MCHAT]]) {
  assert.ok(!/keep_messages\.map\(/.test(src), `${rel} 又拿后端投影副本重建线程了（hidden 就在这一步丢）`);
}

// ── 3. 重绘入口只有一处判隐藏，且判据覆盖三种来历 ──────────────────
const gate = fnBody(CHAT, "function isHiddenContextMessage");
assert.match(gate, /msg\??\.hidden === true/, "判隐藏的第一真源是 msg.hidden，这条不许改松");
assert.match(gate, /metadata\??\.hidden === true/, "读盘回来的隐藏轮（metadata.hidden）也要算隐藏");
assert.match(gate, /model === "\[tool_results\]"/, "只有 model 标记的工具结果投喂也要算隐藏（兜底第二道）");
assert.match(fnBody(CHAT, "function renderThreadInto"), /isHiddenContextMessage\(list\[i\]\)/,
  "重绘入口没在过滤隐藏轮——所有气泡都从这一处出，别开第二条渲染路");
assert.ok(!fnBody(CHAT, "function renderMessage").includes("isHiddenContextMessage"),
  "renderMessage 里不该再有第二处隐藏判断（判一处才谈得上漏没漏）");
assert.match(MCHAT, /if \(msg\.hidden\) continue/, "移动端重绘没跳过隐藏轮");

// ── 4. 出网方向不许"顺手修好"：警告必须真的送到模型面前 ────────────
assert.ok(!/\.hidden/.test(fnBody(ADAPTER, "function buildMessages")),
  "buildMessages 里出现了 hidden 过滤——隐藏轮是发给模型的话术，修气泡不能靠不发");

console.log("隐藏轮守卫：通过（保留段走本地对象，压缩落点 3 处，出网方向不滤 hidden）");
