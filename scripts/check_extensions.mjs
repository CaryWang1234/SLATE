/**
 * 扩展页守卫：scripts/check_extensions.mjs
 *
 * 这一页是把原来散在「设置 → 工具 / 技能」和「设置 → MCP Server」里的东西搬过来拼成的，
 * 拼法是「一个页签 + 左分栏轨 + 六个 .ext-section」，全靠命名约定接线。约定一断就是静默的：
 * ① 页签 data-panel 与 #panel-<name> 不一致——点了没反应，页面还是那张页面；
 * ② 分栏轨的 key 与 data-ext 不同源——多出来的那栏永远点不到，少掉的那栏进不去；
 * ③ 栏内标题上的数字与分栏轨上的数字分开写——刷新一次就各说各话；
 * ④ 列表容器的 id 改了但组件还按旧 id 取——渲染进 null，界面只剩表头；
 * ⑤ Codex 布局的入口是三处登记（分组 / 分发 / 高亮），漏一处就是"进得去但亮着别处"；
 * ⑥ 桌面 CSS 没有全局 .hidden，.ext-section.active 少一条规则等于五栏同时铺开。
 * 所以这里逐条把"约定"钉成断言，而不是只查文件里有没有出现过这些名字。
 *
 * 运行：node scripts/check_extensions.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const APP = read("frontend/js/app.js");
const EXT = read("frontend/js/components/extensions.js");
const DICT = read("frontend/js/services/i18n_dict.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

const COMPONENT_DIR = "frontend/js/components";
const componentSrc = Object.fromEntries(
  readdirSync(`${ROOT}/${COMPONENT_DIR}`)
    .filter(f => f.endsWith(".js"))
    .map(f => [f, read(`${COMPONENT_DIR}/${f}`)]),
);
/** 某个 id 是否真被某个组件取用过（渲染目标不能被 HTML 单方面宣布） */
const readBySomeComponent = (id) =>
  Object.entries(componentSrc).find(([, src]) => src.includes(`getElementById("${id}")`))?.[0] || "";

// ── 1. 页签与面板按约定成对（switchPanel 靠 panel-<name> 拼 id）──────

const TAB_RE = /<button class="tab-btn" data-panel="([^"]+)">([^<]*)<\/button>/g;
const tabs = [...HTML.matchAll(TAB_RE)].map(([, name, label]) => ({ name, label: label.trim() }));
const tabNames = tabs.map(t => t.name);
ok("顶栏页签全部在 HTML 里读得到（不写死清单，加了页签这里就会跟着要面板）",
  tabNames.length >= 4, tabNames.join("/"));
for (const { name, label } of tabs) {
  ok(`页签「${label || name}」有同名面板 #panel-${name}`, HTML.includes(`id="panel-${name}"`));
}
ok("扩展页签的中文标题与面板标题同一个词（两处不同词，用户找不到自己点开的页）",
  /data-panel="ext">扩展</.test(HTML) && /id="panel-ext"[\s\S]{0,200}?panel-title">扩展</.test(HTML));

// ── 2. 分栏轨的 key 与栏内 data-ext 同源 ──────────────────

const SECTION_KEYS = [...HTML.matchAll(/class="ext-section" data-ext="([^"]+)"/g)].map(m => m[1]);
const NAV_KEYS = [...EXT.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:/g)].map(m => m[1]);
ok("分栏轨清单与栏体一一对应（多一个少一个都会点不到）",
  NAV_KEYS.length === SECTION_KEYS.length && NAV_KEYS.every(k => SECTION_KEYS.includes(k)),
  `轨 ${NAV_KEYS.join("/")} vs 栏 ${SECTION_KEYS.join("/")}`);
