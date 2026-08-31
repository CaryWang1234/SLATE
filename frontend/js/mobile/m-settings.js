/**
 * SLATE Mobile — 精简设置
 * 遥控地址 + 二维码 / 模型选择 / 密钥管理 / 主题切换
 */

import { state, setCurrentModel, setModelKey, getModelKey, toggleTheme } from "../store.js?v=20260904-001";
import { get } from "../services/api.js?v=20260904-001";
import { t, mToast, mShowPrompt, mShowConfirm, mIcon } from "./m-ui.js?v=20260904-001";
import { onTab } from "./m-app.js?v=20260904-001";

function $id(id) { return document.getElementById(id); }

function modelGroups() {
  const groups = [];
  if (state.modelRegistry?.domestic?.length) groups.push([t("国产模型"), state.modelRegistry.domestic]);
  if (state.modelRegistry?.international?.length) groups.push([t("国际模型"), state.modelRegistry.international]);
  if (state.modelRegistry?.local?.length) groups.push([t("本地模型"), state.modelRegistry.local]);
  if (state.customModels?.length) groups.push([t("自定义模型"), state.customModels]);
  return groups;
}

function mkGroup(title) {
  const group = document.createElement("div");
  group.className = "m-setting-group";
  const label = document.createElement("div");
  label.className = "m-setting-label";
  label.textContent = title;
  group.appendChild(label);
  const card = document.createElement("div");
  card.className = "m-setting-card";
  group.appendChild(card);
  return { group, card };
}

function mkRow({ title, sub, click }) {
  const row = document.createElement("div");
  row.className = "m-setting-row";
  const main = document.createElement("div");
  main.className = "m-setting-row-main";
  const tEl = document.createElement("div");
  tEl.className = "m-setting-row-title";
  tEl.textContent = title;
  main.appendChild(tEl);
  if (sub) {
    const sEl = document.createElement("div");
    sEl.className = "m-setting-row-sub";
    sEl.textContent = sub;
    main.appendChild(sEl);
  }
  row.appendChild(main);
  if (click) row.addEventListener("click", click);
  return row;
}

// ── 遥控信息 ──────────────────────────────

async function renderLanInfo() {
  const box = $id("m-settings-lan");
  if (!box) return;
  box.innerHTML = "";
  let data = null;
  try {
    const res = await get("/lan/info");
    if (res?.code === 0) data = res.data;
  } catch {}
  if (!data || !data.enabled) {
    const err = document.createElement("div");
    err.className = "m-setting-row-sub";
    err.textContent = t("遥控服务未启动") + (data?.error ? ": " + data.error : t("，请重启应用"));
    box.appendChild(err);
    return;
  }
  const url = data.urls[0];
  const urlRow = document.createElement("div");
  urlRow.className = "m-setting-row";
  const main = document.createElement("div");
  main.className = "m-setting-row-main";
  const tEl = document.createElement("div");
  tEl.className = "m-setting-row-title";
  tEl.style.cssText = "font-family:var(--font-code);font-size:12px;word-break:break-all;";
  tEl.textContent = url;
  main.appendChild(tEl);
  const copyBtn = document.createElement("button");
  copyBtn.className = "m-btn-sm";
  copyBtn.textContent = t("复制");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      mToast(t("遥控地址已复制"));
    } catch {
      const range = document.createRange();
      range.selectNodeContents(tEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      mToast(t("自动复制失败，已为你选中地址"));
    }
  });
  urlRow.appendChild(main);
  urlRow.appendChild(copyBtn);
  box.appendChild(urlRow);

  const qrWrap = document.createElement("div");
  qrWrap.style.cssText = "display:flex;justify-content:center;padding:10px 0 4px;";
  const qr = document.createElement("img");
  qr.className = "m-qr";
  qr.alt = t("遥控地址二维码");
  qr.src = `${API_BASE_LAN_QR()}?t=${Date.now()}`;
  qrWrap.appendChild(qr);
  box.appendChild(qrWrap);

  const tip = document.createElement("div");
  tip.className = "m-setting-row-sub";
  tip.style.cssText = "text-align:center;";
  tip.textContent = t("手机扫码直接打开（需连入同一局域网）");
  box.appendChild(tip);
}

