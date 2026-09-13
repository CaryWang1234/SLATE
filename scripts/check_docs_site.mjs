/**
 * 官网静态守卫：scripts/check_docs_site.mjs
 *
 * docs/ 是 GitHub Pages 直管的零构建站点：没有打包器、没有类型检查，
 * 下面这些错不会在任何编译期暴露，只会在读者眼前现形——
 * ①图片/样式路径写错或截图没落盘：页面照常打开，只留一块空洞；
 * ②页内锚点 href="#x" 指向不存在的 id：点了不动；
 * ③中英两份首页结构走偏：一边改版、一边漏改，读者看到两个产品；
 * ④首页硬数字与仓库常量脱节：spec 表抬头自己写着"这些数字是仓库里的常量，
 *   不是形容词"，数字错了就是页面自己打自己的脸；
 * ⑤彩色 emoji（例如 ⚙）混进黑白+金的站点；
 * ⑥docs 里出现 ?v= 缓存串：站点没有构建流程，写了就是假装会刷新；
 * ⑦下载链写死到某个 tag：下一次发版就集体 404。
 *
 * 只用 fs + 正则读源码，绝不 import 前端 ESM：守卫一旦用 ?v= pin 住 import，
 * pin 落后就会同时加载两份模块实例，测的是自己的影子（见项目长期记忆）。
 *
 * 失败一次报全，不用 assert 首错即停：改站点的人要的是清单，不是第一条栈。
 * 跑法：node scripts/check_docs_site.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = (...p) => path.join(ROOT, ...p);
const rel = p => path.relative(ROOT, p).split(path.sep).join("/");

const fails = [];
const failsIn = (file, msg) => fails.push(`${file}: ${msg}`);
const read = file => {
  const p = abs(file);
  if (!fs.existsSync(p)) {
    fails.push(`(source) ${file} is missing — the page is asserting against thin air`);
    return "";
  }
  return fs.readFileSync(p, "utf8");
};
const count = (s, re) => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
const uniqSorted = arr => [...new Set(arr)].sort();

/* ── 仓库侧：把页面要引用的每个事实先算出来 ───────────────────────── */

function pyFileCount(dir) {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith(".py") ? [p] : []);
  });
  return walk(abs(dir));
}
function jsFileCount(dir) {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith(".js") ? [p] : []);
  });
  return walk(abs(dir));
}
// 与 `find backend -name '*.py' | xargs cat | wc -l` 同口径：只数换行符。
const lineCount = files => files.reduce((n, p) => {
  const s = fs.readFileSync(p, "utf8");
  return n + (s.match(/\n/g) || []).length;
}, 0);

const PY_FILES = pyFileCount("backend");
const JS_FILES = jsFileCount("frontend");
const SRC_LINES = lineCount(PY_FILES) + lineCount(JS_FILES);
const SRC_HINT = `${PY_FILES.length} .py + ${JS_FILES.length} .js`;

const CHECK_SCRIPTS = fs.readdirSync(abs("scripts")).filter(f => /^check_/.test(f)).length;

const REQ_LINES = read("requirements.txt").split(/\r?\n/)
  .filter(l => l.trim() && !l.trim().startsWith("#")).length;

const SUBAGENT_PARALLEL = (read("frontend/js/services/subagent.js")
  .match(/SUBAGENT_MAX_PARALLEL\s*=\s*(\d+)/) || [])[1];
const GRIND_ROUNDS = (read("frontend/js/services/grind.js")
  .match(/MAX_ROUNDS\s*=\s*(\d+)/) || [])[1];
