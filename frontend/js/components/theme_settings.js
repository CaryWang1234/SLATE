/**
 * 设置 → 自定义主题：四个源色 + 字体 + 背景图，改一处就整套重算并即时生效。
 *
 * 生效通道只有一条：控件写 setCustomTheme（store），store 通知 customTheme，
 * app.js 那一份订阅调 applyCustomTheme 注入样式。这里不再自己调 apply——
 * 两处各注入一次会打架，还会让"改了什么"和"页面上看到什么"对不上。
 */
import { state, setCustomTheme } from "../store.js?v=20261001-002";
import {
  THEME_FONTS_MAIN, THEME_FONTS_CODE, THEME_PRESETS,
  uploadBackground, removeBackground, probeBackground,
} from "../services/theme_custom.js?v=20261001-002";
import { dlgToast } from "../services/dialog.js?v=20261001-002";
import { t } from "../services/i18n.js?v=20261001-002";
import { reportError } from "../services/error_sink.js?v=20261001-002";

// 背景图上限与后端 theme.py 的 MAX_BACKGROUND_BYTES 同一个数
const MAX_BG_BYTES = 4 * 1024 * 1024;

const COLOR_FIELDS = [
  { key: "bg", id: "theme-color-bg", label: "页面底色" },
  { key: "panel", id: "theme-color-panel", label: "面板底色" },
  { key: "text", id: "theme-color-text", label: "正文颜色" },
  { key: "accent", id: "theme-color-accent", label: "强调颜色" },
];

function el(id) {
  return document.getElementById(id);
}

function fillSelect(select, list) {
  if (!select) return;
  select.innerHTML = "";
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.id ? t(item.label) : t("跟随系统");
    select.appendChild(opt);
  }
}

// 下拉的选项只在初始化时建一次：每次改色都重建一遍会把刚选完的字体框的焦点弄丢
function buildFontSelects() {
  fillSelect(el("theme-font-main"), THEME_FONTS_MAIN);
  fillSelect(el("theme-font-code"), THEME_FONTS_CODE);
}

function buildPresets() {
  const row = el("theme-preset-row");
  if (!row) return;
  row.innerHTML = "";
  for (const preset of THEME_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-preset-btn";
    btn.dataset.preset = preset.id;
    btn.title = t(preset.name);
    // 色块取的是预设自己的源色，不是界面配色：这里是"给用户看这张色板长什么样"，
    // 用 var() 反而每个预设都长成同一个颜色。
    for (const key of ["bg", "panel", "text", "accent"]) {
      const chip = document.createElement("span");
      chip.className = "theme-preset-chip";
      chip.style.backgroundColor = preset.colors[key];
      btn.appendChild(chip);
    }
    const name = document.createElement("span");
    name.className = "theme-preset-name";
    name.textContent = t(preset.name);
    btn.appendChild(name);
    btn.addEventListener("click", () => {
      setCustomTheme({ preset: preset.id, colors: { ...preset.colors }, fonts: { ...preset.fonts } });
    });
    row.appendChild(btn);
  }
}

/** 背景图那一行的说明文字：图在不在本机、多大 */
async function renderBgState() {
  const hint = el("theme-bg-state");
  const bgOn = el("theme-bg-enabled");
  const info = await probeBackground();
  if (hint) {
    hint.textContent = info.exists
      ? t("背景图已存在本机（{size}）", { size: `${Math.round((info.bytes || 0) / 1024)} KB` })
      : t("本机还没有背景图");
  }
  // 没有图就别让勾"使用背景图"：勾了也只能得到一层半透明底色压在空屏上
  if (bgOn) bgOn.disabled = !info.exists;
  return info;
}

