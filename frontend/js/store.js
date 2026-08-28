/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

import { makeId } from "./services/utils.js?v=20260828-125";

const API_ORIGIN = typeof window !== "undefined" && window.location?.origin
  ? window.location.origin
  : "http://127.0.0.1:8000";
const API_BASE = `${API_ORIGIN}/api`;

const state = {
  // 主题
  theme: "light",

  // 当前选中的模型
  currentModel: null,

  // 每个模型的 API Key（modelId → key）
  modelKeys: {},

  // 自定义模型（用户手动添加的）
  customModels: [],

  // 用量统计（当前对话）
  usage: {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    messageCount: 0,
  },

  // 每个对话的用量统计（convId → usage）
  conversationUsage: {},

  // 每个对话的 TODOLIST（convId → items），目标六阶段闭环的任务清单
  conversationTodos: {},

  // 模型列表
  modelRegistry: {},

  // 对话
  currentConversationId: null,
  conversations: [],
  messages: [],

  // 黑板
  boardCards: [],
  boardNotes: [],
  boardStrokes: [],

  // 宪法
  constitution: null,

  // 内置工具 + SKILL.md 技能 + 远程 MCP 工具
  skills: { mcp: {}, skills: {}, remote: {} },

  // 项目
  project: null,        // { path, name, config, constitution }
  projectFileTree: [],  // 当前浏览的目录内容

  // 记忆
  memories: [],

  // 用户资料
  userProfile: {},

  // 提示词素材
  promptSnippets: [],

  // 自动推进审阅（短回复停顿 + 长回复只陈述计划不行动）
  autoReview: {
    enabled: true,
    modelId: "",
    minChars: 120,
    reviewLongStall: true, // 默认积极审查长回复停顿，避免需要用户反复发送“继续”
  },

  // 输出控制：单次输出上限与“输出文件不限量”开关
  maxTokens: 64000,

  outputSettings: {
    maxTokens: 16384,
    unlimitedFileOutput: true,
  },

  // 文件写入：自动确认创建/修改（默认开；关闭后回到预览手动接受）
  fileOutput: {
    autoApply: true,
  },

  // 目标自主执行：模型自主多轮调用工具直至任务完成
  harness: {
    enabled: false,
    maxRounds: 50,
  },

  // 任务完成通知：音效 + 系统通知
  notifications: {
    soundEnabled: true,
    systemNotifEnabled: false,
  },

  knowledgeSettings: {
    enabled: true,
    topK: 5,
  },
  knowledgeContext: [],

  // 专家包：当前对话激活的专家（注入 persona + rules）
  activeExpertId: "",
  activeExpert: null,

  // Responses API 模式（可选，仅部分模型支持）
  useResponses: false,

  // 首次启动引导：跨 localStorage / 桌面共享配置保存，避免 WebView profile 波动后反复弹出
  onboardingSeen: false,

  // 命令权限模式：ask=人工审批（高危命令弹窗询问）auto=自动审批（高危命令自动放行）full=完全访问（跳过高危判定；灾难级命令始终拦截）
  permissionMode: "ask",

  // 联网搜索配置：engine=auto（Bing+DDG 合并）/ bing / ddg；renderJs=auto（正文过短自动渲染）/ on / off
  webSearch: { engine: "auto", renderJs: "auto" },
};

// ── 订阅者 ──────────────────────────────────

const listeners = {};

function subscribe(key, fn) {
  if (!listeners[key]) listeners[key] = [];
  listeners[key].push(fn);
}

function notify(key, data) {
  (listeners[key] || []).forEach(fn => fn(data));
}

// ── 持久化 ──────────────────────────────────

