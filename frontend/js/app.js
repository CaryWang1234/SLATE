/**
 * SLATE 主控 v4：AI 团队、文件上传、上下文压缩
 */

import { state, subscribe, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel, setModelRegistry, loadPersistent, loadSharedPersistent, savePersistent, toggleTheme, resetUsage } from "./store.js?v=20260807-12";
import { get, put } from "./services/api.js?v=20260807-12";
import { initChat } from "./components/chat.js?v=20260807-12";
import { initWhiteboard } from "./components/whiteboard.js?v=20260807-12";
import { initPromptFactory } from "./components/prompt_factory.js?v=20260807-12";
import { initSkillPanel } from "./components/skill_panel.js?v=20260807-12";
import { initTeamPanel } from "./components/team.js?v=20260807-12";
import { initProjectBar } from "./components/project_bar.js?v=20260807-12";
import { initMemoryPanel } from "./components/memory.js?v=20260807-12";
import { initSchedule } from "./components/schedule.js?v=20260807-12";
import { getCurrentProject, browseFiles } from "./services/project.js?v=20260807-12";
import { setProject, setProjectFileTree } from "./store.js?v=20260807-12";

// ── Toast 通知 ──────────────────────────────

let activePanelName = "chat";

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

function switchPanel(panelName) {
  activePanelName = panelName || "chat";
  document.querySelectorAll(".tab-btn").forEach(t => {
    t.classList.toggle("active", t.dataset.panel === activePanelName);
  });
  document.querySelectorAll(".panel").forEach(el => {
    el.classList.toggle("active", el.id === `panel-${activePanelName}`);
  });
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

function getAllModels() {
  const allModels = [];
  for (const models of Object.values(state.modelRegistry)) {
    allModels.push(...models);
  }
  allModels.push(...state.customModels);
  return allModels;
}

function populateAutoReviewModelSelect() {
  const select = document.getElementById("setting-auto-review-model");
  if (!select) return;
  const currentValue = state.autoReview?.modelId || "";
  select.innerHTML = '<option value="">跟随当前主模型</option>';
  for (const m of getAllModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    select.appendChild(opt);
  }
  select.value = currentValue;
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

let pendingKeyModel = null;

function openKeyInputModal(model) {
  pendingKeyModel = model;
  openSettings({ focusModelId: model.id });
  toast(`请先配置 API Key: ${model.name}`);
}

// ── 自定义模型编辑 ──────────────────────────

let editingCustomModelId = null;

function openCustomModelModal(model = null) {
  switchPanel("settings");
  renderCustomModelManagement();
  renderKeyManagement();
  editingCustomModelId = model?.id || null;
  const editor = document.getElementById("custom-model-editor");
  document.getElementById("custom-model-editor-title").textContent = model ? "编辑自定义模型" : "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = model ? "保存" : "添加";
  document.getElementById("custom-model-name").value = model?.id || "";
  document.getElementById("custom-model-url").value = model?.base_url || "";
  document.getElementById("custom-model-key").value = model ? (getModelKey(model.id) || "") : "";
  document.getElementById("custom-model-ctx").value = model?.context_window || 32768;
  editor?.classList.remove("hidden");
  document.getElementById("custom-model-name").focus();
}

function closeCustomModelModal() {
  document.getElementById("custom-model-editor")?.classList.add("hidden");
  editingCustomModelId = null;
  document.getElementById("custom-model-name").value = "";
  document.getElementById("custom-model-url").value = "";
  document.getElementById("custom-model-key").value = "";
  document.getElementById("custom-model-ctx").value = "32768";
  document.getElementById("custom-model-editor-title").textContent = "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = "添加";
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
  const duplicate = state.customModels.some(m => m.id === name && m.id !== editingCustomModelId);
  if (duplicate) {
    toast("模型名称已存在");
    return;
  }

  if (editingCustomModelId) {
    updateCustomModel(editingCustomModelId, model);
  } else {
    addCustomModel(model);
  }
  setModelKey(name, key);
  const wasEditing = !!editingCustomModelId;
  setCurrentModel(model);
  resetUsage();
  populateModelSelect();
  populateAutoReviewModelSelect();
  renderCustomModelManagement();
  renderKeyManagement();
  closeCustomModelModal();
  toast(wasEditing ? `已更新自定义模型: ${name}` : `已添加自定义模型: ${name}`);
}

// ── 密钥管理面板（设置弹窗内） ──────────────

function renderCustomModelManagement() {
  const container = document.getElementById("custom-model-list");
  if (!container) return;
  container.innerHTML = "";

  if (!state.customModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无自定义模型";
    container.appendChild(empty);
    return;
  }

  for (const model of state.customModels) {
    const row = document.createElement("div");
    row.className = "custom-model-row";

    const info = document.createElement("div");
    info.className = "custom-model-info";
    const name = document.createElement("div");
    name.className = "custom-model-name";
    name.textContent = model.name;
    const meta = document.createElement("div");
    meta.className = "custom-model-meta";
    meta.textContent = `${model.base_url} · ${model.context_window || 32768} ctx`;
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "custom-model-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "✎";
    editBtn.title = "编辑";
    editBtn.addEventListener("click", () => openCustomModelModal(model));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn custom-model-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "删除";
    deleteBtn.addEventListener("click", () => {
      if (!confirm(`删除自定义模型「${model.name}」？`)) return;
      removeCustomModel(model.id);
      if (state.autoReview?.modelId === model.id) {
        state.autoReview.modelId = "";
        savePersistent();
      }
      populateModelSelect();
      populateAutoReviewModelSelect();
      renderCustomModelManagement();
      renderKeyManagement();
      toast(`已删除自定义模型: ${model.name}`);
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

function renderKeyManagement() {
  const container = document.getElementById("key-management-list");
  if (!container) return;
  container.innerHTML = "";

  const allModels = getAllModels().filter(m => !state.customModels.some(custom => custom.id === m.id));

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
    input.dataset.modelKey = m.id;
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
      if (val && pendingKeyModel?.id === m.id) {
        setCurrentModel(m);
        resetUsage();
        pendingKeyModel = null;
        populateModelSelect();
      }
      toast(val ? `已保存: ${m.name}` : `已删除: ${m.name}`);
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(saveBtn);

    row.appendChild(info);
    row.appendChild(inputWrap);
    container.appendChild(row);
  }
  if (!allModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无内置模型";
    container.appendChild(empty);
  }
}

// ── 设置弹窗 ────────────────────────────────

let settingsModal;

function openSettings(options = {}) {
  settingsModal = document.getElementById("panel-settings");
  document.getElementById("setting-max-tokens").value = 64000;
  document.getElementById("setting-output-max-tokens").value = state.outputSettings?.maxTokens || 16384;
  document.getElementById("setting-output-unlimited").checked = state.outputSettings?.unlimitedFileOutput !== false;
  document.getElementById("setting-auto-review-enabled").checked = state.autoReview?.enabled !== false;
  document.getElementById("setting-auto-review-min-chars").value = state.autoReview?.minChars || 120;
  populateAutoReviewModelSelect();
  if (state.constitution) {
    document.getElementById("setting-constitution").value = JSON.stringify(state.constitution, null, 2);
  }
  renderCustomModelManagement();
  renderKeyManagement();
  switchPanel("settings");
  if (options.focusModelId) {
    requestAnimationFrame(() => {
      const input = [...document.querySelectorAll("[data-model-key]")]
        .find(el => el.dataset.modelKey === options.focusModelId);
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  } else if (options.focusConstitution) {
    requestAnimationFrame(() => {
      const input = document.getElementById("setting-constitution");
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  }
}

function closeSettings() { switchPanel("chat"); }

async function saveSettings() {
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;
  state.maxTokens = maxTokens;
  state.outputSettings = {
    maxTokens: Math.max(1024, Math.min(65536, parseInt(document.getElementById("setting-output-max-tokens").value) || 16384)),
    unlimitedFileOutput: document.getElementById("setting-output-unlimited").checked,
  };
  state.autoReview = {
    enabled: document.getElementById("setting-auto-review-enabled").checked,
    modelId: document.getElementById("setting-auto-review-model").value || "",
    minChars: Math.max(20, Math.min(800, parseInt(document.getElementById("setting-auto-review-min-chars").value) || 120)),
  };

  const constText = document.getElementById("setting-constitution").value.trim();
  if (constText) {
    try {
      const constData = JSON.parse(constText);
      if (state.project) {
        const { updateProjectConfig } = await import("./services/project.js?v=20260807-12");
        const config = { ...(state.project.config || {}), constitution: constData };
        const res = await updateProjectConfig(config);
        if (res.code === 0) setProject(res.data);
      } else {
        await put("/constitution", constData);
      }
      state.constitution = constData;
    } catch (e) { /* ignore */ }
  }

  savePersistent();
  toast("设置已保存");
}

// ── 标签页切换 ──────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(tab => tab.addEventListener("click", () => switchPanel(tab.dataset.panel)));
}

// ── 键盘快捷键 ──────────────────────────────

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && copySelectedText()) {
      e.preventDefault();
      return;
    }
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

function getSelectedPageText() {
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return "";
  const selection = window.getSelection();
  const text = selection ? selection.toString() : "";
  return text.trim() ? text : "";
}

function copySelectedText() {
  const text = getSelectedPageText();
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      try { document.execCommand("copy"); } catch (e) {}
    });
  } else {
    try { document.execCommand("copy"); } catch (e) {}
  }
  return true;
}

function initSelectionCopySupport() {
  document.addEventListener("copy", (e) => {
    const text = getSelectedPageText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
}

// ── 加载模型 ────────────────────────────────

async function loadModels() {
  try {
    const res = await get("/proxy/models");
    if (res.code === 0) {
      setModelRegistry(res.data);
      populateModelSelect();
      populateAutoReviewModelSelect();
    }
  } catch (e) {
    console.warn("加载模型列表失败:", e);
  }
}

// ── 初始化 ──────────────────────────────────

async function init() {
  loadPersistent();
  await loadSharedPersistent();

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
  safeInit("定时任务", initSchedule);
  safeInit("快捷键", initKeyboardShortcuts);
  safeInit("文本复制", initSelectionCopySupport);

  // 模型选择
  document.getElementById("model-select").addEventListener("change", handleModelSelect);

  // 密钥管理按钮
  document.getElementById("btn-manage-keys").addEventListener("click", openSettings);

  // 自定义模型编辑器
  document.getElementById("btn-save-custom-model").addEventListener("click", saveCustomModel);
  document.getElementById("btn-add-custom-model-settings")?.addEventListener("click", () => openCustomModelModal());
  document.getElementById("btn-cancel-custom-model")?.addEventListener("click", closeCustomModelModal);

  // 主题切换
  document.getElementById("btn-theme").addEventListener("click", () => {
    toggleTheme();
    toast(state.theme === "dark" ? "深色模式" : "浅色模式");
  });

  // 设置弹窗
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  window.addEventListener("slate:open-settings", (event) => openSettings(event.detail || {}));

  await loadModels();

  // 自动恢复上次打开的项目
  if (state._lastProjectPath) {
    const res = await getCurrentProject();
    if (res.code === 0 && res.data) {
      setProject(res.data);
    } else {
      const { openProject } = await import("./services/project.js?v=20260807-12");
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
