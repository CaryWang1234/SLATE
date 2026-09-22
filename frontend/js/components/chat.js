/**
 * SLATE 聊天组件 v4：文件上传、上下文压缩、用量显示、流式输入 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations, getModelKey, addUsage, resetUsage, restoreUsageForConversation, setConversationUsage, setKnowledgeContext, savePersistent, getConversationTodos, setConversationTodos, setActiveExpertId, setChatMode, setReasoningEffort, addBoardCard, estimateTokens, contextBudgetOf, declaredContextWindow, reasoningCapabilityOf, reasoningLevelsOf, REASONING_COLLAPSED_CAPS, HARNESS_MAX_ROUNDS, setHarnessEnabled, takeLoopExit, recordTaskFlag, markTaskSeen, pruneTaskFlags, setTaskListSort, setTodoPanelOpen } from "../store.js?v=20260922-002";
import { measureContext } from "../services/context_meter.js?v=20260922-002";
import { get, post, del, patch, streamChat, upload, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20260922-002";
import { buildMessages, getDefaultParams, getOutputMaxTokens } from "../services/adapter.js?v=20260922-002";
import { TOOLS, detectToolCalls, detectDsmlCalls, detectAllCalls, hasToolMarkup, hasDsmlMarkup, stripToolCalls, executeToolCalls, hasTruncatedTail, getToolsSystemPrompt, buildOpenAITools, openAICallsToCalls, setModelToolCapability, effectiveToolMode, renderAction } from "../services/tools.js?v=20260922-002";
import { renderMarkdown } from "../services/markdown.js?v=20260922-002";
import { openMemoryModal, openSnippetModal, autoRefineMemoryAndProfile, captureConversationSpark } from "./memory.js?v=20260922-002";
import { getExpertsCached } from "./experts.js?v=20260922-002";
import { syncToolStepCards, clearToolStepCards } from "./whiteboard.js?v=20260922-002";
import { setWorkflowRunApi } from "./board_workflow.js?v=20260922-002";
import { loadExperts, getExpert, readExpertFile } from "../services/experts.js?v=20260922-002";
import { fmtTokens, tokenEquivalence } from "../services/usage.js?v=20260922-002";
import { fileTypeIcon } from "../services/file_icons.js?v=20260922-002";
import { dlgConfirm, dlgPrompt, dlgToast } from "../services/dialog.js?v=20260922-002";
import * as grindSvc from "../services/grind.js?v=20260922-002";
import { t } from "../services/i18n.js?v=20260922-002";
import { iconSvg, iconSvgEl, iconText, setIconText } from "../services/icons.js?v=20260922-002";
import { notifyTaskComplete } from "../services/notify.js?v=20260922-002";
import { subagentEvents, setSubAgentSignal } from "../services/subagent.js?v=20260922-002";
import { cxEmptyIn } from "../services/cx_motion.js?v=20260922-002";
import { createInkstream } from "../services/inkstream.js?v=20260922-002";
import { _pendingToolMsgs, dedupeToolCalls, formatToolResultForModel, buildToolFollowupInstruction, isHistorySummary } from "../services/agent_common.js?v=20260922-002";
import { createAgentLoop } from "../services/agent_loop.js?v=20260922-002";
import { openRun as openLedgerRun, projectChat, projectSteps } from "../services/agent_ledger.js?v=20260922-002";
import { reportError } from "../services/error_sink.js?v=20260922-002";
import { toolLabel } from "../services/tool_meta.js?v=20260922-002";
import { sortConversations, taskStatusOf, statusBadge, normalizeTaskListSort, SORT_MODES } from "../services/task_list.js?v=20260922-002";

let chatScroll, chatInput, btnSend, btnNewChat, convList, usageBar;
let filePreviewArea, btnAttachFile, fileInput;
let btnCompress, btnMemory, btnSnippets, btnDoCompress, compressModal, queueStatus;
let pendingFiles = []; // { name, size, content, type }
let brainstormMode = false;
let isGenerating = false;
let activeGenerationController = null;
let activeGenerationConvId = null; // 当前生成的归属会话：切换/新建会话时中断旧生成，防止串写
let inputQueue = [];

// ── 磨墨模式：会话状态 / 待启磨的想法 / 墨迹面板 ──
let grindSession = null;
let grindPendingIdea = null;
let grindPanelEl = null;
let lastInkStatus = null;

// ── UI 看门狗（防卡死最后防线） ───────────────
// 生成期间超过 180 秒无任何活动（流式增量或工具执行）→ 强制中断
let lastActivityAt = 0;
function markActivity() { lastActivityAt = Date.now(); }
const CHAT_DRAFT_KEY = "slate_chat_draft";

// ── 智能滚动跟随 ──────────────────────────────
// 用户向上滚动浏览历史时不强制拉到底部，仅在处于底部时跟随
let stickToBottom = true;

function cleanupStaleToolMarkers() {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return;
  if (!hasToolMarkup(lastMsg.content)) return;
  lastMsg.content = stripToolCalls(lastMsg.content);
  setMessages([...state.messages]);
}

function isNearBottom(threshold = 90) {
  if (!chatScroll) return true;
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < threshold;
}

function autoScroll(force = false) {
  if (!chatScroll) return;
  if (force || stickToBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ── 目标自主执行（六阶段闭环：目标→计划→执行→验证→汇报→追溯） ──
// 开启后：发送时注入六阶段指令，大任务强制建议TODOLIST，工具循环轮数上限提升到 maxRounds
let harnessStatusEl = null;
let resumeHintEl = null;
// Autopilot 的轮数只是止损线：真正的退出是模型调 exit_autopilot 收口。
// 放宽是因为验证环节（跑一次测试/读一次产物）常在 18 轮附近才排到，卡在收尾前。
const AGENT_AUTOPILOT_DEFAULT_ROUNDS = 24;
const AGENT_AUTOPILOT_BROAD_ROUNDS = 40;

const HARNESS_PREFIX = `[目标模式 · Agent Loop]
请自主完成以下任务，不要向我反复确认，按 Observe → Plan → Act → Verify → Report 推进：
1. 目标：先明确本次目标与可验证完成标准。
2. 计划：多文件、多步骤、排查或实现类任务必须先调用 todo_manage(action=init) 建立 TODOLIST；简单单步任务可跳过。
3. 观察：先读取项目事实，不凭记忆猜测；无依赖读取/扫描可以一轮批量调用。
4. 执行：按清单推进，能合并的一批一起完成；每完成一项或一批立即 todo_manage(action=update)。
5. 验证：修改或生成后必须读取、运行命令、检查输出或执行测试；失败则继续修复。
6. 汇报：全部 done 或 blocked 后再收尾，逐条核对结果、验证方式和剩余风险。
收口：验证全部通过后调用 exit_target_mode（summary 写清交付了什么、怎么验证、结果如何）显式结束本次循环，然后下一条回复给出最终汇报。干完了就停，不要为"再确认一遍"继续动手；没做完则继续推进，不要靠停发工具或只说"已完成"来结束。

注意：系统会在每轮工具结果开头标注 [目标模式 · x/N 轮]。接近轮数上限时优先完成验证和收尾，不要空转。

任务：`;

function setHarnessProgress(text) {
  if (!harnessStatusEl) return;
  if (!text) {
    harnessStatusEl.classList.add("hidden");
    harnessStatusEl.textContent = "";
    return;
  }
  setIconText(harnessStatusEl, "zap", text);
  harnessStatusEl.classList.remove("hidden");
}

// Autopilot 未确认完成就退出时，把状态条换成「继续」按钮：
// 用户不再需要手打"继续"两个字，一键把剩下的活交回给模型。
function showResumeHint(reason) {
  if (!resumeHintEl) return;
  const text = String(reason || "");
  const label = resumeHintEl.querySelector(".resume-hint-reason");
  if (label) {
    label.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    label.title = text;
  }
  resumeHintEl.classList.remove("hidden");
}

function hideResumeHint() {
  if (resumeHintEl) resumeHintEl.classList.add("hidden");
}

// 目标待机指示：停止轮次结束后保持「仍开启」提示，仅在手动关闭时清空
function showHarnessIdle(note = "") {
  if (state.harness?.enabled !== true) {
    setHarnessProgress(null);
    return;
  }
  setHarnessProgress(note || "目标模式已开启 · 待命自主执行（点输入框「＋」菜单里的目标模式可关闭）");
}

// ── 「＋」模式与功能菜单（输入框回形针旁）────────
function syncModeSwitch(rowId, switchId, on) {
  const row = document.getElementById(rowId);
  const sw = document.getElementById(switchId);
  if (row) {
    row.classList.toggle("on", !!on);
    row.setAttribute("aria-checked", on ? "true" : "false");
  }
  if (sw) sw.classList.toggle("on", !!on);
}

function syncModeMenuGrind() {
  const row = document.getElementById("row-grind");
  const status = document.getElementById("mode-status-grind");
  const st = grindSession?.state;
  const active = !!grindSession && ["grinding", "collecting", "done"].includes(st);
  row?.classList.toggle("on", !!active && st !== "done");
  let text = "把粗糙想法研磨成任务书";
  if (st === "grinding" || st === "collecting") {
    const round = Math.min(grindSession.round || 0, grindSvc.MAX_ROUNDS);
    text = st === "collecting" ? "收墨中 · 可输「收墨」出墨稿" : `研磨中 · 第 ${round}/${grindSvc.MAX_ROUNDS} 轮`;
  } else if (st === "done") {
    text = "墨稿已成 · 可开新一轮";
  }
  if (status) status.textContent = text;
}

function syncModeMenu() {
  syncModeSwitch("row-bs", "sw-bs", brainstormMode || state.brainstormMode === true);
  syncModeSwitch("row-harness", "sw-harness", state.harness?.enabled === true);
  syncModeMenuGrind();
}

function openModeMenu() {
  const modal = document.getElementById("mode-menu-modal");
  if (!modal) return;
  syncModeMenu();
  modal.classList.remove("hidden");
}

function closeModeMenu() {
  document.getElementById("mode-menu-modal")?.classList.add("hidden");
}

// ── 回复方式（对话 / 智能体）与推理强度 ─────────────────────
// 档位表、端点回落表与 reasoningCapabilityOf 都在 store.js：桌面输入框和移动端
// 设置页共用一份，后端 proxy.py 的 REASONING_MAP 由守卫逐条比对（同源）。

// 对话态下磨墨 / 目标模式没有意义（两者都依赖工具与多轮循环），置灰而不是隐藏，便于理解
function setModeRowEnabled(rowId, enabled, disabledHint) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.disabled = !enabled;
  if (disabledHint) row.title = disabledHint;
}

function syncChatModeControls() {
  const sel = document.getElementById("chat-mode-select");
  const isChat = state.chatMode === "chat";
  if (sel && sel.value !== state.chatMode) sel.value = state.chatMode;
  const hint = isChat ? t("对话模式不可用：需要工具与多轮执行，请切回智能体") : "";
  setModeRowEnabled("row-grind", !isChat, hint);
  setModeRowEnabled("row-harness", !isChat, hint);
  // 对话态不执行目标循环：待机横幅此时会谎报"目标模式已开启"，直接收起
  if (isChat) setHarnessProgress(null);
  else showHarnessIdle();
}

// 档位回显：记住上一次同步时生效的模型，用来区分"开机带回一个旧档位"和"用户刚切了模型"
let effortControlModel = "";
const EFFORT_LEVEL_LABELS = { off: "关", low: "低", medium: "中", high: "高" };
const EFFORT_LABELS = { auto: "自动", off: "关", low: "低", medium: "中", high: "高" };
// 墨色：把"想多少"翻成砚台里的浓淡——清墨几乎不落墨，焦墨一次研透。
// --ink 只驱动透明度，深浅在明暗两套主题下都是"越浓越醒目"，不必各配一套颜色。
const EFFORT_SHADE = { auto: "随墨", off: "清墨", low: "淡墨", medium: "浓墨", high: "焦墨" };
const EFFORT_INK = { auto: 0.6, off: 0.28, low: 0.46, medium: 0.74, high: 1 };
// 滑杆刻度跟着模型能力走：index → level，弹窗与 sync 都只认这一份
let effortLevels = [];
let effortPopOpen = false;

// 静默把用户的档位改掉必须让他看见；toast 在 app.js，动态引入避免与 app.js 形成静态环
async function echoEffortFallback(model, dropped) {
  const { toast } = await import("../app.js?v=20260922-002");
  toast(t("{model} 不支持「{level}」推理强度，已回落自动", {
    model: model.name || model.id,
    level: t(EFFORT_LEVEL_LABELS[dropped] || dropped),
  }));
}

function effortLevel() {
  return effortLevels.includes(state.reasoningEffort) ? state.reasoningEffort : "auto";
}

function setEffortPop(open) {
  const pop = document.getElementById("effort-pop");
  const btn = document.getElementById("btn-effort");
  if (!pop || !btn) return;
  effortPopOpen = Boolean(open) && !btn.disabled;
  pop.classList.toggle("hidden", !effortPopOpen);
  btn.setAttribute("aria-expanded", effortPopOpen ? "true" : "false");
  if (effortPopOpen) paintEffortPop(effortLevel());
}

// 墨色小字 + 档名：档位是主信息，墨色是同一件事的第二种读法
function renderEffortTicks(allowed, current) {
  const ticks = document.getElementById("effort-ticks");
  if (!ticks) return;
  const sig = allowed.join("|");
  if (ticks.dataset.sig !== sig) {
    ticks.dataset.sig = sig;
    ticks.textContent = "";
    allowed.forEach((level, i) => {
      const cell = document.createElement("span");
      cell.className = "effort-tick";
      cell.dataset.level = level;
      cell.style.left = allowed.length > 1 ? `${(i / (allowed.length - 1)) * 100}%` : "0%";
      const name = document.createElement("b");
      name.textContent = t(EFFORT_LABELS[level] || level);
      const shade = document.createElement("i");
      shade.textContent = t(EFFORT_SHADE[level] || level);
      shade.style.setProperty("--ink", String(EFFORT_INK[level] ?? 0.6));
      cell.append(name, shade);
      ticks.appendChild(cell);
    });
  }
  for (const cell of ticks.children) cell.classList.toggle("is-on", cell.dataset.level === current);
}

function paintEffortPop(level) {
  const slider = document.getElementById("effort-slider");
  const readout = document.getElementById("effort-pop-readout");
  const hint = document.getElementById("effort-pop-hint");
  const cap = reasoningCapabilityOf(state.currentModel);
  if (slider) {
    slider.max = String(Math.max(0, effortLevels.length - 1));
    slider.value = String(Math.max(0, effortLevels.indexOf(level)));
  }
  renderEffortTicks(effortLevels, level);
  if (readout) readout.textContent = `${t(EFFORT_LABELS[level] || level)} · ${t(EFFORT_SHADE[level] || level)}`;
  if (hint) {
    hint.textContent = REASONING_COLLAPSED_CAPS.has(cap)
      ? t("该端点只分开关，低/中/高都会按「开」下发")
      : t("拖动落定即生效，小字是该档对应的墨色");
  }
}

function syncEffortControl() {
  const btn = document.getElementById("btn-effort");
  const label = document.getElementById("effort-pill-label");
  const shade = document.getElementById("effort-pill-shade");
  if (!btn || !label || !shade) return;
  const cap = reasoningCapabilityOf(state.currentModel);
  const allowed = reasoningLevelsOf(state.currentModel);
  const unsupported = cap === "none";
  effortLevels = allowed;
  // 只在"用户刚切了模型"时回声一次回落：开机就带回落到 auto 的档位不该每次启动都弹条
  const currentId = state.currentModel?.id || "";
  const justSwitched = !!effortControlModel && !!currentId && effortControlModel !== currentId;
  effortControlModel = currentId;
  if (!allowed.includes(state.reasoningEffort)) {
    // 注册表尚未返回时 currentModel 为 null，能力只是"未知"而不是"不支持"：
    // 此处若回落会把用户存的档位打回 auto 并落盘，等 model 订阅到达后再同步。
    if (state.currentModel) {
      const dropped = state.reasoningEffort;
      setReasoningEffort("auto");
      btn.title = t("当前模型不支持该档位，已回落自动");
      if (justSwitched) {
        // 静默回落等于"我偷偷改了你的设置"，切模型这一刻要明说
        echoEffortFallback(state.currentModel, dropped);
      }
    }
  } else if (unsupported) {
    btn.title = t("当前模型不支持推理强度设置");
  } else if (REASONING_COLLAPSED_CAPS.has(cap)) {
    // 只分开关的家：让用户知道「中」和「高」在上游是同一个值，而不是我们没生效
    btn.title = t("该端点只分开关，低/中/高都会按「开」下发");
  } else {
    btn.title = t("推理强度");
  }
  const level = effortLevel();
  label.textContent = t(EFFORT_LABELS[level] || level);
  shade.style.setProperty("--ink", String(EFFORT_INK[level] ?? 0.6));
  btn.disabled = unsupported;
  btn.classList.toggle("is-na", unsupported);
  if (unsupported) setEffortPop(false);
  // 刻度始终按当前能力重画：置灰的滑杆留着上一个模型的五档，DOM 就在说谎
  paintEffortPop(level);
}

function initInputModeSelectors() {
  const modeSel = document.getElementById("chat-mode-select");
  modeSel?.addEventListener("change", () => {
    setChatMode(modeSel.value);
  });
  const effortBtn = document.getElementById("btn-effort");
  const effortSlider = document.getElementById("effort-slider");
  effortBtn?.addEventListener("click", () => setEffortPop(!effortPopOpen));
  // 拖动只刷新读数与刻度，松手/键盘落定才写设置：与上下文预算滑杆同一套节奏
  effortSlider?.addEventListener("input", () => {
    paintEffortPop(effortLevels[Number(effortSlider.value)] || "auto");
  });
  effortSlider?.addEventListener("change", () => {
    const level = effortLevels[Number(effortSlider.value)] || "auto";
    if (level !== state.reasoningEffort) setReasoningEffort(level);
    syncEffortControl();
  });
  document.addEventListener("pointerdown", (e) => {
    if (effortPopOpen && !e.target?.closest?.("#effort-picker")) setEffortPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && effortPopOpen) {
      setEffortPop(false);
      effortBtn?.focus();
    }
  });
  subscribe("chatMode", syncChatModeControls);
  subscribe("model", () => {
    syncEffortControl();
    syncChatModeControls();
  });
  // 档位还可能被黑板工作流条、手机遥控那侧改掉：只订阅 model 会让胶囊停在旧值
  subscribe("reasoningEffort", syncEffortControl);
  // 目标模式开关也可能被 exit_target_mode 关掉：不订阅就会留下"菜单里还亮着、实际已关"的假开关
  subscribe("harness", () => {
    syncModeMenu();
    showHarnessIdle();
  });
  syncChatModeControls();
  syncEffortControl();
}

// ── TODOLIST 实时面板（消息区右侧栏，按对话隔离） ─────────────
let todoPanelEl = null;

function setIconOnly(el, name) {
  if (!el) return;
  el.textContent = "";
  el.appendChild(iconSvgEl(name));
}

function setWarningText(el, message) {
  if (!el) return;
  el.textContent = "";
  el.appendChild(iconSvgEl("alert-triangle"));
  el.appendChild(document.createTextNode(" " + message));
}

// 右栏的开合在两处入口（顶栏按钮 / Codex 输入框上方快捷行）共用一份状态，
// 快捷行是顶栏按钮的克隆（Codex 下面板头是 display:none），所以两边都要跟着改。
function syncTodoRailButton(items) {
  const open = state.todoPanelOpen !== false;
  const count = items.length;
  const done = items.filter(x => x.status === "done").length;
  // 收起之后清单彻底看不见，进度只能靠这颗按钮报一句，否则"折叠"等于"失联"
  const title = !count ? t("这一场还没有任务清单")
    : open ? t("折叠任务清单")
    : t("展开任务清单 {done}/{total}", { done, total: count });
  for (const el of [document.getElementById("btn-todo-panel"),
    document.querySelector('[data-cx-key="todo"]')]) {
    if (!el) continue;
    el.title = title;
    el.disabled = !count;
    el.classList.toggle("is-na", !count);
    el.classList.toggle("rail-toggle-on", open && count > 0);
    el.setAttribute("aria-pressed", open ? "true" : "false");
  }
}

function renderTodoPanel() {
  if (!todoPanelEl) return;
  const items = getConversationTodos(state.currentConversationId);
  syncTodoRailButton(items);
  // 收起是用户点的，清单再长也不擅自把栏撑回来
  if (!items.length || state.todoPanelOpen === false) {
    todoPanelEl.classList.add("hidden");
    todoPanelEl.innerHTML = "";
    return;
  }
  const done = items.filter(t => t.status === "done").length;
  const blocked = items.filter(t => t.status === "blocked").length;
  const inProgress = items.filter(t => t.status === "in_progress").length;
  todoPanelEl.innerHTML = "";
  todoPanelEl.classList.remove("hidden");

  const header = document.createElement("div");
  header.className = "todo-panel-header";
  header.title = t("折叠任务清单");
  const title = document.createElement("span");
  title.className = "todo-panel-title";
  title.textContent = t("任务清单 {done}/{total}", { done, total: items.length }) + (blocked ? t(" · 受阻 {n}", { n: blocked }) : "") + (inProgress ? t(" · 进行中 {n}", { n: inProgress }) : "");
  const bar = document.createElement("span");
  bar.className = "todo-progress";
  const fill = document.createElement("span");
  fill.className = "todo-progress-fill";
  fill.style.width = Math.round((done / items.length) * 100) + "%";
  bar.appendChild(fill);
  const toggle = document.createElement("span");
  toggle.className = "todo-toggle";
  toggle.textContent = "▾";
  header.append(title, bar, toggle);
  header.addEventListener("click", () => setTodoPanelOpen(false));
  todoPanelEl.appendChild(header);

  const body = document.createElement("div");
  body.className = "todo-panel-body";
  const icons = { done: "check", in_progress: "clock", blocked: "alert-triangle", pending: "info" };
  for (const t of items) {
    const status = ["done", "in_progress", "blocked"].includes(t.status) ? t.status : "pending";
    const row = document.createElement("div");
    row.className = "todo-item todo-" + status;
    const icon = document.createElement("span");
    icon.className = "todo-icon";
    icon.appendChild(iconSvgEl(icons[status]));
    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = t.content;
    row.append(icon, text);
    body.appendChild(row);
  }
  todoPanelEl.appendChild(body);
}

// ── @ 提及：项目文件 / Skill / 内置工具 / MCP / 专家包────────────
let mentionPopup = null;
let mentionCandidates = [];
let mentionIndex = 0;
let mentionQuery = "";
let mentionSearchSeq = 0;
let mentionSearchTimer = null;
let mentionHighlightLayer = null;
let mentionKindFilter = null;
let mentionBlurTimer = null;

function normalizeMentionText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\\/_\-.:\s()[\]{}"'`]+/g, "");
}

function subsequenceScore(needle, haystack) {
  if (!needle) return 0;
  let pos = 0;
  let gaps = 0;
  for (const ch of needle) {
    const next = haystack.indexOf(ch, pos);
    if (next < 0) return -1;
    gaps += Math.max(0, next - pos);
    pos = next + 1;
  }
  return Math.max(1, 45 - gaps);
}

function scoreMentionCandidate(candidate, query) {
  const q = String(query || "").trim().toLowerCase();
  const nq = normalizeMentionText(q);
  if (!q && !nq) return 80 - (candidate.priority || 0);
  const fields = [
    candidate.name,
    candidate.label,
    candidate.desc,
    candidate.path,
    ...(candidate.aliases || []),
  ].map(x => String(x || "").toLowerCase());
  const normalized = fields.map(normalizeMentionText);
  let best = -1;
  for (const field of fields) {
    if (!field) continue;
    if (field === q) best = Math.max(best, 120);
    else if (field.startsWith(q)) best = Math.max(best, 105);
    else if (field.includes(q)) best = Math.max(best, 85);
  }
  for (const field of normalized) {
    if (!field || !nq) continue;
    if (field === nq) best = Math.max(best, 118);
    else if (field.startsWith(nq)) best = Math.max(best, 102);
    else if (field.includes(nq)) best = Math.max(best, 80);
    else best = Math.max(best, subsequenceScore(nq, field));
  }
  if (best < 0) return -1;
  return best - (candidate.priority || 0);
}

function addMentionCandidate(map, candidate) {
  const key = `${candidate.kind || candidate.type}:${candidate.mention || candidate.name}`;
  if (!map.has(key)) map.set(key, candidate);
}

function flattenProjectEntries(entries, basePath = "", out = []) {
  for (const entry of entries || []) {
    const path = entry.path || [basePath, entry.name].filter(Boolean).join("/");
    out.push({
      kind: "file",
      type: entry.type === "dir" ? "目录" : "文件",
      name: path,
      label: entry.name || path,
      mention: path,
      desc: entry.type === "dir" ? "项目目录" : `项目文件${entry.size ? ` · ${entry.size}B` : ""}`,
      path,
      priority: entry.type === "dir" ? 23 : 20,
      aliases: [entry.name, path.replace(/\//g, " ")],
    });
    if (entry.children?.length) flattenProjectEntries(entry.children, path, out);
  }
  return out;
}

function collectRemoteMcpTools() {
  const result = [];
  const remoteTools = Array.isArray(state.skills?.remoteTools) ? state.skills.remoteTools : [];
  for (const rt of remoteTools) {
    const serverId = rt.serverId || rt.server_id || rt.server || "server";
    const mention = rt.fullName || rt.id || `mcp__${serverId}__${rt.name}`;
    result.push({
      kind: "mcp",
      type: "MCP",
      name: mention,
      label: rt.name || mention,
      mention,
      desc: `[${rt.server || rt.serverName || serverId}] ${rt.description || rt.desc || ""}`.trim(),
      priority: 8,
      aliases: [rt.name, rt.server, rt.serverName, serverId, mention],
      raw: rt,
    });
  }
  const remote = state.skills?.remote || {};
  for (const [name, desc] of Object.entries(remote)) {
    result.push({
      kind: "mcp",
      type: "MCP",
      name,
      label: name.replace(/^mcp__[^_]+__/, ""),
      mention: name,
      desc,
      priority: 9,
      aliases: [name, String(desc || "")],
    });
  }
  return result;
}

function makeFileCandidate(item) {
  const path = item.path || item.name || "";
  return {
    kind: "file",
    type: item.type === "dir" ? "目录" : "文件",
    name: path,
    label: item.name || path,
    mention: path,
    desc: item.type === "dir" ? "项目目录" : `项目文件${item.size ? ` · ${item.size}B` : ""}`,
    path,
    priority: item.type === "dir" ? 23 : 20,
    aliases: [item.name, path.replace(/\//g, " ")],
  };
}

function getMentionCandidates(query, extraFiles = []) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const experts = getExpertsCached() || [];
  const candidates = new Map();
  const treeEntries = Array.isArray(state.projectFileTree?.entries)
    ? state.projectFileTree.entries
    : Array.isArray(state.projectFileTree)
      ? state.projectFileTree
      : [];

  flattenProjectEntries(treeEntries).forEach(c => addMentionCandidate(candidates, c));
  extraFiles.forEach(item => addMentionCandidate(candidates, makeFileCandidate(item)));
  Object.entries(TOOLS || {}).forEach(([name, tool]) => addMentionCandidate(candidates, {
    kind: "tool",
    type: "工具",
    name,
    label: tool?.name || name,
    mention: name,
    desc: tool?.description || "",
    priority: 5,
    aliases: [tool?.name, name],
  }));
  Object.entries(mcp).forEach(([name, desc]) => addMentionCandidate(candidates, {
    kind: "mcp",
    type: "MCP",
    name,
    label: name,
    mention: name,
    desc,
    priority: 6,
  }));
  collectRemoteMcpTools().forEach(c => addMentionCandidate(candidates, c));
  Object.entries(skills).forEach(([name, desc]) => addMentionCandidate(candidates, {
    kind: "skill",
    type: "Skill",
    name,
    label: name,
    mention: name,
    desc,
    priority: 1,
    aliases: [name, String(desc || "").split(/[。.\n]/)[0]],
  }));
  // 提及用 id：它是文件名、纯 ASCII 不带空格；中文名和标签只作为搜索别名
  (Array.isArray(state.actions) ? state.actions : []).forEach(a => addMentionCandidate(candidates, {
    kind: "action",
    type: "Action",
    name: a.id,
    label: a.name || a.id,
    mention: a.id,
    desc: [a.description, a.when ? t("适用：{when}", { when: a.when }) : ""].filter(Boolean).join(" ｜ "),
    priority: 2,
    aliases: [a.name, a.id, ...(a.tags || [])],
  }));
  experts.map(x => ({
    kind: "expert",
    type: "Expert",
    name: x.name || x.id,
    label: x.name || x.id,
    mention: x.name || x.id,
    desc: x.description || t("专家包 · 知识 {k} · 技能 {s}", { k: x.knowledge_count || 0, s: x.skills_count || 0 }),
    priority: 30,
    id: x.id,
  })).forEach(c => addMentionCandidate(candidates, c));

  return [...candidates.values()]
    .map(c => ({ ...c, score: scoreMentionCandidate(c, query) }))
    .filter(c => c.score >= 0)
    .sort((a, b) => b.score - a.score || a.priority - b.priority || String(a.name).localeCompare(String(b.name)));
}

async function findMentionFiles(query) {
  if (!state.project || !String(query || "").trim()) return [];
  try {
    const res = await post("/projects/find", { query: String(query).trim(), limit: 40 });
    return res.code === 0 ? (res.data?.matches || []) : [];
  } catch (e) {
    return [];
  }
}

function readMentionTokens(text) {
  const tokens = [];
  const re = /@"((?:\\.|[^"\\])*)"|@([^\s@]+)/g;
  let match;
  while ((match = re.exec(text || ""))) {
    const raw = match[1] !== undefined
      ? match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
      : String(match[2] || "").replace(/[，。！？,.!?;；:：)）\]】]+$/g, "");
    if (raw) tokens.push(raw);
  }
  return [...new Set(tokens)];
}

function escapeHtmlLocal(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appendHighlightedMentionText(parent, text, query) {
  const raw = String(text || "");
  const q = String(query || "").trim();
  const idx = q ? raw.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) {
    parent.appendChild(document.createTextNode(raw));
    return;
  }
  parent.appendChild(document.createTextNode(raw.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.className = "mention-match";
  mark.textContent = raw.slice(idx, idx + q.length);
  parent.appendChild(mark);
  parent.appendChild(document.createTextNode(raw.slice(idx + q.length)));
}

function buildMentionHighlightHtml(text) {
  const src = String(text || "");
  const re = /@"((?:\\.|[^"\\])*)"|@([^\s@]+)/g;
  let html = "";
  let last = 0;
  let match;
  while ((match = re.exec(src))) {
    html += escapeHtmlLocal(src.slice(last, match.index));
    html += `<span class="mention-mark">${escapeHtmlLocal(match[0])}</span>`;
    last = re.lastIndex;
  }
  html += escapeHtmlLocal(src.slice(last));
  if (src.endsWith("\n")) html += " ";
  return html;
}

function syncMentionHighlight() {
  if (!chatInput || !mentionHighlightLayer) return;
  const text = chatInput.value || "";
  mentionHighlightLayer.innerHTML = buildMentionHighlightHtml(text);
  mentionHighlightLayer.scrollTop = chatInput.scrollTop;
  mentionHighlightLayer.scrollLeft = chatInput.scrollLeft;
  chatInput.classList.toggle("mention-highlight-active", /@"(?:\\.|[^"\\])*"|@[^\s@]+/.test(text));
}

function setupMentionHighlight() {
  if (!chatInput || chatInput.parentElement?.classList.contains("chat-input-wrap")) return;
  const editorZone = chatInput.closest(".input-editor-zone") || chatInput.parentNode;
  const wrap = document.createElement("div");
  wrap.className = "chat-input-wrap";
  editorZone.insertBefore(wrap, chatInput);
  wrap.appendChild(chatInput);
  mentionHighlightLayer = document.createElement("div");
  mentionHighlightLayer.className = "mention-highlight-layer";
  wrap.insertBefore(mentionHighlightLayer, chatInput);
  chatInput.addEventListener("scroll", syncMentionHighlight);
  syncMentionHighlight();
}

// 获取光标前正在输入的 @token；返回 { start, query } 或 null
function detectMentionToken() {
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const before = chatInput.value.slice(0, pos);
  const quoted = /(^|[\s])@"([^"\n]*)$/.exec(before);
  if (quoted) return { start: pos - quoted[2].length - 2, query: quoted[2], quoted: true };
  const m = /(^|[\s])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: pos - m[2].length - 1, query: m[2] };
}

function formatMentionInsert(candidate) {
  const value = String(candidate.mention || candidate.name || "").trim();
  if (!value) return "";
  if (/[\s"@]/.test(value)) return `@"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}" `;
  return `@${value} `;
}

function hideMentionPopup(invalidate = true) {
  if (mentionPopup) { mentionPopup.remove(); mentionPopup = null; }
  if (invalidate && mentionSearchTimer) {
    clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  }
  if (invalidate) {
    mentionSearchSeq++;
    mentionQuery = "";
    mentionKindFilter = null;
  }
  mentionCandidates = [];
  mentionIndex = 0;
}

function renderMentionPopup() {
  const area = document.getElementById("chat-input-area");
  if (!area) return;
  if (!mentionCandidates.length) { hideMentionPopup(false); return; }
  if (!mentionPopup) {
    mentionPopup = document.createElement("div");
    mentionPopup.className = "mention-popup";
    area.appendChild(mentionPopup);
  }
  mentionPopup.innerHTML = "";
  mentionCandidates.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "mention-item" + (i === mentionIndex ? " active" : "");
    const badge = document.createElement("span");
    const kindClass = c.kind === "file"
      ? "skill-kind-file"
      : c.kind === "action"
        ? "skill-kind-action"
        : c.kind === "mcp" || c.type === "工具"
          ? "skill-kind-mcp"
          : c.type === "Skill"
            ? "skill-kind-skill"
            : "skill-kind-expert";
    badge.className = "skill-kind-badge " + kindClass;
    badge.textContent = c.type;
    const name = document.createElement("span");
    name.className = "mention-name";
    appendHighlightedMentionText(name, c.name, mentionQuery);
    const desc = document.createElement("span");
    desc.className = "mention-desc";
    appendHighlightedMentionText(desc, c.desc, mentionQuery);
    item.appendChild(badge);
    item.appendChild(name);
    item.appendChild(desc);
    item.addEventListener("mousedown", (e) => { e.preventDefault(); applyMention(c); });
    mentionPopup.appendChild(item);
  });
  // 无 SKILL.md 技能时给出提示，避免误以为只能提及工具
  const skillCount = Object.keys(state.skills?.skills || {}).length;
  if (skillCount === 0) {
    const hint = document.createElement("div");
    hint.className = "mention-hint";
    hint.textContent = "暂无 Skill：在右侧「工具 / 技能」面板点击「导入技能」或「新建技能」添加 SKILL.md";
    mentionPopup.appendChild(hint);
  }
  const hint = document.createElement("div");
  hint.className = "mention-hint mention-search-hint";
  hint.textContent = state.project ? "可搜索项目文件、Skill、内置工具和 MCP；路径支持 /，含空格会自动加引号" : "可搜索 Skill、内置工具和 MCP；打开项目后可提及项目文件";
  mentionPopup.appendChild(hint);
}

function filterMentionKind(candidates) {
  return mentionKindFilter ? candidates.filter(c => c.kind === mentionKindFilter) : candidates;
}

function updateMentionPopup() {
  const token = detectMentionToken();
  if (!token) { hideMentionPopup(); return; }
  mentionQuery = token.query || "";
  const seq = ++mentionSearchSeq;
  mentionCandidates = filterMentionKind(getMentionCandidates(mentionQuery)).slice(0, 12);
  mentionIndex = 0;
  renderMentionPopup();
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  if (!state.project || !mentionQuery.trim()) return;
  mentionSearchTimer = setTimeout(async () => {
    mentionSearchTimer = null;
    const files = await findMentionFiles(mentionQuery);
    if (seq !== mentionSearchSeq) return;
    mentionCandidates = filterMentionKind(getMentionCandidates(mentionQuery, files)).slice(0, 14);
    mentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1));
    renderMentionPopup();
  }, 120);
}

function openMentionPicker(kind) {
  const input = chatInput || document.getElementById("chat-input");
  if (!input) return;
  if (mentionBlurTimer) { clearTimeout(mentionBlurTimer); mentionBlurTimer = null; }
  if (kind === "file" && !state.project) {
    toast(t("提及文件需先打开项目"), "warn");
    return;
  }
  input.focus();
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  if (!/(^|[\s])@([^\s@]*)$/.test(before) && !/(^|[\s])@"([^"\n]*)$/.test(before)) {
    const spacer = pos > 0 && !/\s/.test(input.value[pos - 1]) ? " " : "";
    input.value = input.value.slice(0, pos) + spacer + "@" + input.value.slice(pos);
    input.setSelectionRange(pos + spacer.length + 1, pos + spacer.length + 1);
  }
  mentionKindFilter = kind;
  syncMentionHighlight();
  updateMentionPopup();
}

function applyMention(candidate) {
  const token = detectMentionToken();
  if (!token) { hideMentionPopup(); return; }
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const insert = formatMentionInsert(candidate);
  chatInput.value = chatInput.value.slice(0, token.start) + insert + chatInput.value.slice(pos);
  const caret = token.start + insert.length;
  chatInput.setSelectionRange(caret, caret);
  chatInput.focus();
  hideMentionPopup();
  syncMentionHighlight();
  try { localStorage.setItem(CHAT_DRAFT_KEY, chatInput.value); } catch (e) {}
}

async function resolveMentionedProjectPath(name) {
  if (!state.project) return "";
  const looksLikePath = /[\\/]/.test(name) || /\.[A-Za-z0-9]{1,8}$/.test(name) || name.startsWith(".");
  if (!looksLikePath) return "";
  try {
    const res = await post("/projects/browse", { path: name });
    if (res.code !== 0 || !res.data) return "";
    const d = res.data;
    if (d.type === "file") {
      return `\n\n[提及项目文件 ${d.path || name}]\n${String(d.content || "").slice(0, 10000)}`;
    }
    const entries = (d.entries || []).slice(0, 80).map(e => `${e.type === "dir" ? "[目录]" : "[文件]"} ${e.name}${e.size ? ` (${e.size}B)` : ""}`);
    return `\n\n[提及项目目录 ${d.path || name}]\n${entries.join("\n") || "(空目录)"}`;
  } catch (e) {
    return "";
  }
}

// @提及的 Action 每次都随消息重发：不设上限等于让一份 64 KB 的 yml 常驻上下文
const ACTION_MENTION_LIMIT = 6000;

async function resolveMentionedAction(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(String(id || ""))) return "";
  try {
    const res = await get(`/actions/${encodeURIComponent(id)}`);
    if (res.code !== 0 || !res.data) return "";
    const text = renderAction(res.data);
    return `\n\n${text.length > ACTION_MENTION_LIMIT
      ? `${text.slice(0, ACTION_MENTION_LIMIT)}\n…（提及注入已截断，完整流程用 actions_read id=${id} 读取）`
      : text}`;
  } catch (e) {
    return "";
  }
}

function resolveRemoteMention(name) {
  const all = collectRemoteMcpTools();
  const item = all.find(x => x.mention === name || x.name === name || x.label === name);
  if (!item) return "";
  return `\n\n[提及 MCP 工具] ${item.mention}\n${item.desc || ""}\n任务需要时请通过 skill_run 调用，skill 参数使用 ${item.mention}。`;
}

// 发送时解析消息中的 @提及：文件注入内容/目录，工具注入调用提示，Action 注入流程单（截断上限内），Skill 注入 SKILL.md，MCP 注入远程工具提示，专家包注入人格/规则/知识
// 同名冲突时内置工具优先：工具名改不了，Action id 是用户自己起的
async function resolveMentions(text) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const tokens = readMentionTokens(text);
  let context = "";
  for (const name of tokens) {
    const fileContext = await resolveMentionedProjectPath(name);
    if (fileContext) {
      context += fileContext;
    } else if (TOOLS?.[name]) {
      context += `\n\n[提及内置工具] ${name} (${TOOLS[name].name || name})\n${TOOLS[name].description || ""}\n任务需要时请用该工具完成，不要把提及误当成普通文本。`;
    } else if (state.actions?.some(a => a.id === name)) {
      context += await resolveMentionedAction(name);
    } else if (mcp[name]) {
      context += `\n\n[提及工具] ${name} ${mcp[name]}。任务需要时请通过 skill_run 工具调用。`;
    } else if (skills[name]) {
      let injected = false;
      try {
        const res = await post("/skills/execute", { skill: name, params: {} });
        if (res.code === 0 && res.data?.content) {
          context += `\n\n[提及技能 ${name}]\n请遵循该 SKILL.md 定义完成任务：\n${res.data.content}`;
          injected = true;
        }
      } catch (e) { /* 降级为描述*/ }
      if (!injected) {
        context += `\n\n[提及技能 ${name}] ${skills[name]}`;
      }
    } else {
      const injected = resolveRemoteMention(name) || await resolveExpertMention(name);
      if (injected) context += injected;
    }
  }
  return context;
}

