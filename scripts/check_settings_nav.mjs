/**
 * 设置页左栏守卫：scripts/check_settings_nav.mjs
 *
 * 这一层的契约只有一句话：左栏必须「跟着区块走」，搜索必须「只改外观不改内容」。
 * 它最容易坏在四个地方：
 * ① 导航回到手写清单——手写清单历史上就漏过三块（后台任务 / 多任务与项目 / MCP Server），
 *    一旦有人再往 index.html 里补 <a>，区块与条目就会各说各话，页面照常渲染、少的那组没人发现；
 * ② 标题取自 h2.textContent——「通用 UI <span class=badge-exp>实验性</span>」会被整段抄进左栏；
 * ③ 桌面 CSS 没有全局 .hidden，筛掉的区块与清除按钮全靠各自那一条 display:none，
 *    少一条就是「筛掉了但还看得见」；
 * ④ 命中若靠改写 DOM 文本做高亮，会撞 i18n 的文本节点遍历与 SVG 子树。
 * 所以这里既查「条目由区块现读生成」，也查「标记只用 class」。
 *
 * 运行：node scripts/check_settings_nav.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const HTML = read("frontend/index.html");
const APP = read("frontend/js/app.js");
const CSS = read("frontend/css/style.css");
const I18N = read("frontend/js/services/i18n_dict.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);

/** 取某个顶层函数的函数体（这些文件里函数都是顶格 `}` 收尾） */
function fnBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

// 设置面板区间：从 panel-settings 到 </main>，行内样式与区块清单都只在这里数
const PANEL = HTML.slice(HTML.indexOf('id="panel-settings"'), HTML.indexOf("</main>"));
const BLOCK_RE = /<section class="settings-block" id="([^"]+)">\s*<div class="settings-block-head">\s*<div>\s*<h2>([^<]*)/g;
const blocks = [...PANEL.matchAll(BLOCK_RE)];

// ── 1. 区块清单成立（左栏同源的前提：区块本身有 id、有标题）───────

ok("设置区块不少于 21 组（少一组要先确认是不是整块被删了）", blocks.length >= 21, `实际 ${blocks.length}`);
ok("每组区块都带 id（没 id 就没法锚点跳转）",
  (PANEL.match(/<section class="settings-block"/g) || []).length === blocks.length,
  `${(PANEL.match(/<section class="settings-block"/g) || []).length} vs ${blocks.length}`);
ok("「存储空间」已从备份里独立成组（嵌在备份里时左栏永远收不到它）",
  has(PANEL, '<section class="settings-block" id="settings-storage">'));
ok("标题取 h2 裸文本：徽标一类的子元素不混进左栏",
  blocks.some(([, , t]) => t.trim() === "通用 UI") && has(PANEL, '<h2>通用 UI <span class="badge-exp">'),
  blocks.map(([, t]) => t).join("/"));

// ── 2. 左栏不许再手写（回归过一次就再也别回去）──────────

ok("index.html 里没有手写导航条目", (HTML.match(/class="settings-nav-item"/g) || []).length === 0);
ok("导航容器是空壳，条目留给 app.js", has(HTML, '<nav class="settings-nav" id="settings-nav"></nav>'));
ok("左栏外面包着侧栏容器（搜索框与导航同列）",
  has(HTML, '<aside class="settings-side">') && has(HTML, '<div class="settings-main">'));

// ── 3. app.js：条目现读生成 + 搜索只改 class ─────────────

const SEL = (APP.match(/const SETTINGS_BLOCK_SEL = "([^"]+)"/) || [])[1] || "";
ok("区块选择器钉在设置面板的 .settings-main 上",
  SEL.startsWith("#panel-settings") && SEL.endsWith(".settings-block"), SEL);
const navBody = fnBody(APP, "renderSettingsNav");
ok("条目由 settingsSections 生成，且带 data-target 与标题",
  has(navBody, "if (!sec.visible) continue;") && has(navBody, 'document.createElement("a")')
  && has(navBody, "a.dataset.target = sec.id;") && has(navBody, "a.textContent = sec.title;"));
const titleBody = fnBody(APP, "settingsBlockTitle");
ok("标题只取 h2 的首个文本节点", has(titleBody, "nodeType === Node.TEXT_NODE")
  && has(titleBody, 'querySelector(".settings-block-head h2")'));
