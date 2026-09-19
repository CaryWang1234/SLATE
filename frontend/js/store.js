/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

import { makeId } from "./services/utils.js?v=20260919-002";

const API_ORIGIN = typeof window !== "undefined" && window.location?.origin
  ? window.location.origin
  : "http://127.0.0.1:8000";
const API_BASE = `${API_ORIGIN}/api`;

const state = {
  // 主题
  theme: "light",

  // 通用 UI 模式：classic（默认，完整布局）| codex（极简 Codex 风格）
  uiMode: "classic",

  // 当前选中的模型
  currentModel: null,

  // 每个模型的 API Key（modelId → key）
  modelKeys: {},

  // 自定义模型（用户手动添加的）
  customModels: [],

  // 每模型的上下文预算（modelId → token 数；缺省或 0 = 自动）
  // 预算决定两件事：上下文条算到哪儿算满、自动压缩在第几轮触发。两者必须同一个数。
  modelContextCaps: {},

  // 用量统计（当前对话）
  usage: {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    messageCount: 0,
  },

  // 每个对话的用量统计（convId → usage）
  conversationUsage: {},

  // 最近一次上下文分桶结果（由 services/context_meter.js 写入，不持久化）
  contextSnapshot: null,

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

  // Actions（data/actions/*.yml 流程说明书）：内存快照，磁盘才是真源，故不落 localStorage
  actions: [],
  actionsBroken: [],

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

  // 回复模式：agent=智能体（可调用工具、多轮自主循环）| chat=对话（单轮直答，不发工具也不注入工具目录）
  chatMode: "agent",

  // 推理强度：auto=沿用模型默认（不下发字段）| off=关 | low/medium/high=档位递增
  // 实际下发字段由后端按模型 reasoning 能力映射；能力为 none 的模型一律不下发
  reasoningEffort: "auto",

  // 联网搜索配置：engine=auto（Bing+DDG 合并）/ bing / ddg；renderJs=auto（正文过短自动渲染）/ on / off
  webSearch: { engine: "auto", renderJs: "auto" },

  // 媒体生成配置：未配置 model / api_key 时对应工具（image_gen / video_gen）不可用
  imageGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },
  videoGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },
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
    uiMode: state.uiMode === "codex" ? "codex" : "classic",
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
    modelContextCaps: state.modelContextCaps,
    autoReview: state.autoReview,
    outputSettings: state.outputSettings,
    fileOutput: state.fileOutput,
    harness: state.harness,
    notifications: state.notifications,
    knowledgeSettings: state.knowledgeSettings,
    activeExpertId: state.activeExpertId,
    useResponses: state.useResponses,
    onboardingSeen: state.onboardingSeen === true,
    permissionMode: normalizePermissionMode(state.permissionMode),
    chatMode: normalizeChatMode(state.chatMode),
    reasoningEffort: state.reasoningEffort,
    webSearch: normalizeWebSearch(state.webSearch),
    imageGen: normalizeGenConfig(state.imageGen),
    videoGen: normalizeGenConfig(state.videoGen),
  };
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizePermissionMode(value) {
  return ["ask", "auto", "full"].includes(value) ? value : "ask";
}

// 回复模式取值域：只认 agent / chat，历史脏值一律回落智能体（旧版本行为）
function normalizeChatMode(value) {
  return ["agent", "chat"].includes(value) ? value : "agent";
}

// 推理强度取值域：auto=不下发；off/low/medium/high=后端按模型能力映射成厂商字段
function normalizeReasoningEffort(value) {
  return ["auto", "off", "low", "medium", "high"].includes(value) ? value : "auto";
}