function API_BASE_LAN_QR() {
  return `${window.location.origin}/api/lan/qrcode`;
}

// ── 模型选择 ──────────────────────────────

function renderModelSection() {
  const box = $id("m-settings-model");
  if (!box) return;
  box.innerHTML = "";
  const { card } = mkGroup(t("模型选择"));
  const groups = modelGroups();
  if (!groups.length) {
    const row = mkRow({ title: t("暂无可用模型") });
    card.appendChild(row);
    box.appendChild(card.parentElement);
    return;
  }
  for (const [label, models] of groups) {
    for (const m of models) {
      const active = state.currentModel?.id === m.id;
      const row = mkRow({
        title: m.name || m.id,
        sub: active ? t("当前使用") : (m.context_window ? `${Math.round(m.context_window / 1024)}K 上下文` : ""),
      });
      row.classList.toggle("active", active);
      const check = document.createElement("div");
      check.className = "m-check";
      check.textContent = active ? "✓" : "";
      row.appendChild(check);
      row.addEventListener("click", () => {
        setCurrentModel(m);
        mToast(t("已切换模型：{name}", { name: m.name || m.id }));
        renderModelSection();
        renderKeySection();
      });
      card.appendChild(row);
    }
    if (groups.length > 1 && groups.indexOf([label, models]) < groups.length - 1) {
      // 组间加细分割线
      const sep = document.createElement("div");
      sep.style.cssText = "height:1px;background:var(--border);margin:0 12px;";
      card.appendChild(sep);
    }
  }
  box.appendChild(card.parentElement);
}

// ── 密钥管理 ──────────────────────────────

function renderKeySection() {
  const box = $id("m-settings-key");
  if (!box) return;
  box.innerHTML = "";
  const model = state.currentModel;
  if (!model) return;
  const { card } = mkGroup(t("密钥 · {name}", { name: model.name || model.id }));
  const has = !!getModelKey(model.id);
  const row = mkRow({
    title: has ? t("已配置密钥") : t("未配置密钥"),
    sub: model.base_url || "",
    click: async () => {
      const key = await mShowPrompt({
        title: t("配置密钥 · {name}", { name: model.name || model.id }),
        value: has ? "" : "",
        placeholder: has ? t("输入新密钥（留空清除）") : t("API Key"),
        allowEmpty: true,
      });
      if (key === null) return;
      setModelKey(model.id, key);
      mToast(key ? t("密钥已保存") : t("密钥已清除"));
      renderKeySection();
    },
  });
  card.appendChild(row);
  box.appendChild(card.parentElement);
}

// ── 主题 ──────────────────────────────────

function renderThemeSection() {
  const box = $id("m-settings-theme");
  if (!box) return;
  box.innerHTML = "";
  const { card } = mkGroup(t("外观"));
  const row = mkRow({
    title: t("深色模式"),
    sub: state.theme === "dark" ? t("开启") : t("关闭"),
    click: () => {
      toggleTheme();
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = state.theme === "dark" ? "#0A0A0A" : "#FFFFFF";
      mToast(state.theme === "dark" ? t("深色模式") : t("浅色模式"));
      renderThemeSection();
    },
  });
  const check = document.createElement("div");
  check.className = "m-check";
  check.textContent = state.theme === "dark" ? "✓" : "";
  row.appendChild(check);
  card.appendChild(row);
  box.appendChild(card.parentElement);
}

function renderAll() {
  renderModelSection();
  renderKeySection();
  renderThemeSection();
  renderLanInfo();
}

export function initMSettings() {
  onTab("settings", renderAll);
  renderAll();
}

export { t };
