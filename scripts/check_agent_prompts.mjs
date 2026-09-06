// 模型可见字符串基线守卫：钉住桌面与移动两条路径发给模型的字符串。
// agent_common.js 的措辞或默认参数一旦偏离基线即失败；有意改动时同步更新本文件基线。
// 去重催办串位于 DOM 模块内（Node 侧不可 import），改以源码级逐字 pin。
// 运行：node scripts/check_agent_prompts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as common from "../frontend/js/services/agent_common.js";

const NEXT_OK = "Next: use this result to continue the task. Do not repeat the same tool call unless new parameters are needed.";
const NEXT_FAIL = "Next: fix the parameters or choose a different tool. Do not repeat the identical failing call.";
const DESKTOP_WRITTEN = "Status: written to disk (auto-confirmed by user setting; no manual acceptance needed; verify via project_read_file if necessary).";
const DESKTOP_PREVIEW = "Status: preview only; not written to disk until the user accepts.";
const MOBILE_WRITTEN = "Status: written to disk.";
const MOBILE_PREVIEW = "Status: preview shown to user; not written to disk until accepted.";

/** 拼出预期的工具结果回灌串：只有「已落盘/待确认」两句按平台传入，其余三端共用 */
function pinFormat(call, result, written, preview, isWritten) {
  const ok = result?.success !== false;
  const nextHint = ok ? NEXT_OK : NEXT_FAIL;
  const structured = result?._structured;
  if (structured && ["file_edit", "file_create", "file_append"].includes(structured._type)) {
    const path = structured.file_path_rel || structured.file_name || structured.file || call?.params?.file_path || "";
    const errors = structured.errors?.length ? `\nWarnings: ${structured.errors.join("; ")}` : "";
    const truncNote = structured._type === "file_append" && structured.truncated
      ? "\nNote: this append was itself truncated; continue with another file_append from the new breakpoint."
      : "";
    return `[工具 ${structured._type} 结果]: ${result.output}\nTarget path: ${path}\n${isWritten(structured.applied) ? written : preview}${errors}${truncNote}\n${nextHint}`;
  }
  return `[工具 ${call.name} ${ok ? "成功" : "失败"}]: ${result.output}\n${nextHint}`;
}

const DESKTOP_HARNESS = `
[Agent Loop 指令]
当前工具轮次：4/20。
- 先吸收工具结果，再决定下一步；不要复述工具原文。
- 若目标仍未完成，继续调用最小必要工具推进。
- 若刚完成文件修改/生成，优先验证：读取文件、运行检查/测试/构建或说明无法验证原因。
- 若已完成并验证，输出简短最终汇报，不再调用工具。
- 目标模式下：如有 TODOLIST，完成一批就 todo_manage(action=update)，全部 done/blocked 后再收尾。
- 有 2 个工具失败：请换参数、换工具或先读取更多上下文，不要重复完全相同的失败调用。`;

const DESKTOP_AUTOPILOT = `
[Agent Loop 指令]
当前工具轮次：8/8。
- 先吸收工具结果，再决定下一步；不要复述工具原文。
- 若目标仍未完成，继续调用最小必要工具推进。
- 若刚完成文件修改/生成，优先验证：读取文件、运行检查/测试/构建或说明无法验证原因。
- 若已完成并验证，输出简短最终汇报，不再调用工具。
- Autopilot 模式下：不要等用户说“继续”；任务未完成就继续观察、修改或验证。`;

const MOBILE_FAILED = `
\n[Agent Loop 指令]
当前工具轮次：1/8。
- 先吸收工具结果，再决定下一步；不要复述工具原文。
- 若目标仍未完成，继续调用最小必要工具推进。
- 若刚完成文件修改/生成，优先验证：读取文件、运行检查/测试/构建或说明无法验证原因。
- 若已完成并验证，输出简短最终汇报，不再调用工具。
- 本轮有 1 个工具失败：换参数、换工具或先读取更多上下文，不要重复完全相同的失败调用。`;

const ok = { success: true, output: "done ok" };
const bad = { success: false, output: "boom" };

// 去重：同名同参只留一次，顺序保持
const calls = [
  { name: "file_edit", params: { a: 1 } },
  { name: "file_edit", params: { a: 1 } },
  { name: "terminal", params: { command: "ls" } },
];
assert.deepEqual(common.dedupeToolCalls(calls), [calls[0], calls[2]]);
assert.deepEqual(common.dedupeToolCalls(undefined), []);
assert.deepEqual(common.dedupeToolCalls([]), []);
assert.equal(common.toolCallSignature(calls[0]), 'file_edit:{"a":1}');