// ── 模型能力 → 可选推理强度档位 ──────────────────────────────
// 桌面输入框与移动端设置页共用这一张表，两边各写一份迟早出现"移动端能选到无效档"。
// 能力取值与后端 backend/routers/proxy.py 的 REASONING_MAP 一一对应：
//   openai / effort / effort_forced = reasoning_effort（三家词表不同，见后端注释）
//   anthropic = output_config.effort / gemini = thinking_level
//   binary / adaptive = 只有 thinking.type 开关 / toggle = 布尔 enable_thinking
//   none = 一律不下发
const REASONING_LEVELS_BY_CAP = {
  openai: ["auto", "off", "low", "medium", "high"],
  effort: ["auto", "off", "low", "medium", "high"], // GLM-5.2 / 豆包 / Ollama：off 写作 none
  effort_forced: ["auto", "low", "medium", "high"], // Kimi K3 / GLM-5.3 强制思考，没有"关"
  anthropic: ["auto", "low", "medium", "high"], // 新版只有 effort 档位，没有"关"
  gemini: ["auto", "off", "low", "medium", "high"],
  binary: ["auto", "off", "low", "medium", "high"], // 低/中/高在后端收敛为"开"
  adaptive: ["auto", "off", "low", "medium", "high"], // MiniMax 同上，开档名为 adaptive
  toggle: ["auto", "off", "low", "medium", "high"], // 通义/文心只有开关
  none: ["auto"],
};

// 端点域名 → 能力。与后端 REASONING_HOST_CAPS 同源（守卫逐条比对字符串集合），
// 前端多了它只是把档位选择器打开，真正下发什么仍由后端决定。
const REASONING_CAP_BY_HOST = [
  ["https://api.openai.com", "openai"],
  ["https://api.deepseek.com", "binary"],
  ["https://api.moonshot.cn", "effort_forced"],
  ["https://api.kimi.com", "effort_forced"],
  ["https://dashscope.aliyuncs.com", "toggle"],
  ["https://open.bigmodel.cn", "effort"],
  ["https://ark.cn-beijing.volces.com", "effort"],
  ["https://api.minimax.cn", "adaptive"],
  ["https://api.minimax.io", "adaptive"],
  ["https://qianfan.baidubce.com", "toggle"],
  ["http://localhost:11434", "effort"],
  ["http://127.0.0.1:11434", "effort"],
];

// 注册表自带 reasoning 字段；自定义模型按 provider + 端点回落，未知端点一律 none（宁可不发，不可发错）
// 该回落规则与后端 _reasoning_capability 同源，由 scripts/check_reasoning_effort.mjs 锁定
function reasoningCapabilityOf(model) {
  if (!model) return "none";
  if (REASONING_LEVELS_BY_CAP[model.reasoning]) return model.reasoning;
  if (model.provider === "anthropic") return "anthropic";
  if (model.provider === "google") return "gemini";
  const url = String(model.base_url || "").trim().toLowerCase();
  for (const [prefix, cap] of REASONING_CAP_BY_HOST) {
    if (url.startsWith(prefix)) return cap;
  }
  return "none";
}

/** 该模型可选的推理强度档位；能力未知时只剩 auto。 */
function reasoningLevelsOf(model) {
  return REASONING_LEVELS_BY_CAP[reasoningCapabilityOf(model)] || REASONING_LEVELS_BY_CAP.none;
}

// 上游只有开/关两值的能力：低、中、高会被收敛成同一个值，UI 要如实说明而不是让用户以为没生效
const REASONING_COLLAPSED_CAPS = new Set(["binary", "adaptive", "toggle"]);

function normalizeWebSearch(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    engine: ["auto", "bing", "ddg"].includes(v.engine) ? v.engine : "auto",
    renderJs: ["auto", "on", "off"].includes(v.renderJs) ? v.renderJs : "auto",
  };
}

