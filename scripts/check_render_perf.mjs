/**
 * 长对话渲染性能守卫：scripts/check_render_perf.mjs
 *
 * 这层钉的是两条实测出来的账（数字来自 .qoder/perf_long_thread.py，基线存 .diag/perf/baseline.json）：
 * ① 流式不再逐块重排整条气泡——上游每 8～20 字一块，逐块重排等于把一条 5638 字的回复
 *    重画 1411 次，实测主线程 4.6 秒里 3.9 秒是不可输入的长任务；现在最多每 60ms 一次。
 *    这条契约最容易坏在"有人把 .kick() 换回直接 renderAssistantContent()"，或收尾漏了
 *    flush()（末块的字会丢），或在 removeStreamingCursor 之后才 flush（摘掉的光标被画回来）。
 * ② 整条线程不再无条件重建——今天"加一条消息"要重画全部消息：300 条的现场实测一次追加
 *    180ms，一回合通知三次。现在按签名逐位比对，只有真变过的消息重画。
 *    这条最容易坏在：回到 host.innerHTML="" 起手（前功尽弃）、签名漏字段（改了却不重画，
 *    界面停在旧内容）、搬树（stash/adopt）时台账不跟着走（切回来一片空白）。
 *
 * 运行：node scripts/check_render_perf.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CHAT = readFileSync(`${ROOT}frontend/js/components/chat.js`, "utf8");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (needle) => CHAT.includes(needle);

/** 取某个函数名往后的函数体（本文件里的函数体都是顶格 `}` 收尾） */
function fnBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

/** 按花括号配对取出 open 处开始的整块（用于逐个流式处理块检查） */
function blockAt(src, openIndex) {
  const from = src.indexOf("{", openIndex);
  if (from < 0) return "";
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(from, i + 1);
    }
  }
  return "";
}

// ── ① 流式合帧 ────────────────────────────────
const PAINTER = fnBody(CHAT, "createStreamPainter");
const MS = Number((CHAT.match(/const STREAM_PAINT_MS\s*=\s*(\d+)/) || [])[1]);
ok("合帧窗口存在且不超过 120ms", Number.isFinite(MS) && MS > 0 && MS <= 120, `STREAM_PAINT_MS=${MS}`);
ok("调度器有 kick/flush 两个口", has("kick() {") && has("flush() {"));
ok("flush 会撤掉在途定时器（否则摘掉的光标会被延时画回来）", PAINTER.includes("clearTimeout(timer)"));
ok("flush 只在有在途内容时补画", /if \(pending\) run\(\)/.test(PAINTER));

