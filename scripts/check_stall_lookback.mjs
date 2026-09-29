/**
 * 续问回退不再自递归爆栈：scripts/check_stall_lookback.mjs
 *
 * 真实事故（现场在装机包的 data/js_errors.log）：连着发「继续」时发送链路抛
 *   RangeError: Maximum call stack size exceeded
 *     at userWantsEnvironmentAction (chat.js:1934)   ← String.replace 那层
 *     at userWantsEnvironmentAction (chat.js:1938)   ← 同一行反复，直到栈满
 * 成因：「继续」本身没有信息量，判环境任务时要往前借任务原文；而那次借写死了
 * "从末尾数第二条"，与递归层级无关——连续两条「继续」时每层借到的都是同一条，
 * 于是自己调自己。用户侧只看到一句「发送失败: Maximum call stack size exceeded」。
 *
 * 这层钉的是"层级必须一路带下去"这条契约，最容易坏在四处：
 *   ① 递归调用忘了传实参（回到零参 = 回到同一个 bug）；
 *   ② 查找函数收了形参却仍写死 skip-one（参数成了摆设）；
 *   ③ 用"数到第 N 层就放弃"糊过去（续问一多就悄悄不再借原文，Autopilot 该开没开）；
 *   ④ 借原文时把系统自己开口的隐藏消息也算成用户的话（借到 nudge/工具回灌文本上）。
 * 行为侧的验收在 .qoder/walk_stall_recursion.py（含深链与"头部闲聊不许误判"对照组）。
 *
 * 运行：node scripts/check_stall_lookback.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CHAT = readFileSync(`${ROOT}frontend/js/components/chat.js`, "utf8");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

/** 取某个函数名往后的函数体（本文件里的函数体都是顶格 `}` 收尾） */
function fnBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

const GUARD = fnBody(CHAT, "userWantsEnvironmentAction");
const LOOKUP = fnBody(CHAT, "getPreviousVisibleUserContent");

ok("两个函数都找得到", GUARD.length > 0 && LOOKUP.length > 0);

// ── ① 层级一路带下去 ────────────────────────
ok("判定函数收层级形参（默认从上一条借起）",
  /function\s+userWantsEnvironmentAction\s*\(\s*content\s*,\s*lookBack\s*=\s*1\s*\)/.test(GUARD),
  GUARD.split("\n")[0]);
const GUARD_BODY = GUARD.replace(/^function[\s\S]*?\{\n/, "");
const RECURSE = (GUARD_BODY.match(/userWantsEnvironmentAction\(/g) || []).length;
ok("函数体内有且只有一处自递归", RECURSE === 1, `实测 ${RECURSE} 处`);
ok("递归把加深后的层级传下去（不传实参就是原 bug）",
  /userWantsEnvironmentAction\(\s*previousUser\s*,\s*lookBack\s*\+\s*1\s*\)/.test(GUARD),
  (GUARD.match(/.*userWantsEnvironmentAction\(previousUser.*/) || [""])[0].trim());
ok("借原文只发生在续问分支里",
  /if\s*\(isContinuationRequest\(text\)\)\s*\{[\s\S]{0,200}getPreviousVisibleUserContent\(/.test(GUARD));

// ── ② 查找函数真的按层级数 ──────────────────
ok("查找函数收层级形参",
  /function\s+getPreviousVisibleUserContent\s*\(\s*lookBack\s*=\s*1\s*\)/.test(LOOKUP),
  LOOKUP.split("\n")[0]);
ok("比较的是传进来的层级（不是摆设）", />\s*lookBack\b/.test(LOOKUP));
ok("旧的「只跳过最后一条」写法没有回来", !/seenLast/.test(LOOKUP));
ok("从数组尾部往前数", /for\s*\(let i = state\.messages\.length - 1; i >= 0; i--\)/.test(LOOKUP));
ok("只数用户消息", /role\s*!==\s*"user"/.test(LOOKUP));
ok("隐藏的系统自述消息不算用户的话", /isHiddenContextMessage\(msg\)/.test(LOOKUP));
ok("数到头返回空串，作为递归的自然收口", /return\s*""\s*;\n\}\s*$/.test(LOOKUP));

// ── ③ 不许用"浅尝辄止"糊过去 ────────────────
ok("没有写死的层数上限（深链要一路借到头）",
  !/lookBack\s*[<>]=?\s*\d/.test(GUARD) && !/depth\s*[<>]=?\s*\d/.test(GUARD),
  (GUARD.match(/.*lookBack\s*[<>]=?\s*\d.*/) || [""])[0].trim());

// ── ④ 调用点：外部一律从"上一条"借起 ─────────
const DEF_START = CHAT.indexOf("function userWantsEnvironmentAction");
const DEF_END = CHAT.indexOf("\n}", DEF_START) + 2;
const CALLS_OUT = [CHAT.slice(0, DEF_START), CHAT.slice(DEF_END)]
  .flatMap(s => s.match(/userWantsEnvironmentAction\([^)]*\)/g) || []);
ok("除定义与递归外还有 5 处调用（少一处说明某条链路被摘了）",
  CALLS_OUT.length === 5, `实测 ${CALLS_OUT.length} 处`);
ok("外部调用一律单参（默认从上一条借起）",
  CALLS_OUT.every(c => !c.includes(",")), JSON.stringify(CALLS_OUT.slice(0, 3)));
const LOOKUP_CALLS = (CHAT.match(/getPreviousVisibleUserContent\(/g) || []).length;
ok("查找函数只有一个调用点（别处零参调用会把旧语义请回来）",
  LOOKUP_CALLS === 2, `实测 ${LOOKUP_CALLS} 处（含定义）`);
ok("那唯一一处调用带上了层级实参",
  /getPreviousVisibleUserContent\(\s*lookBack\s*\)/.test(GUARD));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) console.log(`${p ? "ok  " : "FAIL"} ${name}${p || !detail ? "" : ` :: ${detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败：" + failed.map(([, n]) => n).join(" | "));
}
assert.equal(failed.length, 0, `${failed.length} 项不通过`);
