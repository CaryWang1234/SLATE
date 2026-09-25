/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

import { makeId } from "./services/utils.js?v=20260925-007";
import { FLAG_KINDS, normalizeTaskFlags, normalizeTaskListSort } from "./services/task_list.js?v=20260925-007";

const API_ORIGIN = typeof window !== "undefined" && window.location?.origin
  ? window.location.origin
  : "http://127.0.0.1:8000";
const API_BASE = `${API_ORIGIN}/api`;

// 目标模式的轮数上限：一次真实交付常要"读→改→跑→再跑验证"好几轮，50 经常在验证之前就用完。
// 放宽同时要把话说在前头：上限是止损线，不是预算——干完活该由模型自己调 exit_target_mode 收口。
export const HARNESS_MAX_ROUNDS = 80;

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

  // 侧栏任务徽标（convId → {kind: done|needs|error, at, seen}）：记的是"上一场怎么结束的"。
  // 刻意只存本机 —— "已完成未查看"说的是这块屏幕有没有看过，跨设备同步只会把另一台
  // 机器的阅读进度盖过来。进行中没有这一项：它由实时生成权判定，落库就会留下僵尸态。
  taskFlags: {},

  // 侧栏任务列表的排序偏好（recent|project|status|created|usage，见 services/task_list.js）
  taskListSort: "recent",

  // 消息区右侧 TODOLIST 栏：false = 用户主动收起（有清单也不占位）。
  // 与 taskFlags 同理只存本机——"这一栏占不占我的屏幕"是这台设备的事，
  // 手机遥控同步过去只会把桌面的布局偏好盖到一块根本不长这样的屏上。
  todoPanelOpen: true,

  // 后台任务面板是否展开。刻意不落盘：这一栏是"有任务才出现"的，跨重启记住"上次收起了"
  // 只会让新任务静悄悄地被藏起来
  bgPanelOpen: true,

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
  project: null,        // { path, name, config, constitution, project_id } —— 当前视野那一项的展开
  projectFileTree: [],  // 当前浏览的目录内容

  // 在册项目清单（后端 data/projects.json 的只读快照，见 services/project.js）。
  // 刻意不落 localStorage：真源在服务端，本地再存一份就会出现"清单比服务端新"的窗口，
  // 切换器点下去打到一条已经不存在的记录上。
  projects: [],
  activeProjectId: "",

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
    maxRounds: HARNESS_MAX_ROUNDS,
  },

  // Continue Autopilot：自主推进跑到轮数上限时，若任务还没干完，提醒模型继续并
  // 有界地追加轮数预算——把"用户手动再发一遍继续"换成系统自己开口。
  // 只存本机：这条偏好只有桌面循环兑现得了（移动端 m-chat 的 policy 没有末轮续跑），
  // 同步到手机只会显示"已开启"却不做事。
  continueAutopilot: true,

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

  // 默认审批模式（设置页那三项改的是它）：ask=手动审批（执行命令/访问网络都问）
  // auto=自动审批（只在命中高危规则时问）full=完全访问（一律不问；灾难级命令始终由后端硬拦）
  permissionMode: "ask",

  // 每一场对话自己的审批档（convId → 档）：没单独选过的场沿用上面那个默认档。
  // 键 "" 是"还没建起来的这一场"——发送时会搬给新建的会话（adoptConversationPermissionMode）。
  // 刻意不跨设备同步：审批档是"这台屏幕上谁替我点批准"，手机同步过来只会把桌面的信任档盖到别处。
  permissionModeByConversation: {},

  // 回复模式：agent=智能体（可调用工具、多轮自主循环）| chat=对话（单轮直答，不发工具也不注入工具目录）
  chatMode: "agent",

  // 推理强度：auto=沿用模型默认（不下发字段）| off=关 | low/medium/high=档位递增
  // 实际下发字段由后端按模型 reasoning 能力映射；能力为 none 的模型一律不下发
  reasoningEffort: "auto",

  // 联网搜索配置：engine=auto（Bing+DDG 合并）/ bing / ddg；renderJs=auto（正文过短自动渲染）/ on / off
  webSearch: { engine: "auto", renderJs: "auto" },

  // 后台终端任务（services/bg_tasks.js 轮询写入；任务本体活在后端进程里，这里只是快照）
  bgTasks: [],
  // 后端送来但还没被消费的事件（模型唤醒用；消费即清空）
  bgTaskEvents: [],
  // 认得出但不属于当前会话的消息（多半是别的项目里的任务跑完了）：先进信箱，
  // 等用户回到那场会话再搬回上面的池子。不落库——后端已经 ack 过，重启后只剩徽标。
  bgInbox: [],
  // 空闲自动续跑：任务还在跑、模型已经收工时，允许系统自己把话头接回去（每对话有次数上限）
  bgAutoResume: true,
  // 每对话已用掉几次自动续跑（convId → 次数），防"活一直干不完"时无限自转
  bgResumeUsed: {},

  // 并行运行（services/run_registry.js 是唯一真源，这里只是给订阅者看的快照）
  // 刻意不落盘：run 带着 AbortController 和内存里的气泡引用，刷新后复活成
  // "看着在跑其实早死了"的假象比不复活更糟。
  runs: [],
  // 跨项目同时最多几场（1 = 退回串行）
  maxParallelRuns: 2,
  // 同一个项目内同时最多几场。默认 1：同项目并行 = 两个 run 同时改同一批文件，
  // 坏了都查不出是谁干的；要同项目并行先开 worktree 隔离（P3）。
  maxConcurrentRunsPerProject: 1,
  // 关掉就回到 P2 之前的语义：切换会话即中断当前生成
  backgroundRuns: true,

  // 媒体生成配置：未配置 model / api_key 时对应工具（image_gen / video_gen）不可用
  imageGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },
  videoGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },

  // AI 辅助功能（对话/团队对话/提示词工厂以外那些会自己找模型要结果的）：
  // 功能 id → { enabled, modelId }，登记表在 services/ai_features.js。
  // 空对象 = 全用默认值（开 + 跟随主模型），所以老状态文件没这个键也一切照旧。
  aiHelpers: {},
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
    // 工作区记宿主目录：记当前根的话，下次启动会被当成普通单目录项目重新打开，工作区身份就丢了
    lastProjectPath: state.project?.workspace_dir || state.project?.path || null,
    conversationUsage: state.conversationUsage,
    conversationTodos: state.conversationTodos,
    taskFlags: state.taskFlags,
    taskListSort: normalizeTaskListSort(state.taskListSort),
    todoPanelOpen: state.todoPanelOpen !== false,
    maxTokens: state.maxTokens,
    modelContextCaps: state.modelContextCaps,
    autoReview: state.autoReview,
    outputSettings: state.outputSettings,
    fileOutput: state.fileOutput,
    harness: state.harness,
    // 只存本机：下面 getSharedPersistentData 刻意不收它——末轮续跑只有桌面循环实现，
    // 同步到手机只会多一个"显示已开启却不兑现"的开关
    continueAutopilot: state.continueAutopilot !== false,
    notifications: state.notifications,
    knowledgeSettings: state.knowledgeSettings,
    activeExpertId: state.activeExpertId,
    useResponses: state.useResponses,
    onboardingSeen: state.onboardingSeen === true,
    permissionMode: normalizePermissionMode(state.permissionMode),
    permissionModeByConversation: normalizePermissionModeMap(state.permissionModeByConversation),
    chatMode: normalizeChatMode(state.chatMode),
    reasoningEffort: state.reasoningEffort,
    webSearch: normalizeWebSearch(state.webSearch),
    imageGen: normalizeGenConfig(state.imageGen),
    videoGen: normalizeGenConfig(state.videoGen),
    aiHelpers: normalizeAiHelpers(state.aiHelpers),
    // 后台任务本身与事件不落盘：任务活在后端进程里，重启后这些快照全无意义
    // （日志文件仍在 data/bg_tasks/）。开关与"已续跑几次"是用户偏好/配额，要跨重启。
    bgAutoResume: state.bgAutoResume !== false,
    bgResumeUsed: normalizeCountMap(state.bgResumeUsed),
    // 并行运行的三个偏好只存本机（与 continueAutopilot 同一条理由）：
    // 并行只在桌面循环里实现，同步到手机只会多几个"显示已开启却不兑现"的开关。
    maxParallelRuns: normalizeCountInt(state.maxParallelRuns, 1, 4, 2),
    maxConcurrentRunsPerProject: normalizeCountInt(state.maxConcurrentRunsPerProject, 1, 3, 1),
    backgroundRuns: state.backgroundRuns !== false,
  };
}

