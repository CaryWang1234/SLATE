/**
 * i18n 覆盖守卫：英文界面里不该留下中文，词典也不该有互相覆盖的重复键。
 *
 * 词典 EN_DICT 以「中文原文」为键，运行时 i18n.js 遍历 DOM 替换文本节点与
 * title/placeholder/alt/aria-label；没命中就原样留着——于是英文界面冒出一句中文，
 * 而且不报错，只能人肉扫。这里按"运行时真会去翻什么"核对六条：
 *   A. frontend/js/**\/*.js 里 t("中文") 的字面键必须存在于词典；
 *   B. index.html / m.html 里的静态中文（文本节点 + 那四个属性），只要落在运行时会翻
 *      的位置，就必须有键；
 *   C. 词典不许有重复键：JS 对象字面量里后写的静默覆盖先写的，同一句话两套译名，
 *      看到哪套全凭运气；
 *   D. 带 {var} 占位符的键，英文值必须带同一组 {var}——漏了等于英文界面直接
 *      印出 "{n}"，数字丢了比留中文更难发现；
 *   E. 两套跳过口径（内容级 SKIP_SELECTOR / 属性级 SKIP_ATTR_SELECTOR）只从 i18n.js
 *      现读，守卫不另写一份，否则运行时改了这里永远绿；
 *   F. 豁免机制不是纸面机制：页面里得真的有人用它。
 *
 * 纯拉丁的键（t("API Key")）不要求进词典：运行时未命中就原样返回，而它本来就是英文，
 * 翻不翻结果是同一个字符串。
 *
 * 未被引用的死键只报数不判红：t(变量) 拼出来的键静态扫不到，判红会误伤。
 *
 * 运行：node scripts/check_i18n_coverage.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}/${rel}`, "utf8");
const unesc = (s) => JSON.parse(`"${s}"`);

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

const DICT_SRC = read("frontend/js/services/i18n_dict.js");
const I18N_SRC = read("frontend/js/services/i18n.js");
const INDEX_HTML = read("frontend/index.html");

// ── 0. 词典与运行时口径 ─────────────────────────────────

const dictBody = DICT_SRC.slice(DICT_SRC.indexOf("EN_DICT = {"));
const dict = new Map();
const dupKeys = [];
for (const m of dictBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
  const key = unesc(m[1]);
  if (dict.has(key)) dupKeys.push(key);
  dict.set(key, unesc(m[2]));
}
ok(`词典解析出条目（读到 ${dict.size} 条，应上千）`, dict.size > 1000, String(dict.size));
ok(`C 类：词典没有重复键（后写的会静默覆盖先写的，现 ${dupKeys.length} 处）`,
  dupKeys.length === 0, dupKeys.slice(0, 8).join(" | "));

const skipDecl = I18N_SRC.match(/const SKIP_SELECTOR\s*=([\s\S]*?);\n/);
const attrSkipDecl = I18N_SRC.match(/const SKIP_ATTR_SELECTOR\s*=([\s\S]*?);\n/);
const attrsDecl = I18N_SRC.match(/const TRANS_ATTRS\s*=\s*\[([\s\S]*?)\]/);
ok("E 类：i18n.js 里读得到 SKIP_SELECTOR / SKIP_ATTR_SELECTOR / TRANS_ATTRS（守卫与运行时同源）",
  !!skipDecl && !!attrSkipDecl && !!attrsDecl);
if (!skipDecl || !attrSkipDecl || !attrsDecl) {
  for (const [p, name, detail] of results) {
    console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
  }
  assert.ok(false, "读不到运行时的跳过口径，守卫无从核对（词典条目未核对）");
}

const SKIP_SELECTOR = [...skipDecl[1].matchAll(/"([^"]*)"/g)].map(m => m[1]).join(",");
const ATTR_SELECTOR = [...attrSkipDecl[1].matchAll(/"([^"]*)"/g)].map(m => m[1]).join(",");
const TRANS_ATTRS = [...attrsDecl[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
const SKIP_TAGS = new Set((SKIP_SELECTOR.match(/(?:^|,\s)([a-z]+)/g) || [])
  .map(s => s.replace(/[^a-z]/g, "")));
const classesOf = (sel) => new Set((sel.match(/\.[\w-]+/g) || []).map(s => s.slice(1)));
const CONTENT_CLASSES = classesOf(SKIP_SELECTOR);
const ATTR_CLASSES = classesOf(ATTR_SELECTOR);
const HAS_SKIP_ATTR = /\[data-i18n-skip\]/.test(SKIP_SELECTOR);
const HAS_ATTR_SKIP_ATTR = /\[data-i18n-skip\]/.test(ATTR_SELECTOR);

const CJK = /[\u4e00-\u9fff]/;
// \u8fd0\u884c\u65f6\u662f EN_DICT[s.trim()]\uff1a\u53ea\u53bb\u9996\u5c3e\u7a7a\u767d\uff0c\u7edd\u4e0d\u538b\u7f29\u4e2d\u95f4\u3002\u5b88\u536b\u82e5\u8ddf\u7740\u538b\u7f29\uff0c
// \u5c31\u4f1a\u62ff"\u6bcf\u884c\u4e00\u4e2a\uff09\uff0c\u5982\uff1a c:/\u2026"\u8fd9\u79cd\u952e\u53bb\u6838\u5bf9\u2014\u2014\u8bcd\u5178\u91cc\u52a0\u4e86\u4e5f\u547d\u4e2d\u4e0d\u4e86\uff0c\u9875\u9762\u7167\u65e7\u5192\u4e2d\u6587\u3002
// \u6240\u4ee5\u8fd9\u91cc\u53ea trim\uff0c\u4e2d\u95f4\u7684\u6362\u884c\u539f\u6837\u7559\u7740\uff1b\u6253\u5370\u65f6\u628a\u6362\u884c\u5199\u6210 \n\uff0c\u770b\u5f97\u5230\u4e5f\u6284\u5f97\u5bf9\u3002
const keyOf = (s) => s.trim();
const show = (s) => s.replace(/\n/g, "\\n");
const varSet = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");

ok("E 类：运行时跳过口径里带 data-i18n-skip（豁免机制存在）",
  HAS_SKIP_ATTR && HAS_ATTR_SKIP_ATTR, `${SKIP_SELECTOR} / ${ATTR_SELECTOR}`);

// ── A. JS 里 t("…") 的字面键 ────────────────────────────

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(`${ROOT}/${dir}`)) {
    const rel = `${dir}/${name}`;
    if (statSync(`${ROOT}/${rel}`).isDirectory()) out.push(...jsFiles(rel));
    else if (name.endsWith(".js")) out.push(rel);
  }
  return out;
}

const missingA = [];
const usedKeys = new Set();
for (const rel of jsFiles("frontend/js")) {
  if (rel.endsWith("i18n_dict.js")) continue;
  for (const m of read(rel).matchAll(/\bt\(\s*"((?:[^"\\]|\\.)+)"/g)) {
    const key = unesc(m[1]);
    usedKeys.add(key);
    if (!CJK.test(key)) continue;              // 纯拉丁：未命中也原样，无需词典条目
    if (!dict.has(key)) missingA.push(`${rel} :: ${show(key)}`);
  }
}
ok(`A 类：JS 里 t() 用到的中文键全在词典里（缺 ${missingA.length} 条）`,
  missingA.length === 0, missingA.slice(0, 10).join(" | "));

// ── B. HTML 静态文本与可翻译属性 ────────────────────────

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#10;": "\n", "&#39;": "'" };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#10|#39);/g, (x) => ENTITIES[x] ?? x);

function htmlMisses(rel) {
  const html = decode(read(rel).replace(/<!--[\s\S]*?-->/g, ""));
  const misses = [];
  const stack = [];
  const TAG_RE = /<[/]?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let cursor = 0;
  // 文本节点看内容口径（代码/输入框/正文里的中文是内容，不是界面）；
  // 属性看属性口径（placeholder 是控件说明，装用户输入的框也有它）。
  const skipped = () => stack.some(f => f.contentSkip);
  const attrSkipped = () => stack.some(f => f.attrSkip);

  for (const m of html.matchAll(TAG_RE)) {
    const between = keyOf(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const closing = m[0][1] === "/";

    if (between && CJK.test(between) && !skipped() && !dict.has(between)) {
      misses.push(`text: ${show(between)}`);
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (!attrSkipped()) {
      for (const a of TRANS_ATTRS) {
        const am = attrs.match(new RegExp(`\\b${a}="([^"]*)"`));
        if (am && CJK.test(am[1])) {
          const v = keyOf(am[1]);
          if (v && !dict.has(v)) misses.push(`${a}: ${show(v)}`);
        }
      }
    }
    const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1].split(/\s+/).filter(Boolean);
    const skipAttrMark = HAS_SKIP_ATTR && /\bdata-i18n-skip\b/.test(attrs);
    if (!VOID.has(tag) && tag !== "br" && !/\/\s*$/.test(m[0])) {
      stack.push({
        tag,
        contentSkip: skipAttrMark || SKIP_TAGS.has(tag)
          || cls.some(c => CONTENT_CLASSES.has(c)),
        attrSkip: skipAttrMark || cls.some(c => ATTR_CLASSES.has(c)),
      });
    }
  }
  return misses;
}

const missingB = [];
for (const rel of ["frontend/index.html", "frontend/m.html"]) {
  try {
    missingB.push(...htmlMisses(rel).map(x => `${rel} :: ${x}`));
  } catch (e) {
    ok(`B 类：${rel} 解析没抛错`, false, String(e?.message));
  }
}
ok(`B 类：HTML 静态中文（文本与四个属性）全有键（缺 ${missingB.length} 条）`,
  missingB.length === 0, missingB.slice(0, 12).join(" | "));

// ── D. 占位符成对 ───────────────────────────────────────

const badVars = [];
for (const [key, val] of dict) {
  const kv = varSet(key);
  if (kv && kv !== varSet(val)) badVars.push(`"${key}" → {${kv}} 对 {${varSet(val)}}`);
}
ok(`D 类：带 {var} 的键，英文值带同一组占位符（错位 ${badVars.length} 条）`,
  badVars.length === 0, badVars.slice(0, 8).join(" | "));

// ── F. 豁免不是纸面机制：页面里得真的有人用 ─────────────

const skipUses = [...INDEX_HTML.matchAll(/data-i18n-skip/g)].length;
ok(`F 类：data-i18n-skip 在 index.html 里真被用到（现 ${skipUses} 处）`, skipUses >= 1,
  "机制存在却没人用，等于漏翻只能靠加键硬补");

const dead = [...dict.keys()].filter(k => !usedKeys.has(k)
  && !INDEX_HTML.includes(`>${k}<`) && !INDEX_HTML.includes(`"${k}"`));
console.log(`信息：静态引用不到的键 ${dead.length} 条（动态拼键扫不到，不判红）`);

// 补词典时用 I18N_DUMP=1 看全量清单（判据不受它影响）
if (process.env.I18N_DUMP) {
  console.log("\n== A 类全量 ==");
  for (const x of missingA) console.log("  " + x);
  console.log("== B 类全量 ==");
  for (const x of missingB) console.log("  " + x);
  console.log("== C 类重复键全量 ==");
  for (const x of dupKeys) console.log("  " + x);
}

report();

function report() {
  const failed = results.filter(([p]) => !p);
  for (const [p, name, detail] of results) {
    console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
  }
  console.log(`\ncheck_i18n_coverage: ${results.length - failed.length}/${results.length} 通过`);
  assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
}
