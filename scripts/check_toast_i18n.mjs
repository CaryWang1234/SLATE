#!/usr/bin/env node
// 守卫：面向用户的提示语不许把中文写死在调用点
//
// 为什么单独一条：check_i18n_coverage 查的是"词典里的键有没有译文、t() 用掉的键在不在词典"，
// 它看不见 `toast("设置已保存")` 这种**根本没进词典**的裸字面量——中文界面一切正常，
// 切到英文界面就露出中文。这一族以前攒了几十处，所以这里钉住形态而不是钉住清单：
// toast()/notify() 里每个含中文的字符串字面量，都必须紧跟在 t( 之后。
// 三元、|| 兜底、第二个实参（通知正文）同样算，因为它们在英文界面里一样会露出来。
//
// 跑法：node scripts/check_toast_i18n.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = "frontend/js";
const DICT = "frontend/js/services/i18n_dict.js";

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js") && p !== DICT) files.push(p);
  }
})(ROOT);

const isHan = (s) => [...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x4e00 && c <= 0x9fff;
});

/** 从 open（指向 '(' 的下标）扫到配平的 ')'，返回括号内文本；字符串里的括号不算。 */
function sliceArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

/** 一段表达式里所有字符串字面量（含模板串），连同它前面 3 个字符一起给出。 */
function* literals(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    let j = i + 1;
    while (j < text.length && text[j] !== ch) {
      if (text[j] === "\\") j += 1;
      j += 1;
    }
    yield { body: text.slice(i + 1, j), before: text.slice(Math.max(0, i - 3), i) };
    i = j;
  }
}

const bad = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // 这个文件里 t() 叫什么：`import { t }` 或 `import { t as tr }`（schedule.js 因局部变量
  // 也叫 t 而改了名），只认从 i18n.js 引进来的那几个名字，别的 foo( 不算放行。
  const names = new Set(["t"]);
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*i18n\.js[^"]*"/g)) {
    const picked = new Set();
    for (const part of im[1].split(",")) {
      const m = /^\s*t(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (m) picked.add(m[1] || "t");
    }
    if (picked.size) names.clear();
    for (const n of picked) names.add(n);
  }
  const translated = new RegExp(`(^|[^\\w$])(?:${[...names].join("|")})\\($`);
  const re = /\b(toast|notify)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const args = sliceArgs(src, open);
    for (const lit of literals(args)) {
      if (!isHan(lit.body)) continue;
      // 已走词典的写法：字面量紧跟 t(（或这个文件里 t 的别名）
      if (translated.test(lit.before)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      bad.push(`${f}:${line}  ${m[1]}(…${lit.before}"${lit.body.slice(0, 32)}…`);
    }
  }
}

assert.ok(files.length >= 60, `只扫到 ${files.length} 个 JS 文件，像是目录没走对`);
assert.deepStrictEqual(bad, [], `这些提示语没走词典，英文界面会露出中文：\n  ${bad.join("\n  ")}`);

console.log(`check_toast_i18n: 通过（${files.length} 个 JS 文件 · toast/notify 里的中文全部经 t()）`);
