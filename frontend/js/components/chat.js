/**
 * SLATE 聊天组件 v4：文件上传、上下文压缩、用量显示、流式输入 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations, getModelKey, addUsage, estimateContextTokens, resetUsage, restoreUsageForConversation, setConversationUsage, setKnowledgeContext, savePersistent, getConversationTodos, setConversationTodos, setActiveExpertId, addBoardCard } from "../store.js?v=20260826-110";
import { get, post, del, patch, streamChat, upload, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20260826-110";
import { buildMessages, getDefaultParams, getOutputMaxTokens } from "../services/adapter.js?v=20260826-110";
import { detectToolCalls, stripToolCalls, executeToolCalls, hasTruncatedTail, getToolsSystemPrompt } from "../services/tools.js?v=20260826-110";
import { renderMarkdown } from "../services/markdown.js?v=20260826-110";
import { openMemoryModal, openSnippetModal, autoRefineMemoryAndProfile, captureConversationSpark } from "./memory.js?v=20260826-110";
import { getExpertsCached } from "./experts.js?v=20260826-110";
import { addToolStepCard, updateToolStepCard } from "./whiteboard.js?v=20260826-110";
import { loadExperts, getExpert, readExpertFile } from "../services/experts.js?v=20260826-110";
import { fmtTokens, tokenEquivalence } from "../services/usage.js?v=20260826-110";
import { fileTypeIcon } from "../services/file_icons.js?v=20260826-110";
import { dlgConfirm, dlgPrompt, dlgToast } from "../services/dialog.js?v=20260826-110";
import * as grindSvc from "../services/grind.js?v=20260826-110";
import { t } from "../services/i18n.js?v=20260826-110";
import { notifyTaskComplete } from "../services/notify.js?v=20260826-110";

let chatScroll, chatInput, btnSend, btnNewChat, convList, usageBar, convSidebar;
let filePreviewArea, btnAttachFile, fileInput;
let btnBrainstorm, btnCompress, btnMemory, btnSnippets, btnDoCompress, compressModal, queueStatus;
let pendingFiles = []; // { name, size, content, type }
let brainstormMode = false;
let isGenerating = false;
let activeGenerationController = null;
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

function isNearBottom(threshold = 90) {
  if (!chatScroll) return true;
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < threshold;
}

function autoScroll(force = false) {
  if (!chatScroll) return;
  if (force || stickToBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ── Harness 自主执行（六阶段闭环：目标→计划→执行→验证→汇报→追溯） ──
// 开启后：发送时注入六阶段指令，大任务强制建议TODOLIST，工具循环轮数上限提升到 maxRounds
let harnessStatusEl = null;
let btnHarness = null;
const AGENT_AUTOPILOT_DEFAULT_ROUNDS = 18;
const AGENT_AUTOPILOT_BROAD_ROUNDS = 28;

const HARNESS_PREFIX = `[Harness 自主执行模式 · Agent Loop]
请自主完成以下任务，不要向我反复确认，按 Observe → Plan → Act → Verify → Report 推进：
1. 目标：先明确本次目标与可验证完成标准。
2. 计划：多文件、多步骤、排查或实现类任务必须先调用 todo_manage(action=init) 建立 TODOLIST；简单单步任务可跳过。
3. 观察：先读取项目事实，不凭记忆猜测；无依赖读取/扫描可以一轮批量调用。
4. 执行：按清单推进，能合并的一批一起完成；每完成一项或一批立即 todo_manage(action=update)。
5. 验证：修改或生成后必须读取、运行命令、检查输出或执行测试；失败则继续修复。
6. 汇报：全部 done 或 blocked 后再收尾，逐条核对结果、验证方式和剩余风险。
注意：系统会在每轮工具结果开头标注 [Harness · x/N 轮]。接近轮数上限时优先完成验证和收尾，不要空转。

任务：`;

function setHarnessProgress(text) {
  if (!harnessStatusEl) return;
  if (!text) {
    harnessStatusEl.classList.add("hidden");
    harnessStatusEl.textContent = "";
    return;
  }
  harnessStatusEl.textContent = "⚡ " + text;
  harnessStatusEl.classList.remove("hidden");
}

// Harness 待机指示：停止轮次结束后保持「仍开启」提示，仅在手动关闭时清空
function showHarnessIdle(note = "") {
  if (state.harness?.enabled !== true) {
    setHarnessProgress(null);
    return;
  }
  setHarnessProgress(note || "Harness 已开启 · 待命自主执行（点右上 ⚡ 手动退出）");
}

// ── TODOLIST 实时面板（消息区右侧栏，按对话隔离） ─────────────
let todoPanelEl = null;
let todoPanelCollapsed = false;

function renderTodoPanel() {
  if (!todoPanelEl) return;
  const items = getConversationTodos(state.currentConversationId);
  if (!items.length) {
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
  header.title = todoPanelCollapsed ? "展开任务清单" : "折叠任务清单";
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
  toggle.textContent = todoPanelCollapsed ? "▸" : "▾";
  header.append(title, bar, toggle);
  header.addEventListener("click", () => {
    todoPanelCollapsed = !todoPanelCollapsed;
    renderTodoPanel();
  });
  todoPanelEl.appendChild(header);
  if (todoPanelCollapsed) return;

  const body = document.createElement("div");
  body.className = "todo-panel-body";
  const icons = { done: "✓", in_progress: "…", blocked: "!", pending: "·" };
  for (const t of items) {
    const status = ["done", "in_progress", "blocked"].includes(t.status) ? t.status : "pending";
    const row = document.createElement("div");
    row.className = "todo-item todo-" + status;
    const icon = document.createElement("span");
    icon.className = "todo-icon";
    icon.textContent = icons[status];
    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = t.content;
    row.append(icon, text);
    body.appendChild(row);
  }
  todoPanelEl.appendChild(body);
}

// ── @ 提及 MCP / Skill / 专家包────────────────
let mentionPopup = null;
let mentionCandidates = [];
let mentionIndex = 0;

function getMentionCandidates(query) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const experts = getExpertsCached() || [];
  const list = [
    ...Object.entries(mcp).map(([name, desc]) => ({ name, desc, type: "工具" })),
    ...Object.entries(skills).map(([name, desc]) => ({ name, desc, type: "Skill" })),
    ...experts.map(x => ({
      name: x.name || x.id,
      desc: x.description || t("专家包 · 知识 {k} · 技能 {s}", { k: x.knowledge_count || 0, s: x.skills_count || 0 }),
      type: "Expert",
      id: x.id,
    })),
  ];
  const q = query.toLowerCase();
  if (!q) return list;
  return list.filter(c => c.name.toLowerCase().includes(q) || String(c.desc).toLowerCase().includes(q));
}

// 获取光标前正在输入的 @token；返回 { start, query } 或 null
function detectMentionToken() {
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const before = chatInput.value.slice(0, pos);
  const m = /(^|[\s])@([\w\u4e00-\u9fff.-]*)$/.exec(before);
  if (!m) return null;
  return { start: pos - m[2].length - 1, query: m[2] };
}

function hideMentionPopup() {
  if (mentionPopup) { mentionPopup.remove(); mentionPopup = null; }
  mentionCandidates = [];
  mentionIndex = 0;
}

function renderMentionPopup() {
  const area = document.getElementById("chat-input-area");
  if (!area) return;
  if (!mentionCandidates.length) { hideMentionPopup(); return; }
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
    const kindClass = c.type === "工具" ? "skill-kind-mcp" : c.type === "Skill" ? "skill-kind-skill" : "skill-kind-expert";
    badge.className = "skill-kind-badge " + kindClass;
    badge.textContent = c.type;
    const name = document.createElement("span");
    name.className = "mention-name";
    name.textContent = c.name;
    const desc = document.createElement("span");
    desc.className = "mention-desc";
    desc.textContent = c.desc;
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
}

function updateMentionPopup() {
  const token = detectMentionToken();
  if (!token) { hideMentionPopup(); return; }
  mentionCandidates = getMentionCandidates(token.query).slice(0, 10);
  mentionIndex = 0;
  renderMentionPopup();
}

function applyMention(candidate) {
  const token = detectMentionToken();
  if (!token) { hideMentionPopup(); return; }
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const insert = `@${candidate.name} `;
  chatInput.value = chatInput.value.slice(0, token.start) + insert + chatInput.value.slice(pos);
  const caret = token.start + insert.length;
  chatInput.setSelectionRange(caret, caret);
  chatInput.focus();
  hideMentionPopup();
  try { localStorage.setItem(CHAT_DRAFT_KEY, chatInput.value); } catch (e) {}
}

// 发送时解析消息中的 @提及：工具注入调用提示，Skill 注入 SKILL.md 定义内容，专家包注入人格/规则/知识
async function resolveMentions(text) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const tokens = [...new Set((text.match(/@[\w\u4e00-\u9fff.-]+/g) || []))];
  let context = "";
  for (const token of tokens) {
    const name = token.slice(1);
    if (mcp[name]) {
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
      const injected = await resolveExpertMention(name);
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
  const ctxTokens = estimateContextTokens(state.messages);
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
    role: ["system", "user", "assistant"].includes(msg?.role) ? msg.role : "assistant",
    content: stripReasoningFromContent(typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "")),
  };
  if (typeof normalized.display === "string") {
    normalized.display = stripReasoningFromContent(normalized.display);
  }

  if (normalized.role === "assistant") {
    const calls = detectToolCalls(normalized.content);
    if (calls.length > 0) {
      normalized.content = stripToolCalls(normalized.content);
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
  convProjectEl.textContent = name ? `📁 ${name}` : "📁 无项目";
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

function renderMessage(msg, index) {
  msg = normalizeMessageForRender(msg);
  const div = document.createElement("div");
  div.className = `msg msg-${msg.role}`;
  div.dataset.index = index;

  // 磨墨会话中的消息加墨痕样式
  if (grindSession && state.currentConversationId === grindSession.conversation_id) {

    div.classList.add("msg-grind");
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
    copyBtn.textContent = "⧉";
    copyBtn.title = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(msg.display ?? msg.content);
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);

    // 重新生成按钮（仅助手消息）
    if (msg.role === "assistant") {

      const regenBtn = document.createElement("button");
      regenBtn.className = "msg-action-btn";
      regenBtn.textContent = "↻";
      regenBtn.title = "重新生成";
      regenBtn.addEventListener("click", () => regenerateMessage(msg, div));
      actions.appendChild(regenBtn);
    }

    // 编辑/删除（仅已持久化到后端的消息）
    if (msg.id) {

      const editBtn = document.createElement("button");
      editBtn.className = "msg-action-btn";
      editBtn.textContent = "✎";
      editBtn.title = "编辑内容";
      editBtn.addEventListener("click", () => startInlineEdit(div, content, msg));
      actions.appendChild(editBtn);

      const delMsgBtn = document.createElement("button");
      delMsgBtn.className = "msg-action-btn msg-action-danger";
      delMsgBtn.textContent = "🗑";
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

function renderAllMessages() {
  chatScroll.innerHTML = "";
  // 无可见消息时展示欢迎页（替代 :empty 占位提示）
  const hasVisible = state.messages.some(m => !isHiddenContextMessage(m));

  if (!hasVisible) {
    chatScroll.appendChild(buildWelcomeEl());
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
        btn.textContent = "✅ 已复制";
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
  const displayContent = detectToolCalls(cleanContent).length > 0 ? stripToolCalls(cleanContent) : cleanContent;
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
      <span class="thinking-icon">💭</span>
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

function formatToolResultForModel(call, result) {
  const ok = result?.success !== false;
  const nextHint = ok
    ? "Next: use this result to continue the task. Do not repeat the same tool call unless new parameters are needed."
    : "Next: fix the parameters or choose a different tool. Do not repeat the identical failing call.";
  const structured = result?._structured;
  if (structured && ["file_edit", "file_create", "file_append"].includes(structured._type)) {
    const path = structured.file_path_rel || structured.file_name || structured.file || call?.params?.file_path || "";
    const errors = structured.errors?.length ? `\nWarnings: ${structured.errors.join("; ")}` : "";
    const truncNote = structured._type === "file_append" && structured.truncated
      ? "\nNote: this append was itself truncated; continue with another file_append from the new breakpoint."
      : "";
    const status = structured.applied === "auto"
      ? "Status: written to disk (auto-confirmed by user setting; no manual acceptance needed; verify via project_read_file if necessary)."
      : "Status: preview only; not written to disk until the user accepts.";
    return `[工具 ${structured._type} 结果]: ${result.output}\nTarget path: ${path}\n${status}${errors}${truncNote}\n${nextHint}`;
  }
  return `[工具 ${call.name} ${ok ? "成功" : "失败"}]: ${result.output}\n${nextHint}`;
}

function looksLikeInspectionStall(content) {
  if (!content || detectToolCalls(content).length > 0) return false;
  const text = content.replace(/```[\s\S]*?```/g, " ");
  const offerOrQuestion = /(需要我|要我|是否需要|要不要|你需要|如果你需要|我可以(?:直接)?(?:动手|继续|帮你|给出)|是否要|吗[？?]?|呢[？?]?)/;
  if (offerOrQuestion.test(text)) return false;
  const intent = /(?:先|再|来|会|需要|可以)?(?:查看|看看|看一下|看一眼|浏览|读取|检查|了解|确认|分析)|让我(?:查看|看看|看一下|浏览|读取|检查|了解)|需要(?:查看|看看|看一下|浏览|读取|检查|了解|确认)|(?:先(?:查看|看看|看一下|浏览|读取|检查|了解)|I'll\s+(?:check|inspect|look|read)|I\s+need\s+to\s+(?:check|inspect|look|read))/i;
  const target = /(项目|文件|目录|代码|路径|仓库|工程|结构|数据模型|管理器|核心|黑板|技能|上下文|project|file|directory|repo|code|path|folder|context|model|manager|schema)/i;
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
  if (!content || detectToolCalls(content).length > 0) return false;
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

function looksLikeCompletedReply(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  return /(已完成|修好了|已经修复|验证通过|检查通过|测试通过|已提交|commit\s+[0-9a-f]{6,}|工作区.*干净|无需进一步|不需要再|完成了|done|fixed|passed|committed)/i.test(text);
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

function looksLikeActionStall(content) {
  if (!content || detectToolCalls(content).length > 0) return false;
  if (looksLikeCompletedReply(content) || asksUserToDecide(content)) return false;
  if (!userWantsEnvironmentAction(getLastVisibleUserContent())) return false;
  const text = stripCodeForStallCheck(content);
  const opener = /(接下来|下一步|然后|之后|现在|这次|我(?:会|将|来|需要|准备|先)|让我|先|再|I'll|I\s+(?:need|am going)\s+to)/i;
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
          ? "墨稿已成 · 可在下方选择「送入 Harness / 投到白板 / 存为模板」，或继续对话"
          : (brainstormMode
            ? "灵感发散模式：输入想法、问题、素材或方向…"
            : "输入想法、问题、素材或方向（Enter 发言，Shift+Enter 换行）")));
  }
}

function captureCurrentInputForQueue() {
  const text = chatInput?.value.trim() || "";
  if (!text && pendingFiles.length === 0) return false;
  inputQueue.push({ text, files: [...pendingFiles] });
  chatInput.value = "";
  chatInput.style.height = "auto";
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
  // 停止仅中断本次生成：Harness 开关保持不动，只有手动添加才退出
  showHarnessIdle("本次执行已停止· Harness 保持开启，下一条消息继续自主执行");

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
  if (!content || detectToolCalls(content).length > 0) return false;
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
  if (!content || detectToolCalls(content).length > 0) return false;
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

function toolCallSignature(call) {
  return `${call?.name || ""}:${JSON.stringify(call?.params || {})}`;
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const unique = [];
  for (const call of calls || []) {
    const sig = toolCallSignature(call);
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(call);
  }
  return unique;
}

function buildToolFollowupInstruction({ harnessOn, autopilotOn = false, round, maxRounds, results }) {
  const failed = (results || []).filter(r => r.success === false);
  const lines = [
    "",
    "[Agent Loop 指令]",
    `当前工具轮次：${round + 1}/${maxRounds}。`,
    "- 先吸收工具结果，再决定下一步；不要复述工具原文。",
    "- 若目标仍未完成，继续调用最小必要工具推进。",
    "- 若刚完成文件修改/生成，优先验证：读取文件、运行检查/测试/构建或说明无法验证原因。",
    "- 若已完成并验证，输出简短最终汇报，不再调用工具。",
  ];
  if (autopilotOn && !harnessOn) {
    lines.push("- Autopilot 模式下：不要等用户说“继续”；任务未完成就继续观察、修改或验证。");
  }
  if (harnessOn) {
    lines.push("- Harness 模式下：如有 TODOLIST，完成一批就 todo_manage(action=update)，全部 done/blocked 后再收尾。");
  }
  if (failed.length) {
    lines.push(`- 有 ${failed.length} 个工具失败：请换参数、换工具或先读取更多上下文，不要重复完全相同的失败调用。`);
  }
  return lines.join("\n");
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
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
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
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
  if (signal?.aborted) return msgEl;
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

// 工具卡片的中文标签（含图标），未收录的回退到原始名
const TOOL_LABELS = {
  file_create: "📝 创建文件",
  file_edit: "✏️ 编辑文件",
  file_append: "➕ 追加文件",
  skill_run: "⚡ 技能",
  project_info: "ℹ️ 项目信息",
  project_files: "📁 文件列表",
  project_read_file: "📄 读取文件",
  project_find_file: "🔍 查找文件",
  board_add: "📋 添加卡片",
  board_read: "📋 读取黑板",
  board_update: "📋 更新卡片",
  board_batch: "📋 批量操作",
  board_clear: "📋 清空黑板",
  knowledge_search: "📚 知识检索",
  knowledge_add: "📚 知识添加",
  prompt_gen: "💡 提示词生成",
  chat_context: "💬 对话上下文",
};

function getToolCallLabel(call) {
  if (call?.name === "skill_run") {
    const skillName = call.params?.skill;
    return skillName ? t("⚡ 技能 · {name}", { name: skillName }) : "⚡ 技能";
  }
  return TOOL_LABELS[call?.name] || t("🔧 工具 · {name}", { name: call?.name || "unknown" });
}

function getToolCallStatus(result) {
  if (result?.success === false) return "失败";
  const s = result?._structured;
  if (s?._type === "file_edit") return s.applied === "auto" ? "已应用" : "diff 预览";
  if (s?._type === "file_create") return s.applied === "auto" ? "已创建" : "文件预览";
  if (s?._type === "file_append") return s.applied === "auto" ? "已追加" : "追加预览";
  return "已执行";
}

function getToolCallMeta(call) {
  const params = call?.params || {};
  if (params.file_path) return params.file_path;
  if (params.path) return params.path;
  if (params.query) return params.query;
  if (params.skill) return params.skill;
  if (params.command) return params.command;
  if (params.name) return params.name;
  return call?.name || "";
}

function setToolCallExpanded(el, header, body, expanded) {
  el.classList.toggle("is-open", expanded);
  body.hidden = !expanded;
  header.setAttribute("aria-expanded", String(expanded));
}

// 从工具输出中提取多模态预览信息（chart/qrcode 返回图片，apidoc 等返回文档）
const IMAGE_EXTS = [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
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
  const kind = IMAGE_EXTS.includes(ext) ? "image" : "doc";
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
  const defaultOpen = result?.success === false || result?._structured?._type === "file_edit" || result?._structured?._type === "file_create" || result?._structured?._type === "file_append";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "tool-call-header";
  header.setAttribute("aria-label", t("展开或收起工具调用详情"));
  const titleWrap = document.createElement("span");
  titleWrap.className = "tool-call-title";
  const label = document.createElement("span");
  label.className = "tool-call-name";
  label.textContent = getToolCallLabel(call);
  titleWrap.appendChild(label);
  const metaText = getToolCallMeta(call);
  if (metaText) {
    const meta = document.createElement("span");
    meta.className = "tool-call-card-meta";
    meta.textContent = metaText;
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
      } else {
        wrap.className = "tool-call-doc";
        const link = document.createElement("a");
        link.href = imgInfo.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "📄 " + (imgInfo.name || t("查看输出文档"));
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
    errDiv.textContent = "⚠ " + data.errors.join("\n");
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
        btnAccept.textContent = "✅ 已应用";
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
    btnReject.textContent = "✅ 已拒绝";
    wrap.classList.add("file-edit-rejected");
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "复制 diff";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.diff);
      btnCopy.textContent = "✅ 已复制";
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
    errDiv.textContent = "⚠ " + data.errors.join("\n");
    wrap.appendChild(errDiv);
  }

  // 模型输出被截断时的醒目警告（内容可能不完整）
  if (data.truncated) {
    const warn = document.createElement("div");
    warn.className = "file-edit-errors";
    warn.textContent = "⚠ 模型输出长度达到上限，文件内容可能在末尾被截断。自动写入后模型会用 file_append 补齐剩余部分，可手动核对完整性。";
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
      btnCopy.textContent = "✅ 已复制";
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
    errDiv.textContent = "⚠ " + data.errors.join("\n");
    wrap.appendChild(errDiv);
  }

  // 本次追加内容本身又被截断：提示后续会自动补齐
  if (data.truncated) {
    const warn = document.createElement("div");
    warn.className = "file-edit-errors";
    warn.textContent = "⚠ 本次追加内容因输出长度上限被截断。模型会继续用 file_append 补齐剩余部分。";
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
      btnCopy.textContent = "✅ 已复制";
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

async function continueTruncatedOutput(msgEl, content, modelId, apiKey, baseUrl, params, signal, finishReason = "") {
  const contentEl = msgEl?.querySelector(".msg-content");
  let fr = finishReason;
  for (let round = 1; round <= MAX_CONTINUE_ROUNDS; round++) {
    // 工具块未闭合或模型自报 finish_reason=length 都视为被截断
    const stuck = hasTruncatedTail(content) || fr === "length";
    if (signal?.aborted || !stuck) break;
    const contPrompt = buildContinuePrompt(content);
    try {
      const { toast } = await import("../app.js?v=20260826-110");
      toast(t("输出达到长度上限，自动续写中（{x}/{n}）…", { x: round, n: MAX_CONTINUE_ROUNDS }));
    } catch {}

    // 历史 + 被截断的助手消息原文 + 续写指令（模型需看到断点才能接续）
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    history.push({ role: "assistant", content });
    history.push({ role: "user", content: contPrompt });
    history._modelId = modelId;
    const messages = buildMessages(history, state.constitution);

    const cursor = msgEl ? addStreamingCursor(msgEl) : null;
    const contMeta = {};
    let part = "";
    try {
      for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params?.temperature ?? 0.7, max_tokens: params?.max_tokens ?? getOutputMaxTokens(), stream: true, signal, meta: contMeta })) {
        appendStreamChunk(chunk, {
          reasoning() {
            markActivity();
          },
          content(text) {
            part += text;
            markActivity();
            if (contentEl) renderAssistantContent(contentEl, content + part, cursor);
            autoScroll();
          },
        });
      }
      fr = contMeta.finishReason || "";
    } catch (err) {
      if (cursor) removeStreamingCursor(cursor);
      if (!isAbortError(err)) console.warn("自动续写失败:", err);
      break;
    }
    if (cursor) removeStreamingCursor(cursor);
    if (!part.trim()) break; // 模型零输出，再试也无意义
    content += stripOverlap(content, part);
  }
  // 轮数耗尽仍未闭合：提示用户，后续由工具循环的截断守卫接管（拒执行并要求拆分重试）
  if (!signal?.aborted && hasTruncatedTail(content)) {
    try {
      const { toast } = await import("../app.js?v=20260826-110");
      toast("输出仍不完整，已要求模型拆分重试", 3200);
    } catch {}
  }
  if (contentEl) renderAssistantContent(contentEl, content);
  return content;
}

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
  const harnessOn = state.harness?.enabled === true;
  const autopilotOn = harnessOn || options.autopilot === true;
  const taskText = String(options.taskText || getLastVisibleUserContent() || "");
  // Harness 循环仅三种退出：手动停止 / 轮数用完 / TODO 全部了结；模型侧异常不再中断循环
  let todoNudges = 0;
  let autopilotNudges = 0;
  let prevCallsSig = ""; // 上一轮工具调用指纹，用于拦截原地打转的相同调用
  let dupRounds = 0;
  let exitReason = "";
  let successfulToolInThisLoop = false;
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) {
      exitReason = "已手动停止";
      break;
    }
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") break;

    let calls = dedupeToolCalls(detectToolCalls(lastMsg.content));
    let nudged = false;
    // 上一轮生成异常：失败报错或零输出（Harness 下不退出，催其重新生成继续推进）
    const replyFailed = !(lastMsg.content || "").trim() || /^(续写失败|请求失败)/.test(lastMsg.content);


    // 相同调用去重：本轮调用与上一轮完全一致时不重复执行（避免无效副作用与空转耗尽轮数）
    if (calls.length > 0) {

      const sig = JSON.stringify(calls.map(c => [c.name, c.params]));
      if (sig === prevCallsSig) {
        dupRounds++;
        if (dupRounds >= 2 && !autopilotOn) break;
        // Harness 下仅拦截重复调用并催其换思路，不直接退出。
        addMessage({
          role: "user",
          content: `[系统] ${round + 1}/${maxRounds} 轮：你本轮发出的工具调用与上一轮完全相同，已拦截未重复执行。${dupRounds >= 2 ? "已连续多轮相同调用，必须换思路。" : ""}若上轮结果不符合预期，请换思路（拆分任务、改用其他工具、或先用 project_read_file 查看现状）；若任务已推进，直接继续剩余工作或输出结论。`,
          model: "[dedup]",
          hidden: true,
        });
        nudged = true;
      } else {
        dupRounds = 0;
      }
      prevCallsSig = sig;
    }

    if (calls.length === 0) {
      const pending = getConversationTodos(state.currentConversationId)
        .filter(t => t.status !== "done" && t.status !== "blocked");
      const completedReply = looksLikeCompletedReply(lastMsg.content);
      if (!harnessOn && autopilotOn && completedReply && successfulToolInThisLoop) {
        const settled = settleAutopilotTodosOnCompletion();
        exitReason = settled
          ? t("任务完成或模型已收尾 · 已同步清单 {n} 项", { n: settled })
          : "任务完成或模型已收尾";
        break;
      }
      if (lastMsg.autoAdvanceNudge && round < maxRounds - 1) {
        addMessage({
          role: "user",
          content: lastMsg.autoAdvanceNudge,
          model: "[auto_advance]",
          hidden: true,
        });
        delete lastMsg.autoAdvanceNudge;
        delete lastMsg.autoAdvanceSuggestedCalls;
        nudged = true;
      } else if (autopilotOn && round < maxRounds - 1) {
        if (replyFailed) {
          // 模型侧失败零输出：不退出循环，注入提示让其忽略异常继续推进
          addMessage({
            role: "user",
            content: `[系统] ${round + 1}/${maxRounds} 轮：上一轮生成异常（失败或无输出），自主推进仍在执行，请忽略异常内容，直接继续推进任务。`,
            model: "[retry]",
            hidden: true,
          });
          nudged = true;
        } else if (pending.length > 0) {
          // 闭环强制：模型想收尾但 TODOLIST 仍有未完成项，注入系统催办继续推进。
          todoNudges++;
          setHarnessProgress((harnessOn ? t("Harness 闭环校验 · 清单剩余 {n} 项，自动催办（第 {k} 次）", { n: pending.length, k: todoNudges }) : t("Autopilot 闭环校验 · 清单剩余 {n} 项，自动催办（第 {k} 次）", { n: pending.length, k: todoNudges })));
          addMessage({
            role: "user",
            content: `[系统校验] ${round + 1}/${maxRounds} 轮：任务尚未完成，TODOLIST 仍有 ${pending.length} 项未了结：\n${pending.map(t => `- [${t.id}] ${t.content}`).join("\n")}\n请统筹批量推进剩余事项（能一起完成的多项不要拆开磨），每完成一批立即调用 todo_manage 批量更新状态，让清单实时反映进度，全部了结后再输出汇报与追溯。`,
            model: "[todo_enforce]",
            hidden: true,
          });
          nudged = true;
        } else if (!completedReply && (asksUserToDecide(lastMsg.content) || looksLikeActionStall(lastMsg.content) || looksLikeInspectionStall(lastMsg.content))) {
          autopilotNudges++;
          addMessage({
            role: "user",
            content: `[系统自动推进] ${round + 1}/${maxRounds} 轮：用户希望一句话交代任务后由你完成，不要在可自行决策时等待“继续”或询问是否要做。当前任务是：\n${taskText.slice(0, 2000)}\n\n请直接选择最小必要的下一步工具调用继续推进；如果确实已经完成，请给出包含验证方式的简短最终汇报。`,
            model: "[autopilot]",
            hidden: true,
          });
          setHarnessProgress(t("Autopilot 自主推进 · 自动续跑（第 {k} 次）", { k: autopilotNudges }));
          nudged = true;
        } else if (!harnessOn && autopilotOn && !successfulToolInThisLoop && completedReply) {
          autopilotNudges++;
          addMessage({
            role: "user",
            content: `[系统自动推进] ${round + 1}/${maxRounds} 轮：你刚才像是在汇报完成，但本轮任务没有任何工具执行记录。用户要求你像 Agent 一样把活做完，而不是口头承诺。请先读取/检查/修改/运行验证；如果确实无法操作，请说明具体阻塞原因。任务：\n${taskText.slice(0, 2000)}`,
            model: "[autopilot]",
            hidden: true,
          });
          setHarnessProgress(t("Autopilot 自主推进 · 校验口头完成（第 {k} 次）", { k: autopilotNudges }));
          nudged = true;
        }
      }
      if (!nudged) {
        if (autopilotOn) exitReason = pending.length === 0 ? "任务完成或模型已收尾" : "模型收尾退出";
        break;
      }
    }

    if (autopilotOn) {
      const todos = getConversationTodos(state.currentConversationId);
      const doneCount = todos.filter(t => t.status === "done").length;
      const todoText = todos.length ? t(" · 清单 {done}/{total}", { done: doneCount, total: todos.length }) : "";
      setHarnessProgress((harnessOn ? t("Harness 自主执行 · 第 {x}/{n} 轮", { x: round + 1, n: maxRounds }) : t("Autopilot 自主推进 · 第 {x}/{n} 轮", { x: round + 1, n: maxRounds })) + todoText);
    }

    // 更新最后一条 assistant 消息（去掉工具标记）
    const cleanContent = stripToolCalls(lastMsg.content);
    lastMsg.content = cleanContent;

    // 重新渲染当前消息（去掉标记）
    const contentEl = msgEl.querySelector(".msg-content");
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(cleanContent);
      contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
    }

    if (!nudged) {
      // 执行工具
      markActivity();
      const stepCardIds = [];
      // 为每个工具调用创建步骤卡片
      for (const call of calls) {
        const cardId = addToolStepCard(call.name, call.params, "running");
        stepCardIds.push({ call, cardId });
      }
      const results = await executeToolCalls(calls);
      if (results.some(result => result.success !== false)) successfulToolInThisLoop = true;
      markActivity();
      if (signal?.aborted) { exitReason = "已手动停止"; break; }

      // 渲染工具卡片
      lastMsg.toolResults = [
        ...(lastMsg.toolResults || []),
        ...results.map((result, i) => ({ call: calls[i], result })),
      ];
      setMessages([...state.messages]);
      if (lastMsg.id) {
        try {
          await patch(`/chat/messages/${lastMsg.id}`, {
            content: lastMsg.content,
            metadata: { toolResults: lastMsg.toolResults },
          });
        } catch (e) {
          console.warn("工具结果保存失败:", e);
        }
      }
      autoScroll();

      // 更新步骤卡片状态
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const { cardId } = stepCardIds[i];
        const status = result.success ? "done" : "error";
        const resultSummary = result.success 
          ? (result.output?.slice(0, 100) || "完成")
          : (result.output?.slice(0, 100) || "失败");
        updateToolStepCard(cardId, status, resultSummary);
      }

      // Keep tool results in model context without rendering them as chat bubbles.
      // Harness 下每轮结果开头标注轮次，让模型感知当前进度与剩余轮数预算
      const roundTag = autopilotOn ? `[${harnessOn ? "Harness" : "Autopilot"} · ${round + 1}/${maxRounds} 轮]\n` : "";
      const toolResultText = roundTag
        + results.map((r, i) => formatToolResultForModel(calls[i], r)).join("\n\n")
        + "\n\n"
        + buildToolFollowupInstruction({ harnessOn, autopilotOn, round, maxRounds, results });
      addMessage({ role: "user", content: toolResultText, model: "[tool_results]", hidden: true });
    }

    // 创建新的 assistant 消息
    const followUp = { role: "assistant", content: "", model: state.currentModel?.name || "" };
    addMessage(followUp);

    const followEl = document.createElement("div");
    followEl.className = "msg msg-assistant";
    const followContent = document.createElement("div");
    followContent.className = "msg-content";
    followEl.appendChild(followContent);
    chatScroll.appendChild(followEl);
    const cursor = addStreamingCursor(followEl);
    autoScroll();

    // 流式续写
    await refreshKnowledgeContext(state.messages.slice(-6).map(m => m.content || "").join("\n"));
    if (signal?.aborted) { exitReason = "已手动停止"; break; }
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history._modelId = modelId;
    const messages = buildMessages(history, state.constitution);

    let followContent2 = "";
    let followReasoningText = "";
    let followThinkingPanel = null;
    const followMeta = {};
    try {
      for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature ?? 0.7, max_tokens: params.max_tokens ?? getOutputMaxTokens(), stream: true, signal, meta: followMeta })) {
        appendStreamChunk(chunk, {
          reasoning(text) {
            followReasoningText += text;
            markActivity();
            if (!followThinkingPanel) followThinkingPanel = createThinkingPanel(followEl);
            updateThinkingPanel(followThinkingPanel, followReasoningText);
          },
          content(text) {
            followContent2 += text;
            markActivity();
            renderAssistantContent(followContent, followContent2, cursor);
            autoScroll();
          },
        });
      }
      if (followThinkingPanel) collapseThinkingPanel(followThinkingPanel);
    } catch (err) {
      if (followThinkingPanel) collapseThinkingPanel(followThinkingPanel);
      followContent2 = isAbortError(err)
        ? (followContent2 ? `${followContent2}\n\n[已停止]` : "已停止")
        : t("续写失败: {msg}", { msg: err.message });
    }

    removeStreamingCursor(cursor);
    if (!signal?.aborted && (hasTruncatedTail(followContent2) || followMeta.finishReason === "length")) {
      followContent2 = await continueTruncatedOutput(followEl, followContent2, modelId, apiKey, baseUrl, params, signal, followMeta.finishReason || "");
    }
    updateLastAssistantMessage(followContent2);
    renderAssistantContent(followContent, followContent2);

    // 持久化
    if (state.currentConversationId) {

      const saved = await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: followContent2, model: modelId });
      if (saved.code === 0 && saved.data?.id) followUp.id = saved.data.id;
    }

    if (signal?.aborted) { exitReason = "已手动停止"; break; }
    msgEl = await autoAdvanceIfStalled(followEl, modelId, apiKey, baseUrl, params);
    msgEl = await autoReviewIfStalled(msgEl, modelId, apiKey, baseUrl, signal);
  }
  if (autopilotOn && !exitReason && !(signal?.aborted)) exitReason = t("已达 {n} 轮上限", { n: maxRounds });
  if (harnessOn && maxRounds > 5) {
    showHarnessIdle(exitReason ? exitReason + t(" · Harness 保持开启，下一条消息继续自主执行（点 ⚡ 手动退出）") : "");
  } else if (!harnessOn && autopilotOn) {
    setHarnessProgress(null);
  }

  // 任务完成通知（非手动停止时触发）
  if (autopilotOn && exitReason && !exitReason.includes("手动停止")) {
    notifyTaskComplete(harnessOn ? t("Harness 任务完成") : t("Autopilot 任务完成"), exitReason);
  }
}

// ── 发送消息 ────────────────────────────────

async function sendMessage(queuedPayload = null) {
  if (isGenerating) {
    if (queuedPayload) inputQueue.push(queuedPayload);
    else if (captureCurrentInputForQueue()) {
      const { toast } = await import("../app.js?v=20260826-110");
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
    try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
    startGrindConversation(grindMatch[1].trim());
    return;
  }

  // 抽象任务自动检测：新对话 + 非磨墨进行中 + 匹配抽象模式 → 提示切换磨墨
  const grindActive = grindSession && ["grinding", "collecting"].includes(grindSession.state);
  const isFreshConv = !state.currentConversationId || state.messages.length === 0;
  if (!queuedPayload && !grindActive && isFreshConv && isAbstractTask(text)) {
    const { dlgConfirm } = await import("../services/dialog.js?v=20260826-110");
    const confirmed = await dlgConfirm(
      t("检测到抽象任务「{text}」，建议先进入磨墨模式细化需求后再执行。是否切换？", { text: text.slice(0, 30) }),
      { title: t("磨墨建议"), okText: t("进入磨墨"), cancelText: t("直接发送") }
    );
    if (confirmed) {
      chatInput.value = "";
      chatInput.style.height = "auto";
      try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch (e) {}
      startGrindConversation(text);
      return;
    }
  }

  isGenerating = true;
  markActivity(); // 看门狗计时基准：从本次生成开始算
  activeGenerationController = new AbortController();
  const signal = activeGenerationController.signal;
  updateSendState();

  try {
  if (!state.currentConversationId) {
    // 创建对话时记录当前打开的项目（未打开则为空，前端展示为“无项目”）
    const res = await post("/chat/conversations", {
      title: (text || filesForMessage[0]?.name || "新对话").slice(0, 30),
      project: state.project?.name || "",
    });
    if (res.code === 0) {
      state.currentConversationId = res.data.id;
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
  const harnessOn = state.harness?.enabled === true;
  const agentTask = classifyAgentTask(text);
  const autopilotOn = harnessOn || agentTask.wantsEnv;
  const agentRuntimeContext = buildAgentRuntimeContext(text, harnessOn);
  const fullText = (harnessOn ? HARNESS_PREFIX : "") + text + agentRuntimeContext + mentionContext + fileContext;
  await refreshKnowledgeContext(fullText);
  // display：气泡只展示用户输入的原文；注入的 Skill 定义 / Harness 指令 / 文件内容只进模型上下文，与后端持久化的干净文本保持一致。
  const userMsg = { role: "user", content: fullText, display: text, model: "", files: fileMeta.length > 0 ? fileMeta : undefined };

  addMessage(userMsg);

  if (state.currentConversationId) {
    const saved = await post(`/chat/conversations/${state.currentConversationId}/messages`, {
      role: "user",
      content: text,
      model: "",
      metadata: fileMeta.length > 0 ? { files: fileMeta } : {},
    });
    if (saved.code === 0 && saved.data?.id) userMsg.id = saved.data.id;
  }

  const assistantMsg = { role: "assistant", content: "", model: state.currentModel?.name || "" };
  addMessage(assistantMsg);

  let msgEl = renderMessage(assistantMsg, state.messages.length - 1);
  chatScroll.appendChild(msgEl);
  const cursor = addStreamingCursor(msgEl);
  stickToBottom = true;
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  const params = getDefaultParams(modelId);
  const historyForAdapter = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
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
  // 磨墨注入：接墨 / 磨墨 / 收墨提示词（只进模型上下文，气泡仍显示原文）
  if (grindSession && grindSession.state !== "done" && state.currentConversationId === grindSession.conversation_id) {
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
  const messages = buildMessages(historyForAdapter, state.constitution);

  let fullContent = "";
  let reasoningText = "";
  let thinkingPanel = null;
  const streamMeta = {};
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true, use_responses: state.useResponses, signal, meta: streamMeta })) {
      // 检测 reasoning 前缀，分离思考内容
      appendStreamChunk(chunk, {
        reasoning(text) {
          reasoningText += text;
          markActivity();
          if (!thinkingPanel) thinkingPanel = createThinkingPanel(msgEl);
          updateThinkingPanel(thinkingPanel, reasoningText);
        },
        content(text) {
          fullContent += text;
          markActivity();
          const contentEl = msgEl.querySelector(".msg-content");
          renderAssistantContent(contentEl, fullContent, cursor);
          autoScroll();
        },
      });
    }
    // 流式结束，自动折叠思考面板
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
  } catch (err) {
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : t("请求失败: {msg}", { msg: err.message });
  }

  removeStreamingCursor(cursor);

  // 输出被截断（工具块未闭合或 finish_reason=length）→ 自动续写拼回本条消息
  if (!signal.aborted && (hasTruncatedTail(fullContent) || streamMeta.finishReason === "length")) {
    fullContent = await continueTruncatedOutput(msgEl, fullContent, modelId, apiKey, baseUrl, params, signal, streamMeta.finishReason || "");
  }
  updateLastAssistantMessage(fullContent);

  // 估算并记录用户
  const estimatedPrompt = estimateContextTokens(state.messages.slice(0, -1));

  const estimatedCompletion = Math.ceil(fullContent.length / 3);
  addUsage({ prompt_tokens: estimatedPrompt, completion_tokens: estimatedCompletion });

  // 同步用量到后端
  syncUsageToBackend();


  const contentEl = msgEl.querySelector(".msg-content");
  renderAssistantContent(contentEl, fullContent);

  if (state.currentConversationId) {
    const saved = await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: fullContent, model: modelId });
    if (saved.code === 0 && saved.data?.id) assistantMsg.id = saved.data.id;
  }

  if (!signal.aborted) {
    msgEl = await autoAdvanceIfStalled(msgEl, modelId, apiKey, baseUrl, params);
    msgEl = await autoReviewIfStalled(msgEl, modelId, apiKey, baseUrl, signal);
  }

  // 工具调用循环：环境任务默认进入 Autopilot，避免用户反复说“继续”；Harness 是显式强模式。
  const toolRounds = harnessOn
    ? Math.max(10, Math.min(50, state.harness?.maxRounds || 50))
    : (autopilotOn
      ? (agentTask.broad ? AGENT_AUTOPILOT_BROAD_ROUNDS : AGENT_AUTOPILOT_DEFAULT_ROUNDS)
      : 5);
  if (harnessOn) {
    setHarnessProgress(t("自主执行已启动 · 最多 {n} 轮 · 仅手动停止 / 轮数用完 / 清单了结才退出", { n: toolRounds }));
  } else if (autopilotOn) {
    setHarnessProgress(t("Autopilot 自主推进已启动 · 最多 {n} 轮", { n: toolRounds }));
  }
  if (!signal.aborted) await runToolLoop(msgEl, modelId, apiKey, baseUrl, params, signal, toolRounds, { autopilot: autopilotOn, taskText: text });
  else if (harnessOn) showHarnessIdle(); // 启动前即被停止：runToolLoop 未运行，保持待机指示

  // 后台检查上下文压缩
  if (!signal.aborted) {
    checkAndCompress(modelId, apiKey, baseUrl);
    autoRefineMemoryAndProfile({ silent: true });
  }

  // 磨墨：本轮结束后解析墨迹 / 检测墨稿，更新面板与会话状态
  if (!signal.aborted && grindSession && grindSession.state !== "done"

      && state.currentConversationId === grindSession.conversation_id) {
    await handleGrindReply(fullContent, msgEl);
  }

  } catch (err) {
    console.error("发送失败", err);
    const { toast } = await import("../app.js?v=20260826-110");
    toast(isAbortError(err) ? (state.harness?.enabled === true ? "已停止输出 · Harness 保持开启" : "已停止输出") : t("发送失败: {msg}", { msg: err.message }));
  } finally {
  isGenerating = false;
  activeGenerationController = null;
  updateSendState();
  chatInput.focus();
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
    const msgs = state.messages.map(m => ({ role: m.role, content: m.content }));
    const res = await post("/chat/compress", { messages: msgs, keep_recent_rounds: 2, max_tokens: 64000 });
    if (res.code !== 0 || !res.data.need_compress) return;

    const { compress_prompt, keep_messages, compress_count } = res.data;

    // 调用 LLM 生成摘要
    let summary = "";
    try {
      for await (const chunk of streamChat({ model: modelId, messages: [{ role: "user", content: compress_prompt }], api_key: apiKey, base_url: baseUrl, temperature: 0.3, max_tokens: 1024, stream: true })) {
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
    const { toast } = await import("../app.js?v=20260826-110");
    toast(t("上下文已压缩：{n} 条消息已摘要", { n: compress_count }));
  } catch (e) {
    console.warn("上下文压缩检查失败", e);
  }
}

function toggleBrainstormMode() {
  brainstormMode = !brainstormMode;
  state.brainstormMode = brainstormMode;
  btnBrainstorm?.classList.toggle("active", brainstormMode);
  updateSendState();
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
    const { toast } = await import("../app.js?v=20260826-110");
    toast("墨稿已成：可送入 Harness / 投到白板 / 存为模板");
    return;
  }

  // 未完成：推进轮数（收墨阶段不追问，不计轮次
  const round = (grindSession.round || 0) + (grindSession.state === "collecting" ? 0 : 1);

  grindSession = (await grindSvc.patchSession(convId, { round, resolved: grindSession.resolved || [] })) || grindSession;
  renderGrindPanel();
}

/** 侧边栏墨迹面板：已定 / 未知项；成稿后保留汇总视图 */
function renderGrindPanel() {
  if (!grindPanelEl) grindPanelEl = document.getElementById("grind-panel");
  if (!grindPanelEl) return;
  const st = grindSession?.state;
  const active = grindSession && ["grinding", "collecting", "done"].includes(st);
  grindPanelEl.classList.toggle("hidden", !active);
  // 磨墨按钮高亮：研磨进行中才亮，成员结束后恢复
  document.getElementById("btn-grind")?.classList.toggle("active", !!active && st !== "done");

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
    draftRow.textContent = `📜 ${grindSession.draft.title}`;
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
  grindPanelEl ??= document.getElementById("grind-panel");
  grindPanelEl?.classList.add("hidden");
  document.getElementById("btn-grind")?.classList.remove("active");
}

