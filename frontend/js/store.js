/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

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

  // 每个对话的 TODOLIST（convId → items），Harness 六阶段闭环的任务清单
  conversationTodos: {},

  // 模型列表
  modelRegistry: {},

  // 对话
  currentConversationId: null,
  conversations: [],
  messages: [],

  // 黑板
  boardCards: [],

  // 宪法
  constitution: null,

  // MCP 内置工具 + SKILL.md 技能
  skills: { mcp: {}, skills: {} },

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
    reviewLongStall: true, // 长回复停顿也送审（默认开）
  },

  // 输出控制：单次输出上限与“输出文件不限量”开关
  outputSettings: {
    maxTokens: 16384,
    unlimitedFileOutput: true,
  },

  // 文件写入：自动确认创建/修改（默认开；关闭后回到预览手动接受）
  fileOutput: {
    autoApply: true,
  },

  // Harness 自主执行：模型自主多轮调用工具直至任务完成
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
    theme: state.theme,
    modelKeys: state.modelKeys,
    customModels: state.customModels,
    currentModelId: state.currentModel?.id || state._pendingModelId || null,
    boardCards: state.boardCards,
    memories: state.memories,
    userProfile: state.userProfile,
    promptSnippets: state.promptSnippets,
    lastProjectPath: state.project?.path || null,
    conversationUsage: state.conversationUsage,
    conversationTodos: state.conversationTodos,
    autoReview: state.autoReview,
    outputSettings: state.outputSettings,
    fileOutput: state.fileOutput,
    harness: state.harness,
    notifications: state.notifications,
    knowledgeSettings: state.knowledgeSettings,
    activeExpertId: state.activeExpertId,
    useResponses: state.useResponses,
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
    modelKeys: data.modelKeys || {},
    customModels: data.customModels || [],
    currentModelId: data.currentModelId || null,
    autoReview: data.autoReview || {},
    outputSettings: data.outputSettings || {},
    fileOutput: data.fileOutput || {},
    knowledgeSettings: data.knowledgeSettings || {},
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
    state.theme = data.theme || "light";
    state.modelKeys = data.modelKeys || {};
    state.customModels = data.customModels || [];
    state.boardCards = data.boardCards || [];
    state.memories = data.memories || [];
    state.userProfile = data.userProfile || {};
    state.promptSnippets = data.promptSnippets || [];
    state._pendingModelId = data.currentModelId;
    state._lastProjectPath = data.lastProjectPath || null;
    state.conversationUsage = data.conversationUsage || {};
    state.conversationTodos = data.conversationTodos || {};
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
    state.useResponses = data.useResponses || false;
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
    state.knowledgeSettings = {
      ...state.knowledgeSettings,
      ...(data.knowledgeSettings || {}),
    };
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
  state.theme = t;
  document.documentElement.setAttribute("data-theme", t);
  savePersistent();
  notify("theme", t);
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

// ── TODOLIST（按对话隔离，Harness 任务清单） ────────

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
  state.memories = list;
  savePersistent();
  notify("memories", list);
}

function addMemory(mem) {
  const newMem = { ...mem, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now() };
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
  state.promptSnippets = list;
  notify("promptSnippets", list);
}

function setKnowledgeContext(items) {
  state.knowledgeContext = Array.isArray(items) ? items : [];
  notify("knowledgeContext", state.knowledgeContext);
}

function addPromptSnippet(snip) {
  const newSnip = {
    id: snip.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: snip.createdAt || Date.now(),
    ...snip,
  };
  state.promptSnippets.push(newSnip);
  notify("promptSnippets", state.promptSnippets);
}

function removePromptSnippet(id) {
  state.promptSnippets = state.promptSnippets.filter(s => s.id !== id);
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
  setConversations, setBoardCards, addBoardCard,
  setConstitution, setSkills, setModelRegistry,
  setProject, setProjectFileTree,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  setKnowledgeContext,
  savePersistent, loadPersistent,
};