// 提及专家包：注入 persona + rules，并附带前 6 个知识文件内容（每个 4000 字符）
async function resolveExpertMention(name) {
  let experts = [];
  try {
    experts = getExpertsCached() || [];
    if (!experts.length) experts = await loadExperts();
  } catch (e) { return ""; }
  const expert = experts.find(x => (x.name || x.id) === name);
  if (!expert) return "";
  try {
    const detail = await getExpert(expert.id, { force: true });
    const parts = [`\n\n[提及专家包 ${detail.name || name}]\n请以该专家的身份完成本次任务。`];
    if (String(detail.persona || "").trim()) parts.push(`[专家人格]\n${detail.persona.trim()}`);
    if (String(detail.rules || "").trim()) parts.push(`[专家规则]\n${detail.rules.trim()}`);
    const kFiles = (detail.knowledge || []).slice(0, 6);
    for (const f of kFiles) {
      try {
        const content = await readExpertFile(expert.id, "knowledge", f.name);
        if (content.trim()) parts.push(`[专家知识 · ${f.name}]\n${content.slice(0, 4000)}`);
      } catch (e) { /* 单文件失败不阻塞 */ }
    }
    return parts.join("\n\n");
  } catch (e) {
    return `\n\n[提及专家包 ${name}] ${expert.description || "专家包内容加载失败"}`;
  }
}

// ── 用量同步到后端 ──────────────────────────

async function syncUsageToBackend() {
  if (!state.currentConversationId) return;
  const ctxTokens = measureContext(state.messages).total;
  try {
    await patch(`/chat/conversations/${state.currentConversationId}/usage`, {
      total_tokens: state.usage.totalTokens,
      prompt_tokens: state.usage.promptTokens,
      completion_tokens: state.usage.completionTokens,
      message_count: state.usage.messageCount,
      context_tokens: ctxTokens,
    });
  } catch (e) {
    console.warn("用量同步失败:", e);
  }
}

// ─ Markdown 渲染：统一使用 services/markdown.js（代码块保护 + HTML 转义 + 流式部分输出兼容）─

function normalizeMessageForRender(msg) {
  const normalized = {
    ...msg,
    role: ["system", "user", "assistant", "tool"].includes(msg?.role) ? msg.role : "assistant",
    content: stripReasoningFromContent(typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "")),
  };
  // 原生工具协议元数据 rehydrate：刷新/切会话后从后端 metadata 恢复 toolCalls 与历史工具结果
  if (!Array.isArray(normalized.toolCalls) && Array.isArray(msg?.metadata?.toolCalls)) normalized.toolCalls = msg.metadata.toolCalls;
  if (!Array.isArray(normalized.toolResults) && Array.isArray(msg?.metadata?.toolResults)) normalized.toolResults = msg.metadata.toolResults;
  if (typeof normalized.display === "string") {
    normalized.display = stripReasoningFromContent(normalized.display);
  }

  if (normalized.role === "assistant") {
    const calls = detectAllCalls(normalized.content);
    if (calls.length > 0) {
      normalized.content = stripToolCalls(normalized.content);
      // 执行循环进行中的消息：调用尚未执行，禁止合成"历史恢复"成功卡片
      if (!_pendingToolMsgs.has(msg)) {
        normalized.toolResults = [
          ...(Array.isArray(normalized.toolResults) ? normalized.toolResults : []),
          ...calls.map(call => ({
            call,
            result: {
              success: true,
              output: "这是从历史记录中恢复的工具调用。diff 预览结果未保存在旧历史中，请重新发起编辑以生成可接受的 diff。",
              historical: true,
            },
          })),
        ];
      }
    }
  }

  return normalized;
}

function isHiddenContextMessage(msg) {
  return msg?.hidden === true || msg?.metadata?.hidden === true || msg?.model === "[tool_results]";
}

// ── 会话项目徽章：记录对话发起时打开的项目──────────

let convProjectEl;

function currentProjectLabel() {
  // 已保存对话取创建时记录的项目名；新对话实时跟随当前打开的项目
  if (state.currentConversationId) {

    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    return conv?.project || "";
  }
  return state.project?.name || "";
}

function updateConvProjectBadge() {
  if (!convProjectEl) return;
  const name = currentProjectLabel();
  setIconText(convProjectEl, "folder", name || t("无项目"));
  convProjectEl.classList.toggle("conv-project-none", !name);
  convProjectEl.title = name ? t("本对话发起于项目「{name}」", { name }) : "本对话发起时未打开项目";
}

// ── 新对话欢迎页 ────────────────────────

function buildWelcomeEl() {
  const el = document.createElement("div");
  el.className = "chat-welcome";
  el.innerHTML = `
    <img class="chat-welcome-logo" src="./icon.png" alt="SLATE">
    <h1 class="chat-welcome-title">研磨灵感，落笔成章</h1>
    <span class="chat-welcome-sep"></span>
    <p class="chat-welcome-sub">本地 AI 协作调度台 · 数据不出本机 · 原生零构建</p>
    <p class="chat-welcome-hint">输入消息开始对话，@ 可提及文件或技能</p>
  `;
  return el;
}

// 消息内联编辑：内容区临时替换为 textarea，保存后写回后端并重渲染
function startInlineEdit(msgEl, contentEl, msg) {
  if (msgEl.querySelector(".msg-edit-textarea")) return;
  const original = msg.display ?? msg.content ?? "";
  const ta = document.createElement("textarea");
  ta.className = "msg-edit-textarea";
  ta.value = original;
  ta.rows = Math.min(14, Math.max(3, String(original).split("\n").length));

  const bar = document.createElement("div");
  bar.className = "msg-edit-bar";
  const saveBtn = document.createElement("button");
  saveBtn.className = "msg-edit-save";
  saveBtn.textContent = "保存";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "msg-edit-cancel";
  cancelBtn.textContent = "取消";
  bar.append(saveBtn, cancelBtn);

  const restore = () => {
    ta.remove();
    bar.remove();
    contentEl.style.display = "";
  };

  saveBtn.addEventListener("click", async () => {
    const val = ta.value.trim();
    if (!val || val === original) { restore(); return; }
    msg.content = val;
    if (msg.display !== undefined) msg.display = val;
    if (msg.id) {
      try { await patch(`/chat/messages/${msg.id}`, { content: val }); } catch (e) {}
    }
    contentEl.innerHTML = renderMarkdown(msg.display ?? msg.content);
    contentEl.querySelectorAll("pre code").forEach((block) => {
      if (window.hljs) hljs.highlightElement(block);
    });
    attachCodeCopyButtons(contentEl);
    restore();
    dlgToast("消息已更新");
  });
  cancelBtn.addEventListener("click", restore);

  contentEl.style.display = "none";
  contentEl.insertAdjacentElement("afterend", ta);
  ta.insertAdjacentElement("afterend", bar);
  ta.focus();
}

// ── 消息渲染 ──────────────────────────────

// 压缩写回的摘要消息：整段铺在对话流里像一条新消息，这里收成一行折叠条。
// 载荷本身一个字都不改，改的只是呈现。
function renderHistorySummary(msg) {
  const wrap = document.createElement("div");
  wrap.className = "msg-history-summary";
  const body = String(msg.content || "").replace(/^\s*\[历史摘要\]\s*:?\s*/, "");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "msg-history-summary-head";
  head.setAttribute("aria-expanded", "false");
  head.appendChild(iconSvgEl("package", "msg-history-summary-icon"));

  const label = document.createElement("span");
  label.className = "msg-history-summary-label";
  label.textContent = t("更早的对话已压缩为摘要");
  head.appendChild(label);

  const meta = document.createElement("span");
  meta.className = "msg-history-summary-meta";
  meta.textContent = `≈ ${fmtTokens(estimateTokens(body))} tokens`;
  head.appendChild(meta);

  const toggle = document.createElement("span");
  toggle.className = "msg-history-summary-toggle";
  toggle.textContent = t("展开");
  head.appendChild(toggle);

  const panel = document.createElement("div");
  panel.className = "msg-history-summary-body";
  panel.hidden = true;
  let parsed = false;
  head.addEventListener("click", () => {
    if (!parsed) {
      panel.innerHTML = renderMarkdown(body);
      panel.querySelectorAll("pre code").forEach((block) => {
        if (window.hljs) hljs.highlightElement(block);
      });
      attachCodeCopyButtons(panel);
      parsed = true;
    }
    panel.hidden = !panel.hidden;
    head.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    toggle.textContent = panel.hidden ? t("展开") : t("收起");
  });

  wrap.append(head, panel);
  return wrap;
}

function renderMessage(msg, index) {
  // normalizeMessageForRender 返回新对象副本；按钮闭包必须持有原对象，
  // 否则 regenerateMessage/删除里的 indexOf/过滤会找不到消息
  const origMsg = msg;
  msg = normalizeMessageForRender(msg);
  const div = document.createElement("div");
  div.className = `msg msg-${msg.role}`;
  div.dataset.index = index;

  // 磨墨会话中的消息加墨痕样式
  if (grindSession && state.currentConversationId === grindSession.conversation_id) {

    div.classList.add("msg-grind");
  }

  // 压缩摘要：折叠条，不铺全文
  if (isHistorySummary(msg)) {
    div.appendChild(renderHistorySummary(msg));
    return div;
  }

  if (msg.role === "assistant" && msg.model) {
    const label = document.createElement("div");
    label.className = "msg-model-label";
    label.textContent = msg.model;
    div.appendChild(label);
  }

  // 文件附件展示
  if (msg.files && msg.files.length > 0) {
    const fileDiv = document.createElement("div");
    fileDiv.className = "msg-file-attach";
    for (const f of msg.files) {
      const tag = document.createElement("span");
      tag.className = "msg-file-tag";
      if (f.type === "image" && f.thumbnail) {
        const img = document.createElement("img");
        img.src = f.thumbnail;
        img.style.cursor = "zoom-in";
        img.addEventListener("click", () => showImageLightbox(f.thumbnail, f.name));
        tag.appendChild(img);
      }
      const nameSpan = document.createElement("span");
      nameSpan.textContent = f.name;
      tag.appendChild(nameSpan);
      fileDiv.appendChild(tag);
    }
    div.appendChild(fileDiv);
  }

  const content = document.createElement("div");
  content.className = "msg-content";
  content.innerHTML = renderMarkdown(msg.display ?? msg.content);
  div.appendChild(content);

  if (Array.isArray(msg.toolResults)) {
    div.appendChild(renderToolCallGroup(msg.toolResults));
  }

  // 消息操作按钮
  if (msg.role !== "system") {
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    // 复制按钮
    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-action-btn";
    setIconOnly(copyBtn, "copy");
    copyBtn.title = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(msg.display ?? msg.content);
        setIconOnly(copyBtn, "check");
        setTimeout(() => { setIconOnly(copyBtn, "copy"); }, 1200);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);

    // 重新生成按钮（仅助手消息）
    if (msg.role === "assistant") {

      const regenBtn = document.createElement("button");
      regenBtn.className = "msg-action-btn";
      setIconOnly(regenBtn, "rotate-cw");
      regenBtn.title = "重新生成";
      regenBtn.addEventListener("click", () => regenerateMessage(origMsg, div));
      actions.appendChild(regenBtn);
    }

    // 编辑/删除（仅已持久化到后端的消息）
    if (msg.id) {
      createEditDeleteActions(actions, origMsg, div, content);
    }

    div.appendChild(actions);
  }

  // Highlight.js
  content.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs) hljs.highlightElement(block);
  });
  attachCodeCopyButtons(content);

  // 磨墨会话中的墨稿：重渲染动作按钮（刷新页面后可恢复）
  if (msg.role === "assistant" && grindSession && state.currentConversationId === grindSession.conversation_id) {
    const draft = grindSvc.detectDraft(msg.content || "");
    if (draft) appendDraftActions(div, draft);
  }

  return div;
}

// 消息编辑/删除按钮（消息持久化后补建）
function createEditDeleteActions(actions, msg, msgEl, contentEl) {
  const editBtn = document.createElement("button");
  editBtn.className = "msg-action-btn msg-action-edit";
  setIconOnly(editBtn, "edit-2");
  editBtn.title = "编辑内容";
  editBtn.addEventListener("click", () => startInlineEdit(msgEl, contentEl, msg));
  actions.appendChild(editBtn);

  const delMsgBtn = document.createElement("button");
  delMsgBtn.className = "msg-action-btn msg-action-danger";
  delMsgBtn.appendChild(iconSvgEl("trash-2"));
  delMsgBtn.title = "删除此消息";
  delMsgBtn.addEventListener("click", async () => {
    if (!await dlgConfirm("删除这条消息？删除后不可恢复。", { danger: true, okText: "删除" })) return;
    try { await del(`/chat/messages/${msg.id}`); } catch (e) {}
    const next = state.messages.filter(m => m !== msg);
    setMessages(next);
    dlgToast("已删除消息");
  });
  actions.appendChild(delMsgBtn);
}

// 流式生成中消息先渲染后持久化：id 就绪后为对应 DOM 补建编辑/删除按钮
function syncMsgActionButtons() {
  state.messages.forEach((m, i) => {
    if (!m.id || m.role === "system") return;
    const el = chatScroll.querySelector(`.msg[data-index="${i}"]`);
    if (!el || el.querySelector(".msg-action-edit")) return;
    const actions = el.querySelector(".msg-actions");
    const contentEl = el.querySelector(".msg-content");
    if (actions && contentEl) createEditDeleteActions(actions, m, el, contentEl);
  });
}

function renderAllMessages() {
  chatScroll.innerHTML = "";
  // 无可见消息时展示欢迎页（替代 :empty 占位提示）
  const hasVisible = state.messages.some(m => !isHiddenContextMessage(m));

  if (!hasVisible) {
    chatScroll.appendChild(buildWelcomeEl());
    requestAnimationFrame(() => cxEmptyIn());
    return;
  }
  if (convProjectEl) {
    chatScroll.appendChild(convProjectEl);
    updateConvProjectBadge();
  }
  state.messages.forEach((msg, i) => {
    if (isHiddenContextMessage(msg)) return;
    chatScroll.appendChild(renderMessage(msg, i));
  });
  stickToBottom = true;
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ── 流式光标 ────────────────────────────────

function addStreamingCursor(msgEl) {
  const cursor = document.createElement("span");
  cursor.className = "streaming-cursor thinking-indicator";
  fillThinkingCursor(cursor);
  msgEl.querySelector(".msg-content")?.appendChild(cursor);
  return cursor;
}

function fillThinkingCursor(cursor) {
  cursor.textContent = "";
  cursor.setAttribute("aria-label", t("研墨中"));
  const text = document.createElement("span");
  text.className = "thinking-text";
  text.textContent = t("研墨中");
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  cursor.append(text, dots);
}

function removeStreamingCursor(cursor) {
  cursor?.parentNode?.removeChild(cursor);
}

function updateStreamingCursor(cursor, content) {
  if (!cursor) return;
  const hasContent = String(content || "").trim().length > 0;
  cursor.classList.toggle("thinking-indicator", !hasContent);
  if (hasContent) {
    cursor.removeAttribute("aria-label");
    cursor.textContent = "";
  } else if (!cursor.querySelector(".thinking-text")) {
    fillThinkingCursor(cursor);
  }
}

// 为代码块右上角添加一键复制按钮（每次渲染重建，无需去重）
function attachCodeCopyButtons(container) {
  container?.querySelectorAll("pre").forEach(pre => {
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "复制";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
        setIconText(btn, "check", t("已复制"));
      } catch (e) {
        btn.textContent = "复制失败";
      }
      setTimeout(() => { btn.textContent = "复制"; }, 1500);
    });
    pre.appendChild(btn);
  });
}

