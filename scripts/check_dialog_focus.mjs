#!/usr/bin/env node
// 守卫：应用内弹窗关掉之后必须把焦点还给"打开它的那个控件"
//
// 为什么单独一条：dialog.js 里六扇窗（提示/确认/输入/选择题/审阅）共用 buildShell，收口却是
// 各写各的 finish()。少一句还原，Esc 关完焦点就掉回 body——接着敲的字符既不进输入框也不进
// 聊天框，用户只觉得"它吞了我一句话"，而界面上一切正常、静态上看不出任何异常。
// 所以这里钉的是"每一扇都还原"，不是"有一扇还原了"；顺带钉住两处的先后顺序，
// 因为取打开者的时机、还原焦点的时机，写反了都不报错，只是静默失效。
//
// 跑法：node scripts/check_dialog_focus.mjs
import fs from "node:fs";
import assert from "node:assert";

const SRC = fs.readFileSync("frontend/js/services/dialog.js", "utf8");

// ── 1. 打开者必须在模态挂上页面之前记下 ──────────────────
const shellStart = SRC.indexOf("function buildShell(");
assert.ok(shellStart >= 0, "dialog.js 里找不到 buildShell：六扇窗共用它，改名等于全拆");
const shell = SRC.slice(shellStart, SRC.indexOf("\n}", shellStart));
const appendAt = shell.indexOf("document.body.appendChild(root)");
const captureAt = shell.indexOf("const opener = document.activeElement");
assert.ok(appendAt >= 0, "buildShell 没把模态挂上页面？这一条的前半段失去意义");
assert.ok(captureAt >= 0, "buildShell 没记打开者：关窗时无处可还，焦点会掉回 body");
assert.ok(captureAt < appendAt,
  "打开者是在模态挂上之后才取的：那会儿 activeElement 已经是弹窗里的控件，还回去等于还给自己");
assert.match(shell, /return \{[^}]*\bopener\b/, "buildShell 没把打开者交出去，调用方拿不到");

// ── 2. 每一扇窗的收口都要还原，且排在摘掉节点之后 ────────
const shells = (SRC.match(/= buildShell\(/g) || []).length;
assert.ok(shells >= 3, `只读到 ${shells} 处 buildShell 调用，像是文件被截断（应有提示/确认/选择题/审阅）`);
const restores = [...SRC.matchAll(/restoreFocus\(opener\);/g)];
assert.strictEqual(restores.length, shells,
  `${shells} 扇窗只有 ${restores.length} 处还原焦点：漏掉的那扇关完焦点掉回 body，敲进去的字没人收`);
for (const m of restores) {
  const head = SRC.slice(Math.max(0, m.index - 90), m.index);
  assert.match(head, /root\.remove\(\);[^\n]*\n\s*$/,
    "还原焦点排在 root.remove() 之前：弹窗还挂在页面上，抢不过它，等于没还");
}

// ── 3. 还原要防着那个控件已经被重画掉了 ──────────────────
assert.match(SRC, /function restoreFocus\(opener\) \{[\s\S]{0,220}document\.contains\(opener\)/,
  "restoreFocus 没查节点还在不在：列表重画后拿着的是死节点，focus() 静默失败，判据也就读不到还原");

console.log(`check_dialog_focus: 通过（${shells} 扇弹窗的收口都还原焦点 · 取用顺序钉死）`);
