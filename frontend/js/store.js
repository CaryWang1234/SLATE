/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

const API_BASE = "http://127.0.0.1:8000/api";

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

  // 技能
  skills: { builtin: {}, custom: {} },

  // 项目
  project: null,        // { path, name, config, constitution }
  projectFileTree: [],  // 当前浏览的目录内容

  // 记忆
  memories: [],

  // 用户资料
  userProfile: {},

  // 提示词素材
  promptSnippets: [],
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

function savePersistent() {
  const data = {
    theme: state.theme,
    modelKeys: state.modelKeys,
    customModels: state.customModels,
    currentModelId: state.currentModel?.id || null,
    boardCards: state.boardCards,
    lastProjectPath: state.project?.path || null,
    conversationUsage: state.conversationUsage,
  };
  try { localStorage.setItem("slate_state", JSON.stringify(data)); } catch (e) {}
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
    state._pendingModelId = data.currentModelId;
    state._lastProjectPath = data.lastProjectPath || null;
    state.conversationUsage = data.conversationUsage || {};
  } catch (e) {}
}

// ── 状态修改 ────────────────────────────────

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
  }
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
  notify("memories", list);
}

function addMemory(mem) {
  const newMem = { ...mem, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now() };
  state.memories.push(newMem);
  notify("memories", state.memories);
}

function updateMemory(id, updates) {
  const idx = state.memories.findIndex(m => m.id === id);
  if (idx >= 0) {
    Object.assign(state.memories[idx], updates);
    notify("memories", state.memories);
  }
}

function removeMemory(id) {
  state.memories = state.memories.filter(m => m.id !== id);
  notify("memories", state.memories);
}

// ── 用户资料 ────────────────────────────────

function setUserProfile(profile) {
  state.userProfile = { ...state.userProfile, ...profile };
  notify("userProfile", state.userProfile);
}

function resetUserProfile() {
  state.userProfile = {};
  notify("userProfile", state.userProfile);
}

// ── 提示词素材 ──────────────────────────────

function setPromptSnippets(list) {
  state.promptSnippets = list;
  notify("promptSnippets", list);
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
  setTheme, toggleTheme, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel,
  resetUsage, restoreUsageForConversation, setConversationUsage, addUsage, estimateTokens, estimateContextTokens,
  setMessages, addMessage, updateLastAssistantMessage,
  setConversations, setBoardCards, addBoardCard,
  setConstitution, setSkills, setModelRegistry,
  setProject, setProjectFileTree,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  savePersistent, loadPersistent,
};
