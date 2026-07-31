/**
 * SLATE 主控 v4：AI 团队、文件上传、上下文压缩
 */

import { state, subscribe, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, setModelRegistry, loadPersistent, savePersistent, toggleTheme, resetUsage } from "./store.js?v=20260730-23";
import { get, put } from "./services/api.js?v=20260730-23";
import { initChat } from "./components/chat.js?v=20260730-23";
import { initWhiteboard } from "./components/whiteboard.js?v=20260730-23";
import { initPromptFactory } from "./components/prompt_factory.js?v=20260730-23";
import { initSkillPanel } from "./components/skill_panel.js?v=20260730-23";
import { initTeamPanel } from "./components/team.js?v=20260730-23";
import { initProjectBar } from "./components/project_bar.js?v=20260730-23";
import { initMemoryPanel } from "./components/memory.js?v=20260730-23";
import { getCurrentProject, browseFiles } from "./services/project.js?v=20260730-23";
import { setProject, setProjectFileTree } from "./store.js?v=20260730-23";

// ── Toast 通知 ──────────────────────────────

function toast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}

function safeInit(name, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    console.error(`[SLATE] ${name} 初始化失败:`, e);
    toast(`${name} 初始化失败，请查看控制台`);
    return false;
  }
}

// ── 模型选择器 ──────────────────────────────