// 计数型偏好取值域收窄：脏值（0、负数、"abc"）回落默认，而不是拿去做除数/上限
function normalizeCountInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizePermissionMode(value) {
  return ["ask", "auto", "full"].includes(value) ? value : "ask";
}

// 每场的审批档：脏值（手改 localStorage、旧版本残留）整条丢掉，让它回落到默认档，
// 而不是拿一个不认识的档位去做审批判定——判定分支认不出的值必须等于"最严的那档"。
function normalizePermissionModeMap(value) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (["ask", "auto", "full"].includes(v)) out[String(k)] = v;
  }
  return out;
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

// AI 辅助功能：功能 id → { enabled, modelId }（登记表在 services/ai_features.js）。
// 刻意不按登记表过滤未知 id：登记表在下游模块，这里 import 会成环，而且多留几个键
// 无害、少留一个就等于把用户在另一台机器上的偏好悄悄丢了。
function normalizeAiHelpers(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value)) {
    if (!key || !raw || typeof raw !== "object") continue;
    out[key] = {
      enabled: raw.enabled !== false,
      modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    };
  }
  return out;
}

/** 计数表（convId → 非负整数）：坏值一律丢掉，别让脏数据把配额算成负数 */
function normalizeCountMap(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [k, n] of Object.entries(v)) {
    const num = Number(n);
    if (k && Number.isFinite(num) && num > 0) out[k] = Math.floor(num);
  }
  return out;
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
    // 排序偏好同步；taskFlags 不同步（未读是本机概念），所以这里刻意没有它
    taskListSort: normalizeTaskListSort(data.taskListSort),
    webSearch: normalizeWebSearch(data.webSearch),
    imageGen: normalizeGenConfig(data.imageGen),
    videoGen: normalizeGenConfig(data.videoGen),
    aiHelpers: normalizeAiHelpers(data.aiHelpers),
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
    state.taskFlags = normalizeTaskFlags(data.taskFlags);
    state.taskListSort = normalizeTaskListSort(data.taskListSort);
    state.todoPanelOpen = data.todoPanelOpen !== false;
    state.bgAutoResume = data.bgAutoResume !== false;
    state.bgResumeUsed = normalizeCountMap(data.bgResumeUsed);
    state.maxParallelRuns = normalizeCountInt(data.maxParallelRuns, 1, 4, 2);
    state.maxConcurrentRunsPerProject = normalizeCountInt(data.maxConcurrentRunsPerProject, 1, 3, 1);
    state.backgroundRuns = data.backgroundRuns !== false;
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
    // 旧版本持久化的 maxRounds=20/50 统一提到当前上限：上限只放宽不收紧，
    // 收到低于上限的值就等于把"多给的预算"又悄悄拿走了
    if ((state.harness.maxRounds || 0) < HARNESS_MAX_ROUNDS) state.harness.maxRounds = HARNESS_MAX_ROUNDS;
    // 老状态文件没这个键：读成 undefined 时按默认值（开启）走
    state.continueAutopilot = data.continueAutopilot !== false;
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
    state.permissionModeByConversation = normalizePermissionModeMap(data.permissionModeByConversation);
    state.chatMode = normalizeChatMode(data.chatMode);
    state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
    state.webSearch = normalizeWebSearch(data.webSearch);
    state.imageGen = normalizeGenConfig(data.imageGen);
    state.videoGen = normalizeGenConfig(data.videoGen);
    state.aiHelpers = normalizeAiHelpers(data.aiHelpers);
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
    if ((state.harness.maxRounds || 0) < HARNESS_MAX_ROUNDS) state.harness.maxRounds = HARNESS_MAX_ROUNDS;
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
    if (Object.prototype.hasOwnProperty.call(data, "taskListSort")) {
      state.taskListSort = normalizeTaskListSort(data.taskListSort);
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
    if (Object.prototype.hasOwnProperty.call(data, "aiHelpers")) {
      state.aiHelpers = normalizeAiHelpers(data.aiHelpers);
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

// ── 审批模式：这一场生效哪一档 ────────────────────────────────
// 三档语义（riskguard 是唯一执行处）：ask 命令/联网都问，auto 只问高危，full 一律不问。
// 单独选过的场记住自己的档，没选过的跟着设置页那个默认档走。

/** 这一场生效的审批档。convId 传空 = 还没建起来的这一场（键 ""）。 */
function permissionModeFor(convId = state.currentConversationId) {
  const picked = state.permissionModeByConversation[String(convId || "")];
  if (picked === "ask" || picked === "auto" || picked === "full") return picked;
  return normalizePermissionMode(state.permissionMode);
}

/** 只给这一场挑一档；不传 convId 就是给"屏幕上这一场"挑。 */
function setPermissionModeFor(convId, mode) {
  const key = String(convId || "");
  const next = normalizePermissionMode(mode);
  if (state.permissionModeByConversation[key] === next) return;
  state.permissionModeByConversation = { ...state.permissionModeByConversation, [key]: next };
  savePersistent();
  notify("permissionMode", permissionModeFor(key));
}

/** 设置页改的是默认档：没单独选过的场跟着变，所以订阅者要重画。 */
function setDefaultPermissionMode(mode) {
  const next = normalizePermissionMode(mode);
  if (normalizePermissionMode(state.permissionMode) === next) return;
  state.permissionMode = next;
  savePersistent();
  notify("permissionMode", permissionModeFor(state.currentConversationId));
}

/**
 * 发送途中才建出会话：把"还没建起来的这一场"选的档搬给它。
 * 刻意是搬走而不是复制——下一次新对话该从默认档重新开始，
 * 否则一次"这轮放开跑"会悄悄一直生效到以后每一场新对话。
 */
function adoptConversationPermissionMode(convId) {
  const key = String(convId || "");
  if (!key || !Object.prototype.hasOwnProperty.call(state.permissionModeByConversation, "")) return;
  const pending = state.permissionModeByConversation[""];
  const rest = { ...state.permissionModeByConversation };
  delete rest[""];
  state.permissionModeByConversation = { ...rest, [key]: pending };
  savePersistent();
  notify("permissionMode", permissionModeFor(key));
}

/** 会话删掉了，它那份审批档跟着清掉（不然残留键会一直躺在状态文件里）。 */
function forgetConversationPermissionMode(convId) {
  const key = String(convId || "");
  if (!Object.prototype.hasOwnProperty.call(state.permissionModeByConversation, key)) return;
  const rest = { ...state.permissionModeByConversation };
  delete rest[key];
  state.permissionModeByConversation = rest;
  savePersistent();
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

// 目标模式开关的唯一写入口：菜单里的手动切换与 exit_target_mode 都走这里。
// 各写各的 → 工具关了模式，「＋」菜单的开关和待机条还停在"已开启"。
function setHarnessEnabled(on) {
  state.harness = state.harness || { enabled: false, maxRounds: HARNESS_MAX_ROUNDS };
  const next = on === true;
  if (state.harness.enabled === next) return false;
  state.harness.enabled = next;
  savePersistent();
  notify("harness", state.harness.enabled);
  return true;
}

// ── 模型显式收口 ─────────────────────────────────────────
// exit_target_mode / exit_autopilot 把请求写在这里，工具循环在轮末取走一次并作废。
// 刻意不进 buildPersistentData：它只属于当前这一场运行，换会话或重启都不该带着走。
let loopExit = null;

function requestLoopExit({ mode = "", reason = "" } = {}) {
  loopExit = { mode, reason: String(reason || "").trim() };
  return loopExit;
}

function takeLoopExit() {
  const v = loopExit;
  loopExit = null;
  return v;
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
// 「自动」= 这个模型自己的默认上限（见 defaultContextCap）：1M 窗口的模型默认 800K、
// 256K 的默认 200K，而不是所有模型共用全局那一个 64K。只有标称窗口缺失或小到凑不满
// 一档的模型（自定义 / 本地），才沿用全局「上下文 Token 上限」，再按窗口封顶。
function contextBudgetOf(modelId) {
  const declared = declaredContextWindow(modelId);
  const manual = getContextCap(modelId);
  if (manual) return declared > 0 ? Math.min(manual, declared) : manual;
  const perModel = defaultContextCap(modelId);
  if (perModel) return perModel;
  const global = parseInt(state.maxTokens, 10) > 0 ? parseInt(state.maxTokens, 10) : CONTEXT_CAP_FALLBACK;
  return declared > 0 ? Math.min(global, declared) : global;
}

// 每模型默认上限：按标称窗口留两成余量（上下文塞到刚好等于窗口，第一条回复就没地方写了），
// 再向下吸附到滑杆档位——默认值必须是滑杆表达得出来的数，否则"自动"和拖到同一档不等价。
const CONTEXT_HEADROOM_RATIO = 0.8;

function defaultContextCap(modelId) {
  const declared = declaredContextWindow(modelId);
  if (!(declared > 0)) return 0;
  const room = Math.floor(declared * CONTEXT_HEADROOM_RATIO);
  let best = 0;
  for (const stop of CONTEXT_CAP_STOPS) {
    if (stop > 0 && stop <= room && stop > best) best = stop;
  }
  return best;
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

// ── 侧栏任务状态与排序（徽标数据源，见 services/task_list.js） ────────

// 只记"上一场怎么结束的"。进行中不在这里：它由实时生成权判定，落库就会在重启后
// 留下永远转不完的僵尸态。seen 支撑"已完成未查看"，切进该会话即清。
function recordTaskFlag(convId, { kind = "", seen = false } = {}) {
  const key = convId || "";
  if (!key || !FLAG_KINDS.includes(kind)) return false;
  state.taskFlags = normalizeTaskFlags({
    ...state.taskFlags,
    [key]: { kind, at: Date.now(), seen: seen === true },
  });
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

function markTaskSeen(convId) {
  const flag = state.taskFlags?.[convId || ""];
  if (!flag || flag.seen) return false;   // 已看过就别再写盘：列表每秒重绘时这里是热路径
  flag.seen = true;
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

// 会话被删（含批量管理）后残项要跟着走：只在成功取到全量列表时剪，空列表 = 真删光
function pruneTaskFlags(existingIds) {
  const live = new Set((Array.isArray(existingIds) ? existingIds : []).filter(Boolean));
  const before = state.taskFlags || {};
  const kept = Object.fromEntries(Object.entries(before).filter(([id]) => live.has(id)));
  if (Object.keys(kept).length === Object.keys(before).length) return false;
  state.taskFlags = kept;
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

function setTaskListSort(mode) {
  const next = normalizeTaskListSort(mode);
  if (state.taskListSort === next) return false;
  state.taskListSort = next;
  savePersistent();
  notify("taskListSort", next);
  return true;
}

// 右栏 TODOLIST 折叠：值只有 true/false，undefined 一律当"展开"（老状态文件没这个键）
function setTodoPanelOpen(open) {
  const next = open !== false;
  if ((state.todoPanelOpen !== false) === next) return false;
  state.todoPanelOpen = next;
  savePersistent();
  notify("todoPanelOpen", next);
  return true;
}

function addUsage(usage, convId = state.currentConversationId) {
  if (!usage) return;
  // 后台那场的 token 记在它自己名下：不然用户切到别的项目看用量条，读到的是
  // "我什么都没干却涨了两千"
  if (String(convId || "") !== String(state.currentConversationId || "")) {
    const key = String(convId || "");
    if (!key) return;
    const saved = state.conversationUsage[key] || { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
    saved.promptTokens += usage.prompt_tokens || 0;
    saved.completionTokens += usage.completion_tokens || 0;
    saved.totalTokens = saved.promptTokens + saved.completionTokens;
    saved.messageCount += 1;
    state.conversationUsage[key] = saved;
    savePersistent();
    return;
  }
  state.usage.promptTokens += usage.prompt_tokens || 0;
  state.usage.completionTokens += usage.completion_tokens || 0;
  state.usage.totalTokens = state.usage.promptTokens + state.usage.completionTokens;
  state.usage.messageCount += 1;
  notify("usage", state.usage);
}

// ── 后台任务：空闲自动续跑开关与配额 ─────────────────────────

/** 全局开关：任务还在跑、模型已收工时，是否允许系统自己把话头接回去 */
function setBgAutoResume(enabled) {
  const next = enabled !== false;
  if ((state.bgAutoResume !== false) === next) return false;
  state.bgAutoResume = next;
  savePersistent();
  notify("bgAutoResume", next);
  return true;
}

/** 该对话已用掉几次自动续跑（配额由 services/agent_loop.js 判定） */
function bgResumeUsedOf(convId) {
  const n = Number((state.bgResumeUsed || {})[convId || ""]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function markBgResumeUsed(convId) {
  const key = convId || "";
  if (!key) return 0;
  const next = bgResumeUsedOf(key) + 1;
  state.bgResumeUsed = { ...(state.bgResumeUsed || {}), [key]: next };
  savePersistent();
  notify("bgResumeUsed", state.bgResumeUsed);
  return next;
}

// ── 并行运行：三个偏好 ──────────────────────────────────────
// 上限与开关都只写 state 并落盘，判定在 services/run_registry.js 一处做——
// 两处各判一次的话，设置页改了要等下一次 notify 才生效，队列里那条就可能超发。

function setMaxParallelRuns(value) {
  const next = normalizeCountInt(value, 1, 4, 2);
  if (state.maxParallelRuns === next) return false;
  state.maxParallelRuns = next;
  savePersistent();
  notify("maxParallelRuns", next);
  return true;
}

function setMaxConcurrentRunsPerProject(value) {
  const next = normalizeCountInt(value, 1, 3, 1);
  if (state.maxConcurrentRunsPerProject === next) return false;
  state.maxConcurrentRunsPerProject = next;
  savePersistent();
  notify("maxConcurrentRunsPerProject", next);
  return true;
}

/** true = 切走会话时生成继续跑（P2 语义）；false = 切走即停（P2 之前） */
function setBackgroundRuns(enabled) {
  const next = enabled !== false;
  if ((state.backgroundRuns !== false) === next) return false;
  state.backgroundRuns = next;
  savePersistent();
  notify("backgroundRuns", next);
  return true;
}

function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英文混合约 3 字符/token
  return Math.ceil(text.length / 3);
}

// ── 会话现场（每场一份消息数组） ─────────────────────────────
// 为什么不再共用一个 state.messages：并行时后台那场 run 往共用数组里追加一条，
// 订阅者就照着"整表重渲染"把可见那一场重画成后台那场的样子——串台。
// state.messages 保留为"可见那一份的引用"，今天 30 多处读它的代码一行不用改；
// 后台 run 写的是 threads 里它自己那条数组，切回那一场时复用的还是同一个数组对象
// （run 正在写的 assistant 气泡因此不会在切回来时消失）。
const threads = new Map();

function threadKey(convId) {
  return String(convId || "_scratch");
}

function messagesOf(convId) {
  return threads.get(threadKey(convId)) || [];
}

function hasThread(convId) {
  return threads.has(threadKey(convId));
}

// 会话被删时丢掉它那份现场：内存里少留一条无主数组，也避免同名 id 复用时读到旧内容
function dropThread(convId) {
  const key = threadKey(convId);
  if (key === "_scratch") return;
  if (threads.delete(key)) notify("messages", state.messages);
}

function setMessages(msgs, convId = state.currentConversationId) {
  const list = Array.isArray(msgs) ? msgs : [];
  threads.set(threadKey(convId), list);
  if (String(convId || "") === String(state.currentConversationId || "")) {
    state.messages = list;
    notify("messages", list);
  }
  notify("thread", { convId: String(convId || ""), messages: list });
}

// 静默绑定：把可见线程指到某场会话自己的数组上，不触发重渲染。
// 切回一场还在跑的对话时用得上——它那份 DOM 一直活着（在游离节点里挂着），
// 再通知一次渲染反而把已捕获的气泡引用冲掉，流式光标与砚流条会断。
function bindVisibleThread(convId) {
  const key = threadKey(convId);
  if (!threads.has(key)) threads.set(key, []);
  state.messages = threads.get(key);
  return state.messages;
}

function addMessage(msg, convId = state.currentConversationId) {
  const key = threadKey(convId);
  const visible = String(convId || "") === String(state.currentConversationId || "");
  if (visible) {
    state.messages.push(msg);
    notify("messages", state.messages);
    notify("thread", { convId: String(convId || ""), messages: state.messages });
    return;
  }
  // 后台那场可能从没被打开过（定时任务/手机端发来的会话），数组要先建起来
  if (!threads.has(key)) threads.set(key, []);
  threads.get(key).push(msg);
  notify("thread", { convId: String(convId || ""), messages: threads.get(key) });
}

function updateLastAssistantMessage(content, convId = state.currentConversationId) {
  const visible = String(convId || "") === String(state.currentConversationId || "");
  const list = visible ? state.messages : messagesOf(convId);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant") {
      list[i].content = content;
      if (visible) notify("messages", list);
      notify("thread", { convId: String(convId || ""), messages: list });
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

// 全局宪法与项目宪法是两份东西，各存各的：state.constitution 永远只表示本机全局版本，
// 生效哪一份由这里现算。以前是"打开项目就把 state.constitution 换成项目的"，于是
// 关掉项目后它的规则还在给无项目的对话用，切到一个没写宪法的项目又沿用上一个项目的。
function effectiveConstitution() {
  const own = state.project?.constitution;
  return own && typeof own === "object" ? own : state.constitution;
}

/** 这份宪法改下去会落到哪儿：设置页要写清楚，不然用户以为改的是全局 */
function constitutionScope() {
  const own = state.project?.constitution;
  return own && typeof own === "object" ? "project" : "global";
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
  // 项目的宪法留在 state.project 上，由 effectiveConstitution() 现算：
  // 这里曾经直接覆写 state.constitution，关项目/换项目时没人还原，规则会串台。
  if (data) savePersistent();
  notify("project", data);
}

function setProjectFileTree(data) {
  state.projectFileTree = data;
  notify("projectFileTree", data);
}

// ── 在册项目清单（后端 projects.json 的只读快照） ──────────────
//
// 现场（上一看在哪条会话、草稿、滚动位置）存在后端注册表的 prefs 里，不在这里：
// 设计稿原本还打算把它经 settings 的 allowlist 再同步一份到 desktop_state.json，
// 落地时发现两份都是同一个 DATA_DIR 下的本地文件，"跨设备同步"这个理由并不成立，
// 多出来的只会有一个会和真源不一致的副本。所以 prefs 单点存 projects.json，
// 这里只缓存清单本身，切换器/侧栏都从这一份读。

function setProjects(list, activeId = "") {
  state.projects = Array.isArray(list) ? list : [];
  state.activeProjectId = activeId || state.projects.find(p => p?.active)?.id || "";
  notify("projects", state.projects);
}

/** 从清单里取一条记录（按 id 或名称）；没有就回 null，调用方自己决定怎么降级。 */
function projectEntryOf(key) {
  const text = String(key || "").trim();
  if (!text) return null;
  return state.projects.find(p => p?.id === text) || state.projects.find(p => p?.name === text) || null;
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
  CONTEXT_CAP_STOPS, getContextCap, setModelContextCap, contextBudgetOf, declaredContextWindow, defaultContextCap, isContextCapManual, fmtContextTokens,
  setActiveExpertId,
  setChatMode, setReasoningEffort, normalizeChatMode, normalizeReasoningEffort,
  setHarnessEnabled, requestLoopExit, takeLoopExit,
  REASONING_LEVELS_BY_CAP, reasoningCapabilityOf, reasoningLevelsOf, REASONING_COLLAPSED_CAPS, getModelDefinition,
  resetUsage, restoreUsageForConversation, setConversationUsage, addUsage, estimateTokens,
  getConversationTodos, setConversationTodos,
  recordTaskFlag, markTaskSeen, pruneTaskFlags, setTaskListSort, setTodoPanelOpen,
  setBgAutoResume, bgResumeUsedOf, markBgResumeUsed,
  setMaxParallelRuns, setMaxConcurrentRunsPerProject, setBackgroundRuns,
  // 审批模式：这一场生效哪一档的读与写（判口在 services/riskguard.js）
  permissionModeFor, setPermissionModeFor, setDefaultPermissionMode,
  adoptConversationPermissionMode, forgetConversationPermissionMode,
  loadSharedPersistent,
  setMessages, addMessage, updateLastAssistantMessage, messagesOf, hasThread, dropThread, bindVisibleThread,
  setConversations, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes,
  setConstitution, effectiveConstitution, constitutionScope, setSkills, setActions, setModelRegistry,
  setProject, setProjectFileTree, setProjects, projectEntryOf,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  setKnowledgeContext,
  savePersistent, loadPersistent,
};