ok("栏体只按 data-ext 认，不许再写第二套 key",
  (HTML.match(/data-ext="/g) || []).length === SECTION_KEYS.length);

// ── 3. 计数单源：轨上的数字与栏内标题的数字必须是同一次写入 ──────

const countBody = (EXT.match(/export function setExtCount\([\s\S]*?\n\}/) || [""])[0];
ok("setExtCount 同时写轨上数字与栏内数字（只写一处，另一处就冻在 0）",
  countBody.includes("`ext-nav-count-${key}`") && countBody.includes("`ext-${key}-count`"),
  countBody.replace(/\s+/g, " ").slice(0, 120));
ok("setExtCount 把 NaN/undefined 收成 0（数字框不许冒出 NaN）",
  /String\(Number\(n\) \|\| 0\)/.test(countBody));
for (const key of SECTION_KEYS) {
  ok(`栏内计数位 #ext-${key}-count 在 HTML 里存在（JS 拼出来的 id 要落得下去）`,
    HTML.includes(`id="ext-${key}-count"`));
  const caller = Object.entries(componentSrc).find(([, src]) => src.includes(`setExtCount("${key}"`))?.[0] || "";
  ok(`「${key}」这一栏的计数有人报（没人报就永远显示 0）`, caller !== "", `找不到 setExtCount("${key}", …) 的调用处`);
}

// ── 4. 栏体里的列表容器：HTML 给了 id，组件就得真的去取 ──────────

const HOSTS = { skills: "ext-skill-list", tools: "ext-tool-list", evolved: "ext-evolved-list", mcp: "mcp-server-list", experts: "ext-expert-list", actions: "ext-action-list" };
for (const [key, id] of Object.entries(HOSTS)) {
  ok(`「${key}」的列表容器 #${id} 在 HTML 里`, HTML.includes(`id="${id}"`));
  const owner = readBySomeComponent(id);
  ok(`#${id} 被组件取用（${owner || "没有"}）`, owner !== "");
}
ok("MCP 远程工具挂在 MCP 栏内，与 Server 列表同一屏（分在两栏会看不出是没连还是没工具）",
  HTML.includes('id="ext-mcp-tool-list"') && readBySomeComponent("ext-mcp-tool-list") !== "");
ok("旧的 #skill-list 容器不再存在（两处都能渲染，刷新只会改其中一处）",
  !/<div id="skill-list"/.test(HTML));

// ── 5. 搬走的两块设置区块不许留下空壳 ─────────────────────

ok("设置页不再有「工具 / 技能」与「MCP Server」两块",
  !HTML.includes('id="settings-skills"') && !HTML.includes('id="settings-mcp-servers"'));
ok("旧标题词条一并清掉（留着会让英文界面继续按已经不存在的面板说话）",
  !DICT.includes('"工具 / 技能"'));

// ── 6. Codex 布局三处登记（漏一处＝进得去但高亮错）──────────────

ok("Codex 分组里有扩展项", /CODEX_DOCK_GROUPS[\s\S]{0,600}\{ key: "ext", label: "扩展"/.test(APP));
ok("Codex 分发里点了扩展就切过去", /case "ext":\s*switchPanel\("ext"\)/.test(APP));
ok("高亮按 panel-ext 认（否则停在别项上，用户以为没切换成功）",
  APP.includes('panelId === "panel-ext"'));

// ── 7. 进页面要重取清单 ──────────────────────────────────

const switchBody = (APP.match(/function switchPanel\([\s\S]*?\n\}/) || [""])[0];
ok("切到扩展页会重取技能与 Action（换了项目还留着上一份清单会误导）",
  switchBody.includes('activePanelName === "ext"')
  && switchBody.includes("refreshSkills();") && switchBody.includes("refreshActions();"),
  switchBody.replace(/\s+/g, " ").slice(0, 100));
ok("扩展页外壳被 safeInit 拉起（只定义不调用＝左轨是空的）",
  APP.includes("safeInit(\"扩展页\", initExtensions)"));

// ── 8. CSS：桌面样式没有全局 .hidden，靠自己的规则撑显示 ────────

ok(".ext-section 基态是 display:none", /\.ext-section\s*\{[^}]*display:\s*none/.test(CSS));
ok(".ext-section.active 才铺开（少这条五栏会同时显示）",
  /\.ext-section\.active\s*\{[^}]*display:\s*flex/.test(CSS));
ok(".ext-nav-item.active 有可见差异（没有就看不出选中哪一栏）",
  /\.ext-nav-item\.active\s*\{/.test(CSS));
ok(".ext-layout 撑满剩余高度并自己滚（列表长起来不许把页面顶出去）",
  /\.ext-layout\s*\{[^}]*flex:\s*1/.test(CSS) && /\.ext-main\s*\{[^}]*overflow-y:\s*auto/.test(CSS));

// ── 9. 词条齐全：这一页新增的中文都要有英文对照 ──────────────

const EN_KEYS = ["扩展", "模型能用什么，在这一页决定", "专家包", "技能 · SKILL.md",
  "暂无技能，可点右上「导入技能」或「新建技能」", "后端没有返回任何内置工具",
  "暂无专家包，点右上「＋ 新建专家包」或「导入」", "点击在弹窗中编辑",
  "新功能", "自产", "停用", "启用"];
for (const key of EN_KEYS) ok(`词条：${key}`, DICT.includes(`"${key}"`));

// ── 10. 新手引导的页签枚举：与顶栏页签同源，正文还得是字典认得的键 ──
// 这一张卡是用户第一次开机时唯一一份"顶栏有哪几页"的说明。新加页签没同步它，
// 就等于把入口藏了起来；改了卡片措辞却漏了字典，英文界面会直接把中文冒出来。

const ONBOARD = HTML.slice(HTML.indexOf('id="onboarding-modal"'), HTML.indexOf("btn-onboarding-done"));
const tabCard = (ONBOARD.match(/<p>([^<]*工厂（提示词生产）[^<]*)<\/p>/) || ["", ""])[1];
ok("新手引导有一张卡逐项点名顶栏页签（页签变了这张卡要跟着变）",
  tabCard !== "" && tabs.every(t => tabCard.includes(t.label)),
  `卡片正文：${tabCard.slice(0, 90)}`);
ok("这张卡的正文在 i18n 字典里有同名键（漏了就等于英文界面冒中文）",
  tabCard !== "" && DICT.includes(`"${tabCard}"`), tabCard.slice(0, 40));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_extensions: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