function renderAssistantContent(contentEl, content, cursor = null) {
  if (!contentEl) return;
  updateStreamingCursor(cursor, content);
  const cleanContent = stripReasoningFromContent(content);
  const displayContent = hasToolMarkup(cleanContent) ? stripToolCalls(cleanContent) : cleanContent;
  contentEl.innerHTML = renderMarkdown(displayContent);
  if (cursor) contentEl.appendChild(cursor);
  contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
  attachCodeCopyButtons(contentEl);
}

const REASONING_MARKER_RE = /\x00?\x01R\x01\x00?/g;

function stripReasoningControlMarks(text) {
  return String(text || "").replace(REASONING_MARKER_RE, "");
}

function stripReasoningFromContent(text) {
  const s = String(text || "");
  REASONING_MARKER_RE.lastIndex = 0;
  const match = REASONING_MARKER_RE.exec(s);
  if (!match) return s;
  return s.slice(0, match.index);
}

function splitReasoningStreamChunk(chunk) {
  const text = String(chunk || "");
  if (!text) return [];
  if (text.startsWith(REASONING_PREFIX)) {
    return [{ type: "reasoning", text: stripReasoningControlMarks(text.slice(REASONING_PREFIX.length)) }];
  }
  if (text.startsWith(REASONING_INLINE_PREFIX)) {
    return [{ type: "reasoning", text: stripReasoningControlMarks(text.slice(REASONING_INLINE_PREFIX.length)) }];
  }
  const parts = [];
  let lastIndex = 0;
  let match;
  let mode = "content";
  REASONING_MARKER_RE.lastIndex = 0;
  while ((match = REASONING_MARKER_RE.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: mode, text: stripReasoningControlMarks(text.slice(lastIndex, match.index)) });
    }
    mode = "reasoning";
    lastIndex = REASONING_MARKER_RE.lastIndex;
  }
  if (!parts.length) return [{ type: "content", text }];
  if (lastIndex < text.length) {
    parts.push({ type: mode, text: stripReasoningControlMarks(text.slice(lastIndex)) });
  }
  return parts.filter(part => part.text);
}

function appendStreamChunk(chunk, handlers) {
  for (const part of splitReasoningStreamChunk(chunk)) {
    if (part.type === "reasoning") handlers.reasoning?.(part.text);
    else handlers.content?.(stripReasoningControlMarks(part.text));
  }
}

// ── 思考过程面板 ─────────────────────────────────

/** 创建思考面板（插入到 msg-content 之前） */
function createThinkingPanel(msgEl) {
  const panel = document.createElement("div");
  panel.className = "thinking-panel";
  panel.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-icon">${iconSvg("message-circle")}</span>
      <span class="thinking-label">${t("思考过程")}</span>
      <span class="thinking-toggle">▾</span>
    </div>
    <div class="thinking-body"></div>
  `;
  // 点击头部切换折叠/展开
  panel.querySelector(".thinking-header").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    const toggle = panel.querySelector(".thinking-toggle");
    toggle.textContent = panel.classList.contains("collapsed") ? "" : "▾";
  });
  // 插入到 msg-content 之前
  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) {
    msgEl.insertBefore(panel, contentEl);
  } else {
    msgEl.appendChild(panel);
  }
  return panel;
}

/** 更新思考面板内容 */
function updateThinkingPanel(panel, reasoningText) {
  if (!panel) return;
  const body = panel.querySelector(".thinking-body");
  if (body) {
    body.textContent = reasoningText;
    // 思考内容在面板内部滚动时跟随到底部
    body.scrollTop = body.scrollHeight;
  }
  // 有内容时自动展开
  if (reasoningText && panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    const toggle = panel.querySelector(".thinking-toggle");
    if (toggle) toggle.textContent = "▾";
  }
}

/** 流式结束后自动折叠思考面板 */
function collapseThinkingPanel(panel) {
  if (!panel) return;
  panel.classList.add("collapsed");
  const toggle = panel.querySelector(".thinking-toggle");
  if (toggle) toggle.textContent = "▸";
}

// ── SubAgent 并行执行面板 ───────────────────────

let subAgentPanel = null;
let subAgentEndedCount = 0;
let subAgentTotalCount = 0;

const SUBAGENT_STATUS_KEYS = { done: "已完成", failed: "执行失败", stopped: "已停止", max_rounds: "轮次用尽" };

function createSubAgentPanel(specs) {
  const panel = document.createElement("section");
  panel.className = "subagent-panel";

  const header = document.createElement("div");
  header.className = "subagent-panel-header";
  const icon = document.createElement("span");
  icon.className = "subagent-panel-icon";
  icon.innerHTML = iconSvg("shuffle");
  const title = document.createElement("span");
  title.textContent = `${t("子代理")} ×${specs.length}`;
  const count = document.createElement("span");
  count.className = "subagent-panel-count";
  count.textContent = t("并行执行中");
  header.append(icon, title, count);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "subagent-list";
  specs.forEach((spec, i) => {
    const item = document.createElement("div");
    item.className = "subagent-item";
    item.dataset.idx = String(i);

    const dot = document.createElement("span");
    dot.className = "subagent-dot running";

    const name = document.createElement("span");
    name.className = "subagent-name";
    name.textContent = spec.name;

    const task = document.createElement("span");
    task.className = "subagent-task";
    task.textContent = spec.task;
    task.title = spec.task;

    const round = document.createElement("span");
    round.className = "subagent-round";
    round.textContent = t("运行中");

    const body = document.createElement("div");
    body.className = "subagent-item-body";

    item.append(dot, name, task, round, body);
    item.addEventListener("click", () => item.classList.toggle("expanded"));
    list.appendChild(item);
  });
  panel.appendChild(list);
  return panel;
}

function subAgentRow(idx) {
  return subAgentPanel?.querySelector(`.subagent-item[data-idx="${idx}"]`) || null;
}

subagentEvents.on((event) => {
  if (event.type === "start") {
    subAgentPanel = createSubAgentPanel(event.specs);
    subAgentEndedCount = 0;
    subAgentTotalCount = event.specs.length;
    // 直接追加到聊天滚动区域末尾，不依赖消息气泡结构
    if (chatScroll) {
      chatScroll.appendChild(subAgentPanel);
      autoScroll();
    }
    return;
  }
  if (!subAgentPanel?.isConnected) return;

  if (event.type === "text") {
    const body = subAgentRow(event.index)?.querySelector(".subagent-item-body");
    if (body) body.textContent = event.text;
    return;
  }
  if (event.type === "progress") {
    const round = subAgentRow(event.index)?.querySelector(".subagent-round");
    if (round) round.textContent = t("轮 {n}", { n: event.round });
    return;
  }
  if (event.type === "end") {
    const row = subAgentRow(event.index);
    if (row) {
      const dot = row.querySelector(".subagent-dot");
      const round = row.querySelector(".subagent-round");
      if (dot) dot.className = `subagent-dot ${event.status}`;
      if (round) round.textContent = t(SUBAGENT_STATUS_KEYS[event.status] || event.status);
      if (event.summary) {
        const body = row.querySelector(".subagent-item-body");
        if (body && !body.textContent) body.textContent = event.summary;
      }
    }
    subAgentEndedCount++;
    const count = subAgentPanel.querySelector(".subagent-panel-count");
    if (count) count.textContent = `${subAgentEndedCount}/${subAgentTotalCount}`;
    if (subAgentEndedCount >= subAgentTotalCount) autoScroll();
  }
});

function summarizeParams(params) {
  const summary = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (typeof value === "string") {
      summary[key] = value.length > 120 ? `${value.slice(0, 120)}...` : value;
    } else if (Array.isArray(value)) {
      summary[key] = `Array(${value.length})`;
    } else if (value && typeof value === "object") {
      summary[key] = "Object";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function shouldHideToolOutput(call) {
  return ["skill_run", "project_files", "project_read_file", "project_find_file", "board_read", "chat_context", "knowledge_search"].includes(call?.name);
}

function looksLikeInspectionStall(content) {
  if (!content || hasToolMarkup(content)) return false;
  const text = content.replace(/```[\s\S]*?```/g, " ");
  const offerOrQuestion = /(需要我|要我|是否需要|要不要|你需要|如果你需要|我可以(?:直接)?(?:动手|继续|帮你|给出)|是否要|吗[？?]?|呢[？?]?)/;
  if (offerOrQuestion.test(text)) return false;
  const intent = /(?:先|再|来|会|需要|可以)?(?:查看|看看|看一下|看一眼|浏览|读取|检查|了解|确认|分析|搜索|查找|定位|找到)|让我(?:查看|看看|看一下|浏览|读取|检查|了解|搜索|查找|定位)|需要(?:查看|看看|看一下|浏览|读取|检查|了解|确认|搜索|查找|定位)|(?:先(?:查看|看看|看一下|浏览|读取|检查|了解|搜索|查找|定位)|I'll\s+(?:check|inspect|look|read|search|find|locate)|I\s+need\s+to\s+(?:check|inspect|look|read|search|find|locate))/i;
  const target = /(项目|文件|目录|代码|路径|仓库|工程|结构|数据模型|管理器|核心|黑板|技能|上下文|\.css|\.js|\.py|\.md|\.json|\.html|\.txt|project|file|directory|repo|code|path|folder|context|model|manager|schema)/i;
  const waiting = /(稍等|等一下|接下来|下一步|然后|之后|before|first|next)/i;
  return intent.test(text) && (target.test(text) || waiting.test(text));
}

function extractInspectionPath(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  const quoted = text.match(/["']([^"']+\.[A-Za-z0-9]{1,12})["']/);
  const pathLike = quoted?.[1] || text.match(/([A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@ -]+)*\.[A-Za-z0-9]{1,12})/)?.[1];
  if (!pathLike) return null;
  return pathLike.replace(/\\/g, "/").replace(/[，。；：.!?;:]+$/g, "");
}

function looksLikeFileOutputStall(content) {
  if (!content || hasToolMarkup(content)) return false;
  const text = String(content || "");
  const noCode = text.replace(/```[\s\S]*?```/g, " ");
  const offerOrQuestion = /(需要我|要我|是否需要|要不要|你需要|如果你需要|我可以(?:直接)?(?:动手|继续|帮你|给出)|是否要|吗[？?]?|呢[？?]?)/;
  if (offerOrQuestion.test(noCode)) return false;
  const intent = /(生成|创建|输出|保存|写入).{0,24}(文件|文档|代码|\.md|\.txt|\.json|\.py|\.js|\.html)|(?:文件|文档|代码).{0,24}(生成|创建|输出|保存|写入)/i;
  const hasUsableContent = /```[\s\S]{80,}?```/.test(text) || (text.length > 500 && /(^|\n)#{1,3}\s|\n[-*]\s|\n\d+\.\s/.test(text));
  return intent.test(noCode) && hasUsableContent;
}

function extractFileCreateCandidate(content) {
  const text = String(content || "");
  if (!looksLikeFileOutputStall(text)) return null;
  const fenced = text.match(/```[A-Za-z0-9_-]*\r?\n([\s\S]*?)```/);
  const rawContent = (fenced?.[1] || text).trim();
  if (rawContent.length < 80) return null;
  let filePath = extractInspectionPath(text) || "outputs/slate-output.md";
  filePath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!filePath.includes("/")) filePath = `outputs/${filePath}`;
  if (/^[A-Za-z]:\//.test(filePath) || filePath.split("/").includes("..")) {
    filePath = `outputs/${filePath.split("/").pop() || "slate-output.md"}`;
  }
  return { file_path: filePath, content: rawContent };
}

function isContinuationRequest(content) {
  const text = stripCodeForStallCheck(content).trim();
  return /^(继续|继续吧|接着|接着来|下一步|go on|continue|next)$/i.test(text);
}

function getPreviousVisibleUserContent() {
  let seenLast = false;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg?.role !== "user" || isHiddenContextMessage(msg)) continue;
    if (!seenLast) {
      seenLast = true;
      continue;
    }
    return msg.content || "";
  }
  return "";
}

function stripCodeForStallCheck(content) {
  return String(content || "").replace(/```[\s\S]*?```/g, " ");
}

function asksUserToDecide(content) {
  const text = stripCodeForStallCheck(content);
  return /(需要我|要我|是否需要|要不要|你需要|如果你需要|我可以(?:直接)?(?:动手|继续|帮你|给出)|是否要|吗[？?]?|呢[？?]?)/.test(text);
}

function userWantsEnvironmentAction(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  if (!text.trim()) return false;
  if (isContinuationRequest(text)) {
    const previousUser = getPreviousVisibleUserContent();
    if (previousUser && userWantsEnvironmentAction(previousUser)) return true;
    const previousAssistant = [...state.messages].reverse().find(m => m?.role === "assistant" && !isHiddenContextMessage(m));
    if (previousAssistant && !looksLikeCompletedReply(previousAssistant.content || "")) return true;
  }
  const action = /(查看|看看|看一下|浏览|读取|检查|扫描|排查|修复|修改|编辑|创建|生成|保存|写入|执行|运行|测试|构建|打包|打开项目|了解项目|commit|提交|搜索|联网|截图|点击|遥控|鉴权|工具|文件|目录|代码|项目|仓库|终端|命令|build|test|run|scan|fix|edit|create|write|read|inspect|check|search|commit|terminal|file|repo|project)/i;
  const object = /(项目|文件|目录|代码|仓库|终端|命令|页面|设置|工具|模型|接口|路由|数据库|脚本|配置|README|RULES|\.js|\.py|\.md|\.json|\.html|\.css|project|file|repo|code|terminal|command|script|config|route|api|database)/i;
  return action.test(text) && object.test(text);
}

// 收尾措辞里的"前瞻计划"。Autopilot 提前中断的头号原因就在这条：模型说
// "已完成前两步，接下来我要改 X"，老规则只看"已完成"三个字就判收工，
// 用户只能反复发"继续"。凡是带着下一步打算的回复，一律不算收工。
// 刻意收窄匹配面：宁可多花一轮自证，也不要把干到一半当干完。
const FORWARD_PLAN_RE = /(接下来|下一步|随后|继而|然后我|下面我|还需|尚需|尚未|还未|有待|待(?:验证|确认|补充|继续|办|测)|还有.{0,12}(?:未|待|没|需)|剩余.{0,8}(?:待|未|没)|先停|暂时停|I'?ll|I will|next (?:step|I)|then I|still need|remaining (?:work|items|to)|to be (?:done|verified|checked)|not yet)/i;

function looksLikeCompletedReply(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  if (FORWARD_PLAN_RE.test(text)) return false;
  // 【任务完成】是收尾校验显式教给模型的标记，比散文措辞可靠
  return /(【任务完成】|已完成|修好了|已经修复|验证通过|检查通过|测试通过|已提交|commit\s+[0-9a-f]{6,}|工作区.*干净|无需进一步|不需要再|完成了|done|fixed|passed|committed)/i.test(text);
}

// 显式收口：模型按 Autopilot 协议写了【任务完成】。带这个标记的收尾不再要证据，
// 因为协议要求它同时逐项写明验证方式——追问一个已经守约的模型只是白烧一轮。
function hasExplicitSettle(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  return !FORWARD_PLAN_RE.test(text) && /【任务完成】/.test(text);
}

function settleAutopilotTodosOnCompletion() {
  const convId = state.currentConversationId;
  const todos = getConversationTodos(convId);
  const pending = todos.filter(item => item.status !== "done" && item.status !== "blocked");
  if (!pending.length) return 0;
  setConversationTodos(convId, todos.map(item => (
    item.status === "done" || item.status === "blocked" ? item : { ...item, status: "done" }
  )));
  return pending.length;
}

function getTodoLoopState() {
  const todos = getConversationTodos(state.currentConversationId);
  const pending = todos.filter(item => item.status !== "done" && item.status !== "blocked");
  return {
    todos,
    pending,
    closed: todos.length > 0 && pending.length === 0,
  };
}

function clearAutoAdvanceHints(msg) {
  if (!msg) return;
  delete msg.autoAdvanceNudge;
  delete msg.autoAdvanceSuggestedCalls;
  delete msg.autoAdvanced;
  delete msg.autoReviewed;
}

function looksLikeActionStall(content) {
  if (!content || hasToolMarkup(content)) return false;
  if (looksLikeCompletedReply(content) || asksUserToDecide(content)) return false;
  if (!userWantsEnvironmentAction(getLastVisibleUserContent())) return false;
  const text = stripCodeForStallCheck(content);
  const opener = /(接下来|下一步|然后|之后|现在|这次|立即|马上|立刻|赶紧|直接|改用|我(?:会|将|来|需要|准备|先)|让我|先|再|I'll|I\s+(?:need|am going)\s+to)/i;
  const action = /(查看|读取|检查|扫描|排查|分析|确认|修改|修复|编辑|创建|生成|保存|写入|执行|运行|测试|构建|打包|搜索|提交|commit|inspect|read|check|scan|analy[sz]e|fix|edit|create|write|run|test|build|search|commit)/i;
  const object = /(项目|文件|目录|代码|仓库|工具|接口|路由|脚本|配置|页面|模型|测试|构建|CI|README|RULES|\.js|\.py|\.md|\.json|\.html|\.css|project|file|repo|code|script|config|test|build|ci)/i;
  return opener.test(text) && action.test(text) && object.test(text);
}

function inferDeterministicStallCalls(content) {
  const calls = [];
  const text = stripCodeForStallCheck(content);
  const wantedPath = extractInspectionPath(text);
  if (wantedPath) {
    const hasDirectory = /[\\/]/.test(wantedPath);
    calls.push({
      name: hasDirectory ? "project_read_file" : "project_find_file",
      params: hasDirectory ? { path: wantedPath } : { query: wantedPath },
    });
    return calls;
  }

  const queries = getInspectionQueries(text);
  if (/(扫描|排查|审查|安全|漏洞|bug|错误|问题|scan|audit|bug|issue|error)/i.test(text)) {
    calls.push({ name: "skill_run", params: { skill: "code_scan", params: { severity: "medium" } } });
  }
  if (queries.length) {
    calls.push(...queries.map(query => ({ name: "project_find_file", params: { query } })));
  }
  if (calls.length === 0 || /(项目|目录|结构|仓库|project|repo|directory|structure)/i.test(text)) {
    calls.unshift({ name: "project_files", params: { path: "" } });
  }

  const seen = new Set();
  return calls.filter(call => {
    const sig = `${call.name}:${JSON.stringify(call.params)}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, 4);
}

function getInspectionQueries(content) {
  const text = String(content || "").toLowerCase();
  const queries = [];
  if (/数据模型|模型|schema|model/.test(text)) queries.push("model");
  if (/核心管理器|管理器|manager/.test(text)) queries.push("manager");
  if (/路由|接口|router|api/.test(text)) queries.push("router");
  if (/配置|config/.test(text)) queries.push("config");
  if (/服务|service/.test(text)) queries.push("service");
  return [...new Set(queries)].slice(0, 3);
}

function classifyAgentTask(content) {
  const text = stripCodeForStallCheck(content);
  const wantsEnv = userWantsEnvironmentAction(text);
  const modifies = /(修复|修改|编辑|创建|生成|保存|写入|优化|重构|实现|删除|commit|提交|fix|edit|create|write|optimi[sz]e|refactor|implement|delete|commit)/i.test(text);
  const verifies = /(测试|验证|构建|运行|CI|报错|失败|bug|检查|排查|test|verify|build|run|ci|error|fail|bug|scan)/i.test(text);
  const broad = /(全面|所有|整个|尽可能|排查|扫描|项目|仓库|多文件|全局|complete|all|entire|project|repo|multi)/i.test(text);
  const needsPlan = wantsEnv && (broad || (modifies && verifies) || text.length > 80);
  return { wantsEnv, modifies, verifies, broad, needsPlan };
}

function buildAgentRuntimeContext(content, harnessOn) {
  const cls = classifyAgentTask(content);
  if (!cls.wantsEnv) return "";
  const lines = [
    "",
    "[Agent Runtime · Autopilot]",
    "本条消息被识别为需要环境操作的任务。请像现代 Coding Agent 一样自主执行到完成：",
    "- 不要让用户反复说“继续”；除非缺少关键权限/选择或高风险操作需要确认，否则自行做保守合理决策并推进。",
    "- 下一步若需要项目事实，直接调用工具；不要只说计划或等待。",
    "- 先观察再修改：读取相关目录/文件/配置，确认现状后再写入。",
    "- 修改或生成后必须验证：重新读取、运行检查/测试/构建，或解释无法验证的具体原因。",
    "- 工具失败时换参数或换工具，不重复完全相同的调用。",
    "- 只有任务完成、验证完成或明确受阻时才给最终汇报。",
    "- 收口协议：全部交付且已验证时，先调用 exit_autopilot（summary 写清交付了什么、怎么验证、结果如何），再在回复首行写【任务完成】并逐项附验证方式与结果；既不调工具也不写这个标记，会被当作仍在推进并自动续跑，所以别用它汇报半成品。",
    "- 干完了就停：验证通过就收口，不要为\"再确认一遍\"继续读文件、继续改；没做完则继续发起下一批工具调用。",
    "- 如果一轮回复结束时还没完成，请继续发起下一批工具调用；系统会自动把工具结果喂回给你。",
  ];
  if (cls.needsPlan && !harnessOn) {
    lines.push("- 这是复杂任务；如果需要多步推进，先用 todo_manage(action=init) 建立短清单。");
  }
  if (cls.broad) {
    lines.push("- 任务范围较大；优先扫描入口文件、配置、最近相关模块，再分批推进。");
  }
  if (cls.modifies) {
    lines.push("- 文件修改优先使用 file_edit；新文件才用 file_create。");
  }
  return "\n" + lines.join("\n");
}

function getAllModels() {
  const allModels = [];
  for (const models of Object.values(state.modelRegistry || {})) {
    allModels.push(...models);
  }
  allModels.push(...(state.customModels || []));
  return allModels;
}

function findModelById(modelId) {
  return getAllModels().find(m => m.id === modelId) || null;
}

function isAbortError(err) {
  return err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
}

function updateSendState() {
  if (!btnSend) return;
  btnSend.disabled = false;
  btnSend.textContent = isGenerating ? "停止" : (inputQueue.length ? t("发言{n})", { n: inputQueue.length }) : "发言");
  btnSend.classList.toggle("is-stopping", isGenerating);
  if (queueStatus) {
    queueStatus.classList.toggle("hidden", !isGenerating && inputQueue.length === 0);
    const statusText = queueStatus.querySelector(".queue-status-text");
    if (statusText) {
      statusText.textContent = t(isGenerating ? "正在生成" : "待发送") + (inputQueue.length ? t(" · 队列 {n}", { n: inputQueue.length }) : "");
    }
  }
  if (chatInput) {
    const queueHint = inputQueue.length ? t(" · 队列 {n}", { n: inputQueue.length }) : "";
    const grindOn = grindSession && ["grinding", "collecting"].includes(grindSession.state);
    const grindDone = grindSession?.state === "done";
    const grindRound = grindOn && grindSession.round
      ? t(" · 第 {x}/{n} 轮", { x: Math.min(grindSession.round, grindSvc.MAX_ROUNDS), n: grindSvc.MAX_ROUNDS })
      : "";
    chatInput.placeholder = isGenerating
      ? t("继续输入可加入队列，点击停止中断输出") + queueHint
      : (grindOn
        ? t("磨墨中") + grindRound + t(" · 直接回复问题即可（输「收墨」立即出墨稿）")
        : (grindDone
          ? t("墨稿已成 · 可在下方选择「送入目标模式 / 投到白板 / 存为模板」，或继续对话")
          : (brainstormMode
            ? t("灵感发散模式：输入想法、问题、素材或方向…")
            : t("输入想法、问题、素材或方向（Enter 发言，Shift+Enter 换行）"))));
  }
}

function captureCurrentInputForQueue() {
  const text = chatInput?.value.trim() || "";
  if (!text && pendingFiles.length === 0) return false;
  inputQueue.push({ text, files: [...pendingFiles] });
  chatInput.value = "";
  chatInput.style.height = "auto";
  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
  pendingFiles = [];
  renderFilePreview();
  updateSendState();
  return true;
}

function stopGeneration() {
  if (!isGenerating) return;
  activeGenerationController?.abort();
  updateSendState();
  // 停止仅中断本次生成：目标开关保持不动，只有手动添加才退出
  showHarnessIdle("本次执行已停止· 目标模式保持开启，下一条消息继续自主执行");

}

function clearInputQueue() {
  if (inputQueue.length === 0) return;
  inputQueue = [];
  updateSendState();
}

async function refreshKnowledgeContext(query) {
  if (state.knowledgeSettings?.enabled === false) {
    setKnowledgeContext([]);
    return [];
  }
  const text = String(query || "").trim();
  if (!text) {
    setKnowledgeContext([]);
    return [];
  }
  try {
    const limit = Math.max(1, Math.min(12, parseInt(state.knowledgeSettings?.topK) || 5));
    const res = await post("/knowledge/search", { query: text.slice(-4000), limit });
    const items = res.code === 0 ? (res.data || []) : [];
    setKnowledgeContext(items);
    return items;
  } catch (e) {
    console.warn("知识库检索失败", e);
    setKnowledgeContext([]);
    return [];
  }
}

function isShortReviewCandidate(content) {
  const cfg = state.autoReview || {};
  if (cfg.enabled === false) return false;
  if (!content || hasToolMarkup(content)) return false;
  if (/^◈/.test(String(content).trim())) return false;
  if (looksLikeCompletedReply(content)) return false;
  if (!userWantsEnvironmentAction(getLastVisibleUserContent())) return false;
  const clean = stripToolCalls(content).replace(/```[\s\S]*?```/g, " ").trim();
  const minChars = Math.max(20, Math.min(800, parseInt(cfg.minChars) || 120));
  return clean.length > 0 && clean.length <= minChars;
}

// 长回复停顿：回复不短，但通篇在描述“接下来要做什么”却没有实际调用工具
function looksLikeLongStall(content) {
  const cfg = state.autoReview || {};
  if (cfg.enabled === false) return false;
  if (!content || hasToolMarkup(content)) return false;
  if (/^◈/.test(String(content).trim())) return false;
  if (looksLikeCompletedReply(content)) return false;
  if (!userWantsEnvironmentAction(getLastVisibleUserContent())) return false;
  const text = String(content).replace(/```[\s\S]*?```/g, " ");
  const minChars = Math.max(20, Math.min(800, parseInt(cfg.minChars) || 120));
  if (text.trim().length <= minChars) return false; // 短回复走原有短回复通道
  if (text.length > 4000) return false; // 超长回复通常是完整答复，不审查以控制成本
  if (asksUserToDecide(text)) return false;
  if (/(全部完成|全部搞定|已完成所有|都已处理)/.test(text)) return false;
  const intent = /(?:先|再|来|会|开始|继续|现在)?\s?(?:去|动手)?\s?(?:查看|看看|看一下|浏览|读取|检查|了解|确认|分析|修改|创建|写入|生成|执行|整理|继续|开启|下一步|下面我将|接下来我|现在我将|我将(?:先|会|直接)?|让我|I'll(?:\s+(?:check|inspect|look|read|modify|create|start|continue))?|I\s+(?:need|am going)\s+to)/i;
  const highConfidence = looksLikeActionStall(content);
  return (cfg.reviewLongStall === true || highConfidence) && intent.test(text);
}

// 自动推进审查候选：短回复（原有）或长回复停顿（新增）
function isReviewCandidate(content) {
  return isShortReviewCandidate(content) || looksLikeLongStall(content);
}

function looksLikeContinuationStall(content) {
  if (!isShortReviewCandidate(content)) return false;
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ").trim();
  if (/(需要我|要我|是否需要|要不要|你需要|如果你需要|吗[？?]?|呢[？?]?)/.test(text)) return false;
  return /(?:来|会|先|(?:整理|分析|构思|展开|推演|发散|梳理|想想)|接下来|下面|继续|开启)/.test(text);
}

function getLastVisibleUserContent() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg?.role === "user" && !isHiddenContextMessage(msg)) return msg.content || "";
  }
  return "";
}

