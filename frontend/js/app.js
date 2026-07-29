/**
 * SLATE 主控：初始化、事件绑定、路由切换
 */

import { state, subscribe, setCurrentModel, setApiKey, setModelRegistry, loadPersistent, savePersistent } from "./store.js";
import { get, put } from "./services/api.js";
import { initChat } from "./components/chat.js";
import { initWhiteboard } from "./components/whiteboard.js";
import { initPromptFactory } from "./components/prompt_factory.js";
import { initSkillPanel } from "./components/skill_panel.js";

// ── 模型选择器 ───────────────────────────────

function populateModelSelect(registry) {
  const select = document.getElementById("model-select");
  select.innerHTML = '<option value="">选择模型…</option>';

  const groups = {
    international: "国外",
    domestic: "国内",
    local: "本地",
  };

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

  // 自定义模型选项
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "自定义模型…";
  select.appendChild(customOpt);

  // 恢复选中状态
  if (state.currentModel) {
    select.value = state.currentModel.id;
  }
}

function handleModelSelect(e) {
  const value = e.target.value;
  if (!value) return;

  if (value === "__custom__") {
    // 打开设置弹窗填写自定义模型
    openSettings();
    return;
  }

  // 在注册表中查找
  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === value);
    if (found) {
      setCurrentModel(found);
      return;
    }
  }
}

// ── 设置弹窗 ─────────────────────────────────

let settingsModal;

function openSettings() {
  settingsModal = document.getElementById("settings-modal");
  document.getElementById("setting-api-key").value = state.apiKey;
  document.getElementById("setting-base-url").value = state.customBaseUrl;
  document.getElementById("setting-model-name").value = state.customModelName;
  document.getElementById("setting-max-tokens").value = state.maxTokens;

  if (state.constitution) {
    document.getElementById("setting-constitution").value =
      JSON.stringify(state.constitution, null, 2);
  }

  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
}

async function saveSettings() {
  const apiKey = document.getElementById("setting-api-key").value.trim();
  const baseUrl = document.getElementById("setting-base-url").value.trim();
  const modelName = document.getElementById("setting-model-name").value.trim();
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;

  setApiKey(apiKey);
  state.customBaseUrl = baseUrl;
  state.customModelName = modelName;
  state.maxTokens = maxTokens;

  // 如果有自定义模型，设置它
  if (modelName && baseUrl) {
    setCurrentModel({
      id: modelName,
      name: modelName,
      provider: "openai",
      base_url: baseUrl,
      context_window: maxTokens,
    });
  }

  // 保存宪法
  const constText = document.getElementById("setting-constitution").value.trim();
  if (constText) {
    try {
      const constData = JSON.parse(constText);
      await put("/constitution", constData);
      state.constitution = constData;
    } catch (e) {
      console.warn("宪法格式错误", e);
    }
  }

  savePersistent();
  closeSettings();
}

// ── 标签页切换 ───────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = {
    chat: document.getElementById("panel-chat"),
    whiteboard: document.getElementById("panel-whiteboard"),
    factory: document.getElementById("panel-factory"),
  };

  // 桌面端显示所有面板，移动端用标签切换
  const isDesktop = () => window.innerWidth >= 1024;

  function switchTab(panelName) {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.panel === panelName));
    if (!isDesktop()) {
      Object.entries(panels).forEach(([name, el]) => {
        el.classList.toggle("active", name === panelName);
      });
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.panel));
  });

  // 响应窗口大小变化
  window.addEventListener("resize", () => {
    if (isDesktop()) {
      Object.values(panels).forEach(el => el.classList.add("active"));
    } else {
      const activeTab = document.querySelector(".tab-btn.active");
      if (activeTab) switchTab(activeTab.dataset.panel);
    }
  });
}

// ── 加载模型注册表 ───────────────────────────

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

// ── 初始化 ───────────────────────────────────

async function init() {
  // 加载持久化状态
  loadPersistent();

  // 初始化组件
  initTabs();
  initChat();
  initWhiteboard();
  initPromptFactory();
  initSkillPanel();

  // 模型选择器
  document.getElementById("model-select").addEventListener("change", handleModelSelect);

  // 设置弹窗
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.querySelectorAll("#settings-modal .modal-close, #settings-modal .modal-backdrop")
    .forEach(el => el.addEventListener("click", closeSettings));
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

  // 加载模型列表
  await loadModels();

  console.log("[SLATE] 初始化完成");
}

// 启动
document.addEventListener("DOMContentLoaded", init);
