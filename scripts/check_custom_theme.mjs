/**
 * 「自定义主题」守卫：设置页 → 自定义主题（配色 / 字体 / 背景图，开启时锁明暗）
 *
 * 这个功能最容易出的错不是"按钮没了"，而是四种"看着生效其实没生效"：
 *   ① 只改了一个令牌，其余三十几个还停在内置色板 → 界面一半新一半旧；
 *   ② 推导出的次要文字色压到底色上读不清 → 好看但没法用；
 *   ③ 状态存了但没同步给后端（或反过来），重启/换设备就丢；
 *   ④ 明暗切换没被挡住 → 两套色同时说话。
 * 所以这里钉的是"整套令牌都有人管"、"文字层级带对比度兜底"、"持久化四段接线齐全"、
 * "setTheme 里那一道闸门"，而不只是"控件在不在"。
 *
 * 判据按四段排：接线（HTML/状态/后端）→ 推导（theme_custom.js）→ 控件（theme_settings.js）
 * → 生效与样式（app.js / mobile / style.css）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const STORE = read("frontend/js/store.js");
const APP = read("frontend/js/app.js");
const THEME = read("frontend/js/services/theme_custom.js");
const PANEL = read("frontend/js/components/theme_settings.js");
const DICT = read("frontend/js/services/i18n_dict.js");
const MAIN = read("backend/main.py");
const SETTINGS_PY = read("backend/routers/settings.py");
const THEME_PY = read("backend/routers/theme.py");
const SPEC = read("SLATE.spec");
const M_INIT = read("frontend/js/mobile/m-init.js");
const M_APP = read("frontend/js/mobile/m-app.js");
const M_SETTINGS = read("frontend/js/mobile/m-settings.js");

const problems = [];
const must = (cond, msg, detail = "") => { if (!cond) problems.push(`${msg}${detail ? ` → ${detail}` : ""}`); };

/** 取 #settings-theme 这一段：从它的 <section 开标签到配平的 </section>。 */
function sectionBlock(src, id) {
  const at = src.indexOf(`<section class="settings-block" id="${id}">`);
  if (at < 0) return "";
  const end = src.indexOf("</section>", at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 10);
}

/** 取某个顶层函数的函数体（这些文件里函数都是顶格 } 收尾）。 */
function fnBody(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 2);
}

/** 取对象字面量里那一层键名（deriveTokens 的 return { ... }）。 */
function literalKeys(src, from, until) {
  const seg = src.slice(from, until);
  return [...seg.matchAll(/"(--[a-z-]+)"\s*:/g)].map(m => m[1]);
}

// ── ① 接线：设置区块与控件齐不齐 ──────────────────────
const BLOCK = sectionBlock(HTML, "settings-theme");
must(BLOCK, "index.html 里没有 #settings-theme 区块（自定义主题整块没了）");
must(/<section class="settings-block" id="settings-theme">\s*<div class="settings-block-head">\s*<div>\s*<h2>自定义主题<\/h2>/.test(HTML),
  "#settings-theme 的头部结构不合设置页统一形状（section → head → div → h2）");

const IDS = [
  "theme-custom-enabled", "theme-preset-row",
  "theme-color-bg", "theme-color-panel", "theme-color-text", "theme-color-accent",
  "theme-font-main", "theme-font-code",
  "theme-bg-pick", "theme-bg-clear", "theme-bg-enabled", "theme-bg-file",
  "theme-bg-veil", "theme-bg-veil-value", "theme-bg-state", "theme-reset",
];
for (const id of IDS) must(BLOCK.includes(`id="${id}"`), `#settings-theme 里缺 #${id}`);

for (const id of ["theme-color-bg", "theme-color-panel", "theme-color-text", "theme-color-accent"]) {
  const at = BLOCK.indexOf(`id="${id}"`);
  must(at >= 0 && /type="color"/.test(BLOCK.slice(at - 60, at + 60)), `${id} 不是 type="color"（用户没法选色）`);
}
// 文件控件靠 class 藏起来：区块里出现 style= 就把设置页"排面统一"那条约定破了
must(/class="theme-file-input"[^>]*type="file"|type="file"[^>]*class="theme-file-input"/.test(BLOCK),
  "背景图的文件控件没带 .theme-file-input（靠内联 display:none 藏的话会被设置页的样式约定挡回来）");