const HANDLES = [...CHAT.matchAll(/appendStreamChunk\(chunk, \{/g)];
ok("流式处理块有 4 处（首轮/工具后续轮/自动续写/重新生成）", HANDLES.length === 4, `实测 ${HANDLES.length} 处`);

HANDLES.forEach((m, i) => {
  const body = blockAt(CHAT, m.index);
  const tag = `流式块#${i + 1}`;
  ok(`${tag} 不逐块重排整条气泡`, !body.includes("renderAssistantContent("));
  ok(`${tag} 不逐块写思考面板`, !body.includes("updateThinkingPanel("));
  ok(`${tag} 不在块里滚屏幕`, !/autoScroll(In)?\(/.test(body));
  ok(`${tag} 走合帧调度`, body.includes(".kick()"));
});

// 每条流式路径：flush 必须排在摘光标之前
for (const [name, needle] of [
  ["首轮", "paintText.flush()"],
  ["工具后续轮", "paintFollow.flush()"],
  ["自动续写", "paintCont.flush()"],
  ["重新生成", "paintRegen.flush()"],
]) {
  const at = CHAT.indexOf(needle);
  const after = CHAT.indexOf("removeStreamingCursor(", at);
  ok(`${name}：收尾先 flush 再摘光标`, at >= 0 && after > at, `flush@${at} removeCursor@${after}`);
}
ok("四条路径的思考面板各自也有收尾 flush",
  has("paintReason.flush()") && has("paintFollowReason.flush()") && has("paintRegenReason.flush()"));
ok("流结束后仍有一次不带光标的整块收尾渲染",
  has("renderAssistantContent(contentEl, fullContent);") && has("renderAssistantContent(followContent, followContent2);"));

// ── ② 线程增量重绘 ────────────────────────────
const INTO = fnBody(CHAT, "renderThreadInto");
ok("重绘台账是 per-落点的 WeakMap", has("const threadViews = new WeakMap("));
ok("renderThreadInto 读台账做逐位比对", INTO.includes("threadViews.get(host)") && /items\[k\]\.sig === renderSignature\(/.test(INTO));
ok("留用原节点还要求是同一只消息对象（换场读回来的那份是另一只对象）",
  /items\[k\]\.msg === visible\[k\]\.msg/.test(INTO));
ok("只有签名变了的那一条被摘掉重画", INTO.includes(".el.remove()") && INTO.includes("host.appendChild(el)"));
// 清空只许出现在两个分支里：无可见消息（画欢迎页）与整棵重建；无条件清空＝回到今天的 O(N) 老路
const WIPES = [...INTO.matchAll(/host\.innerHTML = "";/g)];
const guardedWipes = WIPES.length === 2 && WIPES.every(w => /if \([^\n]*\)\s*\{[\s\S]{0,160}$/.test(INTO.slice(0, w.index)));
ok("清空只发生在分支里（无条件清空的老路已封死）", guardedWipes, `实测 ${WIPES.length} 次，全在分支里=${guardedWipes}`);
ok("整棵重建仍然是可达的退路（force / 画过欢迎页 / 台账为空）",
  INTO.includes("options.force ? null") && INTO.includes("view.blank"));
ok("消息数组→DOM 的整表 forEach 回到零", !/list\.forEach\(\(msg, i\)/.test(CHAT));
ok("隐藏回灌消息仍在落点里过滤", INTO.includes("isHiddenContextMessage(list[i])"));
ok("data-index 用的是全数组下标（编辑/删除按钮靠它定位）", INTO.includes("renderMessage(msg, visible[i].index)"));
ok("renderAllMessages 把 options 透下去", /function renderAllMessages\(options = \{\}\) \{\s*\n\s*renderThreadInto\(chatScroll, state\.messages, options\);/.test(CHAT));

const SIG = fnBody(CHAT, "renderSignature");
// 判据只认「真正拼进签名的那一段」：msg.toolResults 这类名字在上面的取值行也出现，
// 拿整个函数体当样本会被借走，删掉签名里的一项照样绿（变异实测过一次）。
const SIG_LIST = SIG.slice(SIG.indexOf("return ["), SIG.indexOf("].join"));
ok("签名靠 return [...] .join 组装", SIG.length > 0 && SIG_LIST.length > 20 && SIG.includes("].join"));
for (const [field, needle] of [
  ["role", "msg.role"], ["model", "msg.model"], ["隐藏态", "isHiddenContextMessage(msg)"],
  ["正文长度", "msg.content"], ["原文长度", "msg.display"], ["工具计数", "results"],
  ["调用计数", "calls"], ["附件计数", "msg.files"], ["本轮总结", "msg.roundSummary"], ["提前收流", "msg.truncated"],
]) ok(`签名覆盖 ${field}`, SIG_LIST.includes(needle));
ok("工具/调用计数确实参与了取值（不只是出现在签名串里）",
  SIG.includes("msg.toolResults") && SIG.includes("msg.toolCalls") && SIG.includes("metadata?.toolResults"));
// id 只决定"编辑/删除按钮有没有"，那件事由 syncMsgActionButtons 就地补；写进签名等于
// 每条气泡在 id 落地后白白重画一次（思考面板与卡片展开态跟着丢）。
ok("签名不含 id（id 落地不许触发重画）", !/msg\.id/.test(SIG));
ok("按钮补建那条路还在（id 到位后靠它，不靠重画）",
  has("function syncMsgActionButtons(") && CHAT.includes("if (!el || el.querySelector(\".msg-action-edit\")) return;"));
ok("签名每一项都是 O(1) 读（不许把正文塞进签名串）", !/JSON\.stringify/.test(SIG) && !/\.slice\(/.test(SIG));

ok("空线程留下 blank 台账（下次整棵重画）", INTO.includes("threadViews.set(host, blankView())"));
const STASH = fnBody(CHAT, "stashRunThread");
const ADOPT = fnBody(CHAT, "adoptRunThread");
ok("搬去游离树时台账跟着走", (STASH.match(/threadViews\.set/g) || []).length === 2);
ok("搬回屏幕时台账跟着回", (ADOPT.match(/threadViews\.set/g) || []).length === 2);
ok("墨痕样式那处点名整棵重绘", has("renderAllMessages({ force: true })"));

// ── 结果 ──────────────────────────────────────
const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_render_perf: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