function buildAutoReviewMessages(lastContent, mainModelId) {
  const recentHistory = state.messages
    .slice(0, -1)
    .slice(-10)
    .map(m => ({ role: m.role, content: String(m.content || "").slice(-3000) }));
  const constitution = state.constitution?.rules?.length
    ? `\n[项目宪法]\n${state.constitution.rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}\n`
    : "";
  const projectContext = state.project
    ? `\n[当前项目] ${state.project.name || ""} (${state.project.path || ""})\n`
    : "";
  const system = `[自动推进审查模式]
你现在不是主回复模型，而是 SLATE 的审查模型。你可以看到最近对话、项目上下文和工具说明。
你的唯一任务：审查主模型刚才的回复是否“停顿”了——即想查询、读取、检查、了解、修改、生成文件或调用技能，但没有实际调用工具。回复可能很短（只表态不行动），也可能很长（铺陈了一大段分析和计划却迟迟不动手）。
输出规则：
- 如果回复是正常确认、向用户提问、等待用户选择、说明已完成、闲聊回应，或没有必要读取/操作环境，输出空字符串。
- 如果需要推进，只输出一个或多个工具调用块，不要解释，不要寒暄，不要输出 Markdown。
- 优先选择最小必要动作：知道路径就读文件，只知道名称就找文件，不知道目标就浏览项目根目录；需要内置技能时使用 skill_run。
- 不要替主模型回答用户，不要总结工具结果，只负责补出应该执行的工具或技能调用。
${constitution}${projectContext}
${getToolsSystemPrompt({ minimal: true })}`;
  const messages = [{ role: "system", content: system }, ...recentHistory];
  messages.push({ role: "assistant", content: lastContent });
  messages.push({
    role: "user",
    content: "请审查上一条主模型回复是否需要自动补工具/技能调用。只输出工具调用块或空字符串。"
  });
  return messages;
}

async function reviewStalledReplyForToolCalls(lastContent, modelId, apiKey, baseUrl, signal = null) {
  if (!isReviewCandidate(lastContent)) return [];
  if (signal?.aborted) return [];
  const reviewerId = state.autoReview?.modelId || modelId;
  const reviewerModel = findModelById(reviewerId) || state.currentModel || { id: modelId, base_url: baseUrl };
  const reviewerKey = getModelKey(reviewerModel.id) || (reviewerModel.id === modelId ? apiKey : "");
  if (!reviewerKey && reviewerModel.id !== "local") return [];

  let reviewText = "";
  try {
    for await (const chunk of streamChat({
      model: reviewerModel.id,
      provider: reviewerModel.provider,
      messages: buildAutoReviewMessages(lastContent, modelId),
      api_key: reviewerKey,
      base_url: reviewerModel.base_url || baseUrl,
      temperature: 0.1,
      max_tokens: 650,
      stream: true,
      signal,
    })) {
      reviewText += chunk;
      markActivity();
    }
  } catch (e) {
    if (isAbortError(e)) return [];
    console.warn("自动审阅失败:", e);
    return [];
  }
  return detectToolCalls(reviewText).slice(0, 4);
}

function formatSuggestedCalls(calls) {
  return calls.map(call => `- ${call.name}: ${JSON.stringify(call.params || {})}`).join("\n");
}

function scheduleAutoAdvanceNudge(msgEl, calls, reason = "stalled") {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return false;
  const suggested = Array.isArray(calls) && calls.length ? `\n\n系统建议的最小动作（仅供参考，最终由你决定是否调用）：\n${formatSuggestedCalls(calls)}` : "";
  lastMsg.autoAdvanceNudge = `[系统自动推进提醒]
你上一条回复看起来可能停在“准备行动/继续推进”阶段，但没有由你自己发出工具调用。
不要解释这条系统提醒；请基于当前任务自行判断下一步：
- 如果确实需要读取、扫描、修改、执行或生成文件，请在下一条 assistant 回复中由你自己输出正确的工具调用块。
- 如果任务已经完成或不该使用工具，请直接给出简短结论，不要调用工具。
- 不要重复已经完成的工具调用。${suggested}

触发原因: ${reason}`;
  lastMsg.autoAdvanceSuggestedCalls = calls || [];
  return true;
}

async function autoAdvanceIfStalled(msgEl, modelId, apiKey, baseUrl, params) {
  if (state.chatMode === "chat") return msgEl; // 对话模式不合成工具调用
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
  if (state.harness?.enabled === true && getTodoLoopState().closed) return msgEl;
  if (lastMsg.autoAdvanced) return msgEl;
  if (looksLikeCompletedReply(lastMsg.content)) return msgEl;
  if (!userWantsEnvironmentAction(getLastVisibleUserContent())) return msgEl;

  const fileCandidate = extractFileCreateCandidate(lastMsg.content);
  if (fileCandidate) {
    lastMsg.autoAdvanced = true;
    scheduleAutoAdvanceNudge(msgEl, [{ name: "file_create", params: fileCandidate }], "file_output_stall");
    return msgEl;
  }

  if (looksLikeActionStall(lastMsg.content)) {
    const calls = inferDeterministicStallCalls(lastMsg.content);
    if (calls.length > 0) {
      lastMsg.autoAdvanced = true;
      scheduleAutoAdvanceNudge(msgEl, calls, "action_stall");
    }
    return msgEl;
  }

  if (!looksLikeInspectionStall(lastMsg.content)) return msgEl;

  lastMsg.autoAdvanced = true;
  scheduleAutoAdvanceNudge(msgEl, inferDeterministicStallCalls(lastMsg.content), "inspection_stall");
  return msgEl;
}

async function autoReviewIfStalled(msgEl, modelId, apiKey, baseUrl, signal = null) {
  if (state.chatMode === "chat") return msgEl; // 对话模式不做停顿审查
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
  if (signal?.aborted) return msgEl;
  if (state.harness?.enabled === true && getTodoLoopState().closed) return msgEl;
  if (lastMsg.autoReviewed) return msgEl;
  if (!isReviewCandidate(lastMsg.content)) return msgEl;

  lastMsg.autoReviewed = true;
  const calls = await reviewStalledReplyForToolCalls(lastMsg.content, modelId, apiKey, baseUrl, signal);
  if (calls.length > 0) {
    scheduleAutoAdvanceNudge(msgEl, calls, "reviewer_stall");
  }
  return msgEl;
}

// ── 工具调用渲染 ─────────────────────────────

// 工具卡片的图标（SVG）；标签已并入 services/tool_meta.js，与白板步骤卡同源
const TOOL_ICONS = {
  file_create: "file",
  file_edit: "edit-2",
  file_append: "arrow-down",
  file_tree: "folder",
  file_peek: "file-text",
  terminal: "monitor",
  skill_run: "zap",
  project_info: "info",
  project_files: "folder",
  project_read_file: "file-text",
  project_find_file: "search",
  code_search: "search",
  web_search: "globe",
  web_fetch: "link",
  image_gen: "sparkles",
  video_gen: "skip-forward",
  chart_create: "bar-chart",
  qrcode_create: "target",
  html_render: "eye",
  css_color: "pen-tool",
  doc_write: "edit-3",
  ppt_create: "monitor",
  word_create: "file-text",
  text_summarize: "book-open",
  json_tool: "tag",
  regex_test: "crosshair",
  repo_stats: "bar-chart",
  todo_scan: "check",
  todo_manage: "check",
  git_tool: "clock",
  code_scan: "shield",
  doc_scan: "alert-triangle",
  excel_tool: "clipboard",
  pdf_tool: "book",
  browser_automation: "globe",
  computer_use: "mouse-pointer",
  mcp_factory: "factory",
  screenshot_to_code: "eye",
  user_ask: "message-circle",
  skill_search: "compass",
  subagent_run: "bot",
  system_info: "info",
  board_add: "clipboard",
  board_read: "clipboard",
  board_update: "clipboard",
  board_batch: "clipboard",
  board_clear: "clipboard",
  knowledge_search: "book",
  knowledge_add: "book",
  prompt_gen: "lightbulb",
  chat_context: "message-circle",
};

function getToolCallLabel(call) {
  const name = call?.name;
  const label = toolLabel(name, call?.params);
  if (label && label !== name) return label;
  if (name?.startsWith?.("mcp__")) {
    const short = String(name).split("__").pop();
    return t("工具 · {name}", { name: short || name });
  }
  return t("工具 · {name}", { name: name || "unknown" });
}

function getToolCallIcon(call) {
  const name = call?.name;
  if (name === "skill_run") return TOOL_ICONS[call.params?.skill] || "zap";
  return TOOL_ICONS[name] || "tool";
}

/** 砚流·落笔即所见：为正在生成的气泡挂上参数成形预览（只读预览，不参与执行判定） */
const _inkstreams = new WeakMap();

function attachInkstream(hostEl) {
  if (!hostEl) return null;
  const alive = _inkstreams.get(hostEl);
  if (alive && !alive.destroyed) return alive;
  const ink = createInkstream({
    host: hostEl,
    labelFor: (name) => getToolCallLabel({ name }),
    iconFor: (name) => getToolCallIcon({ name }),
  });
  _inkstreams.set(hostEl, ink);
  const destroy = ink.destroy.bind(ink);
  ink.destroy = () => {
    if (_inkstreams.get(hostEl) === ink) _inkstreams.delete(hostEl);
    destroy();
  };
  return ink;
}

/** 气泡节点被整表重渲染替换：砚流条改挂到新节点，已落成的行状态不重建 */
function rehostInkstream(staleEl, liveEl) {
  const ink = _inkstreams.get(staleEl);
  if (!ink || ink.destroyed) return;
  _inkstreams.delete(staleEl);
  _inkstreams.set(liveEl, ink);
  ink.rehost(liveEl);
}

function getToolCallStatus(result) {
  if (result?.historical) return "未执行";
  if (result?.success === false) return "失败";
  const s = result?._structured;
  if (s?._type === "file_edit") return s.applied === "auto" ? "已应用" : "diff 预览";
  if (s?._type === "file_create") return s.applied === "auto" ? "已创建" : "文件预览";
  if (s?._type === "file_append") return s.applied === "auto" ? "已追加" : "追加预览";
  return "已执行";
}

const TOOL_FILE_OPS = ["file_edit", "file_create", "file_append"];
const TOOL_READ_FILES = new Set(["file_peek", "project_read_file", "project_files"]);

function pathBase(p) {
  const s = String(p ?? "").trim();
  return s ? s.split(/[\\/]/).pop() : "";
}

function compactText(v, max = 48) {
  if (typeof v !== "string") return "";
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 工具调用一行摘要：文件读取→文件名；文件改动→文件名 +N -M；其余→简短的目标/内容
function getToolCallContent(call, result) {
  const params = call?.params || {};
  const skillRun = call?.name === "skill_run";
  const p = skillRun ? (params.params || {}) : params;
  const s = result?._structured;
  const rawPath = p.file_path || p.path || p.relative_path || params.file_path || params.path;

  // 结构化文件改动结果（编辑/新建/追加）→ “文件名  +N -M”
  if (s && TOOL_FILE_OPS.includes(s._type)) {
    const st = s.stats || {};
    const name = s.file_name || pathBase(s.file_path_rel || s.file || rawPath);
    const hasStats = Number.isFinite(st.lines_added) || Number.isFinite(st.lines_removed);
    if (hasStats) return `${name || "文件"}  +${st.lines_added ?? 0} -${st.lines_removed ?? 0}`;
    return name || "文件";
  }

  const skill = skillRun ? params.skill : call?.name;
  // 文件查看/编辑类：显示文件名
  if (TOOL_FILE_OPS.includes(skill) && !(p.action && ["view", "read"].includes(p.action))) {
    const name = pathBase(rawPath);
    if (name) return name;
  }
  if (TOOL_READ_FILES.has(skill) || (skill === "file_edit" && ["view", "read"].includes(p.action))) {
    return pathBase(rawPath) || "文件";
  }
  if (skill === "file_tree") return pathBase(p.path || p.directory || rawPath) || "";

  // 其余：按工具取简短目标说明
  if (skill === "terminal") return compactText(p.command || p.cmd) || (p.action ? String(p.action) : "");
  if (skill === "user_ask") return compactText(p.question || p.prompt) || "";
  if (skill === "board_batch") return Array.isArray(p.ops) ? `${p.ops.length} 项操作` : "";
  if (skill === "board_update") return p.id ? `卡片 ${String(p.id).slice(0, 24)}` : "";
  if (skill === "board_add") return compactText(p.title) || "";
  if (skill === "todo_manage") {
    if (p.action) return String(p.action);
    if (Array.isArray(p.ids)) return `${p.ids.length} 项`;
    return "";
  }
  if (skill === "subagent_run") {
    if (Array.isArray(p.tasks)) return `${p.tasks.length} 个并行任务`;
    return "";
  }

  const text = [p.prompt, p.question, p.topic, p.request, p.query, p.keyword, p.url, p.command, p.title, p.text, p.search]
    .map(compactText)
    .find(Boolean);
  if (text) return text;
  if (p.action) return String(p.action);
  if (p.id) return String(p.id).slice(0, 24);
  return "";
}

function setToolCallExpanded(el, header, body, expanded) {
  el.classList.toggle("is-open", expanded);
  body.hidden = !expanded;
  header.setAttribute("aria-expanded", String(expanded));
}

// 从工具输出中提取多模态预览信息（chart/qrcode 返回图片，video_gen 返回视频，apidoc 等返回文档）
const IMAGE_EXTS = [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const VIDEO_EXTS = [".mp4", ".webm"];
function extractToolImage(output) {
  if (typeof output !== "string" || !output.includes("preview_url")) return null;
  let url = "", filePath = "";
  try {
    const data = JSON.parse(output);
    url = data?.preview_url || "";
    filePath = data?.file_path || "";
  } catch (e) {
    const m = output.match(/"preview_url"\s*:\s*"([^"]+)"/);
    if (m) url = m[1];
  }
  if (!url) return null;
  const name = filePath ? filePath.split(/[\\/]/).pop() : url.split("name=").pop();
  const ext = ("." + name.split(".").pop()).toLowerCase();
  const kind = VIDEO_EXTS.includes(ext) ? "video" : (IMAGE_EXTS.includes(ext) ? "image" : "doc");
  return { url, name, kind };
}

function renderToolCallGroup(items) {
  const normalized = (items || []).map(item => ({ call: item.call || item, result: item.result || item }));
  if (normalized.length === 0) return document.createDocumentFragment();
  if (normalized.length === 1) return renderToolCallCard(normalized[0].call, normalized[0].result);

  const group = document.createElement("section");
  group.className = "tool-call-group";

  const summary = document.createElement("div");
  summary.className = "tool-call-group-summary";
  const labels = normalized.map(item => getToolCallLabel(item.call)).slice(0, 3).join(" / ");
  const title = document.createElement("span");
  title.textContent = t("调用 {n} 项", { n: normalized.length });
  const meta = document.createElement("span");
  meta.className = "tool-call-summary-meta";
  meta.textContent = `${labels}${normalized.length > 3 ? " / ..." : ""}`;
  summary.append(title, meta);
  group.appendChild(summary);

  const body = document.createElement("div");
  body.className = "tool-call-group-body";
  for (const item of normalized) {
    body.appendChild(renderToolCallCard(item.call, item.result));
  }
  group.appendChild(body);
  return group;
}

function renderToolCallCard(call, result) {
  const el = document.createElement("section");
  el.className = "tool-call-card";
  // 默认一行收起：仅失败自动展开（文件 diff/参数详情点击展开）
  const defaultOpen = result?.success === false;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "tool-call-header";
  header.setAttribute("aria-label", t("展开或收起工具调用详情"));
  const titleWrap = document.createElement("span");
  titleWrap.className = "tool-call-title";
  const label = document.createElement("span");
  label.className = "tool-call-name";
  setIconText(label, getToolCallIcon(call), getToolCallLabel(call));
  titleWrap.appendChild(label);
  const contentText = getToolCallContent(call, result);
  if (contentText) {
    const meta = document.createElement("span");
    meta.className = "tool-call-card-meta";
    meta.textContent = contentText;
    titleWrap.appendChild(meta);
  }
  const status = document.createElement("span");
  const applied = ["file_edit", "file_create", "file_append"].includes(result?._structured?._type) && result._structured.applied === "auto";
  status.className = result?.success === false
    ? "tool-call-status-pill failed"
    : applied ? "tool-call-status-pill applied" : "tool-call-status-pill";
  status.textContent = getToolCallStatus(result);
  header.appendChild(titleWrap);
  header.appendChild(status);
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-call-body";
  setToolCallExpanded(el, header, body, defaultOpen);
  header.addEventListener("click", () => {
    setToolCallExpanded(el, header, body, body.hidden);
  });

  if (call.params && Object.keys(call.params).length > 0) {
    const input = document.createElement("div");
    input.className = "tool-call-input";
    if (call.name === "file_edit" && call.params.edits) {
      const brief = { file_path: call.params.file_path, edits_count: Array.isArray(call.params.edits) ? call.params.edits.length : 0 };
      input.textContent = JSON.stringify(brief, null, 2);
    } else if (call.name === "file_create" && call.params.content) {
      const brief = { file_path: call.params.file_path, lines: (call.params.content || "").split("\n").length };
      input.textContent = JSON.stringify(brief, null, 2);
    } else if (call.name === "file_append" && call.params.content !== undefined) {
      const brief = { file_path: call.params.file_path, lines: (call.params.content || "").split("\n").length };
      input.textContent = JSON.stringify(brief, null, 2);
    } else if (call.name === "skill_run") {
      input.textContent = JSON.stringify({
        skill: call.params.skill,
        params: summarizeParams(call.params.params || {}),
      }, null, 2);
    } else {
      input.textContent = JSON.stringify(call.params, null, 2);
    }
    body.appendChild(input);
  }

  // 检测结构化结果
  if (result._structured && result._structured._type === "file_edit") {
    body.appendChild(renderFileEditDiff(result._structured));
  } else if (result._structured && result._structured._type === "file_create") {
    body.appendChild(renderFileCreateDiff(result._structured));
  } else if (result._structured && result._structured._type === "file_append") {
    body.appendChild(renderFileAppendPreview(result._structured));
  } else {
    const output = document.createElement("div");
    output.className = "tool-call-output tool-call-status";
    output.textContent = shouldHideToolOutput(call)
      ? (result.success === false ? t("执行失败: {msg}", { msg: result.output || "未知错误" }) : "已执行，结果仅作为上下文提供给模型。")
      : (result.output || "");
    body.appendChild(output);
    // 多模态输出预览：工具返回 preview_url 时内联展示（图片直接渲染，文档提供链接）
    const imgInfo = extractToolImage(result?.output);
    if (imgInfo) {
      setToolCallExpanded(el, header, body, true);
      const wrap = document.createElement("div");
      if (imgInfo.kind === "image") {
        wrap.className = "tool-call-image";
        const img = document.createElement("img");
        img.src = imgInfo.url;
        img.alt = imgInfo.name || "工具输出图片";
        img.addEventListener("click", () => showImageLightbox(imgInfo.url, imgInfo.name));
        wrap.appendChild(img);
      } else if (imgInfo.kind === "video") {
        wrap.className = "tool-call-video";
        const video = document.createElement("video");
        video.src = imgInfo.url;
        video.controls = true;
        video.preload = "metadata";
        wrap.appendChild(video);
      } else {
        wrap.className = "tool-call-doc";
        const link = document.createElement("a");
        link.href = imgInfo.url;
        link.target = "_blank";
        link.rel = "noopener";
        setIconText(link, "file", imgInfo.name || t("查看输出文档"));
        wrap.appendChild(link);
      }
      body.appendChild(wrap);
    }
  }

  el.appendChild(body);
  return el;
}

// ── 文件编辑 diff 查看 ───────────────────

function renderFileEditDiff(data) {
  const wrap = document.createElement("div");
  wrap.className = "file-edit-diff";

  const head = document.createElement("div");
  head.className = "file-edit-diff-head";
  const s = data.stats || { lines_added: 0, lines_removed: 0 };
  const fileName = document.createElement("span");
  fileName.className = "file-edit-file-name";
  fileName.textContent = data.file_name || "未知文件";
  const stats = document.createElement("span");
  stats.className = "file-edit-stats";
  stats.textContent = `+${s.lines_added} -${s.lines_removed}`;
  head.append(fileName, stats);
  wrap.appendChild(head);

  const targetPath = data.file_path_rel || data.file;
  if (targetPath) {
    const pathDiv = document.createElement("div");
    pathDiv.className = "file-edit-path";
    pathDiv.textContent = targetPath;
    wrap.appendChild(pathDiv);
  }

  // 显示错误信息
  if (data.errors && data.errors.length > 0) {
    const errDiv = document.createElement("div");
    errDiv.className = "file-edit-errors";
    setWarningText(errDiv, data.errors.join("\n"));
    wrap.appendChild(errDiv);
  }

  // 只有 diff 内容时才渲染 pre
  if (data.diff) {
    const pre = document.createElement("pre");
    pre.className = "file-edit-diff-pre";
    const diffLines = data.diff.split("\n");
    for (const line of diffLines) {
      const span = document.createElement("span");
      span.className = "diff-line" +
        (line.startsWith("+") ? " diff-add" : "") +
        (line.startsWith("-") ? " diff-del" : "") +
        (line.startsWith("@@") ? " diff-hunk" : "");
      span.textContent = line;
      pre.appendChild(span);
      pre.appendChild(document.createTextNode("\n"));
    }
    wrap.appendChild(pre);
  }

  const actions = document.createElement("div");
  actions.className = "file-edit-actions";

  const btnAccept = document.createElement("button");
  btnAccept.className = "file-edit-btn file-edit-btn-accept";
  btnAccept.textContent = "接受";
  btnAccept.addEventListener("click", async () => {
    btnAccept.disabled = true;
    btnReject.disabled = true;
    btnCopy.disabled = true;
    try {
      const res = await post("/projects/apply-edit", { file_path: data.file, content: data.new_content });
      if (res.code === 0) {
        setIconText(btnAccept, "check", t("已应用"));
        btnAccept.classList.add("done");
        wrap.classList.add("file-edit-resolved");
      } else {
        btnAccept.textContent = "失败";
        btnAccept.classList.add("failed");
        btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false;
      }
    } catch (e) {
      btnAccept.textContent = "失败";
      btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false;
    }
  });

  const btnReject = document.createElement("button");
  btnReject.className = "file-edit-btn file-edit-btn-reject";
  btnReject.textContent = "拒绝";
  btnReject.addEventListener("click", () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true;
    setIconText(btnReject, "check", t("已拒绝"));
    wrap.classList.add("file-edit-rejected");
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "复制 diff";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.diff);
      setIconText(btnCopy, "check", t("已复制"));
      setTimeout(() => { btnCopy.textContent = "复制 diff"; }, 1500);
    } catch (e) {}
  });

  if (!data.file) btnAccept.disabled = true;

  // 已自动应用：展示已落盘状态，不再提供接受/拒绝（拒绝也无法回滚已写入的内容）
  if (data.applied === "auto") {

    btnAccept.textContent = "已自动应用";
    btnAccept.classList.add("done");
    btnAccept.disabled = true;
    btnReject.remove();
    wrap.classList.add("file-edit-resolved");
    actions.appendChild(btnAccept);
    actions.appendChild(btnCopy);
    wrap.appendChild(actions);
    return wrap;
  }

  actions.appendChild(btnAccept);
  actions.appendChild(btnReject);
  actions.appendChild(btnCopy);
  wrap.appendChild(actions);

  return wrap;
}

// ── 文件创建 diff 查看 ───────────────────

function renderFileCreateDiff(data) {
  const wrap = document.createElement("div");
  wrap.className = "file-edit-diff file-create-diff";

  const head = document.createElement("div");
  head.className = "file-edit-diff-head";
  const s = data.stats || { lines: 0, chars: 0 };
  const fileName = document.createElement("span");
  fileName.className = "file-edit-file-name";
  fileName.textContent = data.file_name || "未知文件";
  const stats = document.createElement("span");
  stats.className = "file-edit-stats file-create-badge";
  stats.textContent = t("新文件 · {lines} 行 · {chars} 字符", { lines: s.lines, chars: s.chars });
  head.append(fileName, stats);
  wrap.appendChild(head);

  const targetPath = data.file_path_rel || data.file;
  if (targetPath) {
    const pathDiv = document.createElement("div");
    pathDiv.className = "file-edit-path";
    pathDiv.textContent = targetPath;
    wrap.appendChild(pathDiv);
  }

  // 显示错误信息
  if (data.errors && data.errors.length > 0) {
    const errDiv = document.createElement("div");
    errDiv.className = "file-edit-errors";
    setWarningText(errDiv, data.errors.join("\n"));
    wrap.appendChild(errDiv);
  }

  // 模型输出被截断时的醒目警告（内容可能不完整）
  if (data.truncated) {
    const warn = document.createElement("div");
    warn.className = "file-edit-errors";
    setWarningText(warn, t("模型输出长度达到上限，文件内容可能在末尾被截断。自动写入后模型会用 file_append 补齐剩余部分，可手动核对完整性。"));
    wrap.appendChild(warn);
  }

  // 只有 diff 内容时才渲染 pre
  if (data.diff) {
    const pre = document.createElement("pre");
    pre.className = "file-edit-diff-pre";
    const diffLines = data.diff.split("\n");
    for (const line of diffLines) {
      const span = document.createElement("span");
      span.className = "diff-line" +
        (line.startsWith("+") ? " diff-add" : "") +
        (line.startsWith("@@") ? " diff-hunk" : "");
      span.textContent = line;
      pre.appendChild(span);
      pre.appendChild(document.createTextNode("\n"));
    }
    wrap.appendChild(pre);
  }

  const actions = document.createElement("div");
  actions.className = "file-edit-actions";

  const btnAccept = document.createElement("button");
  btnAccept.className = "file-edit-btn file-edit-btn-accept";
  btnAccept.textContent = "创建";
  btnAccept.addEventListener("click", async () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true; btnDownload.disabled = true;
    try {
      const res = await post("/projects/create-file", { file_path: data.file, content: data.content });
      if (res.code === 0) {
        btnAccept.textContent = "已创建";
        btnAccept.classList.add("done");
        wrap.classList.add("file-edit-resolved");
      } else {
        btnAccept.textContent = "失败";
        btnAccept.classList.add("failed");
        btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false; btnDownload.disabled = false;
      }
    } catch (e) {
      btnAccept.textContent = "失败";
      btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false; btnDownload.disabled = false;
    }
  });

  const btnReject = document.createElement("button");
  btnReject.className = "file-edit-btn file-edit-btn-reject";
  btnReject.textContent = "放弃";
  btnReject.addEventListener("click", () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true; btnDownload.disabled = true;
    btnReject.textContent = "已放弃";
    wrap.classList.add("file-edit-rejected");
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "复制内容";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.content);
      setIconText(btnCopy, "check", t("已复制"));
      setTimeout(() => { btnCopy.textContent = "复制内容"; }, 1500);
    } catch (e) {}
  });

  const btnDownload = document.createElement("button");
  btnDownload.className = "file-edit-btn file-edit-btn-copy";
  btnDownload.textContent = "下载文件";
  btnDownload.addEventListener("click", () => {
    const blob = new Blob([data.content || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.file_name || "output.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  if (!data.file) btnAccept.disabled = true;

  // 已自动应用：展示已落盘状态，保留复制/下载，不再提供创建/放弃
  if (data.applied === "auto") {
    btnAccept.textContent = data.truncated ? "已自动创建（内容截断，等待续写补齐）" : "已自动创建";
    btnAccept.classList.add("done");
    btnAccept.disabled = true;
    btnReject.remove();
    wrap.classList.add("file-edit-resolved");
    actions.appendChild(btnAccept);
    actions.appendChild(btnCopy);
    actions.appendChild(btnDownload);
    wrap.appendChild(actions);
    return wrap;
  }

  actions.appendChild(btnAccept);
  actions.appendChild(btnReject);
  actions.appendChild(btnCopy);
  actions.appendChild(btnDownload);
  wrap.appendChild(actions);

  return wrap;
}

// ── 文件追加预览查看器（超长文件分段写入 / 截断补齐）───

function renderFileAppendPreview(data) {
  const wrap = document.createElement("div");
  wrap.className = "file-edit-diff file-create-diff";

  const head = document.createElement("div");
  head.className = "file-edit-diff-head";
  const s = data.stats || { lines: 0, chars: 0 };
  const fileName = document.createElement("span");
  fileName.className = "file-edit-file-name";
  fileName.textContent = data.file_name || "未知文件";
  const stats = document.createElement("span");
  stats.className = "file-edit-stats file-create-badge";
  stats.textContent = t("追加 · {lines} 行 · {chars} 字符", { lines: s.lines, chars: s.chars });
  head.append(fileName, stats);
  wrap.appendChild(head);

  const targetPath = data.file_path_rel || data.file;
  if (targetPath) {
    const pathDiv = document.createElement("div");
    pathDiv.className = "file-edit-path";
    pathDiv.textContent = targetPath;
    wrap.appendChild(pathDiv);
  }

  if (data.errors && data.errors.length > 0) {
    const errDiv = document.createElement("div");
    errDiv.className = "file-edit-errors";
    setWarningText(errDiv, data.errors.join("\n"));
    wrap.appendChild(errDiv);
  }

  // 本次追加内容本身又被截断：提示后续会自动补齐
  if (data.truncated) {
    const warn = document.createElement("div");
    warn.className = "file-edit-errors";
    setWarningText(warn, t("本次追加内容因输出长度上限被截断。模型会继续用 file_append 补齐剩余部分。"));
    wrap.appendChild(warn);
  }

  if (data.content) {
    const pre = document.createElement("pre");
    pre.className = "file-edit-diff-pre";
    const span = document.createElement("span");
    span.className = "diff-line diff-add";
    span.textContent = data.content;
    pre.appendChild(span);
    wrap.appendChild(pre);
  }

  const actions = document.createElement("div");
  actions.className = "file-edit-actions";

  // file_append 在工具调用时已直接写入磁盘（无预览端点）。
  // 卡片只展示已落盘状态与复制按钮；早期版本此处有「追加」按钮，再点会重复追加同一内容，已移除。
  const btnDone = document.createElement("button");
  btnDone.className = "file-edit-btn file-edit-btn-accept done";
  btnDone.textContent = data.truncated ? "已追加（本段截断，等待后续补齐）" : "已追加";
  btnDone.disabled = true;

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "复制内容";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.content || "");
      setIconText(btnCopy, "check", t("已复制"));
      setTimeout(() => { btnCopy.textContent = "复制内容"; }, 1500);
    } catch (e) {}
  });

  wrap.classList.add("file-edit-resolved");
  actions.appendChild(btnDone);
  actions.appendChild(btnCopy);
  wrap.appendChild(actions);

  return wrap;
}