const RISK_PATTERNS = count(
  (read("frontend/js/services/riskguard.js").match(/const HIGH_RISK_PATTERNS = \[[\s\S]*?\n\];/) || [""])[0],
  /\{\s*re:/,
);
const API_SRC = read("frontend/js/services/api.js");
const IDLE_MS = (API_SRC.match(/STREAM_IDLE_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1];
const REQ_MS = (API_SRC.match(/REQUEST_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1];
const TIMEOUT_LABEL = `${Number(IDLE_MS) / 1000}s · ${Number(REQ_MS) / 1000}s`;

const TOOL_COUNT = count(
  (read("backend/routers/skills.py").match(/^BUILTIN_SKILLS[^=]*=\s*\{[\s\S]*?\n\}/m) || [""])[0],
  /^\s{4}"[a-z0-9_]+":/m,
);

const WORKFLOW_TEMPLATES = fs.existsSync(abs("backend", "workflows"))
  ? fs.readdirSync(abs("backend", "workflows")).filter(f => f.endsWith(".json")).length
  : 0;

// 应用启动时从外部拉的资源数。首页的"零遥测"口径与 Honest Limits 的 CDN 披露
// 必须跟着这个数走：它变了，两句话都得改。
const FRONTEND_HTML = read("frontend/index.html");
const EXTERNAL_ASSETS = count(FRONTEND_HTML, /(?:src|href)="https?:\/\/[^"]+"/g);

// 每条 spec 行必须在这里挂上一个"从仓库重算"的算法；挂不上就报错，
// 绝不让新加的数字以"没有对应校验"的身份混过去。
const SPEC_RESOLVERS = [
  [/subagent\.js/, () => String(SUBAGENT_PARALLEL)],
  [/grind\.js/, () => String(GRIND_ROUNDS)],
  [/riskguard\.js/, () => String(RISK_PATTERNS)],
  [/api\.js/, () => TIMEOUT_LABEL],
  [/scripts\/check_\*/, () => String(CHECK_SCRIPTS)],
  [/package\.json/, () => (fs.existsSync(abs("package.json")) ? "PRESENT" : "0")],
  [/requirements\.txt/, () => String(REQ_LINES)],
  [/\.py\s*\+\s*\d+\s*\.js|\.py\s*·/, () => ({ tolerance: { value: String(SRC_LINES), hint: SRC_HINT } })],
];

/* ── 页面侧 ─────────────────────────────────────────────────────── */

const EN = "docs/index.html";
const ZH = "docs/zh/index.html";
const GUIDE = "docs/guide.html";
const PAGES = [EN, ZH, GUIDE];
const enHtml = read(EN);
const zhHtml = read(ZH);
const guideHtml = read(GUIDE);

const isExternal = u => /^(https?:|mailto:|data:|\/\/)/i.test(u);

// 1) 本地引用必须落在盘上；2) 锚点必须闭合；3) 跨页锚点也要闭合。
for (const file of PAGES) {
  const html = read(file);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dupIds = html.match(/\bid="([^"]+)"/g) || [];
  if (uniqSorted(dupIds).length !== dupIds.length) {
    for (const id of uniqSorted(dupIds.map(m => m.slice(4, -1)))) {
      if (count(html, new RegExp(`id="${id}"`, "g")) > 1) failsIn(file, `duplicate id "${id}"`);
    }
  }
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const raw = m[1];
    if (isExternal(raw)) {
      if (/github\.com\/[^"]*\/releases\/tag\//i.test(raw)) {
        failsIn(file, `release link is pinned to a tag (${raw}) — use /releases/latest so it survives the next release`);
      }
      continue;
    }
    const [target, hash] = raw.split("#");
    if (!target) {
      if (!ids.has(hash)) failsIn(file, `in-page anchor "#${hash}" has no matching id`);
      continue;
    }
    const resolved = path.resolve(path.dirname(abs(file)), target);
    if (!fs.existsSync(resolved)) {
      failsIn(file, `local reference "${raw}" resolves to ${rel(resolved)}, which does not exist`);
      continue;
    }
    if (hash) {
      const tHtml = fs.readFileSync(resolved, "utf8");
      if (!new RegExp(`id="${hash}"`).test(tHtml)) {
        failsIn(file, `cross-page anchor "${raw}" — ${rel(resolved)} has no id="${hash}"`);
      }
    }
  }
  // 图片必须有 alt：截图换了人、读屏器读不出内容，都是事故。
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(m[0])) failsIn(file, `<img> without alt: ${m[0].slice(0, 80)}`);
  }
}