export function renderThemeSettings() {
  const theme = state.customTheme;
  if (!theme) return;
  const box = el("theme-custom-enabled");
  if (box) box.checked = theme.enabled === true;
  for (const field of COLOR_FIELDS) {
    const input = el(field.id);
    // 只在值真的变了时才写：正在拖的取色器被反向写一次值，手感会立刻断掉
    if (input && input.value !== theme.colors[field.key]) input.value = theme.colors[field.key];
  }
  const fontMain = el("theme-font-main");
  if (fontMain && fontMain.value !== theme.fonts.main) fontMain.value = theme.fonts.main || "";
  const fontCode = el("theme-font-code");
  if (fontCode && fontCode.value !== theme.fonts.code) fontCode.value = theme.fonts.code || "";
  const bgOn = el("theme-bg-enabled");
  if (bgOn) bgOn.checked = theme.background.enabled === true;
  const veil = el("theme-bg-veil");
  if (veil) veil.value = String(theme.background.veil);
  const veilValue = el("theme-bg-veil-value");
  if (veilValue) veilValue.textContent = `${theme.background.veil}%`;
  for (const btn of [...document.querySelectorAll(".theme-preset-btn")]) {
    btn.classList.toggle("is-active", btn.dataset.preset === theme.preset);
  }
}

async function handlePick(file) {
  if (!file) return;
  if (file.size > MAX_BG_BYTES) {
    dlgToast(t("背景图不能超过 4MB，换一张小一点的"));
    return;
  }
  const picker = el("theme-bg-file");
  try {
    await uploadBackground(file);
    // 换图顺手把"使用背景图"打开：刚挑了一张图却说没开，比直接拒收更难解释
    setCustomTheme({ background: { enabled: true } });
    dlgToast(t("背景图已换"));
  } catch (e) {
    reportError(e, "theme_background_upload");
    dlgToast(t("背景图上传失败，请换一张再试"));
  }
  // 清空 value：同一张图第二次选也要能触发 change
  if (picker) picker.value = "";
  await renderBgState();
}

export function initThemeSettings() {
  buildPresets();
  buildFontSelects();
  renderThemeSettings();
  renderBgState();

  el("theme-custom-enabled")?.addEventListener("change", (e) => {
    const on = e.target.checked === true;
    setCustomTheme({ enabled: on });
    if (on) dlgToast(t("自定义主题已开启：深色/浅色切换暂时锁定"));
  });
  for (const field of COLOR_FIELDS) {
    el(field.id)?.addEventListener("input", (e) => {
      // 手改色板就把预设标记清掉：这时看到的颜色不再属于任何一个预设
      setCustomTheme({ preset: "", colors: { [field.key]: e.target.value } });
    });
  }
  el("theme-font-main")?.addEventListener("change", (e) => {
    setCustomTheme({ fonts: { main: e.target.value } });
  });
  el("theme-font-code")?.addEventListener("change", (e) => {
    setCustomTheme({ fonts: { code: e.target.value } });
  });
  el("theme-bg-enabled")?.addEventListener("change", (e) => {
    setCustomTheme({ background: { enabled: e.target.checked === true } });
  });
  el("theme-bg-pick")?.addEventListener("click", () => el("theme-bg-file")?.click());
  el("theme-bg-file")?.addEventListener("change", (e) => handlePick(e.target.files?.[0]));
  el("theme-bg-clear")?.addEventListener("click", async () => {
    try {
      await removeBackground();
      setCustomTheme({ background: { enabled: false } });
      dlgToast(t("背景图已移除"));
    } catch (e) {
      reportError(e, "theme_background_remove");
      dlgToast(t("背景图移除失败"));
    }
    await renderBgState();
  });
  el("theme-bg-veil")?.addEventListener("input", (e) => {
    const value = parseInt(e.target.value, 10);
    setCustomTheme({ background: { veil: Number.isFinite(value) ? value : 72 } });
  });
  el("theme-reset")?.addEventListener("click", () => {
    const paper = THEME_PRESETS[0];
    setCustomTheme({ preset: "", colors: { ...paper.colors }, fonts: { main: "", code: "" }, background: { enabled: false } });
    dlgToast(t("已恢复默认色板"));
  });
}
