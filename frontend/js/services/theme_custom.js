/**
 * 自定义主题：用户只填四个源色（底色 / 面板 / 正文 / 强调），其余配色令牌由这里推导，
 * 拼成一段只在 html[data-custom-theme="1"] 作用域里生效的 CSS 注入 <head>。
 *
 * 为什么是"推导"而不是"每个令牌都能改"：style.css 里颜色令牌有三十几个，逐个开放会把
 * 设置页变成一张表格，而且用户改一个 --text-secondary 很容易改出对比度不足的四不像。
 * 源色只有四个，剩下的按亮度与对比度算出来，既保证成套又保证正文层级读得清。
 *
 * 关掉自定义主题时这里会把整段样式和两个 data 属性一起摘掉，一个像素都不留——
 * 明暗切换（setTheme）在生效期间被 store.js 挡住，两套色不会同时说话。
 */
import { API_BASE } from "../store.js?v=20261001-002";
import { get, post, del } from "./api.js?v=20261001-002";

const STYLE_ID = "slate-custom-theme";

// ── 颜色工具 ────────────────────────────────

function hexToRgb(hex) {
  const s = String(hex || "").trim().replace("#", "");
  if (s.length !== 6 || /[^0-9A-Fa-f]/.test(s)) return [0, 0, 0];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function channel(v) {
  const toHex = Math.max(0, Math.min(255, Math.round(v))).toString(16);
  return toHex.length === 1 ? `0${toHex}` : toHex;
}

function rgbToHex(rgb) {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`.toUpperCase();
}

/** 按权重 wb 把 b 混进 a（wb=0 得到 a，wb=1 得到 b） */
function mix(a, b, wb) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * wb, A[1] + (B[1] - A[1]) * wb, A[2] + (B[2] - A[2]) * wb]);
}

function channelLum(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 相对亮度（WCAG 定义），0 最暗 1 最亮 */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/** 两色的对比度（1..21） */
export function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 把文字色按 alpha 压在底色上，算出实际看到的那个色 */
function blended(ink, bg, alpha) {
  return mix(bg, ink, alpha);
}

/** 从 start 这个透明度起步，不够读就往不透明方向加，直到达到 minRatio */
function alphaFor(ink, bg, start, minRatio) {
  let a = start;
  while (a < 1 && contrastRatio(blended(ink, bg, a), bg) < minRatio) a = Math.min(1, Math.round((a + 0.04) * 100) / 100);
  return Math.round(a * 100) / 100;
}

/**
 * 强调色要能当正文用（链接、金色标题、选中态都读它），对比不足就往远离底色的方向压。
 * "远离"要按底色算，不能按强调色自己算：拿 #FFFFFF 配浅底时，比亮度得到的方向是"往白里混"，
 * 混 twelve 次还是白，对比度卡在 1.05 出不来——浅底上的纯白强调色就是这么糊掉的。
 */
function accentFor(accent, bg, minRatio) {
  let c = accent;
  const toward = contrastRatio("#000000", bg) >= contrastRatio("#FFFFFF", bg) ? "#000000" : "#FFFFFF";
  for (let i = 0; i < 12 && contrastRatio(c, bg) < minRatio; i++) c = mix(c, toward, 0.12);
  return c;
}

/**
 * 给定一个填充色，选近黑还是近白当上面的文字。
 * 按实测对比度挑，不靠"亮度过半就换"这种阈值——中亮度那一带（比如 #58A6D8 这种蓝）
 * 用白字对比只有 2.6，肉眼就是"选中态看不清"。
 */
function inkOrPaper(color) {
  const dark = "#1A1A1A", light = "#FFFFFF";
  return contrastRatio(dark, color) >= contrastRatio(light, color) ? dark : light;
}

// ── 令牌推导 ────────────────────────────────

// 深色/浅色两套语义色（危险 / 完成 / 需要操作）：跟随内置主题的做法，按底色亮度整组切换，
// 不跟着用户的强调色走——红色报错误、绿色报完成是跨主题的固定约定，换掉会让人认不出状态。
const SEMANTIC_LIGHT = { danger: "#C0392B", ok: "#2D6A3F", needs: "#9A5B12" };
const SEMANTIC_DARK = { danger: "#E2725B", ok: "#6FBF9A", needs: "#E0A94A" };

/**
 * 四个源色 → 整套颜色令牌。veil 是 0..1 的底色不透明度，只有铺背景图时才传（<1），
 * 让 --bg / --bg-alt / --msg-asst-bg 变半透明，图从底下透出来；卡片与输入框保持不透明，
 * 正文仍然骑在实色上。
 */
export function deriveTokens(colors, veil) {
  const bg = colors.bg, panel = colors.panel, ink = colors.text;
  const isDark = luminance(bg) < 0.45;
  const sem = isDark ? SEMANTIC_DARK : SEMANTIC_LIGHT;
  const accent = accentFor(colors.accent, bg, 4.5);
  const translucent = Number.isFinite(veil) && veil > 0 && veil < 1;

  // 面板/输入/卡片：浅色往白提、深色往白提一点点，保持"浮在面板上"的层次
  const inputUp = isDark ? 0.05 : 0.92;
  const cardUp = isDark ? 0.035 : 0.85;
  const bgAlt = translucent ? rgba(panel, veil) : panel;
  // 代码块在任何主题下都是深底亮字：正文读的是长句，代码要一眼和正文分开
  const codeBg = isDark ? mix(bg, "#FFFFFF", 0.06) : mix(ink, "#000000", 0.12);
  const toastBg = isDark ? mix(accent, "#FFFFFF", 0.10) : ink;

  return {
    "--bg": translucent ? rgba(bg, veil) : bg,
    "--bg-alt": bgAlt,
    "--bg-input": mix(panel, "#FFFFFF", inputUp),
    "--bg-card": mix(panel, "#FFFFFF", cardUp),
    "--text": ink,
    "--text-secondary": rgba(ink, alphaFor(ink, bg, isDark ? 0.74 : 0.80, 4.5)),
    "--text-muted": rgba(ink, alphaFor(ink, bg, isDark ? 0.56 : 0.68, 4.5)),
    "--text-faint": rgba(ink, alphaFor(ink, bg, isDark ? 0.30 : 0.40, 2.5)),
    "--border": rgba(ink, isDark ? 0.20 : 0.13),
    "--border-hover": isDark ? mix(accent, "#FFFFFF", 0.18) : ink,
    "--accent-bg": isDark ? accent : ink,
    // 填充上的文字永远取实色纸底：底图开着时 --bg 是半透明的，不能拿它当字色
    "--accent-fg": bg,
    "--accent": accent,
    "--gold": accent,
    "--gold-dim": rgba(colors.accent, isDark ? 0.12 : 0.08),
    "--gold-strong": isDark ? accent : mix(accent, "#000000", 0.18),
    "--code-bg": codeBg,
    "--code-fg": mix(codeBg, "#FFFFFF", 0.82),
    "--inline-code-bg": rgba(ink, isDark ? 0.12 : 0.06),
    "--msg-user-bg": isDark ? mix(bg, "#FFFFFF", 0.09) : ink,
    "--msg-user-fg": isDark ? ink : bg,
    "--msg-asst-bg": bgAlt,
    "--selection-bg": accent,
    "--selection-fg": inkOrPaper(accent),
    "--scrollbar-thumb": rgba(ink, isDark ? 0.24 : 0.17),
    "--board-grid": isDark ? mix(bg, "#FFFFFF", 0.07) : mix(bg, "#000000", 0.06),
    "--modal-backdrop": isDark ? "rgba(0, 0, 0, 0.66)" : rgba(ink, 0.34),
    "--toast-bg": toastBg,
    "--toast-fg": inkOrPaper(toastBg),
    "--danger": sem.danger,
    "--danger-dim": rgba(sem.danger, isDark ? 0.14 : 0.08),
    "--ok": sem.ok,
    "--ok-dim": rgba(sem.ok, isDark ? 0.14 : 0.10),
    "--task-needs": sem.needs,
    "--task-needs-dim": rgba(sem.needs, isDark ? 0.16 : 0.10),
  };
}

// ── 字体：只开放系统里已有的字体族，不引字体文件（RULES.md §8）──

export const THEME_FONTS_MAIN = [
  { id: "", label: "跟随系统", stack: "" },
  { id: "yahei", label: "微软雅黑", stack: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { id: "pingfang", label: "苹方", stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
  { id: "sourcehan", label: "思源黑体", stack: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
  { id: "arial", label: "Arial", stack: 'Arial, Helvetica, "Microsoft YaHei", sans-serif' },
  { id: "georgia", label: "Georgia 衬线", stack: 'Georgia, "Times New Roman", "Songti SC", serif' },
];

export const THEME_FONTS_CODE = [
  { id: "", label: "跟随系统", stack: "" },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  { id: "jbm", label: "JetBrains Mono", stack: '"JetBrains Mono", Consolas, "Courier New", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "menlo", label: "Menlo / Monaco", stack: 'Menlo, Monaco, Consolas, monospace' },
];

function fontStack(list, id) {
  const hit = list.find(item => item.id === id);
  return hit ? hit.stack : "";
}

// ── 预设：一套源色 + 可选字体，点一下整份填进色板 ──────────────

export const THEME_PRESETS = [
  { id: "paper", name: "纸墨", colors: { bg: "#FCFBF8", panel: "#F3EFE8", text: "#26231E", accent: "#836523" }, fonts: { main: "", code: "" } },
  { id: "goldnight", name: "夜金", colors: { bg: "#0A0A0A", panel: "#131313", text: "#E8DCC8", accent: "#CEB381" }, fonts: { main: "", code: "" } },
  { id: "mistblue", name: "雾蓝", colors: { bg: "#F5F8FA", panel: "#E8F0F6", text: "#1F2A33", accent: "#2F6DA8" }, fonts: { main: "", code: "" } },
  { id: "seadeep", name: "深海", colors: { bg: "#0B1220", panel: "#131D2E", text: "#CFE0F2", accent: "#58A6D8" }, fonts: { main: "", code: "" } },
  { id: "pine", name: "松墨", colors: { bg: "#0F1512", panel: "#17211C", text: "#D6E2D9", accent: "#6FBF9A" }, fonts: { main: "", code: "" } },
  { id: "moss", name: "苔绿", colors: { bg: "#F6F7F0", panel: "#E9EDDC", text: "#26301E", accent: "#5B7A2A" }, fonts: { main: "", code: "" } },
  { id: "clay", name: "陶土", colors: { bg: "#FBF4EF", panel: "#F3E4DA", text: "#33231C", accent: "#A85A38" }, fonts: { main: "", code: "" } },
  { id: "plum", name: "暮紫", colors: { bg: "#F7F4FA", panel: "#EDE6F5", text: "#2A2233", accent: "#6E4E9E" }, fonts: { main: "", code: "" } },
  { id: "graphite", name: "石墨", colors: { bg: "#1A1C1E", panel: "#232629", text: "#DDE1E5", accent: "#B9C4CE" }, fonts: { main: "", code: "" } },
  { id: "paperprint", name: "铅字", colors: { bg: "#FFFFFF", panel: "#F1F1F1", text: "#1A1A1A", accent: "#37507A" }, fonts: { main: "georgia", code: "consolas" } },
];

export function presetOf(id) {
  return THEME_PRESETS.find(item => item.id === id) || null;
}

// ── 背景图：文件只存在本机 data/theme/，状态里只留开关与缓存串 ──

// 探测到的图（存在与否、多大、mtime 缓存串）。图不在本机时不铺那层，避免半透明底色压在空气上。
let bgImage = { exists: false, stamp: 0, bytes: 0 };

function digitsOnly(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

export function backgroundUrl(stamp) {
  return `${API_BASE}/theme/background?v=${digitsOnly(stamp || bgImage.stamp)}`;
}

export async function probeBackground() {
  try {
    const res = await get("/theme/background/status");
    const data = res?.data || {};
    bgImage = {
      exists: data.exists === true,
      stamp: Number(digitsOnly(data.stamp)) || 0,
      bytes: Number(digitsOnly(data.bytes)) || 0,
    };
  } catch {
    bgImage = { exists: false, stamp: 0, bytes: 0 };
  }
  return { ...bgImage };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读不出这张图片"));
    reader.readAsDataURL(file);
  });
}

/** 换背景图：整张图走 base64 交给后端落盘，成功后把缓存串更新到新图 */
export async function uploadBackground(file) {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) throw new Error("图片读取为空");
  const res = await post("/theme/background", { data: dataUrl });
  bgImage = {
    exists: true,
    stamp: Number(digitsOnly(res?.data?.stamp)) || Date.now(),
    bytes: Number(digitsOnly(res?.data?.bytes)) || 0,
  };
  return { bytes: bgImage.bytes, ext: res?.data?.ext || "" };
}

export async function removeBackground() {
  await del("/theme/background");
  bgImage = { exists: false, stamp: 0, bytes: 0 };
}

// ── 注入 ────────────────────────────────────

/**
 * 生成那段 CSS。选择器要带上 data-theme 的两种取值：style.css 里
 * html[data-ui="codex"][data-theme="dark"] 这类规则的特异度是 (0,2,1)，
 * 只写 html[data-custom-theme="1"] 会在通用 UI 模式的深色下被它盖住。
 */
export function buildThemeCss(theme, options = {}) {
  const imageReady = options.imageReady === true;
  const tokens = deriveTokens(theme.colors, imageReady ? (theme.background.veil || 72) / 100 : 1);
  const lines = Object.entries(tokens).map(([key, value]) => `  ${key}: ${value};`);

  const mainStack = fontStack(THEME_FONTS_MAIN, theme.fonts.main);
  const codeStack = fontStack(THEME_FONTS_CODE, theme.fonts.code);
  if (mainStack) lines.push(`  --font-main: ${mainStack};`);
  if (codeStack) {
    lines.push(`  --font-code: ${codeStack};`);
    lines.push("  --font-mono: var(--font-code);");
  }

  const selector = [
    'html[data-custom-theme="1"][data-theme="light"]',
    'html[data-custom-theme="1"][data-theme="dark"]',
    'html[data-custom-theme="1"]',
  ].join(",\n");

  let css = `${selector} {\n${lines.join("\n")}\n}`;
  if (imageReady) {
    // 图压在 html 自己的底色之上、所有面板之下：负 z-index 的伪元素就走这个层位，
    // 面板因此要半透明才看得见它——上面的 deriveTokens 已经把 --bg 那一组换成带 alpha 的值。
    css += `\nhtml[data-custom-bg="1"]::before {\n`
      + "  content: \"\";\n"
      + "  position: fixed;\n"
      + "  inset: 0;\n"
      + "  z-index: -1;\n"
      + `  background: url("${backgroundUrl()}") center / cover no-repeat;\n`
      + "}\n";
  }
  return css;
}

function styleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

function clearInjected() {
  const el = document.getElementById(STYLE_ID);
  if (el) el.remove();
  const root = document.documentElement;
  root.removeAttribute("data-custom-theme");
  root.removeAttribute("data-custom-bg");
}

/**
 * 生效一次自定义主题。返回 {active, imageReady}：
 * imageReady 为假说明本机没有那张图（或后端没起来），这时配色照常生效但不铺底图，
 * 免得底色变成半透明压在一片空白上。
 */
export async function applyCustomTheme(theme) {
  if (!theme || theme.enabled !== true) {
    clearInjected();
    return { active: false, imageReady: false };
  }
  let imageReady = false;
  if (theme.background && theme.background.enabled === true) {
    // 每次生效都重新探测：图可能被另一台设备删了，也可能刚在这台机器上换过一张
    imageReady = (await probeBackground()).exists;
  }
  styleEl().textContent = buildThemeCss(theme, { imageReady });
  const root = document.documentElement;
  root.setAttribute("data-custom-theme", "1");
  if (imageReady) root.setAttribute("data-custom-bg", "1");
  else root.removeAttribute("data-custom-bg");
  return { active: true, imageReady };
}

export { STYLE_ID as CUSTOM_THEME_STYLE_ID };
