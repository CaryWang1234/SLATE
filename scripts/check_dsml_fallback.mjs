/**
 * DSML 兜底守卫：scripts/check_dsml_fallback.mjs
 *
 * DeepSeek 系模型（V4 / V4.1-Flash 一类）有时把内部工具调用标记当正文吐进 delta.content，
 * 于是 SLATE 既收不到 tool_calls，也认不出 ◈◈ 文本协议，那一轮就被判成"纯文本回复"而停住。
 * tools.js 的 detectDsmlCalls / hasDsmlMarkup / stripToolCalls 负责把这种回复还原成可执行调用，
 * 并把标记从正文里摘干净。这个脚本盯的是解析契约：竖线码位会变（全角｜、双竖线‖…）、
 * string="false" 的参数要还原成数字/数组、半截 invoke 绝不能执行、正文不能残留标记。
 * 直接 import 真实现（不复制代码），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import {
  detectDsmlCalls, hasDsmlMarkup, detectAllCalls, hasToolMarkup, stripToolCalls, detectToolCalls,
} from "../frontend/js/services/tools.js?v=20260911-001";

const A = "｜";   // U+FF5C 全角竖线：官方 tokenizer 与用户实测粘贴的形态
const B = "‖";   // U+2016 双竖线：部分端点与复制链路的形态
const T = (s) => `<${s}${s}DSML${s}${s}`;

// ── 1. 用户报的原样：一个 file_edit(view)，行号是数字不是字符串 ──
const reported = `我来看一下这段代码。
${T(A)}calls>
${T(A)}invoke name="file_edit">
${T(A)}parameter name="action" string="true">view</${A}${A}DSML${A}${A}parameter>
${T(A)}parameter name="file_path" string="true">backend/routers/proxy.py</${A}${A}DSML${A}${A}parameter>
${T(A)}parameter name="start_line" string="false">770</${A}${A}DSML${A}${A}parameter>
${T(A)}parameter name="end_line" string="false">815</${A}${A}DSML${A}${A}parameter>
</${A}${A}DSML${A}${A}invoke>
</${A}${A}DSML${A}${A}calls>
然后不动了`;

const one = detectDsmlCalls(reported);
assert.equal(one.length, 1, "应还原出 1 个调用");
assert.equal(one[0].name, "file_edit");
assert.deepEqual(one[0].params, {
  action: "view", file_path: "backend/routers/proxy.py", start_line: 770, end_line: 815,
});
assert.equal(typeof one[0].params.start_line, "number", 'string="false" 必须还原成数字');
assert.deepEqual(detectAllCalls(reported), one, "detectAllCalls 应包含 DSML 调用");

// ── 2. 换一种竖线、换一种包裹标签，仍要认 ──
const alt = `先读文件。
${T(B)}tool_calls>${T(B)}invoke name="terminal">
${T(B)}parameter name="command" string="true">git status --short</${B}${B}DSML${B}${B}parameter>
</${B}${B}DSML${B}${B}invoke></${B}${B}DSML${B}${B}tool_calls>`;
const two = detectDsmlCalls(alt);
assert.equal(two.length, 1);
assert.equal(two[0].name, "terminal");
assert.equal(two[0].params.command, "git status --short");

// ── 3. 一次多个 invoke + 数组参数 ──
const multi = `${T(A)}tool_calls>
${T(A)}invoke name="project_files">${T(A)}parameter name="paths" string="false">["a.js","b.js"]</${A}${A}DSML${A}${A}parameter></${A}${A}DSML${A}${A}invoke>
${T(A)}invoke name="skill_search">${T(A)}parameter name="query" string="true">pdf 解析</${A}${A}DSML${A}${A}parameter></${A}${A}DSML${A}${A}invoke>
</${A}${A}DSML${A}${A}tool_calls>`;
const three = detectDsmlCalls(multi);
assert.equal(three.length, 2, "两个 invoke 都要还原");
assert.deepEqual(three[0].params.paths, ["a.js", "b.js"]);

// ── 4. 半截 invoke：不执行，只算"有工具意图"，正文里不能残留 ──
const truncated = `好的。${T(A)}tool_calls>${T(A)}invoke name="file_create">
${T(A)}parameter name="file_path" string="true">x.txt</${A}${A}DSML${A}${A}parameter>
${T(A)}parameter name="content" string="true">一半的内容写到这`;
assert.equal(detectDsmlCalls(truncated).length, 0, "未闭合的 invoke 不能执行");
assert.equal(hasDsmlMarkup(truncated), true);
assert.equal(hasToolMarkup(truncated), true, "半截泄漏也算工具调用意图，不能判成只描述计划");
const strippedTail = stripToolCalls(truncated);
assert.ok(!strippedTail.includes("DSML"), "正文不得残留 DSML 标记");
assert.ok(!strippedTail.includes("x.txt"), "残缺参数不得留在正文里");
assert.equal(strippedTail, "好的。");

// ── 5. 正文清洗只留人话 ──
assert.equal(stripToolCalls(reported), "我来看一下这段代码。\n\n然后不动了");
assert.equal(stripToolCalls(alt), "先读文件。");
assert.equal(stripToolCalls(multi), "");

// ── 6. 正常回复与自家 ◈◈ 协议不受影响 ──
assert.equal(hasDsmlMarkup("普通回复，提到 DSML 这个词但没有标记。"), false);
assert.equal(hasDsmlMarkup(""), false);
assert.deepEqual(detectDsmlCalls("普通回复"), []);
assert.equal(stripToolCalls("普通回复\n第二行"), "普通回复\n第二行");
assert.equal(hasToolMarkup("普通回复"), false);
const own = `◈◈◈project_files\n{"path": ""}\n◈◆◆`;
assert.equal(detectToolCalls(own).length, 1, "自家文本协议仍要能识别");
assert.equal(hasToolMarkup(own), true);
assert.ok(!stripToolCalls(`说明\n${own}`).includes("◈"));

console.log("DSML 兜底解析与正文清洗：通过");