// 2) docs 站点零构建，?v= 缓存串只会把页面钉在旧资产上。
for (const file of [...PAGES, "docs/style.css", "docs/motion.js"]) {
  const s = read(file);
  const hits = [...s.matchAll(/\b(?:src|href)\s*=\s*"[^"]*\?v=[^"]*"/g)].map(m => m[0]);
  for (const hit of hits) failsIn(file, `cache-buster query in a zero-build site: ${hit}`);
}

// 3) 彩色 emoji 禁入。刻意放行文本呈现的 ✕ ☾ ☀ ↗ ◈ ─ ═ 等，
//    只封 Unicode emoji 区段 + 会被 Edge/Safari 上色的 ⚙。
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2B00}-\u{2BFF}\u{2699}\u{2693}\u{26A0}\u{26A1}]/gu;
for (const file of [...PAGES, "docs/style.css", "docs/motion.js"]) {
  const s = read(file);
  s.split(/\r?\n/).forEach((line, i) => {
    for (const ch of line) {
      if (EMOJI.test(ch)) failsIn(file, `colour emoji "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase()}) on line ${i + 1}`);
      EMOJI.lastIndex = 0;
    }
  });
}

// 4) 中英首页镜像：锚点集合、data-count 多重集合、结构类计数三样必须一致。
{
  const anchors = html => new Set([...html.matchAll(/\bhref="#([^"]+)"/g)].map(m => m[1]));
  const a = [...anchors(enHtml)].sort();
  const b = [...anchors(zhHtml)].sort();
  if (a.join(",") !== b.join(",")) {
    failsIn(ZH, `anchor set differs from ${EN} — en[${a.join(", ")}] zh[${b.join(", ")}]`);
  }
  const counts = html => [...html.matchAll(/data-count="(\d+)"/g)].map(m => m[1]).sort();
  if (counts(enHtml).join(",") !== counts(zhHtml).join(",")) {
    failsIn(ZH, `data-count multiset differs from ${EN}: en[${counts(enHtml)}] zh[${counts(zhHtml)}]`);
  }
  const LAYOUT = ["diff", "loop-step", "spec-row", "badge", "scene-card", "contrast",
    "step", "stat-num", "code-box", "section-title", "drawer-icon",
    "bottom-btn", "loop-n", "diff-index", "diff-evidence", "contrast-col",
    "scene-icon", "hero-actions"];
  for (const token of LAYOUT) {
    const re = new RegExp(`class="[^"]*\\b${token}\\b`, "g");
    const ne = count(enHtml, re);
    const nz = count(zhHtml, re);
    if (ne !== nz) failsIn(ZH, `class "${token}" appears ${ne}x in ${EN} but ${nz}x here`);
    if (token !== "contrast-col" && ne === 0) {
      failsIn(EN, `layout class "${token}" disappeared from the English page — was the section deleted without the mirror?`);
    }
  }
  // 中英两页的 spec 行必须挂同一批 <code> 证据，否则同一张表两套口径。
  const codes = html => uniqSorted([...html.matchAll(/<code>([^<]*)<\/code>/g)].map(m => m[1])
    .filter(c => /\.(py|js|txt)|package\.json|scripts\/check_/.test(c)));
  const ce = codes(enHtml), cz = codes(zhHtml);
  if (ce.join("|") !== cz.join("|")) {
    failsIn(ZH, `evidence <code> set differs from ${EN}:\n    en: ${ce.join(" | ")}\n    zh: ${cz.join(" | ")}`);
  }
}

// 5) guide 的双语必须成对，章节号不能重号。
{
  const zh = count(guideHtml, /class="lang-zh"/g);
  const en = count(guideHtml, /class="lang-en"/g);
  if (zh !== en) failsIn(GUIDE, `lang-zh blocks (${zh}) and lang-en blocks (${en}) are not paired`);
  const chapters = [...guideHtml.matchAll(/<div class="scroll-section" id="(ch\d+)"/g)].map(m => m[1]);
  if (uniqSorted(chapters).length !== chapters.length) {
    failsIn(GUIDE, `duplicate chapter id in ${chapters.join(", ")}`);
  }
}

// 6) spec 表逐行重算：页面上每个 <b> 都必须等于仓库里的值。
for (const [file, html] of [[EN, enHtml], [ZH, zhHtml]]) {
  const grid = html.match(/<dl class="spec-grid">([\s\S]*?)<\/dl>/);
  if (!grid) {
    failsIn(file, "no <dl class=\"spec-grid\"> — the constants table was removed or its markup renamed");
    continue;
  }
  const rows = [...grid[1].matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd><b>([\s\S]*?)<\/b><code>([\s\S]*?)<\/code>/g)];
  if (!rows.length) failsIn(file, "spec-grid exists but no <dt>/<dd><b><code> row parsed — markup drifted from the guard");
  for (const [, dt, value, code] of rows) {
    const entry = dt.replace(/<[^>]+>/g, "").trim();
    const resolver = SPEC_RESOLVERS.find(([re]) => re.test(code));
    if (!resolver) {
      failsIn(file, `spec row "${entry}" (evidence: ${code}) has no resolver — add one or drop the number`);
      continue;
    }
    const want = resolver[1]();
    if (typeof want === "object" && want.tolerance) {
      const { value: expected, hint } = want.tolerance;
      const got = Number(value.replace(/[, ]/g, ""));
      const exp = Number(expected.replace(/[, ]/g, ""));
      if (!Number.isFinite(got)) failsIn(file, `spec row "${entry}" holds "${value}", not a number`);
      else if (Math.abs(got - exp) / exp > 0.1) {
        failsIn(file, `spec row "${entry}" says ${value} (${code}) but the repo now measures ${expected} (${hint}) — over 10% off`);
      }
      if (!code.includes(hint)) {
        failsIn(file, `spec row "${entry}" evidence reads "${code}" — the reproducible file scope is "${hint}"`);
      }
      continue;
    }
    if (value.trim() !== want) {
      failsIn(file, `spec row "${entry}" says "${value}" but the repo says "${want}" (evidence: ${code})`);
    }
  }
}