// ── 截断自动续写 ──────────────────────────────

/**
 * 输出达到模型单次上限时，工具调用块会在末尾缺闭合标记 ◈◆◆。
 * 此时自动追加一轮请求，让模型从断点继续输出，把续写内容拼回原消息。
 * 拼合成功后 detectToolCalls 能完整解析，不再触发截断警告。
 */
const MAX_CONTINUE_ROUNDS = 6;
const CONTINUE_PROMPT_TOOL = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释、前言或代码围栏标记，一直续写到工具调用以 ◈◆◆ 闭合为止。";
const CONTINUE_PROMPT_TEXT = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释或前言，一直续写到内容完整结束为止。";
// 原样围栏协议专用：模型正在写文件内容，续写时最容易犯的错是重发工具、路径行或改用 JSON，必须明确禁止。
const CONTINUE_PROMPT_FILE = "你上一次的输出达到长度上限被截断了，当时你正在写文件内容（原样格式）。请继续输出剩余的文件内容：不要重发 ◈◈◈ 工具头，不要重发路径行，不要加任何解释、前言或代码围栏标记，保持原样直写直到内容完整，最后以单独一行 ◈◆◆ 结束。";

/** 续写指令附断点锚点：模型看到自己最后输出的字符，接续准确性显著提示*/
function buildContinuePrompt(content) {
  let base;
  if (hasTruncatedTail(content)) {
    // 协议感知：写文件（原样格式）被截断时用专用指令，避免模型续写时重发头部或切换格式
    const calls = detectToolCalls(content);
    const lastName = calls[calls.length - 1]?.name;
    base = (lastName === "file_create" || lastName === "file_append") ? CONTINUE_PROMPT_FILE : CONTINUE_PROMPT_TOOL;
  } else {
    base = CONTINUE_PROMPT_TEXT;
  }
  const anchor = content.slice(-60);
  if (!anchor.trim()) return base;
  return `${base}\n你最后输出的内容是（直接从它之后接续，不要重复这部分）：\n<<<\n${anchor}\n>>>`;
}

/** 剔除续写输出与已有内容的重叠前缀（模型未听指令重复了尾巴） */
function stripOverlap(oldContent, newPart) {
  const maxCheck = Math.min(oldContent.length, newPart.length, 400);
  for (let len = maxCheck; len > 8; len--) {
    if (oldContent.endsWith(newPart.slice(0, len))) return newPart.slice(len);
  }
  return newPart;
}

async function continueTruncatedOutput(msgEl, content, modelId, apiKey, baseUrl, params, signal, finishReason = "", out = {}) {
  const contentEl = msgEl?.querySelector(".msg-content");
  const ink = msgEl ? attachInkstream(msgEl) : null;
  let fr = finishReason;
  for (let round = 1; round <= MAX_CONTINUE_ROUNDS; round++) {
    // 工具块未闭合或模型自报 finish_reason=length 都视为被截断
    const stuck = hasTruncatedTail(content) || fr === "length";
    if (signal?.aborted || !stuck) break;
    const contPrompt = buildContinuePrompt(content);
    try {
      const { toast } = await import("../app.js?v=20260922-002");
      toast(t("输出达到长度上限，自动续写中（{x}/{n}）…", { x: round, n: MAX_CONTINUE_ROUNDS }));
    } catch {}

    // 历史 + 被截断的助手消息原文 + 续写指令（模型需看到断点才能接续）
    const history = buildAdapterHistory();
    history.push({ role: "assistant", content });
    history.push({ role: "user", content: contPrompt });
    history._modelId = modelId;
    const toolMode = effectiveToolMode(modelId, (findModelById(modelId) || state.currentModel)?.provider, state.chatMode);
    const messages = buildMessages(history, state.constitution, toolMode);

    const cursor = msgEl ? addStreamingCursor(msgEl) : null;
    const contMeta = {};
    let part = "";
    try {
      for await (const chunk of streamChat({ model: modelId, provider: (findModelById(modelId) || state.currentModel)?.provider, messages, api_key: apiKey, base_url: baseUrl, temperature: params?.temperature ?? 0.7, max_tokens: params?.max_tokens ?? getOutputMaxTokens(), reasoning_effort: state.reasoningEffort || "auto", stream: true, signal, meta: contMeta, ...(toolMode === "native" ? { tools: buildOpenAITools() } : {}) }, { onToolCall: (calls) => { out.toolCalls = calls; ink?.onCalls(calls); } })) {
        appendStreamChunk(chunk, {
          reasoning() {
            markActivity();
          },
          content(text) {
            part += text;
            markActivity();
            if (contentEl) renderAssistantContent(contentEl, content + part, cursor);
            ink?.onTextContent(content + part);
            autoScroll();
          },
        });
      }
      fr = contMeta.finishReason || "";
    } catch (err) {
      if (cursor) removeStreamingCursor(cursor);
      if (!isAbortError(err)) { console.warn("自动续写失败:", err); reportError(err, "自动续写"); }
      break;
    }
    if (cursor) removeStreamingCursor(cursor);
    if (!part.trim()) break; // 模型零输出，再试也无意义
    content += stripOverlap(content, part);
  }
  // 轮数耗尽仍未闭合：提示用户，后续由工具循环的截断守卫接管（拒执行并要求拆分重试）
  if (!signal?.aborted && hasTruncatedTail(content)) {
    try {
      const { toast } = await import("../app.js?v=20260922-002");
      toast("输出仍不完整，已要求模型拆分重试", 3200);
    } catch {}
  }
  ink?.destroy();
  if (contentEl) renderAssistantContent(contentEl, content);
  return content;
}

// ── 原生工具调用：历史构建 + 流式降级包装 ────────────────────
// 历史消息需保留原生工具协议字段（assistant.toolCalls / tool.tool_call_id），
// 否则后续请求会因 assistant tool_calls 后缺少匹配的 tool 消息被上游 400。