/** 墨稿下方三个动作：送入 Harness / 投到白板 / 存为模板 */
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

  bar.appendChild(mkBtn("送入 Harness", "把墨稿作为 Harness 任务自主执行", async () => {
    state.harness = state.harness || { enabled: false, maxRounds: 50 };
    state.harness.enabled = true;
    btnHarness?.classList.add("active");
    savePersistent();
    const { toast } = await import("../app.js?v=20260826-110");
    toast("墨稿已送入 Harness，自主执行中…");
    await sendMessage({ text: grindSvc.draftToHarnessTask(draft), files: [] });
  }));

  bar.appendChild(mkBtn("投到白板", "作为白板卡片保存", async () => {
    addBoardCard(grindSvc.draftToBoardCard(draft));
    const { toast } = await import("../app.js?v=20260826-110");
    toast("已投到白板");
  }));

  bar.appendChild(mkBtn("存为模板", "存入知识库作为可复用任务书模板", async () => {
    const ok = await grindSvc.saveDraftAsTemplate(draft);
    const { toast } = await import("../app.js?v=20260826-110");
    toast(ok ? "已存为磨墨模板（知识中心可见）" : "保存失败");
  }));

  msgEl.appendChild(bar);
}

function openCompressModal() {
  if (!compressModal) return;
  if (state.messages.length < 4) {
    import("../app.js?v=20260826-110").then(({ toast }) => toast("当前对话还不需要压缩"));
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

    const { toast } = await import("../app.js?v=20260826-110");
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
    const { toast } = await import("../app.js?v=20260826-110");
    toast("压缩失败: " + e.message);
  } finally {
    btnDoCompress.disabled = false;
    btnDoCompress.textContent = oldText;
  }
}