// 7) 正文里口算出来的数量词（工具数、模板数）也要对上仓库。
const NUM_CLAIMS = [
  [/(\d+)\s+tools?\b(?![-\w])/gi, () => TOOL_COUNT, "built-in tool count"],
  [/(\d+)\s*(?:个)?\s*(?:内置)?工具/g, () => TOOL_COUNT, "built-in tool count"],
  [/(\d+)\s+workflow\s+templates?/gi, () => WORKFLOW_TEMPLATES, "DAG workflow templates in backend/workflows/"],
  [/(\d+)\s+个?工作流模板/g, () => WORKFLOW_TEMPLATES, "DAG workflow templates in backend/workflows/"],
  [/Toolbox \((\d+) Tools\)/g, () => TOOL_COUNT, "built-in tool count"],
  [/工具箱（(\d+)\s*个）/g, () => TOOL_COUNT, "built-in tool count"],
  [/(\d+) built-in templates/gi, () => WORKFLOW_TEMPLATES, "DAG workflow templates in backend/workflows/"],
];
for (const file of [...PAGES, "GUIDE.md", "README.md", "README-zh.md"]) {
  const s = read(file);
  for (const [re, getter, label] of NUM_CLAIMS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const expected = String(getter());
      if (m[1] !== expected) failsIn(file, `claims "${m[0]}" but ${label} is ${expected}`);
    }
  }
}