function populateModelSelect() {
  const select = document.getElementById("model-select");
  select.innerHTML = '<option value="">选择模型…</option>';

  const groups = { international: "国外", domestic: "国内", local: "本地" };

  for (const [cat, label] of Object.entries(groups)) {
    const models = state.modelRegistry[cat];
    if (!models || models.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      const hasKey = hasModelKey(m.id);
      opt.textContent = (hasKey ? "● " : "○ ") + m.name;
      opt.title = m.base_url;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // 自定义模型
  if (state.customModels.length > 0) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = "自定义";
    for (const m of state.customModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      const hasKey = hasModelKey(m.id);
      opt.textContent = (hasKey ? "● " : "○ ") + m.name;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "+ 自定义模型…";
  select.appendChild(customOpt);

  if (state.currentModel) select.value = state.currentModel.id;
}

function handleModelSelect(e) {
  const value = e.target.value;
  if (!value) return;
  if (value === "__custom__") {
    openCustomModelModal();
    e.target.value = state.currentModel?.id || "";
    return;
  }

  // 在所有分类中查找
  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === value);
    if (found) {
      if (!hasModelKey(found.id) && found.id !== "local") {
        // 没有 API key，弹出输入
        openKeyInputModal(found);
      } else {
        setCurrentModel(found);
        resetUsage();
        toast(`已切换: ${found.name}`);
      }
      return;
    }
  }

  // 查找自定义模型
  const custom = state.customModels.find(m => m.id === value);
  if (custom) {
    if (!hasModelKey(custom.id)) {
      openKeyInputModal(custom);
    } else {
      setCurrentModel(custom);
      resetUsage();
      toast(`已切换: ${custom.name}`);
    }
  }
}

// ── 密钥输入弹窗 ────────────────────────────

let keyModal, keyModalModelName, keyModalInput;
let pendingKeyModel = null;

function openKeyInputModal(model) {
  pendingKeyModel = model;
  keyModalModelName.textContent = `${model.name} — 输入 API Key`;
  keyModalInput.value = getModelKey(model.id) || "";
  keyModalInput.placeholder = `${model.base_url}`;
  keyModal.classList.remove("hidden");
  keyModalInput.focus();
}

function saveKeyFromModal() {
  if (!pendingKeyModel) return;
  const key = keyModalInput.value.trim();
  if (key) {
    setModelKey(pendingKeyModel.id, key);
    setCurrentModel(pendingKeyModel);
    resetUsage();
    toast(`已保存密钥并切换: ${pendingKeyModel.name}`);
    populateModelSelect();
  } else {
    toast("请输入有效的 API Key");
    return;
  }
  keyModal.classList.add("hidden");
  pendingKeyModel = null;
}

// ── 自定义模型弹窗 ──────────────────────────

let customModelModal;

function openCustomModelModal() {
  customModelModal = document.getElementById("custom-model-modal");
  customModelModal.classList.remove("hidden");
}

function saveCustomModel() {
  const name = document.getElementById("custom-model-name").value.trim();
  const baseUrl = document.getElementById("custom-model-url").value.trim();
  const key = document.getElementById("custom-model-key").value.trim();
  const ctx = parseInt(document.getElementById("custom-model-ctx").value) || 32768;

  if (!name || !baseUrl) {
    toast("请填写模型名称和 Base URL");
    return;
  }

  const model = { id: name, name, provider: "openai", base_url: baseUrl, context_window: ctx };
  addCustomModel(model);
  if (key) setModelKey(name, key);
  setCurrentModel(model);
  resetUsage();
  populateModelSelect();
  customModelModal.classList.add("hidden");
  toast(`已添加自定义模型: ${name}`);

  // 清空输入
  document.getElementById("custom-model-name").value = "";
  document.getElementById("custom-model-url").value = "";
  document.getElementById("custom-model-key").value = "";
}

// ── 密钥管理面板（设置弹窗内） ──────────────

function renderKeyManagement() {
  const container = document.getElementById("key-management-list");
  if (!container) return;
  container.innerHTML = "";

  const allModels = [];
  for (const models of Object.values(state.modelRegistry)) {
    allModels.push(...models);
  }
  allModels.push(...state.customModels);

  for (const m of allModels) {
    const row = document.createElement("div");
    row.className = "key-mgmt-row";

    const info = document.createElement("div");
    info.className = "key-mgmt-info";
    const nameSpan = document.createElement("span");
    nameSpan.className = "key-mgmt-name";
    nameSpan.textContent = m.name;
    const urlSpan = document.createElement("span");
    urlSpan.className = "key-mgmt-url";
    urlSpan.textContent = m.base_url;
    info.appendChild(nameSpan);
    info.appendChild(urlSpan);

    const inputWrap = document.createElement("div");
    inputWrap.className = "key-mgmt-input-wrap";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "setting-input key-mgmt-input";
    input.value = getModelKey(m.id) || "";
    input.placeholder = hasModelKey(m.id) ? "已配置 (留空删除)" : "未配置";

    const saveBtn = document.createElement("button");
    saveBtn.className = "icon-btn key-mgmt-save";
    saveBtn.textContent = "✓";
    saveBtn.title = "保存";
    saveBtn.addEventListener("click", () => {
      const val = input.value.trim();
      setModelKey(m.id, val);
      populateModelSelect();
      toast(val ? `已保存: ${m.name}` : `已删除: ${m.name}`);
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(saveBtn);

    row.appendChild(info);
    row.appendChild(inputWrap);
    container.appendChild(row);
  }
}

// ── 设置弹窗 ────────────────────────────────

let settingsModal;

function openSettings() {
  settingsModal = document.getElementById("settings-modal");
  document.getElementById("setting-max-tokens").value = 64000;
  if (state.constitution) {
    document.getElementById("setting-constitution").value = JSON.stringify(state.constitution, null, 2);
  }
  renderKeyManagement();
  settingsModal.classList.remove("hidden");
}

function closeSettings() { settingsModal.classList.add("hidden"); }

async function saveSettings() {
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;
  state.maxTokens = maxTokens;

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
      populateModelSelect();
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

  safeInit("标签页", initTabs);
  safeInit("对话", initChat);
  safeInit("黑板", initWhiteboard);
  safeInit("提示词工厂", initPromptFactory);
  safeInit("技能面板", initSkillPanel);
  safeInit("AI 团队", initTeamPanel);
  safeInit("项目栏", initProjectBar);
  safeInit("记忆面板", initMemoryPanel);
  safeInit("快捷键", initKeyboardShortcuts);

  // 模型选择
  document.getElementById("model-select").addEventListener("change", handleModelSelect);

  // 密钥管理按钮
  document.getElementById("btn-manage-keys").addEventListener("click", openSettings);

  // 密钥输入弹窗
  keyModal = document.getElementById("key-input-modal");
  keyModalModelName = document.getElementById("key-modal-model-name");
  keyModalInput = document.getElementById("key-modal-input");
  document.getElementById("btn-save-key").addEventListener("click", saveKeyFromModal);
  keyModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => keyModal.classList.add("hidden"));
  });

  // 自定义模型弹窗
  customModelModal = document.getElementById("custom-model-modal");
  document.getElementById("btn-save-custom-model").addEventListener("click", saveCustomModel);
  customModelModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => customModelModal.classList.add("hidden"));
  });

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

  // 自动恢复上次打开的项目
  if (state._lastProjectPath) {
    const res = await getCurrentProject();
    if (res.code === 0 && res.data) {
      setProject(res.data);
    } else {
      const { openProject } = await import("./services/project.js?v=20260730-23");
      const openRes = await openProject(state._lastProjectPath);
      if (openRes.code === 0) setProject(openRes.data);
    }
    // 确保文件树加载
    const browseRes = await browseFiles("");
    if (browseRes.code === 0) setProjectFileTree(browseRes.data);
  }

  console.log("[SLATE] v3 初始化完成");
}

document.addEventListener("DOMContentLoaded", init);

export { toast };