// ── 对话侧边栏 ─────────────────────────────

async function refreshConversationList() {
  const res = await get("/chat/conversations");
  if (res.code === 0) {
    setConversations(res.data);
    renderConvList(res.data);
  }
}

function renderConvList(conversations) {
  if (!convList) return;
  convList.innerHTML = "";
  for (const conv of conversations) {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === state.currentConversationId ? " active" : "");

    const titleWrap = document.createElement("div");
    titleWrap.className = "conv-item-title-wrap";

    const title = document.createElement("span");
    title.className = "conv-item-title";
    title.textContent = conv.title || conv.id;
    titleWrap.appendChild(title);

    // 发起时打开的项目
    const projTag = document.createElement("span");

    projTag.className = "conv-item-project" + (conv.project ? "" : " none");
    projTag.textContent = conv.project ? `📁 ${conv.project}` : "无项目";
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
    renameBtn.textContent = "✎";
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
    const who = m.role === "user" ? "🧑 用户" : `🤖 助手${m.model ? " · " + m.model : ""}`;
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
    meta.textContent = t("{n}条 · ~{tok} tok", { n: msgCount, tok: tokens >= 1000 ? (tokens / 1000).toFixed(1) + "K" : tokens }) + (dateStr ? " · " + dateStr : "") + (conv.project ? " · 📁 " + conv.project : "");
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
  // 离开当前对话前，捕获灵光（技术洞察归档到知识库）
  captureConversationSpark();
  // 保存当前对话用量
  if (state.currentConversationId) {
    setConversationUsage(state.currentConversationId, { ...state.usage });
  }
  state.currentConversationId = convId;
  grindSession = null;
  lastInkStatus = null;
  const res = await get(`/chat/conversations/${convId}/messages`);
  if (res.code === 0) setMessages((res.data || []).map(normalizeMessageForRender));

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

function renderUsageBar() {
  if (!usageBar) return;
  const u = state.usage;
  const ctxTokens = estimateContextTokens(state.messages);
  const ctxLimit = state.currentModel?.context_window || 0;
  const modelName = state.currentModel?.name || "未选择模型";
  const hasKey = state.currentModel ? !!getModelKey(state.currentModel.id) : false;

  let ctxPercent = 0;
  if (ctxLimit > 0) {
    ctxPercent = Math.min(100, Math.round((ctxTokens / ctxLimit) * 100));
  }

  const fmtTok = fmtTokens;

  usageBar.innerHTML = `
    <span class="usage-model" title="${state.currentModel?.base_url || ''}">${modelName}${hasKey ? "" : " ⚠"}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("消息 {n}", { n: u.messageCount })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输入 {n}", { n: fmtTok(u.promptTokens) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输出 {n}", { n: fmtTok(u.completionTokens) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("总计 {n}", { n: fmtTok(u.totalTokens) })}</span>
    ${ctxLimit > 0 ? `
      <span class="usage-sep">|</span>
      <span class="usage-ctx" title="${t("上下文{a} / {b} tokens", { a: fmtTok(ctxTokens), b: fmtTok(ctxLimit) })}">
        <span class="usage-stat">上下文</span>
        <span class="usage-ctx-track"><span class="usage-ctx-fill${ctxPercent >= 95 ? " usage-ctx-danger" : ""}" style="width:${ctxPercent}%"></span></span>
        <span class="usage-stat${ctxPercent > 80 ? " usage-warn" : ""}">${ctxPercent}%</span>
      </span>` : ""}
  `;
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
  const ctxTokens = estimateContextTokens(state.messages);
  const ctxLimit = state.currentModel?.context_window || 0;
  const ctxPercent = ctxLimit > 0 ? Math.min(100, Math.round((ctxTokens / ctxLimit) * 100)) : 0;
  usagePopup.innerHTML = `
    <div class="usage-popup-main">${fmtTokens(u.totalTokens)} tokens${equiv ? " · " + equiv : ""}</div>
    <div class="usage-popup-detail">
      <span>${t("输入 {n}", { n: fmtTokens(u.promptTokens) })}</span>
      <span>${t("输出 {n}", { n: fmtTokens(u.completionTokens) })}</span>
      <span>${t("消息 {n}", { n: u.messageCount })}</span>
      ${ctxLimit > 0 ? `<span>${t("上下文{p}%", { p: ctxPercent })}</span>` : ""}
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
      const { toast } = await import("../app.js?v=20260826-110");
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
          const { toast } = await import("../app.js?v=20260826-110");
          toast(res.message || t("解析失败: {name}", { name: file.name }));
        }
      } catch (e) {
        const { toast } = await import("../app.js?v=20260826-110");
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
    const { toast } = await import("../app.js?v=20260826-110");
    toast("正在生成中，请稍候");
    return;
  }
  const idx = state.messages.indexOf(msg);
  if (idx < 0) return;
  const after = state.messages.slice(idx + 1).filter(m => !m.hidden && m.role !== "system");
  if (after.length > 0) {
    const { toast } = await import("../app.js?v=20260826-110");
    toast("只能重新生成最后一条助手回复");
    return;
  }
  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    const { toast } = await import("../app.js?v=20260826-110");
    toast("请先在设置中配置该模型的 API Key");
    return;
  }
  const params = getDefaultParams(modelId);

  const history = state.messages.slice(0, idx)
    .filter(m => !m.hidden && m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));
  if (!history.some(m => m.role === "user")) {
    const { toast } = await import("../app.js?v=20260826-110");
    toast("没有可重新生成的上下文");
    return;
  }
  history._modelId = modelId;
  const messages = buildMessages(history, state.constitution);

  isGenerating = true;
  markActivity(); // 看门狗计时基准：从本次生成开始算
  activeGenerationController = new AbortController();
  const signal = activeGenerationController.signal;
  updateSendState();

  // 重置消息与卡片
  msg.content = "";

  msg.toolResults = [];
  msg.model = state.currentModel?.name || msg.model;
  setMessages([...state.messages]);
  const label = msgEl.querySelector(".msg-model-label");
  if (label) label.textContent = msg.model;
  msgEl.querySelector(".tool-call-group")?.remove();
  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) contentEl.innerHTML = "";

  stickToBottom = true;
  const cursor = addStreamingCursor(msgEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  let fullContent = "";
  let reasoningText = "";
  let thinkingPanel = null;
  const regenMeta = {};
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true, signal, meta: regenMeta })) {
      appendStreamChunk(chunk, {
        reasoning(text) {
          reasoningText += text;
          markActivity();
          if (!thinkingPanel) thinkingPanel = createThinkingPanel(msgEl);
          updateThinkingPanel(thinkingPanel, reasoningText);
        },
        content(text) {
          fullContent += text;
          markActivity();
          renderAssistantContent(contentEl, fullContent, cursor);
          autoScroll();
        },
      });
    }
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
  } catch (err) {
    if (thinkingPanel) collapseThinkingPanel(thinkingPanel);
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : t("请求失败: {msg}", { msg: err.message });
  }
  removeStreamingCursor(cursor);

  if (!signal.aborted && (hasTruncatedTail(fullContent) || regenMeta.finishReason === "length")) {
    fullContent = await continueTruncatedOutput(msgEl, fullContent, modelId, apiKey, baseUrl, params, signal, regenMeta.finishReason || "");
  }
  updateLastAssistantMessage(fullContent);
  renderAssistantContent(contentEl, fullContent);

  addUsage({ prompt_tokens: estimateContextTokens(state.messages.slice(0, idx)), completion_tokens: Math.ceil(fullContent.length / 3) });
  syncUsageToBackend();

  if (msg.id) {
    try {
      await patch(`/chat/messages/${msg.id}`, { content: fullContent, metadata: { toolResults: [] } });
    } catch (e) {
      console.warn("重新生成保存失败:", e);
    }
  }

  isGenerating = false;
  activeGenerationController = null;
  updateSendState();

  if (!signal.aborted) await runToolLoop(msgEl, modelId, apiKey, baseUrl, params, signal);
}

function initChat() {
  chatScroll = document.getElementById("chat-messages");
  chatInput = document.getElementById("chat-input");
  btnSend = document.getElementById("btn-send");
  btnNewChat = document.getElementById("btn-new-chat");
  convList = document.getElementById("conv-list");
  usageBar = document.getElementById("usage-bar");
  usageBar?.addEventListener("mouseenter", showUsagePopup);
  usageBar?.addEventListener("mouseleave", hideUsagePopup);
  convSidebar = document.getElementById("conv-sidebar");
  initConvSearch();
  initConvManage();
  filePreviewArea = document.getElementById("file-preview-area");
  btnAttachFile = document.getElementById("btn-attach-file");
  fileInput = document.getElementById("file-input");
  btnBrainstorm = document.getElementById("btn-brainstorm");
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
      const { toast } = await import("../app.js?v=20260826-110");
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
  btnBrainstorm?.addEventListener("click", toggleBrainstormMode);

  // 磨墨模式入口：备份 /grind 输入，等待用户写下粗糙想法
  document.getElementById("btn-grind")?.addEventListener("click", () => startGrindConversation(""));

  grindPanelEl = document.getElementById("grind-panel");

  // Harness 自主执行开关
  btnHarness = document.getElementById("btn-harness");

  btnHarness?.classList.toggle("active", state.harness?.enabled === true);
  btnHarness?.addEventListener("click", async () => {
    state.harness = state.harness || { enabled: false, maxRounds: 50 };
    state.harness.enabled = !state.harness.enabled;
    btnHarness.classList.toggle("active", state.harness.enabled);
    savePersistent();
    const { toast } = await import("../app.js?v=20260826-110");
    toast(state.harness.enabled ? "Harness 已开启：目标→计划→执行→验证→汇报→追溯，六阶段自主闭环，大任务自动建议 TODOLIST" : "Harness 已关闭");
    showHarnessIdle();
  });
  harnessStatusEl = document.createElement("div");
  harnessStatusEl.className = "harness-status hidden";
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", harnessStatusEl);
  showHarnessIdle();
  todoPanelEl = document.getElementById("todo-panel");
  convProjectEl = document.createElement("div");
  convProjectEl.className = "conv-project-badge";
  btnCompress?.addEventListener("click", openCompressModal);
  btnMemory?.addEventListener("click", openMemoryModal);
  btnSnippets?.addEventListener("click", openSnippetModal);
  btnDoCompress?.addEventListener("click", doManualCompress);
  compressModal?.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeCompressModal);
  });

  // 历史侧栏切换
  const btnToggleHistory = document.getElementById("btn-toggle-history");
  btnToggleHistory.addEventListener("click", () => {
    convSidebar.classList.toggle("hidden");
    btnToggleHistory.classList.toggle("active");
  });

  // 文件附件
  btnAttachFile.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = "";
  });

  // 专家包选择：注入专属 persona + rules 到系统提示
  const expertSelect = document.getElementById("expert-select");

  expertSelect?.addEventListener("change", async () => {
    const id = expertSelect.value;
    if (!id) {
      setActiveExpertId("");
      const { toast } = await import("../app.js?v=20260826-110");
      toast("已退出专家模式");
      return;
    }
    try {
      const { getExpert } = await import("../services/experts.js?v=20260826-110");
      const detail = await getExpert(id, { force: true });
      setActiveExpertId(id, detail);
      const { toast } = await import("../app.js?v=20260826-110");
      toast(t("已启用专家包：{name}", { name: detail.name || id }));
    } catch (e) {
      const { toast } = await import("../app.js?v=20260826-110");
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
    updateMentionPopup();
  });

  chatInput.addEventListener("blur", () => {
    // 延迟隐藏，保证弹窗 mousedown 先触发
    setTimeout(hideMentionPopup, 150);

  });

  try {
    const draft = localStorage.getItem(CHAT_DRAFT_KEY);
    if (draft && !chatInput.value) {
      chatInput.value = draft;
      chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
    }
  } catch (e) {}

  btnNewChat.addEventListener("click", () => {
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

  subscribe("messages", renderAllMessages);
  subscribe("conversations", (convs) => renderConvList(convs));
  subscribe("usage", renderUsageBar);
  subscribe("model", renderUsageBar);
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
  const origValue = chatInput.value;
  btn.classList.add("voice-active");
  btn.title = t("正在聆听…点击停止");
  chatInput.placeholder = t("🎤 正在聆听…") ;
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
      const sep = origValue && !origValue.endsWith("\n") && !origValue.endsWith(" ") ? " " : "";
      chatInput.value = (origValue + sep + final).trimStart();
      chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
    }
    if (interim) {
      chatInput.placeholder = t("🎤 ") + interim;
    }
  };
  _voiceRecognition.onerror = (e) => {
    if (e.error !== "aborted" && e.error !== "no-speech") {
      try { import("../app.js?v=20260826-110").then(m => m.toast(t("语音识别错误: {err}", { err: e.error }))); } catch {}
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

export { initChat, sendMessage, renderMarkdown, refreshConversationList };