function buildPersistentData() {
  return {
    theme: normalizeTheme(state.theme),
    modelKeys: state.modelKeys,
    customModels: state.customModels,
    currentModelId: state.currentModel?.id || state._pendingModelId || null,
    boardCards: state.boardCards,
    boardNotes: state.boardNotes,
    boardStrokes: state.boardStrokes,
    memories: state.memories,
    userProfile: state.userProfile,
    promptSnippets: state.promptSnippets,
    lastProjectPath: state.project?.path || null,
    conversationUsage: state.conversationUsage,
    conversationTodos: state.conversationTodos,
    maxTokens: state.maxTokens,
    autoReview: state.autoReview,
    outputSettings: state.outputSettings,
    fileOutput: state.fileOutput,
    harness: state.harness,
    notifications: state.notifications,
    knowledgeSettings: state.knowledgeSettings,
    activeExpertId: state.activeExpertId,
    useResponses: state.useResponses,
    onboardingSeen: state.onboardingSeen === true,
    permissionMode: state.permissionMode,
    webSearch: normalizeWebSearch(state.webSearch),
  };
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizePermissionMode(value) {
  return ["ask", "auto", "full"].includes(value) ? value : "ask";
}

function normalizeWebSearch(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    engine: ["auto", "bing", "ddg"].includes(v.engine) ? v.engine : "auto",
    renderJs: ["auto", "on", "off"].includes(v.renderJs) ? v.renderJs : "auto",
  };
}

function saveLocalPersistent(data = buildPersistentData()) {
  try { localStorage.setItem("slate_state", JSON.stringify(data)); } catch (e) {}
}

function savePersistent() {
  const data = buildPersistentData();
  saveLocalPersistent(data);
  saveSharedPersistent(data);
}

function getSharedPersistentData(data = buildPersistentData()) {
  return {
    theme: normalizeTheme(data.theme),
    modelKeys: data.modelKeys || {},
    customModels: data.customModels || [],
    currentModelId: data.currentModelId || null,
    maxTokens: data.maxTokens || 64000,
    autoReview: data.autoReview || {},
    outputSettings: data.outputSettings || {},
    fileOutput: data.fileOutput || {},
    harness: data.harness || {},
    notifications: data.notifications || {},
    knowledgeSettings: data.knowledgeSettings || {},
    activeExpertId: data.activeExpertId || "",
    useResponses: data.useResponses === true,
    onboardingSeen: data.onboardingSeen === true,
    permissionMode: normalizePermissionMode(data.permissionMode),
    webSearch: normalizeWebSearch(data.webSearch),
  };
}

