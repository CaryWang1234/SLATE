/**
 * 标签式开标记兜底守卫：scripts/check_tool_tag_fallback.mjs
 *
 * SLATE 的文本协议要求开标记是 ◈◈◈tool_name，但模型会按 HTML/XML 书写习惯改写成
 * <tool_name>，收尾常常仍是 ◈◆◆（有时是 </tool_name>）。改写后 ◈◈◈ 正则匹配不上，
 * 那一轮既没有原生 tool_calls 也没有文本协议调用，agent 循环被判成"纯文本回复"而静默停止，
 * 标记还原样留在气泡里。tools.js 把这种块认回可执行调用，并在正文清洗里摘掉。
 * 盯的契约：①只有名字命中工具白名单（含别名）的标签才算调用——<div>/<Button> 等正文标签
 * 必须原样保留；②JSON 体形态要合法，只有真没写完的尾块才标 _truncated（残缺 file_edit 不许执行、
 * 完整调用不得误标）；③◈◈◈ 原路径不得回归，两种格式混排按出现顺序、同一段不重复计数。
 * 直接 import 真实现（不复制代码），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import {
  TOOLS, detectToolCalls, detectAllCalls, hasToolMarkup, hasTruncatedTail, stripToolCalls,
} from "../frontend/js/services/tools.js?v=20260925-004";
import { isTruncatedUnexecutable } from "../frontend/js/services/agent_common.js?v=20260925-004";

// ── 1. 用户实测原样：<skill_run> 开标记 + ◈◆◆ 收尾 ──
const reported = `\`verify-pack\` 输出必须落盘分列才可靠，直接用 PowerShell 对象化处理。

<skill_run>
{"skill":"terminal","params":{"command":"$rows | Measure-Object Size -Sum"}}
◈◆◆`;
const one = detectToolCalls(reported);
assert.equal(one.length, 1, "应还原出 1 个调用");
assert.equal(one[0].name, "skill_run");
assert.deepEqual(one[0].params, { skill: "terminal", params: { command: "$rows | Measure-Object Size -Sum" } });
assert.equal(hasToolMarkup(reported), true);
assert.deepEqual(detectAllCalls(reported), one);
assert.equal(stripToolCalls(reported), "`verify-pack` 输出必须落盘分列才可靠，直接用 PowerShell 对象化处理。");

// ── 2. 自闭合写法 </tool_name> 也要认 ──
const selfClosed = "好。\n<todo_manage>\n{\"action\":\"list\"}\n</todo_manage>\n然后继续";
const two = detectToolCalls(selfClosed);
assert.equal(two.length, 1);
assert.equal(two[0].name, "todo_manage");
assert.equal(two[0].params.action, "list");
assert.equal(stripToolCalls(selfClosed), "好。\n然后继续");

// ── 3. 别名与代码围栏包裹 ──
assert.equal(detectToolCalls("<run_skill>\n{\"skill\":\"pdf_tool\",\"params\":{}}\n◈◆◆")[0].name, "skill_run",
  "别名 <run_skill> 要归一到 skill_run");
const fenced = "<project_files>\n```json\n{\"path\": \"src\"}\n```\n◈◆◆";
assert.equal(detectToolCalls(fenced)[0].params.path, "src", "围栏包裹的 JSON 体仍要解析");

// ── 4. 原样文件工具：首行路径 + 正文直写 ──
const rawFile = "建一个文件。\n<file_create>\nsrc/util/tag.js\nexport const tag = 1;\n</file_create>";
const raw = detectToolCalls(rawFile);
assert.equal(raw.length, 1);
assert.equal(raw[0].name, "file_create");
assert.equal(raw[0].params.file_path, "src/util/tag.js");
assert.equal(raw[0].params.content, "export const tag = 1;");

// ── 5. 截断尾块：可以抢救，但残缺 file_edit 绝不执行 ──
const truncated = "我看一下。\n<file_edit>\n{\"file_path\":\"backend/routers/proxy.py\",\"start_line\":770";
const tail = detectToolCalls(truncated);
assert.equal(tail.length, 1, "半截标签块也要算这一轮的调用意图");
assert.equal(tail[0].params.file_path, "backend/routers/proxy.py", "salvage 至少要救回已输出的必填项");
assert.equal(tail[0].params._truncated, true);
assert.equal(hasTruncatedTail(truncated), true);
assert.equal(isTruncatedUnexecutable(tail[0]), true, "残缺 file_edit 参数必须被截断守卫拦下");
assert.equal(stripToolCalls(truncated), "我看一下。", "残缺 JSON 不能留在正文里");

// ── 6. 不误伤正文标签 ──
const notCalls = [
  "```html\n<div>\n{\"a\":1}\n</div>\n```",
  "```tsx\n<Button>\n{\"label\":\"x\"}\n</Button>\n```",
  "<template>\n{\"a\":1}\n◈◆◆",
  "配置项 <stdio></stdio> 与 <param name=\"x\">y</param> 保持原样",
  "<skill_run>\n这是说明文字，不是 JSON\n</skill_run>",
  "<file_create>\n\n</file_create>",
];
for (const text of notCalls) {
  assert.deepEqual(detectToolCalls(text), [], `不该识别成调用：${text.slice(0, 24)}`);
  assert.equal(hasToolMarkup(text), false, `不该算工具轮：${text.slice(0, 24)}`);
  assert.equal(stripToolCalls(text), text.trim(), `正文必须逐字保留：${text.slice(0, 24)}`);
}

// ── 7. ◈◈◈ 原路径不回归，混排按顺序且同段不重复计数 ──
const own = "◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆";
assert.equal(detectToolCalls(own).length, 1);
const mixed = `先看目录。\n${own}\n<user_ask>\n{"question":"选哪个","options":["a","b"]}\n</user_ask>\n`;
const both = detectToolCalls(mixed);
assert.equal(both.length, 2);
assert.deepEqual(both.map((c) => c.name), ["project_files", "user_ask"], "按出现顺序返回");
assert.equal(stripToolCalls(mixed), "先看目录。");
const quoted = "示例给你看：\n◈◈◈skill_run\n{\"note\":\"内部写了 <file_edit> 也不算调用\"}\n◈◆◆";
assert.deepEqual(detectToolCalls(quoted).map((c) => c.name), ["skill_run"], "◈◈◈ 块内的标签不能重复计数");

// ── 8. 截断标记只给"真没写完"的块：完整调用被误标会白跑一轮 ──
const tagNoClose = "查一下。\n<file_edit>\n{\"action\":\"view\",\"file_path\":\"backend/routers/proxy.py\"}";
const completeTag = detectToolCalls(tagNoClose);
assert.equal(completeTag.length, 1);
assert.equal(completeTag[0].params.file_path, "backend/routers/proxy.py");
assert.equal(completeTag[0].params._truncated, undefined, "JSON 已写完就不算截断");
assert.equal(hasTruncatedTail(tagNoClose), false);
assert.equal(isTruncatedUnexecutable(completeTag[0]), false, "完整调用不该被截断守卫拦下");

const reversed = "看下待办。\n◈◈◈todo_manage\n{\"action\":\"list\"}\n</todo_manage>";
const reverseCall = detectToolCalls(reversed);
assert.deepEqual(reverseCall.map((c) => c.name), ["todo_manage"], "◈◈◈ 开 + </name> 收也要认成调用");
assert.equal(reverseCall[0].params.action, "list");
assert.equal(reverseCall[0].params._truncated, undefined, "反向混排不该误标截断");
assert.equal(hasTruncatedTail(reversed), false);
assert.equal(stripToolCalls(reversed), "看下待办。");

const cutOwn = "◈◈◈file_edit\n{\"file_path\":\"a.py\",\"start_line\":1";
assert.equal(detectToolCalls(cutOwn)[0].params._truncated, true, "◈◈◈ 半截 JSON 仍要标截断");
const cutRaw = "◈◈◈file_create\nsrc/a.txt\n写了一半";
assert.equal(detectToolCalls(cutRaw)[0].params._truncated, true, "原样围栏正文无从判断终点，一律按截断");

// ── 9. 还原出来的调用必须能过执行前校验（validateToolCall 未导出，此处复刻它的必填判据）──
function assertExecutable(call) {
  const spec = TOOLS[call.name];
  assert.ok(spec, `工具 ${call.name} 必须已注册`);
  for (const [key, s] of Object.entries(spec.params || {})) {
    if (!s.required) continue;
    const v = call.params?.[key];
    assert.ok(v !== undefined && v !== null, `${call.name} 缺必填 ${key}，执行前会被 validateToolCall 拦下`);
  }
}
assertExecutable(one[0]);
assertExecutable(two[0]);
assertExecutable(raw[0]);

console.log("标签式开标记兜底解析与正文清洗：通过");
