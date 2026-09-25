/**
 * 打字题库守卫：scripts/check_typing_corpus.mjs
 *
 * 打字小游戏只认 ASCII：中文要过输入法，组合期的 input 事件是半截文本，计时和准确率都会被带偏。
 * 内置题库会长年被人往里加行，自定义题库由用户手填，两条线都得有机器判据兜着——
 * 加进 BUILTIN 一行带中文或制表符的文本，游戏会当场把打不出来的字符算成错。
 * 盯的契约：①内置每条都是可打印 ASCII、长度合用、不重复；
 * ②parseCustom 的取舍与提示文案一致（注释/空行忽略且不记跳过，非 ASCII 与长度不合记跳过，重复行只留一条），
 * ③解析出来的每条都能直接当靶子（已 trim，不会再被游戏改一刀）。
 * 直接 import 真实现（不复制代码），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import { BUILTIN, parseCustom } from "../frontend/js/components/typing_game.js?v=20260925-001";

const ASCII_OK = /^[\x20-\x7e]+$/;

// ── 1. 内置题库：条数、可打性、去重 ──
assert.ok(BUILTIN.length >= 50, `内置题库只剩 ${BUILTIN.length} 条，太薄了`);
for (const line of BUILTIN) {
  assert.equal(typeof line, "string");
  assert.ok(ASCII_OK.test(line), `内置条目含非 ASCII 或制表符，打不出来：${line}`);
  assert.ok(line.length >= 6 && line.length <= 220, `内置条目长度不合：${line.length} ${line}`);
  assert.ok(!line.startsWith("#"), `内置条目不该写成注释行：${line}`);
}
assert.equal(new Set(BUILTIN).size, BUILTIN.length, "内置题库有重复行");

// ── 2. 注释与空行：忽略但不算「跳过」，否则提示会误导 ──
const comments = parseCustom("# 我的题库\n\n   \n#another\n");
assert.deepEqual(comments.lines, []);
assert.equal(comments.dropped, 0, "注释和空行是有意为之，不该报成跳过行");

// ── 3. CRLF（记事本默认）与首尾空白 ──
const crlf = parseCustom("git status --short  \r\n  docker ps -a\r\n");
assert.deepEqual(crlf.lines, ["git status --short", "docker ps -a"]);
assert.equal(crlf.dropped, 0);
assert.ok(crlf.lines.every((l) => l === l.trim()), "每条都得是 trim 过的，才能直接当靶子");

// ── 4. 不合用的行：非 ASCII / 制表符 / 过短 / 过长 ──
const junk = parseCustom([
  "中文一行不能出题",
  "tab\tseparated is out",
  "abc",
  "x".repeat(221),
  "echo 'still fine here'",
].join("\n"));
assert.deepEqual(junk.lines, ["echo 'still fine here'"]);
assert.equal(junk.dropped, 4, "四行不合用的都要计进跳过数");

// ── 5. 重复行只留一条，且不算跳过 ──
const dup = parseCustom("git commit -m 'x'\ngit commit -m 'x'\n  git commit -m 'x'  \n");
assert.deepEqual(dup.lines, ["git commit -m 'x'"]);
assert.equal(dup.dropped, 0, "重复是用户想少写，不是写错了");

// ── 6. 空输入与 undefined 不能炸 ──
for (const empty of ["", null, undefined]) {
  const r = parseCustom(empty);
  assert.deepEqual(r.lines, []);
  assert.equal(r.dropped, 0);
}

console.log("打字题库与自定义解析契约：通过");