function mapAdapterMessage(m) {
  const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : (Array.isArray(m.metadata?.toolCalls) ? m.metadata.toolCalls : null);
  const toolResults = Array.isArray(m.toolResults) ? m.toolResults : (Array.isArray(m.metadata?.toolResults) ? m.metadata.toolResults : null);
  return {
    role: m.role,
    content: m.content,
    ...(m.role === "assistant" && toolCalls && toolCalls.length ? { toolCalls } : {}),
    ...(m.role === "assistant" && toolResults && toolResults.length ? { toolResults } : {}),
    ...(m.role === "tool" && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(Array.isArray(m.images) && m.images.length ? { images: m.images } : {}),
  };
}

function buildAdapterHistory() {
  return state.messages.slice(0, -1).map(mapAdapterMessage);
}

// 统一流式入口：按模型能力决定原生（tools 参数）或文本（◈ 协议）模式；
// 对话模式（state.chatMode==="chat"）取 none——请求不带 tools，系统提示也不含工具目录。
// 原生模式零产出即失败（如上游 400 拒绝 tools）时，降级文本模式重试一次并写 localStorage 记忆。
async function streamWithNativeFallback({ history, model, provider, api_key, base_url, temperature, max_tokens, use_responses, signal, meta, onToolCall }, onChunk) {
  let toolMode = effectiveToolMode(model, provider, state.chatMode);
  while (true) {
    const messages = buildMessages(history, state.constitution, toolMode);
    let produced = false;
    try {
      for await (const chunk of streamChat({
        model, provider, messages, api_key, base_url,
        temperature: temperature ?? 0.7,
        max_tokens: max_tokens ?? getOutputMaxTokens(),
        reasoning_effort: state.reasoningEffort || "auto",
        stream: true, use_responses, signal, meta,
        ...(toolMode === "native" ? { tools: buildOpenAITools() } : {}),
      }, { onToolCall })) {
        produced = true;
        onChunk(chunk);
      }
      return;
    } catch (err) {
      if (toolMode === "native" && !produced && !isAbortError(err)) {
        toolMode = "text";
        setModelToolCapability(model, "text");
        try {
          const { toast } = await import("../app.js?v=20260922-002");
          toast(t("该模型不支持原生工具调用，已自动切换为文本格式"), 3200);
        } catch {}
        continue;
      }
      throw err;
    }
  }
}

// ── Agent 循环：kernel + 桌面装配 ─────────────────────────

const DESKTOP_EXIT_REASONS = { aborted: "已手动停止", switched: "会话已切换", noReply: "队尾已不是待处理回复，循环终止" };

// 一次 run 内收尾校验的总次数上限（跨多次"宣称完成"累计）
const SETTLE_PROBE_MAX = 2;

// 桌面侧策略：轮次推进决策与模型可见提示词（这些字符串不经 t()，只为用户可见文本包 t()）
const desktopPolicy = {
  exitReasons: DESKTOP_EXIT_REASONS,
  beginRun(opts) {
    // 目标循环的退出通道：手动停止 / 模型调收口工具 / 轮数用完 / 清单了结。
    // 上一场遗留的收口请求在这里作废，否则新任务会被上一条的收尾指令直接停掉。
    takeLoopExit();
    const harnessOn = state.harness?.enabled === true;
    return {
      harnessOn,
      autopilotOn: harnessOn || opts.options?.autopilot === true,
      todoNudges: 0,
      autopilotNudges: 0,
      // 收尾校验配额：模型每次"想收工"最多拦两次要证据，其余尊重判断放行。
      // 有界是刻意的——自证只是把"用户手动发继续"换成"系统自动问一句"，不能变成无限续跑。
      settleProbes: 0,
      // 连续"只描述计划、未发起工具调用"的轮数：先强警告，再强制停止，避免长循环空转烧额度
      STALL_WARN_ROUNDS: 2,
      STALL_EXIT_ROUNDS: 4,
    };
  },
  openRun(run) {
    const { harnessOn, autopilotOn } = run.extra;
    return openLedgerRun({
      conversationId: run.genConvId || "",
      mode: harnessOn ? "target" : autopilotOn ? "autopilot" : "chat",
      budget: run.maxRounds,
    });
  },
  onStart(run) {
    // 新任务开始：清掉上一任务残留的工具步骤卡，画布只保留当前任务的步骤链
    clearToolStepCards(run.ledger?.runId || "");
    hideResumeHint();
  },
  markActivity() { markActivity(); },
  postExec(run) {
    // 收口工具已经执行完（结果会照常回灌），这里只把请求搬到本场 run 上。
    // 不在 execute 里直接停：那会让模型连"我做完了什么"都还没说出口就被掐断。
    const exit = takeLoopExit();
    if (exit) run.extra.loopExit = exit;
  },
  dedupRound(run) {
    const { round, maxRounds, dupRounds, extra } = run;
    // 目标模式下仅拦截重复调用并催其换思路，不直接退出。
    if (dupRounds >= 2 && !extra.autopilotOn) return { action: "break" };
    return {
      action: "nudge",
      hiddenMsg: {
        role: "user",
        content: `[系统] ${round + 1}/${maxRounds} 轮：你本轮发出的工具调用与上一轮完全相同，已拦截未重复执行。${dupRounds >= 2 ? "已连续多轮相同调用，必须换思路。" : ""}若上轮结果不符合预期，请换思路（拆分任务、改用其他工具、或先用 project_read_file 查看现状）；若任务已推进，直接继续剩余工作或输出结论。`,
        model: "[dedup]",
        hidden: true,
      },
    };
  },
  emptyRound(run) {
    const { round, maxRounds, lastMsg, stallStreak, successfulTool, extra } = run;
    const { harnessOn, autopilotOn, STALL_WARN_ROUNDS, STALL_EXIT_ROUNDS } = extra;
    const todoState = getTodoLoopState();
    const pending = todoState.pending;
    const completedReply = looksLikeCompletedReply(lastMsg.content);
    const explicitSettle = hasExplicitSettle(lastMsg.content);
    // 上一轮生成异常：失败报错或零输出（目标模式下不退出，催其重新生成继续推进）
    const replyFailed = !(lastMsg.content || "").trim() || /^(续写失败|请求失败)/.test(lastMsg.content);

    if (harnessOn && todoState.closed && !replyFailed) {
      clearAutoAdvanceHints(lastMsg);
      run.exitKind = "done";
      return { action: "break", exitReason: "TODOLIST 已全部了结，模型已收尾" };
    }
    if (!harnessOn && autopilotOn && completedReply && successfulTool) {
      // 模型宣称完成、也确实动过手：散文式的"已完成"先拦一道要证据。Autopilot 被投诉
      // "活没干完就断"，绝大多数就是这句"已完成"来得太早——多问一轮的成本，远低于用户手动发"继续"。
      // 已经按协议写【任务完成】的不再追问，否则守约的模型每次收尾都要白烧一轮。
      if (!explicitSettle && extra.settleProbes < SETTLE_PROBE_MAX && round < maxRounds - 1) {
        extra.settleProbes++;
        return {
          action: "nudge",
          kind: "settle_probe",
          progressText: t("Autopilot 收尾校验 · 要求给出验证证据（第 {k} 次）", { k: extra.settleProbes }),
          hiddenMsg: {
            role: "user",
            content: `[系统收尾校验] ${round + 1}/${maxRounds} 轮：你宣称任务已完成，但 Autopilot 不接受口头收工。本轮二选一，不要解释、不要复述任务：(A) 还有没做或没实测过的部分——直接输出下一步工具调用去把它跑完；(B) 确实全部完成——回复【任务完成】，并逐项写明"交付了什么 + 用什么方式验证 + 验证结果"。没有实测证据的完成不算完成。`,
            model: "[settle_probe]",
            hidden: true,
          },
        };
      }
      const settled = settleAutopilotTodosOnCompletion();
      run.exitKind = "done";
      return {
        action: "break",
        exitReason: settled
          ? t("任务完成或模型已收尾 · 已同步清单 {n} 项", { n: settled })
          : "任务完成或模型已收尾",
      };
    }
    // 连续空转止损：模型多轮只描述计划、从未发起工具调用（通常是不支持/不遵守工具调用格式），
    // 达到阈值即强制退出，避免一路空转到轮数上限烧光额度
    if (autopilotOn && stallStreak >= STALL_EXIT_ROUNDS && round < maxRounds - 1) {
      run.exitKind = "stopped";
      return {
        action: "break",
        exitReason: `模型连续 ${stallStreak} 轮未发起任何工具调用，已停止空转。可能原因：当前模型端点不支持工具调用，或模型未遵守指令。建议停止后更换支持工具调用的模型（如官方 DeepSeek / Claude / GPT 端点）重试。`,
      };
    }
    // DSML 标记泄漏但未能还原出完整调用（多半是被 max_tokens 截断）：模型确实想动手，
    // 不能当成"已收尾"退出，催其按 SLATE 格式重发。放在止损之后，反复泄漏仍会终止。
    if (hasDsmlMarkup(lastMsg.content) && round < maxRounds - 1) {
      return {
        action: "nudge",
        kind: "dsml_leak",
        progressText: t("检测到模型用内部标记输出了工具调用，已要求重发"),
        hiddenMsg: {
          role: "user",
          content: "[系统] 你上一条回复把工具调用写成了 <｜｜DSML｜｜invoke …> 内部标记，且未闭合完整，SLATE 无法解析成可执行调用。请改用 ◈◈工具名\n{JSON 参数}\n◈◆◆ 的格式重发该调用（一次只发一个完整调用，参数写全），或先用一句话说明你要做什么。",
          model: "[dsml_leak]",
          hidden: true,
        },
      };
    }
    if (lastMsg.autoAdvanceNudge && round < maxRounds - 1) {
      const nudge = lastMsg.autoAdvanceNudge;
      delete lastMsg.autoAdvanceNudge;
      delete lastMsg.autoAdvanceSuggestedCalls;
      return {
        action: "nudge",
        hiddenMsg: { role: "user", content: nudge, model: "[auto_advance]", hidden: true },
      };
    }
    if (autopilotOn && round < maxRounds - 1) {
      if (stallStreak >= STALL_WARN_ROUNDS && !replyFailed && !completedReply) {
        // 已连续多轮无工具调用：升级强警告，明确要求输出工具调用块，或声明端点不支持
        return {
          action: "nudge",
          progressText: (harnessOn ? t("目标模式 · 连续 {n} 轮未调用工具，强警告（第 {k} 次）", { n: stallStreak, k: stallStreak - STALL_WARN_ROUNDS + 1 }) : t("Autopilot · 连续 {n} 轮未调用工具，强警告（第 {k} 次）", { n: stallStreak, k: stallStreak - STALL_WARN_ROUNDS + 1 })),
          hiddenMsg: {
            role: "user",
            content: `[系统警告] ${round + 1}/${maxRounds} 轮：你已连续 ${stallStreak} 轮只描述计划，从未发起任何工具调用。SLATE 的 Agent 必须通过工具调用执行任务：请以 ◈◈◈ 工具名\n{JSON 参数}\n◈◆◆ 的格式输出工具调用（可用 file_tree / project_find_file / project_read_file / terminal 等）。若你的模型端点确实无法输出工具调用格式，请直接回复【不支持工具调用】，系统将停止本次执行以免浪费额度。`,
            model: "[stall_warn]",
            hidden: true,
          },
        };
      }
      if (replyFailed) {
        // 模型侧失败零输出：不退出循环，注入提示让其忽略异常继续推进
        return {
          action: "nudge",
          hiddenMsg: {
            role: "user",
            content: `[系统] ${round + 1}/${maxRounds} 轮：上一轮生成异常（失败或无输出），自主推进仍在执行，请忽略异常内容，直接继续推进任务。`,
            model: "[retry]",
            hidden: true,
          },
        };
      }
      if (pending.length > 0) {
        // 闭环强制：模型想收尾但 TODOLIST 仍有未完成项，注入系统催办继续推进。
        extra.todoNudges++;
        return {
          action: "nudge",
          progressText: (harnessOn ? t("目标模式闭环校验 · 清单剩余 {n} 项，自动催办（第 {k} 次）", { n: pending.length, k: extra.todoNudges }) : t("Autopilot 闭环校验 · 清单剩余 {n} 项，自动催办（第 {k} 次）", { n: pending.length, k: extra.todoNudges })),
          hiddenMsg: {
            role: "user",
            content: `[系统校验] ${round + 1}/${maxRounds} 轮：任务尚未完成，TODOLIST 仍有 ${pending.length} 项未了结：\n${pending.map(t => `- [${t.id}] ${t.content}`).join("\n")}\n请统筹批量推进剩余事项（能一起完成的多项不要拆开磨），每完成一批立即调用 todo_manage 批量更新状态，让清单实时反映进度，全部了结后再输出汇报与追溯。`,
            model: "[todo_enforce]",
            hidden: true,
          },
        };
      }
      if (!completedReply && (asksUserToDecide(lastMsg.content) || looksLikeActionStall(lastMsg.content) || looksLikeInspectionStall(lastMsg.content))) {
        extra.autopilotNudges++;
        return {
          action: "nudge",
          progressText: t("Autopilot 自主推进 · 自动续跑（第 {k} 次）", { k: extra.autopilotNudges }),
          hiddenMsg: {
            role: "user",
            content: `[系统自动推进] ${round + 1}/${maxRounds} 轮：你上一条回复停在计划/询问阶段，但用户希望由你自主完成，不要在可自行决策时等待“继续”或确认。任务与全部约束就在你上方的对话历史里，无需复述或重新规划。请直接从上次停下的位置继续，第一句就输出下一步的最小必要动作：需要事实就调用工具；若确实已经完成，则直接给出包含验证方式的简短最终汇报。`,
            model: "[autopilot]",
            hidden: true,
          },
        };
      }
      if (!harnessOn && autopilotOn && !successfulTool && completedReply) {
        extra.autopilotNudges++;
        return {
          action: "nudge",
          progressText: t("Autopilot 自主推进 · 校验口头完成（第 {k} 次）", { k: extra.autopilotNudges }),
          hiddenMsg: {
            role: "user",
            content: `[系统自动推进] ${round + 1}/${maxRounds} 轮：你刚才像是在汇报完成，但本轮没有任何工具执行记录。用户要求你像 Agent 一样把活做完，而不是口头承诺。任务要求就在你上方的对话历史里，不要复述任务，请直接从第一句开始读取/检查/修改/运行验证；如果确实无法操作，请说明具体阻塞原因。`,
            model: "[autopilot]",
            hidden: true,
          },
        };
      }
    }
    // 最后一道闸：既没干活、也没声明完成、又没向用户提问就停笔——这正是用户要连发
    // 几句"继续"的场景。用掉一次收尾校验配额逼它表态（继续做，或明确写【任务完成】），
    // 配额用尽才按"未确认完成"退出，不再伪装成任务完成。
    if (autopilotOn && !completedReply && !replyFailed && round < maxRounds - 1
        && extra.settleProbes < SETTLE_PROBE_MAX) {
      extra.settleProbes++;
      return {
        action: "nudge",
        kind: "settle_probe",
        progressText: t("Autopilot 收尾校验 · 未声明完成，要求续做或显式收口（第 {k} 次）", { k: extra.settleProbes }),
        hiddenMsg: {
          role: "user",
          content: `[系统收尾校验] ${round + 1}/${maxRounds} 轮：这一轮你没有发起工具调用，也没有声明任务完成，循环即将结束。二选一：任务未完成就直接输出下一步工具调用继续推进（用户不打算再说"继续"）；已完成就回复一行【任务完成】并给出最终汇报，逐项写明验证方式与结果。`,
          model: "[settle_probe]",
          hidden: true,
        },
      };
    }
    // 未走完成通道的退出统统记为"未确认完成"：轮数耗尽、模型收尾退出都在这里
    run.exitKind = completedReply ? "done" : "stopped";
    return {
      action: "break",
      exitReason: autopilotOn
        ? (completedReply ? "任务完成或模型已收尾"
          : pending.length === 0 ? t("模型停止推进 · 未声明完成")
            : t("模型收尾退出 · 清单剩余 {n} 项", { n: pending.length }))
        : undefined,
    };
  },
  progressForRound(run) {
    const { extra } = run;
    if (!extra.autopilotOn) return undefined;
    const todos = getConversationTodos(state.currentConversationId);
    const doneCount = todos.filter(t => t.status === "done").length;
    const todoText = todos.length ? t(" · 清单 {done}/{total}", { done: doneCount, total: todos.length }) : "";
    return (extra.harnessOn ? t("目标模式 · 第 {x}/{n} 轮", { x: run.round + 1, n: run.maxRounds }) : t("Autopilot 自主推进 · 第 {x}/{n} 轮", { x: run.round + 1, n: run.maxRounds })) + todoText;
  },
  buildFeeds(run) {
    const { calls, results, round, maxRounds, extra } = run;
    // Keep tool results in model context without rendering them as chat bubbles.
    // 目标模式下每轮结果开头标注轮次，让模型感知当前进度与剩余轮数预算
    const roundTag = extra.autopilotOn ? `[${extra.harnessOn ? "目标模式" : "Autopilot"} · ${round + 1}/${maxRounds} 轮]\n` : "";
    // 原生调用以 role:"tool" + tool_call_id 回灌（OpenAI 协议要求 assistant tool_calls 后必须配对）；
    // 文本块调用保持 role:"user" [tool_results]（含轮次标签与推进指令）
    const nativeFeeds = [];
    const textParts = [];
    for (let i = 0; i < results.length; i++) {
      if (calls[i]?.id) nativeFeeds.push({ call: calls[i], result: results[i] });
      else textParts.push(formatToolResultForModel(calls[i], results[i]));
    }
    const feeds = nativeFeeds.map(({ call, result }) => ({
      role: "tool",
      content: String(result.output ?? "完成"),
      tool_call_id: call.id,
      model: "[tool_results]",
      hidden: true,
    }));
    const toolResultText = roundTag
      + textParts.join("\n\n")
      + (textParts.length ? "\n\n" : "")
      + buildToolFollowupInstruction({ harnessOn: extra.harnessOn, autopilotOn: extra.autopilotOn, round, maxRounds, results });
    feeds.push({ role: "user", content: toolResultText, model: "[tool_results]", hidden: true });
    return feeds;
  },
  async endTurn(run) {
    const { extra, turn } = run;
    const { modelId, apiKey, baseUrl, params } = run.opts;
    // 模型调过收口工具：这一轮就是它的最终汇报，说完即停——不再自动续跑、也不再催办
    if (extra.loopExit) {
      clearAutoAdvanceHints(turn.message);
      run.exitKind = "done";
      return {
        action: "break",
        exitReason: extra.loopExit.mode === "target"
          ? `模型已调 exit_target_mode 收口${extra.loopExit.reason ? `：${extra.loopExit.reason}` : ""}`
          : `模型已调 exit_autopilot 收口${extra.loopExit.reason ? `：${extra.loopExit.reason}` : ""}`,
      };
    }
    if (extra.harnessOn && getTodoLoopState().closed && !hasToolMarkup(turn.content) && turn.content.trim()) {
      clearAutoAdvanceHints(turn.message);
      run.exitKind = "done";
      return { action: "break", exitReason: "TODOLIST 已全部了结，模型已收尾" };
    }
    let el = await autoAdvanceIfStalled(turn.bubble, modelId, apiKey, baseUrl, params);
    el = await autoReviewIfStalled(el, modelId, apiKey, baseUrl, run.signal);
    return { action: "continue", bubble: el };
  },
  finish(run) {
    const { extra } = run;
    // 账本已补发取消事件，这里再投一次，停止/异常/轮数耗尽时不留悬空黄卡
    projectBoard(run);
    boardRunInfo = {
      runId: run.ledger?.runId || "",
      exitReason: run.exitReason || "",
      exitKind: run.exitKind || "stopped",
      wallMs: Math.max(0, Date.now() - (run.ledger?.startedAtMs || Date.now())),
    };
    // 清理未执行的工具标记并解除渲染抑制，防止残留标记被渲染成伪造的"历史恢复"卡片
    cleanupStaleToolMarkers();
    if (extra.autopilotOn && !run.exitReason && !(run.signal?.aborted)) {
      run.exitReason = t("已达 {n} 轮上限", { n: run.maxRounds });
      // 轮数用完而没走完成通道 = 活没干完，不能报"任务完成"
      if (!run.exitKind) run.exitKind = "stopped";
    }
    if (extra.harnessOn && run.maxRounds > 5) {
      showHarnessIdle(run.exitReason ? run.exitReason + t(" · 目标模式保持开启，下一条消息继续自主执行（点「目标模式」手动退出）") : "");
    } else if (!extra.harnessOn && extra.autopilotOn) {
      setHarnessProgress(null);
    }
    // 任务完成通知（非手动停止时触发）；只有走完完成通道的退出才配"任务完成"这个标题，
    // 空转止损、轮数耗尽、未声明完成就停笔一律如实报"已中断"，并给出续跑入口。
    if (extra.autopilotOn && run.exitReason && !run.exitReason.includes("手动停止")) {
      const settled = run.exitKind === "done";
      const stalled = run.exitReason.includes("停止空转");
      const mode = extra.harnessOn ? t("目标模式") : "Autopilot";
      const title = settled ? t("{m} 任务完成", { m: mode })
        : stalled ? t("{m} 已停止", { m: mode })
          : t("{m} 已中断 · 任务未确认完成", { m: mode });
      notifyTaskComplete(title, run.exitReason);
      if (!settled && !extra.harnessOn) showResumeHint(run.exitReason);
    }
    // 侧栏徽标：这一场以什么姿态结束就记什么。kernel 观察到异常=error；
    // 走完完成通道（含 exit_* 收口）=done；手动停止/轮数耗尽/切走中断都还有"继续跑完"可做=needs。
    noteTaskOutcome(run.genConvId, run.exitStatus === "error" ? "error" : run.exitKind === "done" ? "done" : "needs");
  },
};

// 账 → 白板：一次 run 的步骤链投影，幂等可重复调用
function projectBoard(run) {
  if (!run.ledger) return;
  boardRunLedger = run.ledger;   // 黑板工作流视图读的就是这一份账，不另存一份状态
  boardRunConvId = run.genConvId || state.currentConversationId || "";
  syncToolStepCards(projectSteps(run.ledger), run.ledger.runId);
}

// ── 黑板工作流视图的现场读取 ────────────────────────────
// 视图每秒 pull 一次（不 push、不 notify）：账本仍是唯一真源，这里只是给只读入口。
let boardRunLedger = null;   // 当前/最近一次 run 的账本
let boardRunConvId = "";     // 这份账属于哪场对话：换了对话就不能再拿它充数
let boardRunInfo = null;     // 上一场的收尾：{runId, exitReason, exitKind, wallMs}

function boardWorkflowSnapshot() {
  const busy = Boolean(isGenerating);
  // 账本跟着对话作废：不然切到没跑过的对话，"当前运行"还在播上一场的步骤
  const mine = !boardRunConvId || boardRunConvId === (state.currentConversationId || "");
  const ledger = mine ? boardRunLedger : null;
  return {
    busy,
    conversationId: state.currentConversationId || "",
    round: ledger ? Math.max(1, ledger.roundSeen + 1) : 0,
    startedAtMs: busy ? (ledger?.startedAtMs || 0) : 0,
    steps: ledger ? projectSteps(ledger) : [],
    finished: !busy && ledger ? {
      runId: ledger.runId,
      exitReason: boardRunInfo?.exitReason || "",
      exitKind: boardRunInfo?.exitKind || "stopped",
      wallMs: boardRunInfo?.wallMs || 0,
    } : null,
  };
}

function registerBoardWorkflow() {
  setWorkflowRunApi({
    snapshot: boardWorkflowSnapshot,
    conversationId: () => state.currentConversationId || "",
    canResume: () => !isGenerating
      && Boolean(resumeHintEl) && !resumeHintEl.classList.contains("hidden"),
    runAction: (id, name) => {
      // 复用 @提及 注入这一条既有链路：Action 的正文由 resolveMentions 取，视图不另造执行器
      sendMessage({ text: `@${id} 请按这份流程执行「${name || id}」`, files: [] });
    },
    stop: () => stopGeneration(),
    resume: () => {
      hideResumeHint();
      sendMessage({ text: "继续", files: [] });
    },
    toggleAutopilot: () => { toggleHarness(); },
  });
}

// 桌面侧视图：气泡重锚定、正文回显、进度条、砚流进度、白板步骤卡
const desktopView = {
  reanchorBubble(el, index) {
    if (el?.isConnected) return null;
    const liveEl = chatScroll?.querySelector(`.msg[data-index="${index}"]`);
    if (!liveEl) return null;
    // 砚流条实例随节点迁移，本轮 DOM 写入才不落空
    rehostInkstream(el, liveEl);
    return liveEl;
  },
  renderBubble(el, content) {
    const contentEl = el?.querySelector(".msg-content");
    if (!contentEl) return;
    contentEl.innerHTML = renderMarkdown(content);
    contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
  },
  setProgress(text) { setHarnessProgress(text); },
  execProgress(el) {
    const execInk = attachInkstream(el);
    const argKeyOf = (call) => (call?.index != null ? `n${call.index}` : "t0");
    // 只有走 /stream 的调用才有实时进度；本地工具（user_ask/diff 确认）会等人，不演「执行中」
    const canStream = (call) => call?.name === "skill_run";
    return {
      onCallStart: (call, i) => {
        if (!canStream(call)) return;
        execInk?.onExecStart({
          key: `e${i}`,
          name: call.name,
          skill: call.params?.skill || "",
          hide: argKeyOf(call),
        });
      },
      onEvent: (env, call, i) => { if (canStream(call)) execInk?.onExecEvent(`e${i}`, env); },
      onCallEnd: (call, i) => { if (canStream(call)) execInk?.onExecEnd(`e${i}`); },
      endAll: (calls) => { for (let i = 0; i < calls.length; i++) execInk?.onExecEnd(`e${i}`); },
    };
  },
  toolCards: {
    // 步骤卡是账的投影：开跑时生成本轮的 running 卡，执行收尾后再投一次回写状态与摘录
    begin(run) { projectBoard(run); },
    finish(run) { projectBoard(run); },
  },
};

// 桌面侧 IO：调用探测、工具执行、结果落库、新建气泡流式续写
const desktopIo = {
  detectCalls(lastMsg) {
    return dedupeToolCalls([
      ...detectToolCalls(lastMsg.content),
      ...detectDsmlCalls(lastMsg.content),
      ...openAICallsToCalls(lastMsg.toolCalls || []),
    ]);
  },
  execute(calls, opts) {
    return executeToolCalls(calls, opts);
  },
  async commitResults(run) {
    const { lastMsg } = run;
    lastMsg.toolResults = [
      ...(lastMsg.toolResults || []),
      ...projectChat(run.ledger, run.round),
    ];
    setMessages([...state.messages]);
    if (lastMsg.id) {
      try {
        await patch(`/chat/messages/${lastMsg.id}`, {
          content: lastMsg.content,
          metadata: {
            toolResults: lastMsg.toolResults,
            ...(lastMsg.toolCalls ? { toolCalls: lastMsg.toolCalls } : {}),
            ledgerRunId: run.ledger?.runId || "",
          },
        });
      } catch (e) {
        console.warn("工具结果保存失败:", e);
      }
    }
    autoScroll();
  },
  async streamTurn(run) {
    const { signal, genConvId } = run;
    const { modelId, apiKey, baseUrl, params } = run.opts;
    const followUp = { role: "assistant", content: "", model: state.currentModel?.name || "" };
    addMessage(followUp);
    _pendingToolMsgs.add(followUp);

    // addMessage 已同步触发全量重渲染，直接复用刚生成的气泡，避免产生重复空气泡
    const followEl = chatScroll.lastElementChild;
    const followContent = followEl.querySelector(".msg-content");
    const cursor = addStreamingCursor(followEl);
    autoScroll();

    // 流式续写
    await refreshKnowledgeContext(state.messages.slice(-6).map(m => m.content || "").join("\n"));
    if (signal?.aborted) return { bubble: followEl, message: followUp, stop: DESKTOP_EXIT_REASONS.aborted };
    const history = buildAdapterHistory();
    history._modelId = modelId;
    const nativeCalls = [];

    let followContent2 = "";
    let followReasoningText = "";
    let followThinkingPanel = null;
    const followMeta = {};
    const ink = attachInkstream(followEl);
    try {
      await streamWithNativeFallback({ history, model: modelId, provider: (findModelById(modelId) || state.currentModel)?.provider, api_key: apiKey, base_url: baseUrl, temperature: params.temperature ?? 0.7, max_tokens: params.max_tokens ?? getOutputMaxTokens(), signal, meta: followMeta, onToolCall: (calls) => { nativeCalls.length = 0; nativeCalls.push(...calls); ink.onCalls(calls); } }, (chunk) => {
        appendStreamChunk(chunk, {
          reasoning(text) {
            followReasoningText += text;
            markActivity();
            if (!followThinkingPanel) followThinkingPanel = createThinkingPanel(followEl);
            updateThinkingPanel(followThinkingPanel, followReasoningText);
            autoScroll();
          },
          content(text) {
            followContent2 += text;
            markActivity();
            renderAssistantContent(followContent, followContent2, cursor);
            ink.onTextContent(followContent2);
            autoScroll();
          },
        });
      });
      if (followThinkingPanel) collapseThinkingPanel(followThinkingPanel);
    } catch (err) {
      if (followThinkingPanel) collapseThinkingPanel(followThinkingPanel);
      followContent2 = isAbortError(err)
        ? (followContent2 ? `${followContent2}\n\n[已停止]` : "已停止")
        : t("续写失败: {msg}", { msg: err.message });
      if (!isAbortError(err)) reportError(err, "工具后续轮");
    }

    removeStreamingCursor(cursor);
    const contOut = {};
    if (!signal?.aborted && (hasTruncatedTail(followContent2) || followMeta.finishReason === "length")) {
      followContent2 = await continueTruncatedOutput(followEl, followContent2, modelId, apiKey, baseUrl, params, signal, followMeta.finishReason || "", contOut);
    }
    if (contOut.toolCalls || nativeCalls.length) followUp.toolCalls = contOut.toolCalls || nativeCalls;
    // 会话已切换时跳过本地列表更新（内容仍持久化到归属会话，切回后从后端加载可见）
    if (state.currentConversationId === genConvId) updateLastAssistantMessage(followContent2);
    renderAssistantContent(followContent, followContent2);

    // 持久化（写回归属会话而非当前会话）
    if (genConvId) {
      const saved = await post(`/chat/conversations/${genConvId}/messages`, { role: "assistant", content: followContent2, model: modelId, ...(followUp.toolCalls ? { metadata: { toolCalls: followUp.toolCalls } } : {}) });
      if (saved.code === 0 && saved.data?.id) followUp.id = saved.data.id;
    }
    return { bubble: followEl, message: followUp, content: followContent2 };
  },
};

const desktopAgentLoop = createAgentLoop({ policy: desktopPolicy, view: desktopView, io: desktopIo });

async function runToolLoop(
  msgEl,
  modelId,
  apiKey,
  baseUrl,
  params = { temperature: 0.7, max_tokens: getOutputMaxTokens() },
  signal = null,
  maxRounds = 5,
  options = {},
) {
  // 对话模式：只保留刚结束的这一轮流式输出，不进多轮工具循环
  if (state.chatMode === "chat") return null;
  // 本循环归属会话：之后即使切换到新会话并开始新生成，旧循环也只读写自己的会话。
  // run 交给调用方：徽标已由 policy.finish 落过，发送链路据此避免再记一遍——
  // 否则"手动停止/轮数耗尽"会被收尾的 finally 一律改写成"已完成"。
  return await desktopAgentLoop({
    bubble: msgEl,
    modelId,
    apiKey,
    baseUrl,
    params,
    signal,
    maxRounds,
    options,
    genConvId: activeGenerationConvId,
  });
}

// ── 单次任务计时 ───────────────────────────────

let taskTimerEl = null;
let taskTimerInt = null;
let taskStartedAt = 0;

function initTaskTimer() {
  if (taskTimerEl) return;
  taskTimerEl = document.createElement("div");
  taskTimerEl.className = "task-timer hidden";
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", taskTimerEl);
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function startTaskTimer() {
  initTaskTimer();
  if (!taskTimerEl) return;
  taskStartedAt = Date.now();
  clearInterval(taskTimerInt);
  taskTimerEl.classList.remove("hidden");
  setIconText(taskTimerEl, "clock", `已用时 0s`);
  taskTimerInt = setInterval(() => {
    setIconText(taskTimerEl, "clock", `已用时 ${formatElapsed(Date.now() - taskStartedAt)}`);
  }, 500);
}

function stopTaskTimer() {
  clearInterval(taskTimerInt);
  taskTimerInt = null;
  if (!taskTimerEl) return;
  setIconText(taskTimerEl, "clock", `本次任务 ${formatElapsed(Date.now() - taskStartedAt)}`);
}

// ── 发送消息 ────────────────────────────────

async function sendMessage(queuedPayload = null) {
  if (isGenerating) {
    if (queuedPayload) inputQueue.push(queuedPayload);
    else if (captureCurrentInputForQueue()) {
      const { toast } = await import("../app.js?v=20260922-002");
      toast(t("已加入输入队列（{n}）", { n: inputQueue.length }));
    }
    updateSendState();
    return;
  }

  const text = queuedPayload?.text ?? chatInput.value.trim();
  const filesForMessage = queuedPayload?.files ?? [...pendingFiles];
  if (!text && filesForMessage.length === 0) return;

  // /grind 命令：开启磨墨会话
  const grindMatch = !queuedPayload && text.match(/^\/grind\s+([\s\S]+)/);

  if (grindMatch) {
    chatInput.value = "";
    chatInput.style.height = "auto";
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
    startGrindConversation(grindMatch[1].trim());
    return;
  }

  // 抽象任务自动检测：新对话 + 非磨墨进行中 + 匹配抽象模式 → 提示切换磨墨
  const grindActive = grindSession && ["grinding", "collecting"].includes(grindSession.state);
  const isFreshConv = !state.currentConversationId || state.messages.length === 0;
  if (!queuedPayload && !grindActive && isFreshConv && isAbstractTask(text)) {
    const { dlgConfirm } = await import("../services/dialog.js?v=20260922-002");
    const confirmed = await dlgConfirm(
      t("检测到抽象任务「{text}」，建议先进入磨墨模式细化需求后再执行。是否切换？", { text: text.slice(0, 30) }),
      { title: t("磨墨建议"), okText: t("进入磨墨"), cancelText: t("直接发送") }
    );
    if (confirmed) {
      chatInput.value = "";
      chatInput.style.height = "auto";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
      startGrindConversation(text);
      return;
    }
  }

  isGenerating = true;
  hideResumeHint(); // 新的一轮生成开始：上一次的中断提示条使命结束
  markActivity(); // 看门狗计时基准：从本次生成开始算
  activeGenerationController = new AbortController();
  const signal = activeGenerationController.signal;
  setSubAgentSignal(signal);
  // 生成归属会话：本次生成全程只读写该会话，切换/新建会话后旧回复不会写入新会话
  let genConvId = state.currentConversationId;
  activeGenerationConvId = genConvId;
  updateSendState();
  refreshTaskBadges();  // 「进行中」跟着生成权走：只有实时这一层知道
  startTaskTimer();

  // 这三个标志要在 try 之外声明：finally 里的徽标落点读得到，才轮得到"细粒度结论优先"
  // （侧栏徽标的两条落点：循环跑完由 policy.finish 记，它看得见收口/停止；其余路径由 finally 记）
  let streamFailed = false;
  let loopOutcome = null;
  let sendFailed = false;

  try {
  if (!state.currentConversationId) {
    // 创建对话时记录当前打开的项目（未打开则为空，前端展示为“无项目”）
    const res = await post("/chat/conversations", {
      title: (text || filesForMessage[0]?.name || "新对话").slice(0, 30),
      project: state.project?.name || "",
    });
    if (res.code === 0) {
      state.currentConversationId = res.data.id;
      genConvId = res.data.id;
      activeGenerationConvId = genConvId;
      await refreshConversationList();
      updateConvProjectBadge();
    }
  }

  // TODOLIST：若对话建立前产生了临时清单（_scratch），迁移到正式对话
  const scratchTodos = getConversationTodos(null);

  if (state.currentConversationId && scratchTodos.length) {
    setConversationTodos(state.currentConversationId, [...getConversationTodos(state.currentConversationId), ...scratchTodos]);
    setConversationTodos(null, []);
  }

  // 磨墨：待启磨的想法在对话创建后开启会话
  if (grindPendingIdea && state.currentConversationId) {

    grindSession = await grindSvc.startSession(state.currentConversationId, grindPendingIdea);
    grindPendingIdea = null;
    if (grindSession) {
      renderGrindPanel();
      updateSendState();
    }
  }

  if (!queuedPayload) {
    chatInput.value = "";
    chatInput.style.height = "auto";
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
    pendingFiles = [];
    renderFilePreview();
  }

  // 收集文件内容
  const fileMeta = [];
  let fileContext = "";
  if (filesForMessage.length > 0) {
    fileContext = "\n\n[附件内容]\n以下是用户随本条消息上传的文件与图片，回答时应参考其内容。";
    for (const f of filesForMessage) {
      fileMeta.push({ name: f.name, type: f.type, thumbnail: f.type === "image" ? f.content : null });
      if (f.type === "image") {
        fileContext += `\n[图片: ${f.name}]（已随消息以图片形式发送，请直接查看图片内容）`;
      } else if (f.type === "csv") {
        fileContext += `\n\n[文件: ${f.name}]\n${f.content}`;
      } else {
        fileContext += `\n\n[文件: ${f.name}]\n\`\`\`\n${f.content.slice(0, 10000)}\n\`\`\``;
      }
    }
  }

  const mentionContext = await resolveMentions(text);
  // 对话模式：目标模式与 Autopilot 一律不生效（磨墨/目标模式在「＋」菜单里同步置灰）
  const chatModeOn = state.chatMode === "chat";
  const harnessOn = !chatModeOn && state.harness?.enabled === true;
  const agentTask = classifyAgentTask(text);
  const autopilotOn = !chatModeOn && (harnessOn || agentTask.wantsEnv);
  const agentRuntimeContext = buildAgentRuntimeContext(text, harnessOn);
  const fullText = (harnessOn ? HARNESS_PREFIX : "") + text + agentRuntimeContext + mentionContext + fileContext;
  await refreshKnowledgeContext(fullText);
  // display：气泡只展示用户输入的原文；注入的 Skill 定义 / 目标指令 / 文件内容只进模型上下文，与后端持久化的干净文本保持一致。
  const userMsg = { role: "user", content: fullText, display: text, model: "", files: fileMeta.length > 0 ? fileMeta : undefined };

  addMessage(userMsg);

  // 追溯用：把本轮生效的回复模式与推理强度记进消息 metadata（messages 表已有该 JSON 列，无需迁移）
  const turnMeta = { chatMode: chatModeOn ? "chat" : "agent", reasoningEffort: state.reasoningEffort || "auto" };

  if (genConvId) {
    const saved = await post(`/chat/conversations/${genConvId}/messages`, {
      role: "user",
      content: text,
      model: "",
      metadata: { ...turnMeta, ...(fileMeta.length > 0 ? { files: fileMeta } : {}) },
    });
    if (saved.code === 0 && saved.data?.id) userMsg.id = saved.data.id;
    syncMsgActionButtons();
  }

  const assistantMsg = { role: "assistant", content: "", model: state.currentModel?.name || "" };
  addMessage(assistantMsg);
  _pendingToolMsgs.add(assistantMsg);

  // addMessage 已同步触发全量重渲染，直接复用刚生成的气泡，避免流式期间出现两个空气泡
  let msgEl = chatScroll.lastElementChild;
  const cursor = addStreamingCursor(msgEl);
  stickToBottom = true;
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  const params = getDefaultParams(modelId);
  const historyForAdapter = buildAdapterHistory();
  // 多模态：上传的图片挂到当前用户消息，由 buildMessages 装配成 image_url 内容真正传给模型。
  const imageDataUrls = filesForMessage
    .filter(f => f.type === "image" && typeof f.content === "string" && f.content.startsWith("data:image"))
    .map(f => f.content);
  if (imageDataUrls.length) {
    const lastUserForVision = historyForAdapter[historyForAdapter.length - 1];
    if (lastUserForVision?.role === "user") lastUserForVision.images = imageDataUrls;
  }
  if (brainstormMode) {
    const lastUser = historyForAdapter[historyForAdapter.length - 1];
    if (lastUser?.role === "user") {
      lastUser.content = `[头脑风暴模式]\n请先发散：给 5-8 个不同角度的可能方向，每个用一两句说明亮点与适用场景；\n再收束：选出最值得推进的 1-3 个，说明为什么值得做、第一步怎么走。保持具体、可执行。\n\n${lastUser.content}`;
    }
  }
  // 磨墨注入：接墨 / 磨墨 / 收墨提示词（只进模型上下文，气泡仍显示原文；对话模式不注入）
  if (!chatModeOn && grindSession && grindSession.state !== "done" && state.currentConversationId === grindSession.conversation_id) {
    const lastUser = historyForAdapter[historyForAdapter.length - 1];
    if (lastUser?.role === "user") {
      if (grindSession.state === "collecting") {
        lastUser.content = `${grindSvc.collectingPrompt()}\n\n用户输入：${lastUser.content}`;
      } else if ((grindSession.round || 0) === 0) {
        lastUser.content = grindSvc.firstRoundPrompt(lastUser.content);
      } else {
        const isCollect = grindSvc.COLLECT_RE.test(lastUser.content.trim());
        const reachedLimit = grindSession.round >= grindSvc.MAX_ROUNDS;
        if (isCollect || reachedLimit) {
          await grindSvc.collectSession(grindSession.conversation_id);
          grindSession.state = "collecting";
          lastUser.content = `${grindSvc.collectingPrompt()}\n\n用户输入：${lastUser.content}`;
        } else {
          lastUser.content = `${grindSvc.grindRoundPrompt(grindSession)}\n\n用户本轮回复：${lastUser.content}`;
        }
      }
    }
  }
  historyForAdapter._modelId = modelId;
  const nativeCalls0 = [];

  let fullContent = "";
  let reasoningText = "";
  let thinkingPanel = null;
  const streamMeta = {};
  const ink0 = attachInkstream(msgEl);
  try {
    await streamWithNativeFallback({ history: historyForAdapter, model: modelId, provider: state.currentModel?.provider, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, use_responses: state.useResponses, signal, meta: streamMeta, onToolCall: (calls) => { nativeCalls0.length = 0; nativeCalls0.push(...calls); ink0.onCalls(calls); } }, (chunk) => {
      // 检测 reasoning 前缀，分离思考内容
      appendStreamChunk(chunk, {
        reasoning(text) {
          reasoningText += text;
          markActivity();
          if (!thinkingPanel) thinkingPanel = createThinkingPanel(msgEl);
          updateThinkingPanel(thinkingPanel, reasoningText);
          autoScroll();
        },
        content(text) {
          fullContent += text;
          markActivity();
          const contentEl = msgEl.querySelector(".msg-content");
          renderAssistantContent(contentEl, fullContent, cursor);
          ink0.onTextContent(fullContent);
          autoScroll();
        },
      });
    });
    // 流式结束，自动折叠思考面板
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
  } catch (err) {
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
    streamFailed = !isAbortError(err);
    if (streamFailed) reportError(err, "首轮生成");
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : t("请求失败: {msg}", { msg: err.message });
  }

  removeStreamingCursor(cursor);

  // 输出被截断（工具块未闭合或 finish_reason=length）→ 自动续写拼回本条消息
  const contOut0 = {};
  if (!signal.aborted && (hasTruncatedTail(fullContent) || streamMeta.finishReason === "length")) {
    fullContent = await continueTruncatedOutput(msgEl, fullContent, modelId, apiKey, baseUrl, params, signal, streamMeta.finishReason || "", contOut0);
  }
  if (contOut0.toolCalls || nativeCalls0.length) assistantMsg.toolCalls = contOut0.toolCalls || nativeCalls0;
  // 会话已切换时不更新新会话的本地消息列表（内容仍会写回 genConvId 对应会话）
  if (state.currentConversationId === genConvId) updateLastAssistantMessage(fullContent);

  // 估算并记录用户
  const estimatedPrompt = measureContext(state.messages.slice(0, -1)).total;

  const estimatedCompletion = Math.ceil(fullContent.length / 3);
  addUsage({ prompt_tokens: estimatedPrompt, completion_tokens: estimatedCompletion });

  // 同步用量到后端
  syncUsageToBackend();


  const contentEl = msgEl.querySelector(".msg-content");
  renderAssistantContent(contentEl, fullContent);

  if (genConvId) {
    const saved = await post(`/chat/conversations/${genConvId}/messages`, { role: "assistant", content: fullContent, model: modelId, metadata: { ...turnMeta, ...(assistantMsg.toolCalls ? { toolCalls: assistantMsg.toolCalls } : {}) } });
    if (saved.code === 0 && saved.data?.id) assistantMsg.id = saved.data.id;
    syncMsgActionButtons();
  }

  if (!signal.aborted && !streamFailed) {
    msgEl = await autoAdvanceIfStalled(msgEl, modelId, apiKey, baseUrl, params);
    msgEl = await autoReviewIfStalled(msgEl, modelId, apiKey, baseUrl, signal);
  }

  // 工具调用循环：环境任务默认进入 Autopilot，避免用户反复说“继续”；目标是显式强模式。
  const toolRounds = harnessOn
    ? Math.max(10, Math.min(HARNESS_MAX_ROUNDS, state.harness?.maxRounds || HARNESS_MAX_ROUNDS))
    : (autopilotOn
      ? (agentTask.broad ? AGENT_AUTOPILOT_BROAD_ROUNDS : AGENT_AUTOPILOT_DEFAULT_ROUNDS)
      : 5);
  if (harnessOn) {
    setHarnessProgress(t("自主执行已启动 · 最多 {n} 轮 · 仅手动停止 / 轮数用完 / 模型调 exit_target_mode 收口才退出", { n: toolRounds }));
  } else if (autopilotOn) {
    setHarnessProgress(t("Autopilot 自主推进已启动 · 最多 {n} 轮", { n: toolRounds }));
  }
  if (!signal.aborted && !streamFailed) loopOutcome = await runToolLoop(msgEl, modelId, apiKey, baseUrl, params, signal, toolRounds, { autopilot: autopilotOn });
  else if (harnessOn) showHarnessIdle(); // 启动前即被停止：runToolLoop 未运行，保持待机指示

  // 后台检查上下文压缩
  if (!signal.aborted && !streamFailed) {
    checkAndCompress(modelId, apiKey, baseUrl);
    autoRefineMemoryAndProfile({ silent: true });
  }

  // 磨墨：本轮结束后解析墨迹 / 检测墨稿，更新面板与会话状态
  if (!signal.aborted && !streamFailed && grindSession && grindSession.state !== "done"

      && state.currentConversationId === grindSession.conversation_id) {
    await handleGrindReply(fullContent, msgEl);
  }

  } catch (err) {
    console.error("发送失败", err);
    sendFailed = !isAbortError(err);
    if (!isAbortError(err)) reportError(err, "发送链路");
    const { toast } = await import("../app.js?v=20260922-002");
    toast(isAbortError(err) ? (state.harness?.enabled === true ? "已停止输出 · 目标模式保持开启" : "已停止输出") : t("发送失败: {msg}", { msg: err.message }));
  } finally {
  isGenerating = false;
  activeGenerationController = null;
  setSubAgentSignal(null);
  // 仅在归属未变时清空：若已切换到新会话并开始了新生成，这里不能抢清新生成的归属
  if (activeGenerationConvId === genConvId) activeGenerationConvId = null;
  // 徽标：循环没跑（对话模式 / 启动前就被停止 / 流失败 / 抛异常）才由这里落，
  // 跑过的话它已经带着"收口/停止/耗尽"的细粒度结论记过了，别用粗结论覆盖
  if (!loopOutcome) {
    noteTaskOutcome(genConvId, streamFailed || sendFailed ? "error" : signal.aborted ? "needs" : "done");
  }
  updateSendState();
  stopTaskTimer();
  chatInput.focus();
  // 未进入工具循环（abort 等）时也可能残留未执行的工具标记，统一清理
  cleanupStaleToolMarkers();
  _pendingToolMsgs.clear();
  if (inputQueue.length > 0) {
    const next = inputQueue.shift();
    updateSendState();
    setTimeout(() => sendMessage(next), 0);
  }
  }
}

// ── 上下文压缩──────────────────────────────

async function checkAndCompress(modelId, apiKey, baseUrl) {
  try {
    const msgs = state.messages.map(m => ({ role: m.role, content: m.content, ...(m.display !== undefined ? { display: m.display } : {}) }));
    // 阈值跟着「上下文预算」走：以前硬编码 64000，1M 窗口的模型也在 64K 就被压缩，
    // 而且和上下文条各算各的，条子显示 6% 却已经压过一轮
    const res = await post("/chat/compress", { messages: msgs, keep_recent_rounds: 2, max_tokens: contextBudgetOf(modelId) });
    if (res.code !== 0 || !res.data.need_compress) return;

    const { compress_prompt, keep_messages, compress_count } = res.data;

    // 调用 LLM 生成摘要
    let summary = "";
    try {
      for await (const chunk of streamChat({ model: modelId, provider: (findModelById(modelId) || state.currentModel)?.provider, messages: [{ role: "user", content: compress_prompt }], api_key: apiKey, base_url: baseUrl, temperature: 0.3, max_tokens: 1024, stream: true })) {
        summary += chunk;
      }
    } catch (e) {
      console.warn("压缩摘要生成失败:", e);
      return;
    }

    // 用摘要替换旧消息
    const summaryMsg = { role: "system", content: `[历史摘要]: ${summary}` };
    const newMessages = [summaryMsg, ...keep_messages.map(m => ({ ...m, model: "" }))];

    // 更新前端状态
    setMessages(newMessages);


    // 通知用户
    const { toast } = await import("../app.js?v=20260922-002");
    toast(t("上下文已压缩：{n} 条消息已摘要", { n: compress_count }));
  } catch (e) {
    console.warn("上下文压缩检查失败", e);
  }
}

function toggleBrainstormMode() {
  brainstormMode = !brainstormMode;
  state.brainstormMode = brainstormMode;
  syncModeMenu();
  updateSendState();
}

async function toggleHarness() {
  // 开关只经 store 的唯一写入口：exit_target_mode 走的是同一个 setter，
  // 两边各写 state.harness 就会出现"工具关了、菜单还亮着"
  const on = setHarnessEnabled(!(state.harness?.enabled === true));
  const { toast } = await import("../app.js?v=20260922-002");
  toast(on ? "目标模式已开启：目标→计划→执行→验证→汇报→追溯，六阶段自主闭环，大任务自动建议 TODOLIST" : "目标模式已关闭");
  showHarnessIdle();
  syncModeMenu();
}

// ── 磨墨模式 ─────────────────────────────────

/** 开启磨墨会话：新对话 + 首条消息注入接墨提示。idea 为空时仅备好输入框。 */
/**
 * 检测用户输入是否为抽象/宏观任务描述，适合先进入磨墨模式细化。
 * 匹配策略：动作词 + 宽泛名词组合，或极短模糊描述。
 */
function isAbstractTask(text) {
  if (!text || text.startsWith("/")) return false;
  const t = text.trim();
  // 过长输入（>60字）通常是具体指令，不再自动切换
  if (t.length > 60) return false;
  // 已包含明确技术细节的：路径、URL、代码块、@工具
  if (/[\/\\]{2}|https?:\/\/|```|@\w+/.test(t)) return false;

  const ACTION = "(?:制作|做|开发|创建|搭建|设计|写|实现|构建|编写|弄|搞|建|策划|规划|完成|部署|上线|打造|做一个|弄一个|搞一个|建一个|写一个|画一个)";
  const BROAD_NOUN = "(?:网站|应用|系统|平台|[Aa]pp|工具|项目|软件|页面|功能|模块|组件|服务|接口|[Aa][Pp][Ii]|后台|前端|小程序|游戏|数据库|模型|算法|框架|库|[Ss][Dd][Kk]|插件|扩展|脚本|机器人|[Bb]ot|爬虫|自动化|流程|方案|报告|文档|手册|教程|课程|计划|策略|营销|运营|产品|业务|需求|规范|标准|官网|博客|商城|论坛|社区|仪表盘|看板|面板)";

  // 模式 1：动作词 + 宽泛名词（如"制作一个网站"）
  const pattern1 = new RegExp(`^${ACTION}\\s*(?:一个|一套|一款|一份|个|套|款|份)?\\s*${BROAD_NOUN}`);
  if (pattern1.test(t)) return true;

  // 模式 2："帮我/我想/我要 + 动作 + 宽泛名词"
  const pattern2 = new RegExp(`^(?:帮我|我想|我要|我需要|我们来做|请帮我)\\s*${ACTION}\\s*(?:一个|一套|一款|份)?\\s*${BROAD_NOUN}`);
  if (pattern2.test(t)) return true;

  // 模式 3：极短模糊描述（≤12字，含动作词但无特殊符号）
  if (t.length <= 12 && new RegExp(ACTION).test(t) && !/[^\u4e00-\u9fff\w\s]/.test(t)) return true;

  return false;
}

async function startGrindConversation(idea) {
  // 开启磨墨新会话：中断进行中的生成，防止旧回复写入磨墨会话
  if (isGenerating) activeGenerationController?.abort();
  state.currentConversationId = null;
  setMessages([]);
  resetUsage();
  renderConvList(state.conversations);
  hideGrindPanel();
  if (!idea) {
    chatInput.value = "/grind ";
    chatInput.focus();
    updateSendState();
    return;
  }
  grindPendingIdea = idea;
  chatInput.value = idea;
  chatInput.style.height = "auto";
  updateSendState();
  await sendMessage();
}

/** 磨墨会话中每轮助手回复结束后的处理：墨迹面板 + 墨稿检测 */
async function handleGrindReply(content, msgEl) {
  const convId = grindSession.conversation_id;
  const ink = grindSvc.parseInkStatus(content);
  if (ink) {
    lastInkStatus = ink;
    if (ink.resolved.length) grindSession.resolved = ink.resolved;
  }

  const draft = grindSvc.detectDraft(content);
  if (draft) {
    grindSession = (await grindSvc.patchSession(convId, { draft })) || { ...grindSession, state: "done" };
    renderGrindPanel();
    updateSendState();
    appendDraftActions(msgEl, draft);
    const { toast } = await import("../app.js?v=20260922-002");
    toast("墨稿已成：可送入目标模式 / 投到白板 / 存为模板");
    return;
  }

  // 未完成：推进轮数（收墨阶段不追问，不计轮次
  const round = (grindSession.round || 0) + (grindSession.state === "collecting" ? 0 : 1);

  grindSession = (await grindSvc.patchSession(convId, { round, resolved: grindSession.resolved || [] })) || grindSession;
  renderGrindPanel();
}

/** 侧边栏墨迹面板：已定 / 未知项；成稿后保留汇总视图 */
function renderGrindPanel() {
  syncModeMenuGrind();
  if (!grindPanelEl) grindPanelEl = document.getElementById("grind-panel");
  if (!grindPanelEl) return;
  const st = grindSession?.state;
  const active = grindSession && ["grinding", "collecting", "done"].includes(st);
  grindPanelEl.classList.toggle("hidden", !active);

  if (!active) return;

  grindPanelEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "grind-panel-header";
  const round = Math.min(grindSession.round || 0, grindSvc.MAX_ROUNDS);
  header.textContent = st === "done"
    ? "墨迹 · 已成稿"
    : (st === "collecting"
      ? "墨迹 · 收墨中"
      : t("墨迹 · 第 {x}/{n} 轮", { x: round, n: grindSvc.MAX_ROUNDS }));
  grindPanelEl.appendChild(header);

  if (grindSession.idea) {
    const idea = document.createElement("div");
    idea.className = "grind-panel-idea";
    idea.textContent = grindSession.idea;
    idea.title = grindSession.idea;
    grindPanelEl.appendChild(idea);
  }

  const body = document.createElement("div");
  body.className = "grind-panel-body";
  const resolved = grindSession.resolved || [];
  const unknown = st === "done" ? [] : (lastInkStatus?.unknown || []);

  // 进度统计：已定 N 项 · 待定 M 项
  if (resolved.length || unknown.length) {

    const stats = document.createElement("div");
    stats.className = "grind-panel-stats";
    stats.textContent = t("已定 {n} 项", { n: resolved.length }) + (unknown.length ? t(" · 待定 {n} 项", { n: unknown.length }) : "");
    body.appendChild(stats);
  }

  // 成稿后展示墨稿标题，未知项已无意义
  if (st === "done" && grindSession.draft?.title) {

    const draftRow = document.createElement("div");
    draftRow.className = "grind-item draft";
    setIconText(draftRow, "scroll", grindSession.draft.title);
    body.appendChild(draftRow);
  }

  if (resolved.length === 0 && unknown.length === 0 && st !== "done") {
    const hint = document.createElement("div");
    hint.className = "grind-panel-hint";
    hint.textContent = "随对话推进，已定/未知项将实时更新";
    body.appendChild(hint);
  }
  for (const item of resolved) {
    const row = document.createElement("div");
    row.className = "grind-item resolved";
    row.textContent = `${item}`;
    body.appendChild(row);
  }
  for (const item of unknown) {
    const row = document.createElement("div");
    row.className = "grind-item unknown";
    row.textContent = `${item}`;
    body.appendChild(row);
  }
  grindPanelEl.appendChild(body);
}

function hideGrindPanel() {
  syncModeMenuGrind();
  grindPanelEl ??= document.getElementById("grind-panel");
  grindPanelEl?.classList.add("hidden");
}

/** 墨稿下方三个动作：送入目标 / 投到白板 / 存为模板 */
function appendDraftActions(msgEl, draft) {
  if (!msgEl || msgEl.querySelector(".grind-draft-actions")) return;
  const bar = document.createElement("div");
  bar.className = "grind-draft-actions";

  const mkBtn = (label, title, onClick) => {
    const btn = document.createElement("button");
    btn.className = "send-btn send-btn-sm";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", onClick);
    return btn;
  };

  bar.appendChild(mkBtn("送入目标模式", "把墨稿作为目标模式任务自主执行", async () => {
    state.harness = state.harness || { enabled: false, maxRounds: 50 };
    state.harness.enabled = true;
    syncModeMenu();
    savePersistent();
    const { toast } = await import("../app.js?v=20260922-002");
    toast("墨稿已送入目标模式，自主执行中…");
    await sendMessage({ text: grindSvc.draftToHarnessTask(draft), files: [] });
  }));

  bar.appendChild(mkBtn("投到白板", "作为白板卡片保存", async () => {
    addBoardCard(grindSvc.draftToBoardCard(draft));
    const { toast } = await import("../app.js?v=20260922-002");
    toast("已投到白板");
  }));

  bar.appendChild(mkBtn("存为模板", "存入知识库作为可复用任务书模板", async () => {
    const ok = await grindSvc.saveDraftAsTemplate(draft);
    const { toast } = await import("../app.js?v=20260922-002");
    toast(ok ? "已存为磨墨模板（知识中心可见）" : "保存失败");
  }));

  msgEl.appendChild(bar);
}

function openCompressModal() {
  if (!compressModal) return;
  if (state.messages.length < 4) {
    import("../app.js?v=20260922-002").then(({ toast }) => toast("当前对话还不需要压缩"));
    return;
  }
  compressModal.classList.remove("hidden");
}

function closeCompressModal() {
  compressModal?.classList.add("hidden");
}

async function doManualCompress() {
  if (!compressModal || !btnDoCompress) return;
  const level = document.querySelector('input[name="compress-level"]:checked')?.value || "light";
  btnDoCompress.disabled = true;
  const oldText = btnDoCompress.textContent;
  btnDoCompress.textContent = "压缩中…";

  try {
    const res = await post("/chat/compress-manual", {
      messages: state.messages.map(m => ({ role: m.role, content: m.content || "" })),
      level,
      keep_recent_rounds: 2,
    });

    const { toast } = await import("../app.js?v=20260922-002");
    if (res.code !== 0) {
      toast("压缩失败: " + (res.message || "未知错误"));
      return;
    }
    if (!res.data?.need_compress) {
      toast("当前对话还不需要压缩");
      closeCompressModal();
      return;
    }

    const modelId = state.currentModel?.id || "gpt-5.6-terra";
    const apiKey = getModelKey(modelId);
    const baseUrl = state.currentModel?.base_url || undefined;
    let summary = "";
    for await (const chunk of streamChat({
      model: modelId,
      provider: state.currentModel?.provider,
      messages: [{ role: "user", content: res.data.compress_prompt }],
      api_key: apiKey,
      base_url: baseUrl,
      temperature: 0.3,
      max_tokens: level === "heavy" ? 512 : 1024,
      stream: true,
    })) {
      summary += chunk;
    }

    const summaryMsg = { role: "system", content: `[历史摘要]: ${summary}` };
    const keepMessages = (res.data.keep_messages || []).map(normalizeMessageForRender);
    setMessages([summaryMsg, ...keepMessages]);
    closeCompressModal();
    toast(t("上下文已压缩：{n} 条消息已摘要", { n: res.data.compress_count || 0 }));
  } catch (e) {
    const { toast } = await import("../app.js?v=20260922-002");
    toast("压缩失败: " + e.message);
  } finally {
    btnDoCompress.disabled = false;
    btnDoCompress.textContent = oldText;
  }
}

// ── 对话侧边栏 ─────────────────────────────

// "未查看"说的是这块屏幕：跑完时用户正看着这个会话就不算未读，切回来即清。
function isConvInSight(convId) {
  return Boolean(convId) && state.currentConversationId === convId && !document.hidden;
}

// kind: done | needs | error（进行中由实时生成权判定，绝不落库，见 services/task_list.js）
function noteTaskOutcome(convId, kind) {
  if (convId && kind) recordTaskFlag(convId, { kind, seen: isConvInSight(convId) });
}

function taskCtx() {
  return { flags: state.taskFlags, activeConvId: activeGenerationConvId || "" };
}

// 徽标要同时重绘两处：classic 的 #conv-list 与 Codex 的历史分组。
// 后者不 import chat.js（避免成环），所以走一个只表示"该重绘了"的事件，数据仍各读各的缓存。
function refreshTaskBadges() {
  renderConvList(state.conversations || []);
  // 生成归属只有这里知道（切换会话即中断），Codex 侧靠这一份实时参数点亮"进行中"
  window.dispatchEvent(new CustomEvent("slate:task-badges-updated", { detail: { activeConvId: activeGenerationConvId || "" } }));
}

// 排序控件的选项在 JS 里造：写死在 HTML 里的中文选项切到英文界面时不会被翻译
function initConvSortPicker() {
  const sel = document.getElementById("conv-sort");
  if (!sel) return;
  sel.innerHTML = "";
  for (const mode of SORT_MODES) {
    const opt = document.createElement("option");
    opt.value = mode.key;
    opt.textContent = t(mode.label);
    sel.appendChild(opt);
  }
  sel.title = t("任务列表排序");
  sel.setAttribute("aria-label", t("任务列表排序"));
  sel.value = normalizeTaskListSort(state.taskListSort);
  // 只写偏好，重绘交给 subscribe("taskListSort")：两处列表才不会各写各的
  sel.addEventListener("change", () => setTaskListSort(sel.value));
  subscribe("taskListSort", (mode) => { sel.value = normalizeTaskListSort(mode); });
}

async function refreshConversationList() {
  const res = await get("/chat/conversations");
  if (res.code === 0) {
    setConversations(res.data);
    // 会话被删（含批量管理）后徽标残项跟着清；只在成功取到全量时剪，避免误删
    pruneTaskFlags((res.data || []).map(c => c?.id));
    renderConvList(res.data);
    window.dispatchEvent(new CustomEvent("slate:convs-updated", { detail: { conversations: res.data } }));
  }
}

// 供通用 UI（Codex）左侧历史分组列表点击切换会话
async function openConversation(convId) {
  await switchConversation(convId);
  window.dispatchEvent(new CustomEvent("slate:conv-active-changed", { detail: { id: convId } }));
}

function renderConvList(conversations) {
  if (!convList) return;
  convList.innerHTML = "";
  const ctx = taskCtx();
  for (const conv of sortConversations(conversations, state.taskListSort, ctx)) {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === state.currentConversationId ? " active" : "");

    // 状态徽标排在标题之前：扫列表时靠的是最左那一列，不是行尾的小字
    const badge = statusBadge(taskStatusOf(conv, ctx));
    if (badge) {
      item.classList.add("is-" + badge.status);
      const mark = document.createElement("span");
      mark.className = badge.className;
      mark.dataset.status = badge.status;
      mark.title = t(badge.label);
      mark.appendChild(iconSvgEl(badge.icon));
      item.appendChild(mark);
    }

    const titleWrap = document.createElement("div");
    titleWrap.className = "conv-item-title-wrap";

    const title = document.createElement("span");
    title.className = "conv-item-title";
    title.textContent = conv.title || conv.id;
    titleWrap.appendChild(title);

    // 发起时打开的项目
    const projTag = document.createElement("span");

    projTag.className = "conv-item-project" + (conv.project ? "" : " none");
    setIconText(projTag, "folder", conv.project || t("无项目"));
    titleWrap.appendChild(projTag);

    // 用量摘要
    const msgCount = conv.message_count || 0;
    const totalTokens = conv.total_tokens || 0;
    if (msgCount > 0 || totalTokens > 0) {
      const usageInfo = document.createElement("span");
      usageInfo.className = "conv-item-usage";
      usageInfo.textContent = t("{n}条 · ~{tok} tok", { n: msgCount, tok: totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + "K" : totalTokens });
      titleWrap.appendChild(usageInfo);
    }

    item.appendChild(titleWrap);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "conv-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "conv-item-del conv-item-rename";
    setIconOnly(renameBtn, "edit-2");
    renameBtn.title = "重命名";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const newTitle = await dlgPrompt("输入新的会话标题：", { title: "重命名会话", value: conv.title || "", okText: "保存" });
      if (!newTitle || !newTitle.trim()) return;
      const res = await patch(`/chat/conversations/${conv.id}`, { title: newTitle.trim() });
      if (res.code === 0) {
        dlgToast("已重命名");
        await refreshConversationList();
      } else {
        dlgToast(res.message || "重命名失败");
      }
    });
    actionsWrap.appendChild(renameBtn);

    const exportBtn = document.createElement("button");
    exportBtn.className = "conv-item-del conv-item-export";
    exportBtn.textContent = "MD";
    exportBtn.title = "导出 Markdown";
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      exportConversationMd(conv);
    });
    actionsWrap.appendChild(exportBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "conv-item-del";
    delBtn.textContent = "×";
    delBtn.title = "删除";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await del(`/chat/conversations/${conv.id}`);
      if (state.currentConversationId === conv.id) {
        state.currentConversationId = null;
        setMessages([]);
      }
      await refreshConversationList();
    });
    actionsWrap.appendChild(delBtn);
    item.appendChild(actionsWrap);

    item.addEventListener("click", () => switchConversation(conv.id));
    convList.appendChild(item);
  }
}

// 导出单个会话 Markdown 文件
async function exportConversationMd(conv) {
  const res = await get(`/chat/conversations/${conv.id}/messages`);
  if (res.code !== 0) { dlgToast("导出失败"); return; }
  const msgs = (res.data || []).filter(m => m.role === "user" || m.role === "assistant");
  if (msgs.length === 0) { dlgToast("该会话没有可导出的消息"); return; }
  const title = conv.title || conv.id;
  const lines = [
    `# ${title}`,
    "",
    `> 导出自 SLATE · ${new Date().toLocaleString()}`,
    "",
  ];
  for (const m of msgs) {
    const who = m.role === "user" ? "用户" : `助手${m.model ? " · " + m.model : ""}`;
    lines.push(`## ${who}`, "", String(m.content || "").trim(), "");
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `SLATE-${safeTitle}-${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  dlgToast("已导出 Markdown");
}

// ── 历史侧栏搜索：标题即时过滤 + 内容全文检索 ──────────
let convSearchTimer = null;

function initConvSearch() {
  const input = document.getElementById("conv-search");
  if (!input || !convList) return;
  const resultsBox = document.createElement("div");
  resultsBox.className = "conv-search-results hidden";
  convList.insertAdjacentElement("beforebegin", resultsBox);

  input.addEventListener("input", () => {
    clearTimeout(convSearchTimer);
    const q = input.value.trim();
    convSearchTimer = setTimeout(async () => {
      // 标题过滤（即时）
      const lower = q.toLowerCase();
      renderConvList(state.conversations.filter(c => !lower || (c.title || "").toLowerCase().includes(lower)));
      // 内容搜索（≥2 字符才请求后端）
      if (q.length >= 2) {
        try {
          const res = await get(`/chat/search?q=${encodeURIComponent(q)}&limit=12`);
          renderConvSearchResults(resultsBox, res.code === 0 ? res.data : [], q);
        } catch (e) { renderConvSearchResults(resultsBox, [], q); }
      } else {
        renderConvSearchResults(resultsBox, [], q);
      }
    }, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); }
  });
}

function renderConvSearchResults(box, hits, q) {
  if (!box) return;
  box.innerHTML = "";
  if (!hits.length) { box.classList.add("hidden"); return; }
  const header = document.createElement("div");
  header.className = "conv-search-hits-title";
  header.textContent = t("内容命中 · {n} 条", { n: hits.length });
  box.appendChild(header);
  for (const h of hits) {
    const item = document.createElement("div");
    item.className = "conv-search-hit";
    const t = document.createElement("div");
    t.className = "conv-search-hit-title";
    t.textContent = h.conversation_title;
    const s = document.createElement("div");
    s.className = "conv-search-hit-snippet";
    s.textContent = h.snippet;
    item.append(t, s);
    item.addEventListener("click", async () => {
      await switchConversation(h.conversation_id);
      dlgToast(t("已跳转到「{title}」", { title: h.conversation_title }));
    });
    box.appendChild(item);
  }
  box.classList.remove("hidden");
}

// ── 历史会话批量管理 ──────────────────
let convManageChecks = new Map(); // conv.id -> checkbox

function initConvManage() {
  const modal = document.getElementById("conv-manage-modal");
  if (!modal) return;
  const close = () => modal.classList.add("hidden");
  modal.querySelector(".modal-close")?.addEventListener("click", close);
  modal.querySelector(".modal-backdrop")?.addEventListener("click", close);

  document.getElementById("btn-conv-manage")?.addEventListener("click", () => openConvManage());

  document.getElementById("conv-manage-checkall")?.addEventListener("change", (e) => {
    for (const cb of convManageChecks.values()) cb.checked = e.target.checked;
    updateConvManageCount();
  });

  document.getElementById("btn-conv-delete-selected")?.addEventListener("click", async () => {
    const ids = [...convManageChecks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (ids.length === 0) { dlgToast("请先勾选要删除的会话"); return; }
    if (!await dlgConfirm(t("删除选中 {n} 个会话？删除后不可恢复。", { n: ids.length }), { danger: true, okText: "删除" })) return;
    await post("/chat/conversations/batch-delete", { ids });
    if (ids.includes(state.currentConversationId)) {
      state.currentConversationId = null;
      setMessages([]);
    }
    await refreshConversationList();
    renderConvManageList();
    dlgToast(t("已删除 {n} 个会话", { n: ids.length }));
  });

  document.getElementById("btn-conv-clear-all")?.addEventListener("click", async () => {
    if (!await dlgConfirm("清空全部历史会话？此操作不可恢复，建议先备份数据", { danger: true, okText: "清空" })) return;
    await post("/chat/conversations/batch-delete", { clear_all: true });
    state.currentConversationId = null;
    setMessages([]);
    await refreshConversationList();
    renderConvManageList();
    dlgToast("已清空全部会话");
  });
}

function openConvManage() {
  const modal = document.getElementById("conv-manage-modal");
  if (!modal) return;
  renderConvManageList();
  modal.classList.remove("hidden");
}

function renderConvManageList() {
  const list = document.getElementById("conv-manage-list");
  if (!list) return;
  convManageChecks = new Map();
  list.innerHTML = "";
  const checkall = document.getElementById("conv-manage-checkall");
  if (checkall) checkall.checked = false;

  const conversations = state.conversations || [];
  if (conversations.length === 0) {
    list.innerHTML = '<div class="setting-hint" style="padding:16px;text-align:center;">暂无历史会话</div>';
    updateConvManageCount();
    return;
  }
  for (const conv of conversations) {
    const row = document.createElement("label");
    row.className = "conv-manage-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", updateConvManageCount);
    convManageChecks.set(conv.id, cb);
    const info = document.createElement("div");
    info.className = "conv-manage-info";
    const title = document.createElement("div");
    title.className = "conv-manage-title";
    title.textContent = conv.title || conv.id;
    const meta = document.createElement("div");
    meta.className = "conv-manage-meta";
    const msgCount = conv.message_count || 0;
    const tokens = conv.total_tokens || 0;
    const dateStr = conv.updated_at ? new Date(conv.updated_at * 1000).toLocaleDateString() : "";
    meta.textContent = t("{n}条 · ~{tok} tok", { n: msgCount, tok: tokens >= 1000 ? (tokens / 1000).toFixed(1) + "K" : tokens }) + (dateStr ? " · " + dateStr : "") + (conv.project ? " · " + conv.project : "");
    info.append(title, meta);
    row.append(cb, info);
    list.appendChild(row);
  }
  updateConvManageCount();
}

function updateConvManageCount() {
  const countEl = document.getElementById("conv-manage-count");
  if (!countEl) return;
  const checked = [...convManageChecks.values()].filter(cb => cb.checked).length;
  countEl.textContent = t("{total} 个会话，已选 {n} 个", { total: convManageChecks.size, n: checked });
}

async function switchConversation(convId) {
  const seq = ++_switchConvSeq; // 递增序列号
  // 切换会话：中断正在进行的生成，防止旧回复写入目标会话（重复点击当前会话不中断）
  if (isGenerating && convId !== state.currentConversationId) activeGenerationController?.abort();
  // 离开当前对话前，捕获灵光（技术洞察归档到知识库）
  captureConversationSpark();
  // 保存当前对话用量
  if (state.currentConversationId) {
    setConversationUsage(state.currentConversationId, { ...state.usage });
  }
  state.currentConversationId = convId;
  hideResumeHint(); // 切会话：上一个会话的中断提示不属于这里
  grindSession = null;
  lastInkStatus = null;
  const res = await get(`/chat/conversations/${convId}/messages`);
  if (seq !== _switchConvSeq) return; // 用户已切换到其他会话，丢弃此响应
  if (res.code === 0) {
    setMessages((res.data || []).map(normalizeMessageForRender));
    // 真的看到内容了才清未读：这次切换被更晚的切换作废时（上面已 return），徽标要留着
    markTaskSeen(convId);
  }

  // 磨墨会话恢复（刷新页面 / 切换对话后重建状态与面板）
  grindSession = await grindSvc.getSession(convId);

  if (grindSession) {
    for (const m of state.messages) {
      if (m.role !== "assistant") continue;
      const ink = grindSvc.parseInkStatus(m.content || "");
      if (ink) lastInkStatus = ink;
    }
    renderGrindPanel();
    renderAllMessages(); // 重新渲染以应用墨痕样式与墨稿按钮
  } else {
    hideGrindPanel();
  }
  updateSendState();

  // 从后端对话列表获取用量数据
  const conv = state.conversations.find(c => c.id === convId);

  if (conv && (conv.total_tokens || conv.message_count)) {
    const backendUsage = {
      totalTokens: conv.total_tokens || 0,
      promptTokens: conv.prompt_tokens || 0,
      completionTokens: conv.completion_tokens || 0,
      messageCount: conv.message_count || 0,
    };
    setConversationUsage(convId, backendUsage);
    restoreUsageForConversation(convId);
  } else {
    restoreUsageForConversation(convId);
  }

  renderConvList(state.conversations);
  renderTodoPanel();
  updateConvProjectBadge();
}

// ── 用量显示 ────────────────────────────────

function contextDetailLines(ctx) {
  const lines = ctx.buckets
    .filter(b => b.tokens > 0)
    .map(b => `${t(b.label)} ${fmtTokens(b.tokens)}`);
  lines.push(`${t("合计")} ${fmtTokens(ctx.total)}${ctx.limit > 0 ? ` / ${fmtTokens(ctx.limit)} tokens` : ""}`);
  // 分母是上下文预算（滑杆定的），不一定等于模型标称窗口；两者不一致时必须写出来，
  // 否则用户看到的是"没满就压缩了"
  const declared = declaredContextWindow(state.currentModel?.id);
  if (ctx.limit > 0 && declared > 0 && declared !== ctx.limit) {
    lines.push(t("预算 {b} · 模型窗口 {w}", { b: fmtTokens(ctx.limit), w: fmtTokens(declared) }));
  }
  lines.push(t("点按调整该模型的上下文预算"));
  return lines;
}

function renderUsageBar() {
  if (!usageBar) return;
  const u = state.usage;
  const ctx = measureContext(state.messages);
  const ctxLimit = ctx.limit;
  const modelName = escapeHtmlLocal(state.currentModel?.name || "未选择模型");
  const hasKey = state.currentModel ? !!getModelKey(state.currentModel.id) : false;
  const baseUrl = escapeHtmlLocal(state.currentModel?.base_url || "");

  let ctxPercent = 0;
  if (ctxLimit > 0) {
    ctxPercent = Math.min(100, Math.round((ctx.total / ctxLimit) * 100));
  }

  const fmtTok = fmtTokens;

  usageBar.innerHTML = `
    <span class="usage-model" title="${baseUrl}">${modelName}${hasKey ? "" : " " + iconSvg("alert-triangle", "usage-warning-icon")}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("消息 {n}", { n: u.messageCount })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输入 {n}", { n: fmtTok(u.promptTokens) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输出 {n}", { n: fmtTok(u.completionTokens) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("总计 {n}", { n: fmtTok(u.totalTokens) })}</span>
    ${ctx.total > 0 ? `
      <span class="usage-sep">|</span>
      <span class="usage-ctx" role="button" tabindex="0" title="${escapeHtmlLocal(contextDetailLines(ctx).join("\n"))}">
        <span class="usage-stat">${t("上下文")}</span>
        <span class="usage-ctx-total">${fmtTok(ctx.total)}</span>
        ${ctxLimit > 0 ? `
          <span class="usage-ctx-track"><span class="usage-ctx-fill${ctxPercent >= 95 ? " usage-ctx-danger" : ""}" style="width:${ctxPercent}%"></span></span>
          <span class="usage-stat${ctxPercent > 80 ? " usage-warn" : ""}">${ctxPercent}%</span>` : ""}
      </span>` : ""}
  `;
}

// 用量条上的上下文段点一下就该到"这个模型的预算"：设置页里逐个滑杆找太费事
async function openContextSettings() {
  const { openSettings } = await import("../app.js?v=20260922-002");
  hideUsagePopup();
  openSettings({ focusCtxModelId: state.currentModel?.id || "" });
}

function onUsageBarKeyActivate(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (!e.target?.closest?.(".usage-ctx")) return;
  e.preventDefault();
  openContextSettings();
}

  // 用量条悬浮弹窗：token + 趣味等价换算（如“相当于一本《老人与海》”）
let usagePopup = null;

function showUsagePopup() {
  if (!usageBar) return;
  if (!usagePopup) {
    usagePopup = document.createElement("div");
    usagePopup.className = "usage-popup";
    document.body.appendChild(usagePopup);
  }
  const u = state.usage;
  const equiv = tokenEquivalence(u.totalTokens);
  const ctx = measureContext(state.messages);
  const ctxPercent = ctx.limit > 0 ? Math.min(100, Math.round((ctx.total / ctx.limit) * 100)) : 0;
  const bucketRows = ctx.buckets.filter(b => b.tokens > 0).map(b => {
    const share = ctx.total > 0 ? Math.round((b.tokens / ctx.total) * 100) : 0;
    return `
      <div class="usage-ctx-row">
        <span class="usage-ctx-label">${t(b.label)}</span>
        <span class="usage-ctx-bar"><span style="width:${Math.min(100, share)}%"></span></span>
        <span class="usage-ctx-num">${fmtTokens(b.tokens)}</span>
        <span class="usage-ctx-share">${share}%</span>
      </div>`;
  }).join("");
  usagePopup.innerHTML = `
    <div class="usage-popup-main">${fmtTokens(u.totalTokens)} tokens${equiv ? " · " + equiv : ""}</div>
    <div class="usage-popup-detail">
      <span>${t("输入 {n}", { n: fmtTokens(u.promptTokens) })}</span>
      <span>${t("输出 {n}", { n: fmtTokens(u.completionTokens) })}</span>
      <span>${t("消息 {n}", { n: u.messageCount })}</span>
      ${ctx.limit > 0 ? `<span>${t("上下文 {p}%", { p: ctxPercent })}</span>` : ""}
    </div>
    <div class="usage-ctx-block">
      <div class="usage-ctx-head">
        <span>${t("上下文构成")}</span>
        <span>${fmtTokens(ctx.total)}${ctx.limit > 0 ? ` / ${fmtTokens(ctx.limit)}` : ""}</span>
      </div>
      ${bucketRows}
      <div class="usage-ctx-note">${t("含系统提示词与工具结果，按约 3 字符 / token 估算")}</div>
    </div>
  `;
  const r = usageBar.getBoundingClientRect();
  usagePopup.style.left = Math.max(8, r.left) + "px";
  usagePopup.style.top = r.bottom + 6 + "px";
  usagePopup.classList.add("visible");
}

function hideUsagePopup() {
  usagePopup?.classList.remove("visible");
}

// ── 文件附件处理 ────────────────────────────

// 图片大图预览（点击遮罩关闭）
function showImageLightbox(src, name = "") {
  document.querySelector(".image-lightbox")?.remove();
  const box = document.createElement("div");
  box.className = "image-lightbox";
  const img = document.createElement("img");
  img.src = src;
  if (name) img.alt = name;
  const title = document.createElement("div");
  title.className = "image-lightbox-name";
  title.textContent = name;
  const close = document.createElement("button");
  close.className = "image-lightbox-close";
  close.textContent = "×";
  box.append(img, title, close);
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

function renderFilePreview() {
  if (!filePreviewArea) return;
  if (pendingFiles.length === 0) {
    filePreviewArea.classList.add("hidden");
    filePreviewArea.innerHTML = "";
    return;
  }
  filePreviewArea.classList.remove("hidden");
  filePreviewArea.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";

    const icon = document.createElement("span");
    icon.className = "file-chip-icon";
    icon.innerHTML = fileTypeIcon(f.name, { size: 13 });
    chip.appendChild(icon);

    // 图片附件：缩略图，点击可放大预览
    if (f.type === "image" && typeof f.content === "string") {
      const thumb = document.createElement("img");
      thumb.className = "file-chip-thumb";
      thumb.src = f.content;
      thumb.addEventListener("click", () => showImageLightbox(f.content, f.name));
      chip.appendChild(thumb);
    }

    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = f.name;
    chip.appendChild(name);

    const size = document.createElement("span");
    size.className = "file-chip-size";
    size.textContent = f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)}KB` : `${(f.size / 1048576).toFixed(1)}MB`;
    chip.appendChild(size);

    const remove = document.createElement("button");
    remove.className = "file-chip-remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingFiles.splice(i, 1);
      renderFilePreview();
    });
    chip.appendChild(remove);

    filePreviewArea.appendChild(chip);
  });
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 10 * 1024 * 1024) {
      const { toast } = await import("../app.js?v=20260922-002");
      toast(t("文件过大，已跳过: {name}", { name: file.name }));
      continue;
    }

    // Office / PDF：浏览器无法直接读取，交后端解析为文字
    const extName = file.name.split(".").pop().toLowerCase();

    if (["docx", "xlsx", "pdf"].includes(extName)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await upload("/files/upload", fd);
        if (res.code === 0 && res.data?.content) {
          pendingFiles.push({ name: file.name, size: file.size, content: res.data.content, type: "text" });
        } else {
          const { toast } = await import("../app.js?v=20260922-002");
          toast(res.message || t("解析失败: {name}", { name: file.name }));
        }
      } catch (e) {
        const { toast } = await import("../app.js?v=20260922-002");
        toast(t("解析失败: {name}（{msg}）", { name: file.name, msg: e.message }));
      }
      continue;
    }

    // 图片文件：读取为 base64 data URL
    if (file.type.startsWith("image/")) {
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      pendingFiles.push({ name: file.name, size: file.size, content: dataUrl, type: "image" });
      continue;
    }

    // 文本文件：直接读取内容
    try {

      const text = await file.text();
      const ext = file.name.split(".").pop().toLowerCase();
      const fileType = (ext === "csv" || ext === "tsv") ? "csv" : "text";
      pendingFiles.push({ name: file.name, size: file.size, content: text, type: fileType });
    } catch (e) {
      console.warn("读取文件失败:", file.name, e);
    }
  }
  renderFilePreview();
}