function saveSharedPersistent(data) {
  try {
    fetch(`${API_BASE}/settings/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: getSharedPersistentData(data) }),
    }).catch(() => {});
  } catch (e) {}
}

function loadPersistent() {
  try {
    const raw = localStorage.getItem("slate_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    state.theme = normalizeTheme(data.theme);
    state.modelKeys = data.modelKeys || {};
    state.customModels = data.customModels || [];
    state.boardCards = data.boardCards || [];
    state.boardNotes = Array.isArray(data.boardNotes) ? data.boardNotes : [];
    state.boardStrokes = Array.isArray(data.boardStrokes) ? data.boardStrokes : [];
    state.memories = data.memories || [];
    state.userProfile = data.userProfile || {};
    state.promptSnippets = data.promptSnippets || [];
    state._pendingModelId = data.currentModelId;
    state._lastProjectPath = data.lastProjectPath || null;
    state.conversationUsage = data.conversationUsage || {};
    state.conversationTodos = data.conversationTodos || {};
    state.maxTokens = Math.max(1000, parseInt(data.maxTokens) || 64000);
    state.autoReview = {
      ...state.autoReview,
      ...(data.autoReview || {}),
    };
    state.outputSettings = {
      ...state.outputSettings,
      ...(data.outputSettings || {}),
    };
    state.fileOutput = {
      ...state.fileOutput,
      ...(data.fileOutput || {}),
    };
    state.harness = {
      ...state.harness,
      ...(data.harness || {}),
    };
    // 旧版本持久化的 maxRounds=20 统一提升到 50 轮上限
    if ((state.harness.maxRounds || 0) < 50) state.harness.maxRounds = 50;
    state.notifications = {
      ...state.notifications,
      ...(data.notifications || {}),
    };
    state.knowledgeSettings = {
      ...state.knowledgeSettings,
      ...(data.knowledgeSettings || {}),
    };
    state.activeExpertId = data.activeExpertId || "";
    state.useResponses = data.useResponses === true;
    state.onboardingSeen = data.onboardingSeen === true;
    state.permissionMode = normalizePermissionMode(data.permissionMode);
    state.webSearch = normalizeWebSearch(data.webSearch);
  } catch (e) {}
}

async function loadSharedPersistent() {
  try {
    const resp = await fetch(`${API_BASE}/settings/state`, { cache: "no-store" });
    if (!resp.ok) return;
    const res = await resp.json();
    const data = res?.data || {};
    state.modelKeys = { ...(data.modelKeys || {}), ...state.modelKeys };
    if (Array.isArray(data.customModels) && data.customModels.length > 0) {
      const merged = [...state.customModels];
      for (const model of data.customModels) {
        if (model?.id && !merged.some(item => item.id === model.id)) merged.push(model);
      }
      state.customModels = merged;
    }
    if (!state._pendingModelId && data.currentModelId) {
      state._pendingModelId = data.currentModelId;
    }
    if (Object.prototype.hasOwnProperty.call(data, "theme")) {
      state.theme = normalizeTheme(data.theme);
    }
    if (Object.prototype.hasOwnProperty.call(data, "maxTokens")) {
      state.maxTokens = Math.max(1000, parseInt(data.maxTokens) || 64000);
    }
    state.autoReview = {
      ...state.autoReview,
      ...(data.autoReview || {}),
    };
    state.outputSettings = {
      ...state.outputSettings,
      ...(data.outputSettings || {}),
    };
    state.fileOutput = {
      ...state.fileOutput,
      ...(data.fileOutput || {}),
    };
    state.harness = {
      ...state.harness,
      ...(data.harness || {}),
    };
    if ((state.harness.maxRounds || 0) < 50) state.harness.maxRounds = 50;
    state.notifications = {
      ...state.notifications,
      ...(data.notifications || {}),
    };
    state.knowledgeSettings = {
      ...state.knowledgeSettings,
      ...(data.knowledgeSettings || {}),
    };
    if (Object.prototype.hasOwnProperty.call(data, "activeExpertId")) {
      state.activeExpertId = data.activeExpertId || "";
    }
    if (Object.prototype.hasOwnProperty.call(data, "useResponses")) {
      state.useResponses = data.useResponses === true;
    }
    if (Object.prototype.hasOwnProperty.call(data, "onboardingSeen")) {
      state.onboardingSeen = data.onboardingSeen === true;
    }
    if (Object.prototype.hasOwnProperty.call(data, "permissionMode")) {
      state.permissionMode = normalizePermissionMode(data.permissionMode);
    }
    if (Object.prototype.hasOwnProperty.call(data, "webSearch")) {
      state.webSearch = normalizeWebSearch(data.webSearch);
    }
    saveLocalPersistent();
  } catch (e) {}
}

// ── 状态修改 ────────────────────────────────

function setActiveExpertId(id, detail = null) {
  state.activeExpertId = id || "";
  state.activeExpert = detail || null;
  savePersistent();
  notify("activeExpert", state.activeExpert);
}

function setTheme(t) {
  state.theme = normalizeTheme(t);
  document.documentElement.setAttribute("data-theme", state.theme);
  savePersistent();
  notify("theme", state.theme);
}

function toggleTheme() {
  setTheme(state.theme === "light" ? "dark" : "light");
}

function setCurrentModel(model) {
  state.currentModel = model;
  savePersistent();
  notify("model", model);
}

function setModelKey(modelId, key) {
  if (key) {
    state.modelKeys[modelId] = key;
  } else {
    delete state.modelKeys[modelId];
  }
  savePersistent();
  notify("modelKeys", state.modelKeys);
}

function getModelKey(modelId) {
  return state.modelKeys[modelId] || "";
}

function hasModelKey(modelId) {
  return !!state.modelKeys[modelId];
}

function addCustomModel(model) {
  if (!state.customModels.find(m => m.id === model.id)) {
    state.customModels.push(model);
    savePersistent();
    notify("customModels", state.customModels);
  }
}

function updateCustomModel(originalId, model) {
  const idx = state.customModels.findIndex(m => m.id === originalId);
  if (idx < 0) return false;
  state.customModels[idx] = model;
  if (originalId !== model.id && state.modelKeys[originalId] && !state.modelKeys[model.id]) {
    state.modelKeys[model.id] = state.modelKeys[originalId];
    delete state.modelKeys[originalId];
  }
  if (state.currentModel?.id === originalId) {
    state.currentModel = model;
    notify("model", model);
  }
  savePersistent();
  notify("customModels", state.customModels);
  notify("modelKeys", state.modelKeys);
  return true;
}

function removeCustomModel(modelId) {
  const idx = state.customModels.findIndex(m => m.id === modelId);
  if (idx < 0) return false;
  state.customModels.splice(idx, 1);
  delete state.modelKeys[modelId];
  if (state.currentModel?.id === modelId) {
    state.currentModel = null;
    notify("model", null);
  }
  savePersistent();
  notify("customModels", state.customModels);
  notify("modelKeys", state.modelKeys);
  return true;
}

function resetUsage() {
  // 保存当前对话的用量
  if (state.currentConversationId) {
    state.conversationUsage[state.currentConversationId] = { ...state.usage };
  }
  state.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
  notify("usage", state.usage);
}

function restoreUsageForConversation(convId) {
  const saved = state.conversationUsage[convId];
  if (saved) {
    state.usage = { ...saved };
  } else {
    state.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
  }
  notify("usage", state.usage);
}

function setConversationUsage(convId, usage) {
  state.conversationUsage[convId] = { ...usage };
}

// ── TODOLIST（按对话隔离，目标任务清单） ────────

function getConversationTodos(convId) {
  return state.conversationTodos[convId || "_scratch"] || [];
}

function setConversationTodos(convId, items) {
  const key = convId || "_scratch";
  const clean = Array.isArray(items) ? items.filter(t => t && t.content) : [];
  if (!clean.length) delete state.conversationTodos[key];
  else state.conversationTodos[key] = clean;
  savePersistent();
  notify("todos", getConversationTodos(key));
}

function addUsage(usage) {
  if (!usage) return;
  state.usage.promptTokens += usage.prompt_tokens || 0;
  state.usage.completionTokens += usage.completion_tokens || 0;
  state.usage.totalTokens = state.usage.promptTokens + state.usage.completionTokens;
  state.usage.messageCount += 1;
  notify("usage", state.usage);
}

function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英文混合约 3 字符/token
  return Math.ceil(text.length / 3);
}

function estimateContextTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || "") + 4; // role overhead
  }
  return total;
}

function setMessages(msgs) {
  state.messages = msgs;
  notify("messages", msgs);
}

function addMessage(msg) {
  state.messages.push(msg);
  notify("messages", state.messages);
}

function updateLastAssistantMessage(content) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === "assistant") {
      state.messages[i].content = content;
      notify("messages", state.messages);
      return;
    }
  }
}

function setConversations(list) {
  state.conversations = list;
  notify("conversations", list);
}

function setBoardCards(cards) {
  state.boardCards = cards;
  savePersistent();
  notify("boardCards", cards);
}

function addBoardCard(card) {
  state.boardCards.push(card);
  savePersistent();
  notify("boardCards", state.boardCards);
}

function setBoardNotes(notes) {
  state.boardNotes = Array.isArray(notes) ? notes : [];
  savePersistent();
  notify("boardNotes", state.boardNotes);
}

function setBoardStrokes(strokes) {
  state.boardStrokes = Array.isArray(strokes) ? strokes : [];
  savePersistent();
  notify("boardStrokes", state.boardStrokes);
}

function setConstitution(data) {
  state.constitution = data;
  notify("constitution", data);
}

function setSkills(data) {
  state.skills = data;
  notify("skills", data);
}

function setProject(data) {
  state.project = data;
  if (data) {
    savePersistent();
    // 如果项目有自己的宪法，覆盖全局宪法
    if (data.constitution) {
      setConstitution(data.constitution);
    }
  }
  notify("project", data);
}

function setProjectFileTree(data) {
  state.projectFileTree = data;
  notify("projectFileTree", data);
}

// ── 记忆管理 ────────────────────────────────

function setMemories(list) {
  state.memories = (Array.isArray(list) ? list : []).map(mem => ({
    ...mem,
    id: mem.id || makeId(),
    category: mem.category || "general",
    content: mem.content || "",
    createdAt: mem.createdAt || (mem.created_at ? Math.round(Number(mem.created_at) * 1000) : Date.now()),
  }));
  savePersistent();
  notify("memories", state.memories);
}

function addMemory(mem) {
  const newMem = {
    ...mem,
    id: mem.id || makeId(),
    category: mem.category || "general",
    content: mem.content || "",
    createdAt: mem.createdAt || (mem.created_at ? Math.round(Number(mem.created_at) * 1000) : Date.now()),
  };
  state.memories.push(newMem);
  savePersistent();
  notify("memories", state.memories);
  return newMem;
}

function updateMemory(id, updates) {
  const idx = state.memories.findIndex(m => m.id === id);
  if (idx >= 0) {
    Object.assign(state.memories[idx], updates);
    savePersistent();
    notify("memories", state.memories);
  }
}

function removeMemory(id) {
  state.memories = state.memories.filter(m => m.id !== id);
  savePersistent();
  notify("memories", state.memories);
}

// ── 用户资料 ────────────────────────────────

function setUserProfile(profile) {
  state.userProfile = { ...state.userProfile, ...profile };
  savePersistent();
  notify("userProfile", state.userProfile);
}

function resetUserProfile() {
  state.userProfile = {};
  savePersistent();
  notify("userProfile", state.userProfile);
}

// ── 提示词素材 ──────────────────────────────

function setPromptSnippets(list) {
  state.promptSnippets = (Array.isArray(list) ? list : []).map(snip => ({
    ...snip,
    id: snip.id || makeId(),
    createdAt: snip.createdAt || (snip.created_at ? Math.round(Number(snip.created_at) * 1000) : Date.now()),
  }));
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function setKnowledgeContext(items) {
  state.knowledgeContext = Array.isArray(items) ? items : [];
  notify("knowledgeContext", state.knowledgeContext);
}

function addPromptSnippet(snip) {
  const newSnip = {
    id: snip.id || makeId(),
    createdAt: snip.createdAt || Date.now(),
    ...snip,
  };
  state.promptSnippets.push(newSnip);
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function removePromptSnippet(id) {
  state.promptSnippets = state.promptSnippets.filter(s => s.id !== id);
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function setModelRegistry(registry) {
  state.modelRegistry = registry;
  if (state._pendingModelId) {
    for (const category of Object.values(registry)) {
      const found = category.find(m => m.id === state._pendingModelId);
      if (found) { setCurrentModel(found); break; }
    }
    delete state._pendingModelId;
  }
  notify("modelRegistry", registry);
}

export {
  API_BASE, state, subscribe, notify,
  setTheme, toggleTheme, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel,
  setActiveExpertId,
  resetUsage, restoreUsageForConversation, setConversationUsage, addUsage, estimateTokens, estimateContextTokens,
  getConversationTodos, setConversationTodos,
  loadSharedPersistent,
  setMessages, addMessage, updateLastAssistantMessage,
  setConversations, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes,
  setConstitution, setSkills, setModelRegistry,
  setProject, setProjectFileTree,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  setKnowledgeContext,
  savePersistent, loadPersistent,
};