// 工具结果回灌：桌面走默认常量，移动显式传自己的常量
const cases = [
  [{ name: "file_edit", params: {} }, { ...ok, _structured: { _type: "file_edit", applied: "auto", file_path_rel: "a/b.css" } }],
  [{ name: "file_create", params: {} }, { ...ok, _structured: { _type: "file_create", applied: true, file_name: "c.md", errors: ["w1", "w2"] } }],
  [{ name: "file_append", params: { file_path: "d.txt" } }, { ...ok, _structured: { _type: "file_append", applied: false, truncated: true } }],
  [{ name: "file_append", params: {} }, { success: false, output: "x", _structured: { _type: "file_append", applied: "manual" } }],
  [{ name: "terminal", params: {} }, bad],
  [{ name: "code_search", params: {} }, ok],
];
for (const [c, r] of cases) {
  assert.equal(
    common.formatToolResultForModel(c, r),
    pinFormat(c, r, DESKTOP_WRITTEN, DESKTOP_PREVIEW, (a) => a === "auto"),
    `desktop format ${c.name}`,
  );
  assert.equal(
    common.formatToolResultForModel(c, r, common.MOBILE_TOOL_RESULT_STATUS),
    pinFormat(c, r, MOBILE_WRITTEN, MOBILE_PREVIEW, (a) => a === "auto" || a === true),
    `mobile format ${c.name}`,
  );
}

// applied:true 是平台分歧的判据：桌面视为「未落盘」，移动视为「已落盘」
assert.ok(common.formatToolResultForModel(cases[1][0], cases[1][1]).includes(DESKTOP_PREVIEW));
assert.ok(common.formatToolResultForModel(cases[1][0], cases[1][1], common.MOBILE_TOOL_RESULT_STATUS).includes(MOBILE_WRITTEN));

// 轮次催办指令
assert.equal(
  common.buildToolFollowupInstruction({ harnessOn: true, autopilotOn: false, round: 3, maxRounds: 20, results: [bad, ok, bad] }),
  DESKTOP_HARNESS,
);
assert.equal(
  common.buildToolFollowupInstruction({ harnessOn: false, autopilotOn: true, round: 7, maxRounds: 8, results: [] }),
  DESKTOP_AUTOPILOT,
);
assert.equal(
  common.buildToolFollowupInstruction({ round: 0, maxRounds: 8, results: [bad], failedLine: common.MOBILE_FAILED_LINE, prefix: "\n" }),
  MOBILE_FAILED,
);

// 截断守卫：file_create/file_append 的残缺前缀仍可执行，其余拒绝
assert.equal(common.isTruncatedUnexecutable({ name: "file_edit", params: { _truncated: true } }), true);
assert.equal(common.isTruncatedUnexecutable({ name: "file_append", params: { _truncated: true } }), false);
assert.equal(common.isTruncatedUnexecutable({ name: "file_create", params: { _truncated: true } }), false);
assert.equal(common.isTruncatedUnexecutable({ name: "terminal", params: {} }), false);
assert.equal(common.isTruncatedUnexecutable({ name: "terminal" }), false);

// 去重催办串：P0 后分别位于 desktopPolicy / mobilePolicy，只能按源码文本钉住
const DEDUP_PIN = /content: (`\[系统\][^\n]*`),\n\s*model: "\[dedup\]"/;
const DESKTOP_DEDUP_TPL =
  '`[系统] ${round + 1}/${maxRounds} 轮：你本轮发出的工具调用与上一轮完全相同，已拦截未重复执行。${dupRounds >= 2 ? "已连续多轮相同调用，必须换思路。" : ""}若上轮结果不符合预期，请换思路（拆分任务、改用其他工具、或先用 project_read_file 查看现状）；若任务已推进，直接继续剩余工作或输出结论。`';
const MOBILE_DEDUP_TPL =
  '`[系统] ${round + 1}/${maxRounds} 轮：你本轮发出的工具调用与上一轮完全相同，已拦截未重复执行。${dupRounds >= 2 ? "已连续多轮相同调用，必须换思路。" : ""}若上轮结果不符合预期，请换思路（拆分任务、改用其他工具、或先读取文件查看现状）；若任务已推进，直接继续剩余工作或输出结论。`';
for (const [file, pin] of [
  ["../frontend/js/components/chat.js", DESKTOP_DEDUP_TPL],
  ["../frontend/js/mobile/m-chat.js", MOBILE_DEDUP_TPL],
]) {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const found = src.match(DEDUP_PIN);
  assert.ok(found, `未找到 dedup 催办串: ${file}`);
  assert.equal(found[1], pin, `dedup 催办串偏离基线: ${file}`);
}

console.log("agent_common.js 输出与基线逐字全等：通过");
