/**
 * 「自定义主题」守卫：设置页 → 自定义主题（配色 / 板块透明度 / 字体（含自行导入）/ 背景图（含 Wallpaper Engine 取图），开启时锁明暗）
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

/** 取某个 Python 函数的函数体（下一行顶格的东西就是它的结尾：装饰器、def、注释都不算）。 */
function pyFn(src, name) {
  const at = src.search(new RegExp(`^(?:async\\s+)?def\\s+${name}\\s*\\(`, "m"));
  if (at < 0) return "";
  const rest = src.slice(at);
  const end = rest.slice(1).search(/\n(?=\S)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
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
  "theme-font-pick", "theme-font-file", "theme-font-list", "theme-font-state",
  "theme-panel-alpha", "theme-panel-alpha-value",
  "theme-bg-pick", "theme-bg-clear", "theme-bg-enabled", "theme-bg-file",
  "theme-bg-veil", "theme-bg-veil-value", "theme-bg-state", "theme-reset",
  "theme-we-pick", "theme-we-state", "theme-we-refresh",
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
// 板块透明度：滑杆与 store 同一个区间，缺省 100（＝不铺图时与旧行为逐字节相同）
const ALPHA_AT = BLOCK.indexOf('id="theme-panel-alpha"');
must(/min="55"/.test(BLOCK.slice(ALPHA_AT - 80, ALPHA_AT + 160)) && /max="100"/.test(BLOCK.slice(ALPHA_AT - 80, ALPHA_AT + 160)),
  "板块透明度滑杆的取值区间不是 55..100（低于 55 面板只剩一圈边框在撑层级）");
must(/panel: normalizeCountInt\(o\.panel, 55, 100, 100\)/.test(STORE),
  "store 里板块透明度的上下限不再是 55..100（默认值也不再是实色）");
// 导入字体：id 形状只有一份，且脏账要被丢掉
must(STORE.includes("export const IMPORTED_FONT_ID_RE = /^f[0-9a-f]{10}$/;"),
  "store 里导入字体的 id 形状不再是 f + 10 位十六进制（这是拼进 CSS 前的唯一围栏）");
must(/fonts: \{[\s\S]{0,200}imported: normalizeImportedFonts\(f\.imported\)/.test(fnBody(STORE, "normalizeCustomTheme")),
  "normalizeCustomTheme 不再过一遍 fonts.imported（同步来的半截对象会直接进 CSS）");
const NORM_FONTS = fnBody(STORE, "normalizeImportedFonts");
must(/if \(!IMPORTED_FONT_ID_RE\.test\(id\) \|\| seen\.has\(id\)\) continue;/.test(NORM_FONTS)
  && /out\.length >= 24/.test(NORM_FONTS),
  "normalizeImportedFonts 不再丢非法 id / 去重 / 封顶 24 个");
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
  && /\.\.\.cur\.background, \.\.\.\(p\.background \|\| \{\}\)/.test(SET_CUSTOM)
  && /\.\.\.cur\.opacity, \.\.\.\(p\.opacity \|\| \{\}\)/.test(SET_CUSTOM),
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

// 字体：四个端点 + 与背景图同一套围栏（魔数、上限、临时名、id 形状）
for (const route of ['@router.get("/fonts")', '@router.get("/font/{fid}")', '@router.post("/font")', '@router.delete("/font/{fid}")']) {
  must(THEME_PY.includes(route), `theme.py 缺 ${route}`);
}
must(/MAX_FONT_BYTES = 16 \* 1024 \* 1024/.test(THEME_PY), "theme.py 的字体上限不再是 16MB");
must(/FONT_DIR = THEME_DIR \/ "fonts"/.test(THEME_PY), "字体不再单独存 data/theme/fonts/（会和背景图的 background.* 混在一起）");
must(/_FONT_ID_RE = re\.compile\(r"\^\[a-z0-9\]\{1,16\}\$"\)/.test(THEME_PY),
  "theme.py 的字体 id 形状校验没了（这是拿 id 拼路径前的唯一一道闸）");
must(/def _font_id\(raw: bytes\)/.test(THEME_PY) && /sha256\(raw\)\.hexdigest\(\)\[:10\]/.test(THEME_PY),
  "字体 id 不再由内容哈希生成（同一份字体第二次导入会多落一份文件，前端那条「账上已有就不再加一行」也失去依据）");
must(/if not _FONT_ID_RE\.match\(fid\)/.test(pyFn(THEME_PY, "delete_font")),
  "DELETE /font 不再先校验 id 形状（拿 ..\\..\\x 就能删到 fonts/ 外面）");
must(/_font_path\(fid\)/.test(pyFn(THEME_PY, "get_font")) && /_font_path\(fid\)/.test(pyFn(THEME_PY, "delete_font")),
  "get/delete 不再都走 _font_path（那条路里才有形状校验与 tmp 残骸排除）");
must(/def _sniff_font/.test(THEME_PY) && /b"wOF2"/.test(THEME_PY) && /b"OTTO"/.test(THEME_PY)
  && /b"\\x00\\x01\\x00\\x00"/.test(THEME_PY),
  "theme.py 不再按魔数认字体（任意字节都会被当成字体存进 data/，并交给字体引擎解析）");
must(/b"ttcf"/.test(THEME_PY) && /合集/.test(THEME_PY),
  "字体合集 .ttcf 不再单独拒（它会占 20MB 却一个像素都不变）");
must(/\.tmp\{ext\}/.test(pyFn(THEME_PY, "save_font")) && /tmp\.replace\(target\)/.test(pyFn(THEME_PY, "save_font")),
  "字体不再先写临时名再换（写一半断电会留下半个字体，GET 会把它发出去）");
must(/max-age=31536000, immutable/.test(THEME_PY),
  "字体的 Cache-Control 不再是长驻 immutable（id 就是内容哈希，同 id 永不变；改 no-store 就是每次起窗重下一遍）");
must(/\.glob\(f"\{fid\}\.\*"\)/.test(pyFn(THEME_PY, "_font_path")),
  "_font_path 不再按 id 前缀找文件（换了格式扩展名就取不到了）");
must(/def _font_label[\s\S]{0,400}isprintable\(\)/.test(THEME_PY),
  "_font_label 不再洗净控制字符/尖括号/引号（标签会进设置页的 DOM）");

// Wallpaper Engine：只读 WE 自己写下的东西，取回来那张图必须走同一道门口
const WE_DIRS_FN = pyFn(THEME_PY, "_we_install_dirs");
const WE_PREVIEW_FN = pyFn(THEME_PY, "_we_preview_for");
const WE_BLOCKS_FN = pyFn(THEME_PY, "_we_user_blocks");
const WE_DETECT_FN = pyFn(THEME_PY, "_we_detect");
for (const route of ['@router.get("/wallpaper-engine/status")', '@router.post("/wallpaper-engine/background")']) {
  must(THEME_PY.includes(route), `theme.py 缺 ${route}`);
}
must(/os\.environ\.get\("SLATE_WALLPAPER_ENGINE_DIR"\)/.test(WE_DIRS_FN)
  && /if override:\n        return \[Path\(override\)\]/.test(WE_DIRS_FN),
  "SLATE_WALLPAPER_ENGINE_DIR 不再是那句排他的话（设了它还去猜 Program Files，走查与自定义安装位都会读到别人的 WE）");
must(/sys\.platform != "win32"/.test(WE_DIRS_FN),
  "非 Windows 不再直接返回空候选（没了这道分支就会去扫注册表、去猜别的盘）");
must(/WE_PREVIEW_NAMES = \("preview\.jpg", "preview\.jpeg", "preview\.png", "preview\.gif"\)/.test(THEME_PY),
  "预览图的挑选顺序不再是静态在前、gif 兜底（gif 会在界面后面一直动）");
must(/_WE_MONITOR_RE = re\.compile\(r"\^Monitor\(\\d\+\)\$"\)/.test(THEME_PY)
  && /if not _WE_MONITOR_RE\.match\(name\) or name in seen:/.test(pyFn(THEME_PY, "_we_candidates")),
  "selectedwallpapers 里的键不再只认 MonitorN（多进程合并来的怪键会被当成一块屏）");
must(/target\.resolve\(\)\.relative_to\(root\.resolve\(\)\)/.test(pyFn(THEME_PY, "_within")),
  "_within 不再两边先 resolve（`..` 就能把 Steam 目录外的图说成在里面）");
must(/if not any\(_within\(root, cand\) for root in allowed\):\n            continue/.test(WE_PREVIEW_FN),
  "预览图不再要求落在 Steam/WE 目录内（config 是被谁改过的我们不知道，它只该用来定位目录）");
must(/cand\.stat\(\)\.st_size > MAX_BACKGROUND_BYTES/.test(WE_PREVIEW_FN),
  "预览图不看大小（取回来才被门口拒，白读一次盘）");
must(/encoding="utf-8-sig"/.test(WE_BLOCKS_FN) && /except \(OSError, ValueError\):\n        return \[\]/.test(WE_BLOCKS_FN),
  "读 WE 的 config.json 不再兜住「读到半截」（WE 运行时就在重写这个文件，那一下该说没选中，不是抛 500）");
must(/if not isinstance\(key, str\) or key\.startswith\("\?"\)/.test(WE_BLOCKS_FN),
  "_we_user_blocks 不再跳过 ?installdirectory 这类键（字符串会被当成一个用户块）");must(/"preview": \(\{"name": c\["preview"\]\.name, "bytes": c\["bytes"\]\}/.test(WE_DETECT_FN),
  "状态里那份预览不再只报文件名与大小（绝对路径会跟着状态发到浏览器）");
must(/found\.pop\("_cands", None\)/.test(pyFn(THEME_PY, "wallpaper_engine_status")),
  "status 端点不再剔掉内部那份绝对路径清单（_cands 是给 POST 用的，不该出门）");
must(/stored = _store_background\(raw\)/.test(pyFn(THEME_PY, "save_background"))
  && /stored = _store_background\(raw\)/.test(pyFn(THEME_PY, "use_wallpaper_engine_background")),
  "上传与 Wallpaper Engine 不再共用同一道门口（分两处写围栏，迟早一边紧一边松）");

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
must(/^[ \t]*"--bg": over\(bg, bgAlpha\),/m.test(DERIVE),
  "--bg 没按遮罩浓度走半透明（铺图时底色仍是不透明，图根本看不见）");
// 板块那三层（面板/输入/卡片）要跟着"板块透明度"走，而 --accent-fg / 代码块不许跟着走
must(/^[ \t]*"--bg-alt": bgAlt,/m.test(DERIVE), "--bg-alt 不再由板块透明度推导");
must(/const bgAlt = over\(panel, surfaceAlpha\);/.test(DERIVE),
  "--bg-alt 没走 over(panel, surfaceAlpha)（板块透明度滑杆对面板没作用）");
must(/^[ \t]*"--bg-input": over\(mix\(panel, "#FFFFFF", inputUp\), surfaceAlpha\),/m.test(DERIVE),
  "--bg-input 没跟板块透明度走（面板透了一半，输入框还是实色一块）");
must(/^[ \t]*"--bg-card": over\(mix\(panel, "#FFFFFF", cardUp\), surfaceAlpha\),/m.test(DERIVE),
  "--bg-card 没跟板块透明度走");
// 半透明只允许发生在"板块"这一族：填充按钮的字色与代码块跟着变就会读不清
must(/const surfaceAlpha = Math\.min\(bgAlpha, clampAlpha\(panelAlpha\)\);/.test(DERIVE),
  "板块透明度不再取 min(遮罩浓度, 板块透明度)（铺图时两层各降一档会把面板洗没）");
must(/function clampAlpha\(value\)/.test(THEME)
  && /Number\.isFinite\(value\) && value > 0 && value < 1 \? value : 1/.test(fnBody(THEME, "clampAlpha")),
  "clampAlpha 不再把脏值/缺省当'完全不透明'（undefined 会算出 NaN 的 rgba）");
must(/const bgAlpha = clampAlpha\(veil\);/.test(DERIVE),
  "底色那层跟着板块透明度走了（不铺图时 --bg 变半透明，透出来的是窗口外面）");
// 语义色整组跟亮度走，不跟用户的强调色走
must(/SEMANTIC_LIGHT/.test(THEME) && /SEMANTIC_DARK/.test(THEME), "危险/完成/需要操作三色的两套定义没了");
must(/sem\.danger/.test(DERIVE) && /sem\.ok/.test(DERIVE) && /sem\.needs/.test(DERIVE), "语义色不再成组切换");
// 第四档"夜间模式"的夜紫也走同一组语义色：内置色板里加了 --night，自定义就得跟着推导
// 两条都要按"整行取自 sem"来判：只写 /sem\.night/ 或 /"--night-dim":/ 的话，
// 兄弟那条没被毒到的 --night 会把分借走（实测：把 --night-dim 改成定值，守卫照样全绿）。
must(/"--night":\s*sem\.night,/.test(DERIVE) && /"--night-dim":\s*rgba\(sem\.night,/.test(DERIVE),
  "夜紫色（--night / --night-dim）没跟着亮度成组切换（切到自定义会留在内置色板里）");

// 文件类型图标：vscode-icons 是 <img> 引入的，吃不到 currentColor，只能靠滤镜染。
// 内置主题把滤镜写死没事，自定义主题下就得按用户挑的强调色现算，否则"部分文件图标不变色"。
must(/function hsvOf\(/.test(THEME) && /function fileIconFilter\(/.test(THEME),
  "theme_custom.js 少了把强调色换算成图标滤镜的 hsvOf / fileIconFilter");
const FILTER = fnBody(THEME, "fileIconFilter");
must(/hue-rotate\(\$\{rot\}deg\)/.test(FILTER) && /grayscale\(1\)/.test(FILTER) && /sepia\(1\)/.test(FILTER),
  "fileIconFilter 不再把彩色图标灰度化再用 sepia+hue-rotate 染成强调色（图标会保持原色）");
must(/hsvOf\(accent\)/.test(FILTER), "fileIconFilter 没从用户强调色取色相（等于写死一种颜色）");
must(/"--file-icon-color":\s*accent,/.test(DERIVE) && /"--file-icon-filter":\s*fileIconFilter\(accent, isDark\)/.test(DERIVE),
  "deriveTokens 不产出 --file-icon-color / --file-icon-filter（自定义主题下文件图标不跟着调色板）");
// style.css 那两个 var() 兜底要在：内置主题没注入这两个令牌，没兜底图标就没滤镜/没颜色。
// 两条规则各自取块再判——直接对整份 CSS 用 /img\.file-type-icon\{[^}]*var\(…/ 的话，
// 深色那条（选择器里也含 img.file-type-icon）会把浅色那条的分借走（实测：毒掉浅色那条，守卫照样绿）。
const FILE_ICON_LIGHT = (CSS.match(/(?:^|\n)img\.file-type-icon\s*\{[^}]*\}/) || [""])[0];
const FILE_ICON_DARK = (CSS.match(/\[data-theme="dark"\]\s+img\.file-type-icon\s*\{[^}]*\}/) || [""])[0];
must(/filter:\s*var\(--file-icon-filter/.test(FILE_ICON_LIGHT)
  && /filter:\s*var\(--file-icon-filter/.test(FILE_ICON_DARK),
  "img.file-type-icon 的 filter 不再是 var(--file-icon-filter, 兜底)（自定义主题下颜色进不去）",
  `light=${FILE_ICON_LIGHT.replace(/\s+/g, " ").slice(0, 70)} | dark=${FILE_ICON_DARK.replace(/\s+/g, " ").slice(0, 70)}`);
must(/\.file-icon-fallback\s*\{[^}]*color:\s*var\(--file-icon-color/.test(CSS),
  ".file-icon-fallback 的颜色不再是 var(--file-icon-color, 兜底)（兜底 SVG 不跟着调色板）");
// 字体两条腿：内置的系统字体族（只写 family 名）+ 用户自己导入的字体文件（走 @font-face）。
// RULES.md §8 的边界是"不随包带字体文件"，所以这里禁的是打进前端的字体（data: 内联、本地相对路径），
// 不是 @font-face 本身——那个现在只由后端 data/theme/fonts/ 里的文件产生。
must(!/data:font|data:application\/font/.test(THEME) && !/\.(woff2|woff|ttf|otf)["']/.test(THEME),
  "theme_custom.js 里出现了随包分发的字体引用（RULES.md §8：字体文件只能由用户导入，走后端读）");
must(/font-family: "\$\{importedFontFamily\(id\)\}"/.test(fnBody(THEME, "fontFaceRule")),
  "@font-face 的家庭名不再由 importedFontFamily(id) 生成（用户起的文件名一旦进 CSS，一个引号就能破开整条规则）");
must(/export function importedFontFamily\(id\) \{\n  return `SLATE Font \$\{id\}`;\n\}/.test(THEME),
  "importedFontFamily 不再是 'SLATE Font ' + id 这一份来源（家庭名两处拼迟早对不上）");
must(/import \{ API_BASE, IMPORTED_FONT_ID_RE \} from "\.\.\/store\.js\?v=\d{8}-\d+";/.test(THEME),
  "id 形状没从 store 那一份导过来（两处各写一个正则＝一边收下的 id 另一边拼不出样式）");
must(/export function isImportedFontId\(id\) \{\n  return IMPORTED_FONT_ID_RE\.test\(String\(id \|\| ""\)\);/.test(THEME),
  "isImportedFontId 不再统一挡 id 形状（fontUrl / @font-face / 清单都在用它）");
must(/return `\$\{API_BASE\}\/theme\/font\/\$\{id\}`;/.test(fnBody(THEME, "fontUrl")),
  "fontUrl 不再是 /theme/font/{id} 这一条");
const FACE = fnBody(THEME, "fontFaceRule");
must(/src: url\("\$\{fontUrl\(id\)\}"\);/.test(FACE) && !/format\(/.test(FACE),
  "@font-face 写了 format() 或 src 不再是 fontUrl(id)（format() 与真实格式对不上时 Chrome 直接拒用这个字体）");
must(/font-display: swap/.test(FACE), "@font-face 丢了 font-display: swap（本地字体加载中会有一段看不见字的空白）");
const BUILD_FACES = fnBody(THEME, "buildThemeCss");
must(/for \(const id of usedFontIds\(theme\)\)\s*\{\s*if \(onDisk\.has\(id\)\) faces \+= fontFaceRule\(id\);/.test(BUILD_FACES),
  "@font-face 不再只给「被选中且本机真有文件」的字体发（每条没用的都在启动时占一次带宽，指向 404 的红在控制台）");
const USED_IDS = fnBody(THEME, "usedFontIds");
must(/for \(const id of \[theme\?\.fonts\?\.main, theme\?\.fonts\?\.code\]\)/.test(USED_IDS) && /isImportedFontId\(id\)/.test(USED_IDS),
  "usedFontIds 不再只收正文/代码两格里形状合法的导入字体");
const STACKFN = fnBody(THEME, "fontStack");
must(/if \(!isImportedFontId\(fid\)\) return "";/.test(STACKFN)
  && STACKFN.includes('if (!(imported || []).some(item => item?.id === fid)) return "";')
  && STACKFN.includes('return `"${importedFontFamily(fid)}", ${tail}`;'),
  "fontStack 对导入字体的处理不再是「形状合法 + 账上有这个 id + 后面接通用族兜底」（缺一条就会拼出一个没人认识的 family）");
must(/const FONT_TAIL_MAIN = '"Microsoft YaHei", sans-serif';/.test(THEME)
  && /const FONT_TAIL_CODE = 'Consolas, "Courier New", monospace';/.test(THEME),
  "导入字体的兜底栈没了（换一台没这个文件的机器，字就没地方落）");
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
// 导入字体：只有真选了它才问后端，且问到的那份必须传进 buildThemeCss
must(/const wanted = usedFontIds\(theme\);/.test(APPLY)
  && /const index = wanted\.size \? await probeFonts\(\) : null;/.test(APPLY),
  "applyCustomTheme 不再「只在选了导入字体时才问后端」（拖一次颜色滑块就多打一次请求，或者反过来：选了字体却没问过）");
must(/buildThemeCss\(theme, \{ imageReady, fontIds \}\)/.test(APPLY),
  "探测到的字体清单没传进 buildThemeCss（@font-face 要么一条不发，要么对着 404 发）");
must(/const onDisk = options\.fontIds instanceof Set \? options\.fontIds : new Set\(\);/.test(BUILD),
  "buildThemeCss 不再按传进来的那份清单判（options 缺 fontIds 时会拿 undefined 去 .has）");
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
must(/await uploadBackground\(file\)/.test(fnBody(PANEL, "handlePick"))
  && /setCustomTheme\(\{ background: \{ enabled: true \} \}\)/.test(fnBody(PANEL, "handlePick")),
  "换图成功后没把「铺在界面上」打开（用户挑完图还得自己去勾）");
must(/picker\.value = ""/.test(PANEL), "文件控件选完没清空 value（同一张图第二次点没反应）");
must(/bgOn\.disabled = !info\.exists/.test(fnBody(PANEL, "renderBgState")),
  "本机没图时「铺在界面上」不再置灰（勾了只会得到一层半透明底色压在空屏上）");
must(/await removeBackground\(\)/.test(PANEL) && /setCustomTheme\(\{ background: \{ enabled: false \} \}\)/.test(PANEL),
  "移除背景图后没关掉那层（属性与文件两头对不上）");
// Wallpaper Engine：面板只做两件事——问状态、取一次；取回来照常铺上
must(/export async function probeWallpaperEngine\(\)/.test(THEME)
  && /return \{ installed: false, reason: "unreachable", monitors: \[\] \};/.test(fnBody(THEME, "probeWallpaperEngine")),
  "probeWallpaperEngine 不再把「问不到后端」与「没装」分成两回事（后端没起来会被说成这台机器没装 WE）");
const WE_PULL = fnBody(THEME, "pullWallpaperEngineBackground");
must(/post\("\/theme\/wallpaper-engine\/background", \{\}\)/.test(WE_PULL)
  && /stamp: Number\(digitsOnly\(res\?\.data\?\.stamp\)\) \|\| Date\.now\(\)/.test(WE_PULL)
  && /monitor: digitsOnly\(res\?\.data\?\.monitor\)/.test(WE_PULL),
  "取 WE 壁纸不再走那条通道（自己拼 url，或后端给的值不经 digitsOnly 就进界面）");
must(/btn\.disabled = !hit;/.test(fnBody(PANEL, "renderWeState")),
  "没得取的时候「取当前壁纸」不再置灰（点一下才知道没装，是最差的说明）");
must(/renderWeState\(\);/.test(fnBody(PANEL, "initThemeSettings")),
  "initThemeSettings 没问 Wallpaper Engine 的状态（那一栏永远停在「正在问…」）");
must(/el\("theme-we-pick"\)\?\.addEventListener\("click", \(\) => handlePullWallpaperEngine\(\)\);/.test(PANEL),
  "「取当前壁纸」按钮没接上处理函数（点了没反应）");
must(/el\("theme-we-refresh"\)\?\.addEventListener\("click", \(\) => renderWeState\(\)\);/.test(PANEL),
  "「重新检测」没接回 renderWeState（中途才装好 WE 的人只能重启应用才看得见）");
const WE_HANDLER = fnBody(PANEL, "handlePullWallpaperEngine");
must(/setCustomTheme\(\{ background: \{ enabled: true \} \}\);/.test(WE_HANDLER)
  && /await renderBgState\(\);\n  await renderWeState\(\);/.test(WE_HANDLER)
  && /reportError\(e, "theme_we_pull"\)/.test(WE_HANDLER),
  "取完 WE 壁纸没铺上、没重画那两行状态，或失败没上报");
must(/setCustomTheme\(\{ preset: "", colors: \{ \[field\.key\]: e\.target\.value \} \}\)/.test(PANEL),
  "手改色板没把 preset 清掉（色板已经不是那个预设了，高亮还留着）");
must(/syncFontOptions\(\);/.test(fnBody(PANEL, "initThemeSettings")),
  "字体下拉没在初始化时建好（每次同步都重建会丢焦点）");
must(!/fillSelect\(/.test(fnBody(PANEL, "renderThemeSettings")), "字体下拉还在同步里重建（改一次色重建一次，选中的框会跳掉）");
must(/optionsFor\(THEME_FONTS_MAIN, state\.customTheme\)/.test(fnBody(PANEL, "syncFontOptions"))
  && /optionsFor\(THEME_FONTS_CODE, state\.customTheme\)/.test(fnBody(PANEL, "syncFontOptions")),
  "两个字体下拉不再合并导入的字体（导入完在列表里能看到，却选不了）");
must(/else if \(!index\) hint\.textContent/.test(fnBody(PANEL, "renderFontState")),
  "字体清单问不到时不再单独说一句（后端没起来会被显示成「本机没有这个文件」）");
must(/imported\.length \? await probeFonts\(\) : null/.test(fnBody(PANEL, "renderFontState")),
  "一个都没导入也在起窗时问一遍后端（每个用户都多一次没人看的请求）");
must(/name\.textContent = item\.label \|\| item\.id/.test(fnBody(PANEL, "renderFontState")),
  "字体名不再走 textContent（用户起的文件名里带 < 就能往设置页里塞标签）");
must(!/innerHTML\s*[+=][^;]*\$\{/.test(fnBody(PANEL, "renderFontState")),
  "字体清单还在用模板串拼 innerHTML（标签/文件名一旦被当成 HTML 解析）");
// 导入/移除：上限先看、账本只在真没有这个 id 时加一行、移除要把指向它的选择一起清掉
must(/MAX_FONT_BYTES/.test(PANEL) && !/MAX_FONT_BYTES = \d/.test(PANEL),
  "面板自己又写了一份字体上限（和后端 theme.py 的 MAX_FONT_BYTES 迟早对不上）");
must(/file\.size > MAX_FONT_BYTES/.test(PANEL), "导入前不看文件大小（20MB 的字体要等后端拒了才知道）");
must(/if \(picker\) picker\.value = "";/.test(fnBody(PANEL, "handlePickFont")),
  "字体文件控件选完没清空 value（同一个文件第二次点没反应）");
must(/if \(!cur\.some\(item => item\?\.id === got\.id\)\)/.test(fnBody(PANEL, "handlePickFont"))
  && fnBody(PANEL, "handlePickFont").includes("setCustomTheme({ fonts: { imported: [...cur, { id: got.id, label: got.label }] } });"),
  "同一个字体第二次导入会再加一行，或账本那一行不再只带 id + label（后端给的是同一个内容哈希 id）");
must(/const patch = \{ imported:[\s\S]{0,200}if \(state\.customTheme\?\.fonts\?\.main === id\) patch\.main = "";/
  .test(fnBody(PANEL, "handleRemoveFont")),
  "移除字体没清掉指向它的那一格选择（家庭名会指向一个已经不存在的文件）");
must(/await removeFont\(id\)/.test(fnBody(PANEL, "handleRemoveFont"))
  && /importedFonts\(state\.customTheme\)\.filter\(item => item\?\.id !== id\)/.test(fnBody(PANEL, "handleRemoveFont")),
  "移除字体没同时收掉文件与账上那一行");
// 板块透明度：滑杆 → store → 生效，三段都要接上
must(/setCustomTheme\(\{ opacity: \{ panel: Number\.isFinite\(value\) \? value : 100 \} \}\)/.test(PANEL),
  "板块透明度滑杆没写进 store（拖了没反应，脏值也会当成 100 之外的东西）");
must(/alpha && alpha\.value !== String\(theme\.opacity\.panel\)/.test(fnBody(PANEL, "renderThemeSettings")),
  "板块透明度只在值变了时才回写滑块（正在拖的时候被反向写一次会断手感）");
must(/alphaValue\) alphaValue\.textContent = `\$\{theme\.opacity\.panel\}%`;/.test(fnBody(PANEL, "renderThemeSettings")),
  "板块透明度旁边那个数字没跟着同步");

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
  "theme-color-grid", "theme-color-field", "theme-bg-row", "theme-file-input", "theme-veil-slider", "theme-veil-value",
  "theme-font-import-row", "theme-font-list", "theme-font-item", "theme-font-name", "theme-font-meta", "theme-font-remove"]) {
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
console.log("✓ check_custom_theme：自定义主题（四个源色推导整套令牌 + 板块透明度 + 字体（含导入）+ 背景图（含 Wallpaper Engine）+ 锁明暗）接线一致");