// ── 初始化 ──────────────────────────────────

// ── 重新生成 ────────────────────────────────

/**
 * 重新生成最后一条助手回复：以该消息之前的历史重新请求，
  * 原地替换内容与工具卡片；完成后照常进入工具调用循环。
  */
async function regenerateMessage(msg, msgEl) {
  if (isGenerating) {
    const { toast } = await import("../app.js?v=20260922-002");
    toast("正在生成中，请稍候");
    return;
  }
  let idx = state.messages.indexOf(msg);
  if (idx < 0 && msg.id) idx = state.messages.findIndex(m => m.id === msg.id);
  if (idx < 0) return;
  // 重发会重写后续内容：删除该消息之后的所有可见消息（含后端记录）
  const afterVisible = state.messages.slice(idx + 1).filter(m => !m.hidden && m.role !== "system");
  for (const m of afterVisible) {
    if (m.id) { try { await del(`/chat/messages/${m.id}`); } catch (e) {} }
  }
  if (afterVisible.length > 0) {
    setMessages([...state.messages.slice(0, idx + 1)]);
    // setMessages 触发全量重渲染，原 msgEl 已脱离 DOM，需重新获取
    msgEl = chatScroll.querySelector(`.msg[data-index="${idx}"]`);
  }
  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    const { toast } = await import("../app.js?v=20260922-002");
    toast("请先在设置中配置该模型的 API Key");
    return;
  }
  const params = getDefaultParams(modelId);

  const history = state.messages.slice(0, idx)
    .filter(m => !m.hidden && m.role !== "system")
    .map(mapAdapterMessage);
  if (!history.some(m => m.role === "user")) {
    const { toast } = await import("../app.js?v=20260922-002");
    toast("没有可重新生成的上下文");
    return;
  }
  history._modelId = modelId;

  const regenConvId = state.currentConversationId;
  isGenerating = true;
  hideResumeHint(); // 新的一轮生成开始：上一次的中断提示条使命结束
  markActivity(); // 看门狗计时基准：从本次生成开始算
  activeGenerationController = new AbortController();
  const signal = activeGenerationController.signal;
  setSubAgentSignal(signal);
  activeGenerationConvId = regenConvId;
  updateSendState();
  refreshTaskBadges();  // 「进行中」跟着生成权走：只有实时这一层知道
  startTaskTimer();

  // 重置消息与卡片：直接操作现有 DOM，避免全量重渲染导致 msgEl 失效
  msg.content = "";
  msg.toolResults = [];
  msg.toolCalls = [];
  msg.model = state.currentModel?.name || msg.model;
  const label = msgEl.querySelector(".msg-model-label");
  if (label) label.textContent = msg.model;
  msgEl.querySelector(".tool-call-group")?.remove();
  _inkstreams.get(msgEl)?.destroy();
  msgEl.querySelector(".inkstream")?.remove();
  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) contentEl.innerHTML = "";

  stickToBottom = true;
  const cursor = addStreamingCursor(msgEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  let fullContent = "";
  let reasoningText = "";
  let thinkingPanel = null;
  const regenMeta = {};
  const regenNativeCalls = [];
  // 循环跑没跑成，finally 里要据此决定"徽标由循环落还是由这里落"（声明须在 try 外）
  let regenLoop = null;
  let streamFailed = false;
  const inkR = attachInkstream(msgEl);
  try {
    await streamWithNativeFallback({ history, model: modelId, provider: (findModelById(modelId) || state.currentModel)?.provider, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, signal, meta: regenMeta, onToolCall: (calls) => { regenNativeCalls.length = 0; regenNativeCalls.push(...calls); inkR.onCalls(calls); } }, (chunk) => {
      appendStreamChunk(chunk, {
        reasoning(text) {
          reasoningText += text;
          markActivity();
          if (!thinkingPanel) thinkingPanel = createThinkingPanel(msgEl);
          updateThinkingPanel(thinkingPanel, reasoningText);
          autoScroll();
        },
        content(text) {
          fullContent += text;
          markActivity();
          renderAssistantContent(contentEl, fullContent, cursor);
          inkR.onTextContent(fullContent);
          autoScroll();
        },
      });
    });
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
  } catch (err) {
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
    streamFailed = !isAbortError(err);
    if (streamFailed) reportError(err, "重新生成");
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : t("请求失败: {msg}", { msg: err.message });
  }
  removeStreamingCursor(cursor);

  try {
    const contOutR = {};
    if (!signal.aborted && (hasTruncatedTail(fullContent) || regenMeta.finishReason === "length")) {
      fullContent = await continueTruncatedOutput(msgEl, fullContent, modelId, apiKey, baseUrl, params, signal, regenMeta.finishReason || "", contOutR);
    }
    if (contOutR.toolCalls || regenNativeCalls.length) msg.toolCalls = contOutR.toolCalls || regenNativeCalls;
    msg.content = fullContent;
    renderAssistantContent(contentEl, fullContent);

    addUsage({ prompt_tokens: measureContext(state.messages.slice(0, idx)).total, completion_tokens: Math.ceil(fullContent.length / 3) });
    syncUsageToBackend();

    if (msg.id) {
      try {
        await patch(`/chat/messages/${msg.id}`, { content: fullContent, metadata: { toolResults: [], ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}) } });
      } catch (e) {
        console.warn("重新生成保存失败:", e);
      }
    }

    // 重新生成同样是"这一场"：徽标要跟着新结局走，而不是留着上一场的旧结论
    regenLoop = !signal.aborted && !streamFailed
      ? await runToolLoop(msgEl, modelId, apiKey, baseUrl, params, signal)
      : null;
  } finally {
    isGenerating = false;
    activeGenerationController = null;
    setSubAgentSignal(null);
    if (activeGenerationConvId === regenConvId) activeGenerationConvId = null;
    if (!regenLoop) {
      noteTaskOutcome(regenConvId, streamFailed ? "error" : signal.aborted ? "needs" : "done");
    }
    updateSendState();
    stopTaskTimer();
  }
}

