/**
 * SLATE 主控 v2：主题切换、面板拖拽、键盘快捷键、Toast 系统
 */

import { state, subscribe, setCurrentModel, setApiKey, setModelRegistry, loadPersistent, savePersistent, toggleTheme } from "./store.js";
import { get, put } from "./services/api.js";
import { initChat } from "./components/chat.js";
import { initWhiteboard } from "./components/whiteboard.js";
import { initPromptFactory } from "./components/prompt_factory.js";
import { initSkillPanel } from "./components/skill_panel.js";

// ── Toast 通知 ──────────────────────────────

function toast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}

// ── 模型选择器 ──────────────────────────────

function populateModelSelect(registry) {
  const select = document.getElementById("model-select");
  select.innerHTML = '<option value="">选择模型…</option>';

  const groups = { international: "国外", domestic: "国内", local: "本地" };

  for (const [cat, label] of Object.entries(groups)) {
    const models = registry[cat];
    if (!models || models.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "自定义模型…";
  select.appendChild(customOpt);

  if (state.currentModel) select.value = state.currentModel.id;
}

function handleModelSelect(e) {
  const value = e.target.value;
  if (!value) return;
  if (value === "__custom__") { openSettings(); return; }

  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === value);
    if (found) { setCurrentModel(found); toast(`已切换: ${found.name}`); return; }
  }
}

// ── 设置弹窗 ────────────────────────────────

let settingsModal;

function openSettings() {
  settingsModal = document.getElementById("settings-modal");
  document.getElementById("setting-api-key").value = state.apiKey;
  document.getElementById("setting-base-url").value = state.customBaseUrl;
  document.getElementById("setting-model-name").value = state.customModelName;
  document.getElementById("setting-max-tokens").value = state.maxTokens;
  if (state.constitution) {
    document.getElementById("setting-constitution").value = JSON.stringify(state.constitution, null, 2);
  }
  settingsModal.classList.remove("hidden");
}

function closeSettings() { settingsModal.classList.add("hidden"); }

async function saveSettings() {
  const apiKey = document.getElementById("setting-api-key").value.trim();
  const baseUrl = document.getElementById("setting-base-url").value.trim();
  const modelName = document.getElementById("setting-model-name").value.trim();
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;

  setApiKey(apiKey);
  state.customBaseUrl = baseUrl;
  state.customModelName = modelName;
  state.maxTokens = maxTokens;

  if (modelName && baseUrl) {
    setCurrentModel({ id: modelName, name: modelName, provider: "openai", base_url: baseUrl, context_window: maxTokens });
  }

  const constText = document.getElementById("setting-constitution").value.trim();
  if (constText) {
    try {
      const constData = JSON.parse(constText);
      await put("/constitution", constData);
      state.constitution = constData;
    } catch (e) { /* ignore */ }
  }

  savePersistent();
  closeSettings();
  toast("设置已保存");
}

// ── 标签页切换 ──────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");

  function switchTab(panelName) {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.panel === panelName));
    document.querySelectorAll(".panel").forEach(el => {
      el.classList.toggle("active", el.id === `panel-${panelName}`);
    });
  }

  tabs.forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.panel)));
}

// ── 键盘快捷键 ──────────────────────────────

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Ctrl+N: 新建对话
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      document.getElementById("btn-new-chat")?.click();
    }
    // Ctrl+D: 切换主题
    if (e.ctrlKey && e.key === "d") {
      e.preventDefault();
      toggleTheme();
      toast(state.theme === "dark" ? "深色模式" : "浅色模式");
    }
    // Escape: 关闭弹窗
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not(.hidden)").forEach(m => m.classList.add("hidden"));
    }
  });
}

// ── 加载模型 ────────────────────────────────

async function loadModels() {
  try {
    const res = await get("/proxy/models");
    if (res.code === 0) {
      setModelRegistry(res.data);
      populateModelSelect(res.data);
    }
  } catch (e) {
    console.warn("加载模型列表失败:", e);
  }
}

// ── 初始化 ──────────────────────────────────

async function init() {
  loadPersistent();

  // 应用保存的主题
  document.documentElement.setAttribute("data-theme", state.theme);

  initTabs();
  initChat();
  initWhiteboard();
  initPromptFactory();
  initSkillPanel();
  initKeyboardShortcuts();

  // 模型选择
  document.getElementById("model-select").addEventListener("change", handleModelSelect);

  // 主题切换
  document.getElementById("btn-theme").addEventListener("click", () => {
    toggleTheme();
    toast(state.theme === "dark" ? "深色模式" : "浅色模式");
  });

  // 设置弹窗
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.querySelectorAll("#settings-modal .modal-close, #settings-modal .modal-backdrop")
    .forEach(el => el.addEventListener("click", closeSettings));
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

  await loadModels();
  console.log("[SLATE] v2 初始化完成");
}

document.addEventListener("DOMContentLoaded", init);

export { toast };