const hayBody = fnBody(APP, "settingsHaystack");
ok("可搜文本含 placeholder 与 title（只存在于属性里的提示也要能搜到）",
  has(hayBody, "textContent") && has(hayBody, "[placeholder], [title]"));
const filterBody = fnBody(APP, "applySettingsFilter");
ok("筛掉区块与描出命中行都只动 class，不碰 DOM 文本",
  has(filterBody, 'classList.toggle("settings-hidden"') && has(filterBody, 'classList.toggle("settings-search-hit"')
  && !/innerHTML|replaceChild|removeChild/.test(filterBody), filterBody.slice(0, 80));
ok("搜索时左栏跟着重建、高亮跟着重算",
  has(filterBody, "renderSettingsNav();") && has(filterBody, "syncSettingsNavHighlight();"));
ok("状态行三态齐全：总数 / 命中数 / 空态",
  has(filterBody, 't("共 {n} 组设置"') && has(filterBody, 't("匹配到 {n} 组设置"')
  && has(filterBody, 't("没有匹配的设置项")'));
const spyBody = fnBody(APP, "syncSettingsNavHighlight");
ok("滚动高亮跳过被筛掉的区块（隐藏块 rect 为 0，不跳会高亮看不见的那组）",
  has(spyBody, "filter(s => s.visible)"));
const searchBody = fnBody(APP, "initSettingsSearch");
ok("回车跳目标、Esc 与清除按钮都回到全量",
  has(searchBody, 'e.key !== "Enter"') && has(searchBody, 'e.key === "Escape"')
  && has(searchBody, 'btn-settings-search-clear'));
ok("占位符自己走 t()：i18n 的 DOM 遍历刻意跳过 input",
  has(searchBody, 'input.placeholder = t("搜索设置项")'));
ok("搜索在 initSettingsNav 里接线（只定义不调用＝面板上没搜索）",
  has(fnBody(APP, "initSettingsNav"), "initSettingsSearch();"));

// ── 4. CSS：没有全局 .hidden，隐藏与宽度档都得自己写 ──────

ok("被筛掉的区块真会消失", /settings-block\.settings-hidden\s*\{[^}]*display:\s*none/.test(CSS));
ok("清除按钮的 .hidden 自己写了一条", /settings-search-clear\.hidden\s*\{[^}]*display:\s*none/.test(CSS));
ok("左栏 sticky 且自己滚（21 条比一屏高）",
  /\.settings-side\s*\{[^}]*position:\s*sticky[^}]*overflow-y:\s*auto/.test(CSS));
ok("控件宽度有统一档，数字框单独收窄",
  has(CSS, "--settings-control-w: 460px")
  && /\.setting-input\[type="number"\]\s*\{[^}]*max-width/.test(CSS));
ok("「说明—下拉」那种行有样式（此前两个下拉完全没被样式管过）",
  /\.settings-block \.setting-row\s*\{/.test(CSS));
ok("设置页列宽只有一处定义（两处定义时后写的会盖掉前一份）",
  (CSS.match(/^\.settings-page\s*\{/gm) || []).length === 1);
ok("命中行用 inset 阴影描边，不加 padding（逐字输入时内容不许跳位）",
  /\.settings-search-hit\s*\{[^}]*box-shadow:[^}]*inset/.test(CSS)
  && !/\.settings-search-hit\s*\{[^}]*padding/.test(CSS));

// ── 5. 排版回归：设置面板里不许再放行内样式 ──────────────

ok("设置面板零行内 style（口径应当留在 style.css）",
  (PANEL.match(/style="/g) || []).length === 0,
  (PANEL.match(/style="[^"]*"/g) || []).slice(0, 3).join(" "));
ok("并行上限两个下拉走 .setting-input 档",
  /<select id="setting-max-parallel-runs" class="setting-input">/.test(PANEL)
  && /<select id="setting-max-runs-per-project" class="setting-input">/.test(PANEL));

// ── 6. 词条齐全（英文界面不许留着中文）──────────────────

for (const key of ["搜索设置项", "清除", "共 {n} 组设置", "匹配到 {n} 组设置", "没有匹配的设置项"]) {
  ok(`词条：${key}`, has(I18N, `"${key}"`));
}

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_settings_nav: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