function normalizeGenConfig(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    model: typeof v.model === "string" ? v.model : "",
    base_url: typeof v.base_url === "string" && v.base_url.trim() ? v.base_url.trim() : "https://api.openai.com/v1",
    api_key: typeof v.api_key === "string" ? v.api_key : "",
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
    uiMode: data.uiMode === "codex" ? "codex" : "classic",
    modelKeys: data.modelKeys || {},
    customModels: data.customModels || [],
    currentModelId: data.currentModelId || null,
    maxTokens: data.maxTokens || 64000,
    modelContextCaps: normalizeContextCaps(data.modelContextCaps),
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
    chatMode: normalizeChatMode(data.chatMode),
    reasoningEffort: normalizeReasoningEffort(data.reasoningEffort),
    webSearch: normalizeWebSearch(data.webSearch),
    imageGen: normalizeGenConfig(data.imageGen),
    videoGen: normalizeGenConfig(data.videoGen),
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

// 注册表中的 id 同时是 API Key 与「当前模型」的存储键，改名后必须把旧键的值搬到新键，
// 否则用户凭据会静默失联。旧键保留，便于回滚到旧版本。
const MODEL_ID_RENAMES = {
  "deepseek-chat": "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "minimax-m3": "MiniMax-M3",
};

function migrateModelIds() {
  let changed = false;
  for (const [oldId, newId] of Object.entries(MODEL_ID_RENAMES)) {
    if (state.modelKeys[oldId] && !state.modelKeys[newId]) {
      state.modelKeys[newId] = state.modelKeys[oldId];
      changed = true;
    }
    if (state._pendingModelId === oldId) {
      state._pendingModelId = newId;
      changed = true;
    }
    if (state.autoReview?.modelId === oldId) {
      state.autoReview.modelId = newId;
      changed = true;
    }
  }
  if (changed) savePersistent();
}

function loadPersistent() {
  try {
    const raw = localStorage.getItem("slate_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    state.theme = normalizeTheme(data.theme);
    state.uiMode = data.uiMode === "codex" ? "codex" : "classic";
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
    state.modelContextCaps = normalizeContextCaps(data.modelContextCaps);
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
    state.chatMode = normalizeChatMode(data.chatMode);
    state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
    state.webSearch = normalizeWebSearch(data.webSearch);
    state.imageGen = normalizeGenConfig(data.imageGen);
    state.videoGen = normalizeGenConfig(data.videoGen);
    migrateModelIds();
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
    if (Object.prototype.hasOwnProperty.call(data, "uiMode")) {
      state.uiMode = data.uiMode === "codex" ? "codex" : "classic";
    }
    if (Object.prototype.hasOwnProperty.call(data, "maxTokens")) {
      state.maxTokens = Math.max(1000, parseInt(data.maxTokens) || 64000);
    }
    if (data.modelContextCaps && typeof data.modelContextCaps === "object") {
      state.modelContextCaps = normalizeContextCaps(data.modelContextCaps);
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
    if (Object.prototype.hasOwnProperty.call(data, "chatMode")) {
      state.chatMode = normalizeChatMode(data.chatMode);
    }
    if (Object.prototype.hasOwnProperty.call(data, "reasoningEffort")) {
      state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
    }
    if (Object.prototype.hasOwnProperty.call(data, "webSearch")) {
      state.webSearch = normalizeWebSearch(data.webSearch);
    }
    if (Object.prototype.hasOwnProperty.call(data, "imageGen")) {
      state.imageGen = normalizeGenConfig(data.imageGen);
    }
    if (Object.prototype.hasOwnProperty.call(data, "videoGen")) {
      state.videoGen = normalizeGenConfig(data.videoGen);
    }
    migrateModelIds();
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

function setChatMode(mode) {
  const next = normalizeChatMode(mode);
  if (state.chatMode === next) return;
  state.chatMode = next;
  savePersistent();
  notify("chatMode", state.chatMode);
}

function setReasoningEffort(level) {
  const next = normalizeReasoningEffort(level);
  if (state.reasoningEffort === next) return;
  state.reasoningEffort = next;
  savePersistent();
  notify("reasoningEffort", state.reasoningEffort);
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

// ── 每模型上下文预算 ───────────────────────────────────
// 滑杆只给这几档（0 = 自动）：让"这个模型我能开多大上下文"不必先去查厂商文档。
// 自动档沿用模型标称窗口；窗口未知时回落 64K，也就是本功能之前的硬编码值。
const CONTEXT_CAP_STOPS = [0, 100000, 200000, 400000, 600000, 800000, 1000000];
const CONTEXT_CAP_FALLBACK = 64000;

function normalizeContextCap(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 吸附到最近档位：手输 150000 这类值不会造出滑杆表达不了的第四种状态
  return CONTEXT_CAP_STOPS.reduce((best, stop) => (stop && Math.abs(stop - n) < Math.abs(best - n) ? stop : best), 0);
}

function normalizeContextCaps(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [modelId, value] of Object.entries(raw)) {
    const cap = normalizeContextCap(value);
    if (cap > 0 && typeof modelId === "string" && modelId) out[modelId] = cap;
  }
  return out;
}

function getModelDefinition(modelId) {
  if (!modelId) return null;
  for (const group of Object.values(state.modelRegistry || {})) {
    const hit = (group || []).find(m => m?.id === modelId);
    if (hit) return hit;
  }
  return state.customModels.find(m => m?.id === modelId) || null;
}

function getContextCap(modelId) {
  return normalizeContextCap(state.modelContextCaps?.[modelId] ?? 0);
}

function setModelContextCap(modelId, tokens) {
  if (!modelId) return;
  const cap = normalizeContextCap(tokens);
  if (cap > 0) state.modelContextCaps[modelId] = cap;
  else delete state.modelContextCaps[modelId];
  savePersistent();
  notify("modelContextCaps", state.modelContextCaps);
}

// 生效预算：这一条同时喂给上下文条与自动压缩阈值，两边不再是两个数。
// 自动档沿用全局「上下文 Token 上限」（今天压缩阈值就是它，只是以前上下文条没跟着它走）。
// 再按模型标称窗口封顶：滑杆能选到 1M，不代表 32K 的本地模型真能吃下 1M。
function contextBudgetOf(modelId) {
  const cap = getContextCap(modelId) || (parseInt(state.maxTokens, 10) > 0 ? parseInt(state.maxTokens, 10) : CONTEXT_CAP_FALLBACK);
  const declared = declaredContextWindow(modelId);
  return declared > 0 ? Math.min(cap, declared) : cap;
}

// 模型标称窗口：只做展示（预算小于它时，界面要告诉用户模型本身能吃多少）
function declaredContextWindow(modelId) {
  return parseInt(getModelDefinition(modelId)?.context_window, 10) || 0;
}

// 预算是否来自用户显式设置（用于界面区分"自动"与"手动"）
function isContextCapManual(modelId) {
  return getContextCap(modelId) > 0;
}

function fmtContextTokens(n) {
  const v = parseInt(n, 10) || 0;
  if (!v) return "0";
  if (v >= 1000000) return `${(v / 1000000).toFixed(v % 1000000 ? 1 : 0)}M`;
  return `${Math.round(v / 1000)}K`;
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

/**
 * Action 目录快照（内存态）：由 /api/actions 刷新，供系统提示注入与 actions_list 复用。
 * 刻意不落 localStorage——data/actions/*.yml 才是真源，缓存一份副本只会与磁盘不一致。
 */
function setActions(data) {
  state.actions = Array.isArray(data?.actions) ? data.actions : [];
  state.actionsBroken = Array.isArray(data?.broken) ? data.broken : [];
  notify("actions", { actions: state.actions, broken: state.actionsBroken });
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
    let found = null;
    for (const category of Object.values(registry)) {
      found = category.find(m => m.id === state._pendingModelId);
      if (found) break;
    }
    if (!found) {
      found = state.customModels.find(m => m.id === state._pendingModelId);
    }
    if (found) {
      setCurrentModel(found);
      delete state._pendingModelId;
    }
  }
  notify("modelRegistry", registry);
}

export {
  API_BASE, state, subscribe, notify,
  setTheme, toggleTheme, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel,
  CONTEXT_CAP_STOPS, getContextCap, setModelContextCap, contextBudgetOf, declaredContextWindow, isContextCapManual, fmtContextTokens,
  setActiveExpertId,
  setChatMode, setReasoningEffort, normalizeChatMode, normalizeReasoningEffort,
  REASONING_LEVELS_BY_CAP, reasoningCapabilityOf, reasoningLevelsOf, REASONING_COLLAPSED_CAPS, getModelDefinition,
  resetUsage, restoreUsageForConversation, setConversationUsage, addUsage, estimateTokens,
  getConversationTodos, setConversationTodos,
  loadSharedPersistent,
  setMessages, addMessage, updateLastAssistantMessage,
  setConversations, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes,
  setConstitution, setSkills, setActions, setModelRegistry,
  setProject, setProjectFileTree,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  setKnowledgeContext,
  savePersistent, loadPersistent,
};