must(!/style="/.test(BLOCK), "#settings-theme 里出现了内联 style（设置页不许）");
const VEIL_AT = BLOCK.indexOf('id="theme-bg-veil"');
must(/min="40"/.test(BLOCK.slice(VEIL_AT - 80, VEIL_AT + 160)) && /max="95"/.test(BLOCK.slice(VEIL_AT - 80, VEIL_AT + 160)),
  "遮罩浓度滑杆的取值区间不是 40..95（和 store 里 normalizeCountInt 的上下限同一个数）");
// 光看滑杆的 HTML 等于没看：真正的围栏在 store 那一夹，两处得各钉一次
must(/veil: normalizeCountInt\(b\.veil, 40, 95, 72\)/.test(STORE),
  "store 里遮罩浓度的上下限不再是 40..95（滑杆拦得住，脏值照样进 CSS）");
// 图标必须和 icons.js 同一份路径：两处各画一次迟早长得不一样
const ICONS = read("frontend/js/services/icons.js");
for (const name of ["palette", "image"]) {
  const pathOnly = (ICONS.match(new RegExp(`\\n\\s*${name}: '([^']+)'`)) || [])[1] || "";
  must(pathOnly && BLOCK.includes(pathOnly), `#settings-theme 里的 ${name} 图标与 icons.js 不是同一份路径`);
}

// ── ① 状态：四段持久化接线 ────────────────────────────
must(/function normalizeCustomTheme\(/.test(STORE), "store.js 里没有 normalizeCustomTheme（脏值没人挡）");
must(/customTheme: normalizeCustomTheme\(null\)/.test(STORE), "state.customTheme 没有默认值");
must(/customTheme: normalizeCustomTheme\(state\.customTheme\)/.test(fnBody(STORE, "buildPersistentData")),
  "buildPersistentData 不写 customTheme（本机 localStorage 里存不住）");
must(/customTheme: normalizeCustomTheme\(data\.customTheme\)/.test(fnBody(STORE, "getSharedPersistentData")),
  "getSharedPersistentData 不收 customTheme（同步不到后端，换设备就丢）");
must(/state\.customTheme = normalizeCustomTheme\(data\.customTheme\)/.test(fnBody(STORE, "loadPersistent")),
  "loadPersistent 没还原 customTheme（刷新后色板回默认）");
must(/hasOwnProperty\.call\(data, "customTheme"\)/.test(STORE)
  && /state\.customTheme = normalizeCustomTheme\(data\.customTheme\)/.test(fnBody(STORE, "loadSharedPersistent")),
  "loadSharedPersistent 没按 hasOwnProperty 还原 customTheme");
must(/"customTheme"/.test(SETTINGS_PY), "backend settings.py 的 allowed_keys 不收 customTheme（PUT 时被静默丢掉）");

// 闸门：setTheme 必须先问自定义主题开没开，并且把"没换成"回报给调用方
const SET_THEME = fnBody(STORE, "setTheme");
must(/if \(customThemeActive\(\)\) return false;/.test(SET_THEME),
  "setTheme 没挡自定义主题（开着自定义还能切明暗，两套色互相矛盾）");
must(SET_THEME.includes('return false;') && /return true;/.test(SET_THEME),
  "setTheme 没把成不成回报出去（调用方只能盲发「已切换」的提示）");
must(/state\.customTheme\?\.enabled === true/.test(fnBody(STORE, "customThemeActive")),
  "customThemeActive 读的不再是 customTheme.enabled");
const SET_CUSTOM = fnBody(STORE, "setCustomTheme");
must(/\.\.\.cur\.colors, \.\.\.\(p\.colors \|\| \{\}\)/.test(SET_CUSTOM)
  && /\.\.\.cur\.fonts, \.\.\.\(p\.fonts \|\| \{\}\)/.test(SET_CUSTOM)
  && /\.\.\.cur\.background, \.\.\.\(p\.background \|\| \{\}\)/.test(SET_CUSTOM),
  "setCustomTheme 不再逐组浅合并（只改一格会把另外几格冲回默认）");
must(/notify\("customTheme", state\.customTheme\)/.test(SET_CUSTOM) && /savePersistent\(\)/.test(SET_CUSTOM),
  "setCustomTheme 没落盘或没通知（改完看不见、重启就丢）");
must(/setTheme, toggleTheme, setCustomTheme, customThemeActive,/.test(STORE),
  "store.js 没导出 setCustomTheme / customThemeActive");

// ── ② 后端：背景图的存取围栏 ──────────────────────────
must(/prefix="\/theme"/.test(THEME_PY), "theme.py 的路由前缀不是 /theme");
for (const route of ['@router.get("/background/status")', '@router.get("/background")', '@router.post("/background")', '@router.delete("/background")']) {
  must(THEME_PY.includes(route), `theme.py 缺 ${route}`);
}
must(/from backend\.routers import[^\n]*\btheme\b/.test(MAIN)
  && /app\.include_router\(theme\.router, prefix="\/api"\)/.test(MAIN),
  "main.py 没注册 theme 路由（背景图接口整条 404）");
must(/'backend\.routers\.theme'/.test(SPEC), "SLATE.spec 的 hiddenimports 少了 backend.routers.theme（装机版 404）");
must(/MAX_BACKGROUND_BYTES = 4 \* 1024 \* 1024/.test(THEME_PY), "theme.py 的背景图上限不再是 4MB");
must(/_sniff/.test(THEME_PY) && /b"\\x89PNG/.test(THEME_PY) && /RIFF/.test(THEME_PY),
  "theme.py 不校验魔数了（任意字节都会被当成图存进 data/theme/）");
must(/background\.tmp/.test(THEME_PY) && /\.replace\(/.test(THEME_PY),
  "theme.py 不再先写临时名再换（写一半断电会留下半张图）");
must(/"Cache-Control": "no-store"/.test(THEME_PY), "theme.py 的 GET /background 丢了 no-store（换图后看到上一张）");
must(/background\.tmp/.test(fnBody(THEME_PY, "_current_file")) || /startswith\("background\.tmp"\)/.test(THEME_PY),
  "_current_file 不排临时名了（半张图会被当成背景发出去）");

// ── ③ 推导：整套令牌都要有人管，文字层级要读得清 ──────
const ROOT_BLOCK = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("\n}", CSS.indexOf(":root {")));
const ROOT_TOKENS = [...ROOT_BLOCK.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1]);
must(ROOT_TOKENS.length > 30, `没从 style.css 的 :root 读到足够多的令牌（只读到 ${ROOT_TOKENS.length} 个），这条覆盖判据已经失效`);
const DERIVE = fnBody(THEME, "deriveTokens");
const FROM = DERIVE.indexOf("return {");
const UNTIL = DERIVE.lastIndexOf("}");
const DERIVED = literalKeys(DERIVE, FROM, UNTIL);
// 字体三个 + 圆角/顶栏高/过渡不属于"配色推导"，其余每一个都必须有人接
const NOT_DERIVED = ["--font-main", "--font-code", "--font-mono", "--radius", "--topbar-h", "--transition"];
const MISSING = ROOT_TOKENS.filter(t => !NOT_DERIVED.includes(t) && !DERIVED.includes(t));
must(MISSING.length === 0, "内置主题里有这些令牌没被推导（切到自定义会一半新一半旧）", MISSING.join(" "));
for (const token of ["--bg", "--bg-alt", "--text", "--text-secondary", "--text-muted", "--text-faint", "--border",
  "--accent", "--accent-bg", "--accent-fg", "--code-bg", "--code-fg", "--msg-user-bg", "--msg-user-fg",
  "--selection-bg", "--selection-fg", "--modal-backdrop", "--toast-bg", "--toast-fg", "--danger", "--ok", "--task-needs"]) {
  must(DERIVED.includes(token), `deriveTokens 不再产出 ${token}`);
}
must(/luminance\(bg\) < 0\.45/.test(DERIVE), "deriveTokens 不按底色亮度决定走深色系还是浅色系");
must(/accentFor\(colors\.accent, bg, 4\.5\)/.test(DERIVE), "强调色没有 4.5:1 的对比度兜底");
// 判据钉在"往哪边压"那一行：按强调色自己的亮度选方向，浅底上的纯白会往白里混（混不动＝卡 1.05:1）
const ACCENT_FN = fnBody(THEME, "accentFor");
must(/const toward = contrastRatio\("#000000", bg\) >= contrastRatio\("#FFFFFF", bg\) \? "#000000" : "#FFFFFF";/.test(ACCENT_FN),
  "accentFor 的推导方向不再按底色算（按强调色自己算＝浅底纯白压不动）");
must(/for \(let i = 0; i < 12 && contrastRatio\(c, bg\) < minRatio; i\+\+\)/.test(ACCENT_FN),
  "accentFor 丢了循环上限或对比度门槛");
// 填充色上选黑还是白：按实测对比挑，不是按亮度过半翻白字
const INKFN = fnBody(THEME, "inkOrPaper");
must(/contrastRatio\(dark, color\) >= contrastRatio\(light, color\) \? dark : light/.test(INKFN),
  "inkOrPaper 回退成亮度阈值了（中亮度底色上的白字会掉到 2.6:1，选中态/toast 看不清）");
must(/rgba\(ink, alphaFor\(ink, bg, isDark \? 0\.74 : 0\.80, 4\.5\)\)/.test(DERIVE),
  "--text-secondary 丢了对比度兜底（次要文字会读不清）");
must(/rgba\(ink, alphaFor\(ink, bg, isDark \? 0\.56 : 0\.68, 4\.5\)\)/.test(DERIVE),
  "--text-muted 丢了对比度兜底");
must(/function alphaFor\(/.test(THEME) && /contrastRatio\(/.test(THEME),
  "alphaFor / contrastRatio 没了（文字层级没人校验，随便一个色板都能糊成一片）");
must(/"--accent-fg": bg,/.test(DERIVE),
  "--accent-fg 不再是实色纸底（铺背景图时它会跟着 --bg 变半透明，填充按钮上的字会发虚）");
must(/^[ \t]*"--bg": translucent \? rgba\(bg, veil\) : bg,/m.test(DERIVE),
  "--bg 没按遮罩浓度走半透明（铺图时底色仍是不透明，图根本看不见）");
// 语义色整组跟亮度走，不跟用户的强调色走
must(/SEMANTIC_LIGHT/.test(THEME) && /SEMANTIC_DARK/.test(THEME), "危险/完成/需要操作三色的两套定义没了");
must(/sem\.danger/.test(DERIVE) && /sem\.ok/.test(DERIVE) && /sem\.needs/.test(DERIVE), "语义色不再成组切换");
// 字体：只允许系统字体族，且每条都要有通用族兜底（RULES.md §8 不带字体文件）
must(!/@font-face|\.woff|\.ttf/.test(THEME), "theme_custom.js 里出现了字体文件引用（RULES.md §8 禁止）");
const FONT_LISTS = `${THEME}`.match(/export const THEME_FONTS_(?:MAIN|CODE) = \[([\s\S]*?)\n\];/g) || [];
must(FONT_LISTS.length === 2, "正文字体表与代码字体表要各有一份");
for (const list of FONT_LISTS) {
  const stacks = [...list.matchAll(/stack: '([^']*)'/g)].map(m => m[1]).filter(Boolean);
  must(stacks.length >= 4, "字体表里只剩 " + stacks.length + " 个可用族");
  for (const stack of stacks) {
    must(/sans-serif|serif|monospace/.test(stack), `字体栈没有通用族兜底：${stack}`);
  }
}
// 预设：至少 8 套，四色齐全且都是 #RRGGBB
const PRESETS = THEME.slice(THEME.indexOf("export const THEME_PRESETS"), THEME.indexOf("export function presetOf"));
const PRESET_ROWS = [...PRESETS.matchAll(/id: "([a-z]+)", name: "([^"]+)", colors: \{([^}]*)\}/g)];
must(PRESET_ROWS.length >= 8, "基础预设少于 8 套", `实际 ${PRESET_ROWS.length}`);
const PRESET_IDS = new Set(PRESET_ROWS.map(m => m[1]));
must(PRESET_IDS.size === PRESET_ROWS.length, "预设 id 有重复");
for (const row of PRESET_ROWS) {
  for (const key of ["bg", "panel", "text", "accent"]) {
    const hex = (row[3].match(new RegExp(`${key}: "(#[0-9A-Fa-f]{6})"`)) || [])[1];
    must(hex, `预设 ${row[1]} 缺合法的 ${key} 色值`);
  }
}
// 注入 CSS 的特异度：必须带 data-theme 的两种取值，否则通用 UI 深色下会被 style.css 盖住
const BUILD = fnBody(THEME, "buildThemeCss");
must(/html\[data-custom-theme="1"\]\[data-theme="light"\]/.test(BUILD)
  && /html\[data-custom-theme="1"\]\[data-theme="dark"\]/.test(BUILD),
  "buildThemeCss 的选择器丢了 data-theme 限定（通用 UI 的深色规则会把它盖掉）");
must(/options\.imageReady === true/.test(BUILD), "buildThemeCss 不再按「本机有没有图」决定铺不铺那层");
const LAYER = fnBody(THEME, "buildThemeCss");
must(/position: fixed/.test(LAYER) && /z-index: -1/.test(LAYER) && /inset: 0/.test(LAYER),
  "背景图那一层不再是「铺满视口、压在面板之下」");
must(/backgroundUrl\(\)/.test(LAYER) && /function backgroundUrl/.test(THEME) && /\[\^\\d\]/.test(THEME),
  "背景图 URL 的缓存串没过 digitsOnly（外部值直接进 url()）");
// 生效通道：只在 enabled 时装样式，只在探测到图时挂 data-custom-bg
const APPLY = fnBody(THEME, "applyCustomTheme");
must(/theme\.enabled !== true/.test(APPLY) && /clearInjected\(\)/.test(APPLY),
  "applyCustomTheme 关掉时不摘样式（会留一份没人认领的色板在页面上）");
must(/await probeBackground\(\)/.test(APPLY), "applyCustomTheme 不再先探测本机有没有图");
const CLEAR = fnBody(THEME, "clearInjected");
must(/removeAttribute\("data-custom-theme"\)/.test(CLEAR) && /removeAttribute\("data-custom-bg"\)/.test(CLEAR),
  "clearInjected 没把两个 data 属性一起摘掉");
must(/removeAttribute\("data-custom-bg"\)/.test(APPLY) && /setAttribute\("data-custom-bg", "1"\)/.test(APPLY),
  "applyCustomTheme 里 data-custom-bg 不成对（图没了属性还挂着）");

// ── ④ 控件：面板只做两件事——读状态、写状态 ────────────
const COLOR_FIELD_IDS = [...PANEL.matchAll(/id: "(theme-color-[a-z]+)"/g)].map(m => m[1]);
must(COLOR_FIELD_IDS.length === 4, "面板的四个源色输入框少了一个", `实际 ${COLOR_FIELD_IDS.length}`);
for (const id of COLOR_FIELD_IDS) must(BLOCK.includes(`id="${id}"`), `面板里的 ${id} 在 index.html 找不到`);
must(/MAX_BG_BYTES = 4 \* 1024 \* 1024/.test(PANEL), "面板的体积上限与后端不是同一个数（会挑一张后端必拒的图）");
must(/file\.size > MAX_BG_BYTES/.test(PANEL), "面板不再先看文件大小就上传（大了才被后端拒，白跑一趟）");
must(/await uploadBackground\(file\)/.test(PANEL) && /setCustomTheme\(\{ background: \{ enabled: true \} \}\)/.test(PANEL),
  "换图成功后没把「铺在界面上」打开（用户挑完图还得自己去勾）");
must(/picker\.value = ""/.test(PANEL), "文件控件选完没清空 value（同一张图第二次点没反应）");
must(/bgOn\.disabled = !info\.exists/.test(fnBody(PANEL, "renderBgState")),
  "本机没图时「铺在界面上」不再置灰（勾了只会得到一层半透明底色压在空屏上）");
must(/await removeBackground\(\)/.test(PANEL) && /setCustomTheme\(\{ background: \{ enabled: false \} \}\)/.test(PANEL),
  "移除背景图后没关掉那层（属性与文件两头对不上）");
must(/setCustomTheme\(\{ preset: "", colors: \{ \[field\.key\]: e\.target\.value \} \}\)/.test(PANEL),
  "手改色板没把 preset 清掉（色板已经不是那个预设了，高亮还留着）");
must(/buildFontSelects\(\)/.test(fnBody(PANEL, "initThemeSettings")), "字体下拉没在初始化时建好（每次同步都重建会丢焦点）");
must(!/fillSelect\(/.test(fnBody(PANEL, "renderThemeSettings")), "字体下拉还在同步里重建（改一次色重建一次，选中的框会跳掉）");

// 面板与提示语：每个 t() 的字面量都得在词典里
for (const lit of new Set([...PANEL.matchAll(/\bt\("([^"]+)"/g)].map(m => m[1]))) {
  if (/^[A-Za-z]/.test(lit)) continue;   // 拉丁字体名不翻译，也不进词典
  must(DICT.includes(`"${lit}"`), `词典缺键：${lit}`);
}
for (const preset of PRESET_ROWS) must(DICT.includes(`"${preset[2]}"`), `词典缺预设名：${preset[2]}`);

// ── ⑤ 生效与入口：明暗那颗按钮要说得出为什么没换 ──────
const TOGGLE = fnBody(APP, "requestThemeToggle");
must(TOGGLE, "app.js 里没有 requestThemeToggle（明暗切换又散成各写各的）");
must(/if \(toggleTheme\(\)\)/.test(TOGGLE), "requestThemeToggle 不看 setTheme 的返回值（被挡了也照样播「已切换」）");
must(/toast\(/.test(TOGGLE) && DICT.includes('"自定义主题生效中：先在「设置 → 自定义主题」里关掉它，才能切换深色/浅色"'),
  "被挡时那句解释没了或没进词典");
must(/getElementById\("btn-theme"\)\.addEventListener\("click", \(\) => \{\s*requestThemeToggle\(\)/.test(APP),
  "顶栏明暗按钮没有走唯一入口");
must(/e\.key === "d"\) \{\s*e\.preventDefault\(\);\s*requestThemeToggle\(\)/.test(APP),
  "Ctrl/⌘+D 没有走唯一入口");
const LOCK_UI = fnBody(APP, "syncThemeLockUI");
must(/classList\.toggle\("is-locked", locked\)/.test(LOCK_UI) && !/disabled = /.test(LOCK_UI),
  "锁的样子改成了禁用（禁用的按钮点不出解释）");
must(/subscribe\("customTheme"/.test(APP) && /applyCustomTheme\(theme\)/.test(APP)
  && /renderThemeSettings\(\)/.test(APP) && /syncThemeLockUI\(\)/.test(APP),
  "app.js 的 customTheme 订阅不再同时做三件事（注入样式 / 同步控件 / 同步锁的样子）");
must(/applyCustomTheme\(state\.customTheme\)/.test(APP), "启动时没把已存的色板装回去");
must(/safeInit\("自定义主题设置", initThemeSettings\)/.test(APP), "initThemeSettings 没挂进启动序列");
must(/renderThemeSettings\(\);/.test(fnBody(APP, "openSettings")), "打开设置页没同步主题控件");
must(/#btn-theme\.is-locked(?![\w-])[^{]*\{/.test(CSS), "style.css 缺 #btn-theme.is-locked 规则（JS 切了 class 但像素不动）");
// 只看"CSS 里有这个点号串"是不够的：把规则改名成 .theme-file-input-x 照样被算中，
// 于是"类在切、像素不动"这条最常见的错法就漏了。按选择器整词配规则块，改名＝没有规则。
const SELECTORS = [...CSS.matchAll(/([^{}]+)\{/g)].map(m => m[1]).join("\n");
for (const cls of ["theme-preset-row", "theme-preset-btn", "theme-preset-chip", "theme-preset-name",
  "theme-color-grid", "theme-color-field", "theme-bg-row", "theme-file-input", "theme-veil-slider", "theme-veil-value"]) {
  must(new RegExp(`\\.${cls}(?![\\w-])`).test(SELECTORS), `style.css 里没有 .${cls} 规则块`);
}
must(/\.theme-file-input(?![\w-])[^{]*\{[^}]*display:\s*none/.test(CSS),
  ".theme-file-input 的规则块不再藏住控件（原生的「选择文件」框会露在设置页里）");
must(!/\bdisplay:\s*none\b/.test(CSS.match(/\.theme-preset-btn\b[^}]*\}/)?.[0] || ""),
  ".theme-preset-btn 自己不显示（预设点了没反应，用户只会以为这栏是空的）");

// ── ⑥ 手机：读同一份色板，同样不响也要给话 ────────────
must(/applyCustomTheme\(state\.customTheme\)/.test(fnBody(M_INIT, "applyTheme")),
  "手机端没装自定义主题（同一份设置在手机上只剩内置色板）");
for (const [label, src] of [["m-app.js", M_APP], ["m-settings.js", M_SETTINGS]]) {
  must(/if \(!toggleTheme\(\)\)/.test(src), `${label} 的明暗入口没看返回值（被挡了还会播「深色模式」）`);
  must(src.includes('t("自定义主题生效中，明暗切换已锁定")'), `${label} 少了那句解释`);
}

if (problems.length) {
  console.error(`✗ check_custom_theme：${problems.length} 项不合`);
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}
console.log("✓ check_custom_theme：自定义主题（四个源色推导整套令牌 + 字体 + 背景图 + 锁明暗）接线一致");