// 8) style.css 里不得留死选择器：站点没有构建期 tree-shaking，
//    改版留下的旧规则会一直躺在线上文件里，没人知道。
//    口径刻意放宽——token 在任一份源码里作为整词出现即算"在用"，
//    宁可漏报也不误报（JS 里拼出来的类名不能被静态 class="" 抓到）。
{
  const css = read("docs/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const blob = [enHtml, zhHtml, guideHtml, read("docs/motion.js")].join("\n");
  const defined = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]));
  const dead = [...defined].filter(t => !new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(blob)).sort();
  if (dead.length) {
    failsIn("docs/style.css", `selector(s) defined but used by nothing in docs/: ${dead.join(", ")}`);
  }
}

// 9) 外发口径必须由仓库决定。首页曾一边说"例行外发只有检查更新"，一边在
//    Honest Limits 里承认启动会拉 CDN 资源——两句都是散文，前面所有数字校验都看不见。
//    现在数量取自 frontend/index.html 的外部 src/href，两处文案都得跟着它走。
{
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const n = EXTERNAL_ASSETS;
  const pairs = [
    [EN, enHtml, "Telemetry Beacons", "Not Offline"],
    [ZH, zhHtml, "遥测上报点", "不算离线运行"],
  ];
  for (const [file, html, label, cardTitle] of pairs) {
    const hint = (html.match(new RegExp(
      `<div class="stat-label">[^<]*${label}[\\s\\S]{0,60}?<div class="stat-hint">([^<]*)</div>`)) || [])[1];
    if (!hint) {
      failsIn(file, `stat block "${label}" is gone or its markup changed — the outbound-call claim is now unchecked`);
      continue;
    }
    const card = (html.match(new RegExp(`<h3>${cardTitle}</h3>\\s*<p>([\\s\\S]*?)</p>`)) || [])[1];
    if (n > 0) {
      if (!/CDN/i.test(hint)) {
        failsIn(file, `frontend/index.html loads ${n} external asset(s), so "${label}" cannot claim the update check is the only call — point the hint at the CDN disclosure`);
      }
      if (!card) {
        failsIn(file, `"${cardTitle}" card disappeared while frontend/index.html still loads ${n} external asset(s)`);
      } else {
        const alts = n <= 10 ? `${n}|${WORDS[n]}` : String(n);
        if (!new RegExp(`(^|[^\\d])(${alts})($|[^\\d])`, "i").test(card)) {
          failsIn(file, `"${cardTitle}" card states a count different from frontend/index.html (${n} external asset(s))`);
        }
      }
    } else if (card || /CDN/i.test(hint)) {
      failsIn(file, `frontend/index.html no longer loads external assets — drop the stale CDN disclosure from "${cardTitle}" and "${label}"`);
    }
  }
}

/* ── 汇总 ───────────────────────────────────────────────────────── */

if (fails.length) {
  console.error(`\ncheck_docs_site: ${fails.length} problem(s)\n`);
  for (const f of fails) console.error("  ✗ " + f);
  console.error("\nFacts recomputed from the repository right now:");
  console.error(`  SUBAGENT_MAX_PARALLEL=${SUBAGENT_PARALLEL}  MAX_ROUNDS=${GRIND_ROUNDS}  HIGH_RISK_PATTERNS=${RISK_PATTERNS}`);
  console.error(`  timeouts=${TIMEOUT_LABEL}  check_*=${CHECK_SCRIPTS}  requirements=${REQ_LINES}  BUILTIN_SKILLS=${TOOL_COUNT}`);
  console.error(`  workflows=${WORKFLOW_TEMPLATES}  source=${SRC_LINES} lines (${SRC_HINT})`);
  console.error(`  external assets in frontend/index.html=${EXTERNAL_ASSETS}`);
  process.exit(1);
}

console.log("check_docs_site: passed");
console.log(`  ${PAGES.length} pages · ${CHECK_SCRIPTS} self-check scripts · ${TOOL_COUNT} tools · ${SRC_LINES} source lines (${SRC_HINT})`);