function initChat() {
  chatScroll = document.getElementById("chat-messages");
  // 黑板工作流视图的控制按钮指向这里的运行现场（视图不 import chat.js，避免成环）
  registerBoardWorkflow();
  chatInput = document.getElementById("chat-input");
  btnSend = document.getElementById("btn-send");
  btnNewChat = document.getElementById("btn-new-chat");
  convList = document.getElementById("conv-list");
  initConvSortPicker();
  // 徽标与排序都是"别处也会改"的状态：工具收口、手机侧继续跑、另一处换了排序，都要在这里回显
  subscribe("taskFlags", refreshTaskBadges);
  subscribe("taskListSort", refreshTaskBadges);
  usageBar = document.getElementById("usage-bar");
  usageBar?.addEventListener("mouseenter", showUsagePopup);
  usageBar?.addEventListener("mouseleave", hideUsagePopup);
  // 上下文段是动态重绘出来的，监听挂在用量条上做事件委托
  usageBar?.addEventListener("click", (e) => {
    if (!e.target?.closest?.(".usage-ctx")) return;
    openContextSettings();
  });
  usageBar?.addEventListener("keydown", onUsageBarKeyActivate);
  initConvSearch();
  initConvManage();
  setupMentionHighlight();
  filePreviewArea = document.getElementById("file-preview-area");
  btnAttachFile = document.getElementById("btn-attach-file");
  fileInput = document.getElementById("file-input");
  btnCompress = document.getElementById("btn-compress");
  btnMemory = document.getElementById("btn-memory");
  btnSnippets = document.getElementById("btn-snippets");
  btnDoCompress = document.getElementById("btn-do-compress");
  compressModal = document.getElementById("compress-modal");
  queueStatus = document.createElement("div");
  queueStatus.className = "queue-status hidden";
  queueStatus.innerHTML = '<span class="queue-status-text"></span><button type="button" class="queue-clear-btn">清空队列</button>';
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", queueStatus);
  queueStatus.querySelector(".queue-clear-btn")?.addEventListener("click", clearInputQueue);

  // UI 看门狗：生成期间长时间无活动（流挂死/工具挂起）→ 强制中断恢复界面
  setInterval(async () => {
    if (!isGenerating || !lastActivityAt) return;
    if (Date.now() - lastActivityAt <= 180000) return;
    markActivity(); // 防止重复触发
    try { activeGenerationController?.abort(); } catch {}
    try {
      const { toast } = await import("../app.js?v=20260922-002");
      toast("连接长时间无响应，已自动中断，可重试");
    } catch {}
  }, 15000);

  // 智能滚动跟随：用户向上滚动浏览历史时不强制拉回底部
  chatScroll.addEventListener("scroll", () => {

    stickToBottom = isNearBottom();
  });

  btnSend.addEventListener("click", () => {
    if (isGenerating) stopGeneration();
    else sendMessage();
  });

  grindPanelEl = document.getElementById("grind-panel");

  // 「＋」模式与功能菜单：磨墨 / 头脑风暴 / 目标模式 / 定时任务 / 提及
  document.getElementById("btn-mode-menu")?.addEventListener("click", openModeMenu);
  const modeModal = document.getElementById("mode-menu-modal");
  modeModal?.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeModeMenu);
  });
  document.getElementById("row-bs")?.addEventListener("click", toggleBrainstormMode);
  document.getElementById("row-harness")?.addEventListener("click", toggleHarness);
  document.getElementById("row-grind")?.addEventListener("click", () => {
    closeModeMenu();
    startGrindConversation("");
  });
  document.getElementById("row-schedule")?.addEventListener("click", async () => {
    closeModeMenu();
    try {
      const mod = await import("./schedule.js?v=20260922-002");
      mod.openScheduleModal?.();
    } catch (e) {
      console.warn("定时任务模块加载失败", e);
    }
  });
  const mentionRowKinds = { "row-mention-skill": "skill", "row-mention-tool": "tool", "row-mention-mcp": "mcp", "row-mention-file": "file" };
  for (const [rowId, kind] of Object.entries(mentionRowKinds)) {
    document.getElementById(rowId)?.addEventListener("click", () => {
      closeModeMenu();
      openMentionPicker(kind);
    });
  }
  harnessStatusEl = document.createElement("div");
  harnessStatusEl.className = "harness-status hidden";
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", harnessStatusEl);
  // 中断续跑条：紧挨状态条下方，只在 Autopilot 未确认完成退出时出现
  resumeHintEl = document.createElement("div");
  resumeHintEl.className = "resume-hint hidden";
  const resumeIcon = document.createElement("span");
  resumeIcon.className = "resume-hint-icon";
  resumeIcon.setAttribute("aria-hidden", "true");
  setIconText(resumeIcon, "zap", "");
  const resumeReason = document.createElement("span");
  resumeReason.className = "resume-hint-reason";
  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.className = "resume-hint-btn";
  resumeBtn.textContent = t("继续跑完");
  resumeBtn.addEventListener("click", () => {
    hideResumeHint();
    sendMessage({ text: "继续", files: [] });
  });
  resumeHintEl.append(resumeIcon, resumeReason, resumeBtn);
  harnessStatusEl?.insertAdjacentElement("afterend", resumeHintEl);
  showHarnessIdle();
  // 回复方式（对话/智能体）与推理强度：依赖 harnessStatusEl，必须在其之后装配
  initInputModeSelectors();
  todoPanelEl = document.getElementById("todo-panel");
  // 顶栏这颗是右栏唯一的常驻开关：折叠后整栏不占位，栏里就没有任何可点的东西了
  document.getElementById("btn-todo-panel")?.addEventListener("click", () => {
    setTodoPanelOpen(state.todoPanelOpen === false);
  });
  subscribe("todoPanelOpen", () => renderTodoPanel());
  convProjectEl = document.createElement("div");
  convProjectEl.className = "conv-project-badge";
  btnCompress?.addEventListener("click", openCompressModal);
  btnMemory?.addEventListener("click", openMemoryModal);
  btnSnippets?.addEventListener("click", openSnippetModal);
  btnDoCompress?.addEventListener("click", doManualCompress);
  compressModal?.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeCompressModal);
  });

  // 文件附件
  btnAttachFile.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    // 先快照为普通数组：handleFiles 内部有 await，清空 value 会令 live FileList 失效
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = "";
    if (files.length) handleFiles(files);
  });

  // 专家包选择：注入专属 persona + rules 到系统提示
  const expertSelect = document.getElementById("expert-select");

  expertSelect?.addEventListener("change", async () => {
    const id = expertSelect.value;
    if (!id) {
      setActiveExpertId("");
      const { toast } = await import("../app.js?v=20260922-002");
      toast("已退出专家模式");
      return;
    }
    try {
      const { getExpert } = await import("../services/experts.js?v=20260922-002");
      const detail = await getExpert(id, { force: true });
      setActiveExpertId(id, detail);
      const { toast } = await import("../app.js?v=20260922-002");
      toast(t("已启用专家包：{name}", { name: detail.name || id }));
    } catch (e) {
      const { toast } = await import("../app.js?v=20260922-002");
      toast(t("专家包加载失败: {msg}", { msg: e.message }));
      expertSelect.value = state.activeExpertId || "";
    }
  });

  // 拖放文件
  chatScroll.addEventListener("dragover", (e) => { e.preventDefault(); chatScroll.classList.add("drag-over"); });
  chatScroll.addEventListener("dragleave", () => { chatScroll.classList.remove("drag-over"); });
  chatScroll.addEventListener("drop", (e) => {
    e.preventDefault();
    chatScroll.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // 粘贴图片
  chatInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) handleFiles(files);
  });

  chatInput.addEventListener("keydown", (e) => {
    // @ 提及弹窗优先接管方向键 / Enter / Tab / Esc
    if (mentionPopup) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionCandidates.length; renderMentionPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionCandidates.length) % mentionCandidates.length; renderMentionPopup(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionCandidates[mentionIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); hideMentionPopup(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
    try { localStorage.setItem(CHAT_DRAFT_KEY, chatInput.value); } catch (e) {}
    syncMentionHighlight();
    updateMentionPopup();
  });

  chatInput.addEventListener("blur", () => {
    // 延迟隐藏，保证弹窗 mousedown 先触发
    if (mentionBlurTimer) clearTimeout(mentionBlurTimer);
    mentionBlurTimer = setTimeout(hideMentionPopup, 150);
  });

  try {
    const draft = localStorage.getItem(CHAT_DRAFT_KEY);
    if (draft && !chatInput.value) {
      chatInput.value = draft;
      chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
      syncMentionHighlight();
    }
  } catch (e) {}

  btnNewChat.addEventListener("click", () => {
    if (isGenerating) activeGenerationController?.abort();
    hideResumeHint(); // 新会话不该背着上一个会话的"未确认完成"
    state.currentConversationId = null;
    setMessages([]);
    resetUsage();
    grindSession = null;
    grindPendingIdea = null;
    lastInkStatus = null;
    hideGrindPanel();
    renderConvList(state.conversations);
    renderTodoPanel();
    updateConvProjectBadge();
    updateSendState();
  });

  subscribe("messages", () => {
    renderAllMessages();
    renderUsageBar();
  });
  subscribe("conversations", (convs) => renderConvList(convs));
  subscribe("usage", renderUsageBar);
  subscribe("model", renderUsageBar);
  // 滑杆改的是当前模型的预算：条子要立刻按新分母重算，否则读数滞后一轮
  subscribe("modelContextCaps", () => renderUsageBar());
  subscribe("todos", renderTodoPanel);
  // 开关项目时，未保存的新对话徽章实时跟随
  subscribe("project", updateConvProjectBadge);

  refreshConversationList();
  renderUsageBar();
  renderTodoPanel();
  updateConvProjectBadge();
  updateSendState();

  // ── 语音输入（Web Speech API）──────────────
  initVoiceInput();
}

// ── 语音输入 ──────────────────────────────────

let _voiceRecognition = null;
let _voiceListening = false;
let _switchConvSeq = 0; // switchConversation 序列计数器，防止快速连点竞态

function initVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // 浏览器不支持
  const btn = document.getElementById("btn-voice");
  if (!btn) return;
  btn.style.display = "";
  btn.addEventListener("click", () => {
    if (_voiceListening) { stopVoice(); return; }
    startVoice(btn);
  });
}

function startVoice(btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !chatInput) return;
  _voiceRecognition = new SR();
  _voiceRecognition.lang = (state.settings?.language === "en" ? "en-US" : "zh-CN");
  _voiceRecognition.interimResults = true;
  _voiceRecognition.continuous = true;
  _voiceRecognition.maxAlternatives = 1;

  const origPlaceholder = chatInput.placeholder;
  let voiceBase = chatInput.value;
  let voiceFinalText = "";
  btn.classList.add("voice-active");
  btn.title = t("正在聆听…点击停止");
  chatInput.placeholder = t("正在聆听…");
  _voiceListening = true;

  _voiceRecognition.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += transcript;
      else interim += transcript;
    }
    if (final) {
      // 听写期间手动改过输入框则以其为新的基准，避免覆盖手动输入
      const expected = voiceBase + (voiceFinalText ? " " + voiceFinalText : "");
      if (chatInput.value !== expected) voiceBase = chatInput.value;
      voiceFinalText += final;
      const sep = voiceBase && !voiceBase.endsWith("\n") && !voiceBase.endsWith(" ") ? " " : "";
      chatInput.value = (voiceBase + sep + voiceFinalText).trimStart();
      chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
    }
    if (interim) {
      chatInput.placeholder = t("正在聆听… ") + interim;
    }
  };
  _voiceRecognition.onerror = (e) => {
    if (e.error !== "aborted" && e.error !== "no-speech") {
      try { import("../app.js?v=20260922-002").then(m => m.toast(t("语音识别错误: {err}", { err: e.error }))); } catch {}
    }
    stopVoice();
  };
  _voiceRecognition.onend = () => {
    stopVoice();
  };
  try { _voiceRecognition.start(); } catch (e) { stopVoice(); }
}

function stopVoice() {
  _voiceListening = false;
  const btn = document.getElementById("btn-voice");
  if (btn) { btn.classList.remove("voice-active"); btn.title = t("语音输入"); }
  if (chatInput) chatInput.placeholder = t("输入消息…(Enter 发送, Shift+Enter 换行)");
  try { _voiceRecognition?.stop(); } catch {}
  _voiceRecognition = null;
}

export { initChat, sendMessage, renderMarkdown, refreshConversationList, openConversation };
