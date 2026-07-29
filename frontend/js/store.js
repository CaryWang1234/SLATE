/**
 * SLATE 全局状态管理 v2
 * 管理主题、模型、对话历史、上下文池、黑板卡片
 */

const API_BASE = "http://127.0.0.1:8000/api";

const state = {
  // 主题
  theme: "light",

  // 当前选中的模型
  currentModel: null,
  apiKey: "",
  customBaseUrl: "",
  customModelName: "",
  maxTokens: 64000,

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
    apiKey: state.apiKey,
    customBaseUrl: state.customBaseUrl,
    customModelName: state.customModelName,
    maxTokens: state.maxTokens,
    currentModelId: state.currentModel?.id || null,
    boardCards: state.boardCards,
  };
  try { localStorage.setItem("slate_state", JSON.stringify(data)); } catch (e) {}
}

function loadPersistent() {
  try {
    const raw = localStorage.getItem("slate_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    state.theme = data.theme || "light";
    state.apiKey = data.apiKey || "";
    state.customBaseUrl = data.customBaseUrl || "";
    state.customModelName = data.customModelName || "";
    state.maxTokens = data.maxTokens || 64000;
    state.boardCards = data.boardCards || [];
    state._pendingModelId = data.currentModelId;
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

function setApiKey(key) {
  state.apiKey = key;
  savePersistent();
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
  setTheme, toggleTheme, setCurrentModel, setApiKey,
  setMessages, addMessage, updateLastAssistantMessage,
  setConversations, setBoardCards, addBoardCard,
  setConstitution, setSkills, setModelRegistry,
  savePersistent, loadPersistent,
};
