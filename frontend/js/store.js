/**
 * SLATE 全局状态管理
 * 管理当前模型、对话历史、上下文池、黑板卡片
 */

const API_BASE = "http://127.0.0.1:8000/api";

// ── 状态 ────────────────────────────────────

const state = {
  // 当前选中的模型
  currentModel: null,       // { id, name, provider, base_url, context_window }
  apiKey: "",
  customBaseUrl: "",
  customModelName: "",
  maxTokens: 64000,

  // 模型列表
  modelRegistry: {},        // { international: [...], domestic: [...], local: [...] }

  // 对话
  currentConversationId: null,
  conversations: [],        // [{ id, title, created_at }]
  messages: [],             // [{ id, role, content, model, created_at }]

  // 黑板
  boardCards: [],           // [{ id, title, body, arrows: [targetId] }]

  // 宪法
  constitution: null,       // { project_name, rules, context, ... }

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

// ── 持久化（内存 + localStorage 备份） ───────

function savePersistent() {
  const data = {
    apiKey: state.apiKey,
    customBaseUrl: state.customBaseUrl,
    customModelName: state.customModelName,
    maxTokens: state.maxTokens,
    currentModelId: state.currentModel?.id || null,
    boardCards: state.boardCards,
  };
  try {
    localStorage.setItem("slate_state", JSON.stringify(data));
  } catch (e) { /* 忽略 */ }
}

function loadPersistent() {
  try {
    const raw = localStorage.getItem("slate_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    state.apiKey = data.apiKey || "";
    state.customBaseUrl = data.customBaseUrl || "";
    state.customModelName = data.customModelName || "";
    state.maxTokens = data.maxTokens || 64000;
    state.boardCards = data.boardCards || [];
    // currentModelId 需要在模型列表加载后恢复
    state._pendingModelId = data.currentModelId;
  } catch (e) { /* 忽略 */ }
}

// ── 状态修改函数 ────────────────────────────

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
  // 恢复之前选中的模型
  if (state._pendingModelId) {
    for (const category of Object.values(registry)) {
      const found = category.find(m => m.id === state._pendingModelId);
      if (found) {
        setCurrentModel(found);
        break;
      }
    }
    delete state._pendingModelId;
  }
  notify("modelRegistry", registry);
}

export {
  API_BASE, state, subscribe, notify,
  setCurrentModel, setApiKey, setMessages, addMessage,
  updateLastAssistantMessage, setConversations, addMessage as pushMessage,
  setBoardCards, addBoardCard, setConstitution, setSkills,
  setModelRegistry, savePersistent, loadPersistent,
};
