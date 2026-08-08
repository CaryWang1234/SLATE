/**
 * SLATE 聊天组件 v4：文件上传、上下文压缩、用量显示、流式输出
 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations, getModelKey, addUsage, estimateContextTokens, resetUsage, restoreUsageForConversation, setConversationUsage, setKnowledgeContext, savePersistent, getConversationTodos, setConversationTodos } from "../store.js?v=20260808-6";
import { get, post, del, patch, streamChat, upload } from "../services/api.js?v=20260808-6";
import { buildMessages, getDefaultParams, getOutputMaxTokens } from "../services/adapter.js?v=20260808-6";
import { detectToolCalls, stripToolCalls, executeToolCalls, hasTruncatedTail } from "../services/tools.js?v=20260808-6";
import { renderMarkdown } from "../services/markdown.js?v=20260808-6";
import { openMemoryModal, openSnippetModal, autoRefineMemoryAndProfile } from "./memory.js?v=20260808-6";

let chatScroll, chatInput, btnSend, btnNewChat, convList, usageBar, convSidebar;
let filePreviewArea, btnAttachFile, fileInput;
let btnBrainstorm, btnCompress, btnMemory, btnSnippets, btnDoCompress, compressModal, queueStatus;
let pendingFiles = []; // { name, size, content, type }
let brainstormMode = false;
let isGenerating = false;
let activeGenerationController = null;
let inputQueue = [];

// ── UI 看门狗（防卡死最后防线） ───────────────
// 生成期间超过 180 秒无任何活动（流式增量/工具执行）→ 强制中断
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
// 开启后：发送时注入六阶段指令，大任务强制建立 TODOLIST，工具循环轮数上限提升到 maxRounds
let harnessStatusEl = null;
let btnHarness = null;

const HARNESS_PREFIX = "[Harness 自主执行模式 · 六阶段闭环]\n请自主完成以下任务，不要向我提问，严格按六阶段推进：\n① 目标：开篇用一句话明确本次任务的目标与验收标准；\n② 计划：面临大任务（多步骤 / 多文件 / 复杂修改）必须先调用 todo_manage(action=init) 建立 TODOLIST，拆解为可执行、可验证的步骤；简单任务可跳过；\n③ 执行：逐项推进，每完成一项立即调用 todo_manage(action=update) 标记 done；受阻项标记 blocked 并说明原因；需要信息或操作时直接调用 MCP 工具；\n④ 验证：每步完成后自行验证结果（重新读取文件 / 执行命令 / 核对输出），失败则修复后重新验证；\n⑤ 汇报：全部完成后输出完结报告，逐条核对 TODOLIST（done / blocked+原因），未全部了结不得宣称任务完成；\n⑥ 追溯：用 1-3 句总结本次任务的关键决策、踩坑与可复用经验。\n\n任务：";

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

// ── TODOLIST 实时面板（输入区上方，按对话隔离） ─────────────
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
  title.textContent = `☰ 任务清单 ${done}/${items.length}` + (blocked ? ` · 受阻 ${blocked}` : "") + (inProgress ? ` · 进行中 ${inProgress}` : "");
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
  const icons = { done: "✔", in_progress: "▶", blocked: "✕", pending: "○" };
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

// ── @ 提及 MCP / Skill ──────────────────────
let mentionPopup = null;
let mentionCandidates = [];
let mentionIndex = 0;

function getMentionCandidates(query) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const list = [
    ...Object.entries(mcp).map(([name, desc]) => ({ name, desc, type: "MCP" })),
    ...Object.entries(skills).map(([name, desc]) => ({ name, desc, type: "Skill" })),
  ];
  const q = query.toLowerCase();
  if (!q) return list;
  return list.filter(c => c.name.toLowerCase().includes(q) || String(c.desc).toLowerCase().includes(q));
}

// 获取光标前正在输入的 @token；返回 { start, query } 或 null
function detectMentionToken() {
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const before = chatInput.value.slice(0, pos);
  const m = /(^|[\s（(])@([\w\u4e00-\u9fff.-]*)$/.exec(before);
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
    badge.className = "skill-kind-badge " + (c.type === "MCP" ? "skill-kind-mcp" : "skill-kind-skill");
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
  // 无 SKILL.md 技能时给出提示，避免误以为只能提及 MCP
  const skillCount = Object.keys(state.skills?.skills || {}).length;
  if (skillCount === 0) {
    const hint = document.createElement("div");
    hint.className = "mention-hint";
    hint.textContent = "暂无 Skill：在右侧「MCP / 技能」面板点击「导入技能」或「新建技能」添加 SKILL.md";
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

// 发送时解析消息中的 @提及：MCP 注入调用提示，Skill 注入 SKILL.md 定义内容
async function resolveMentions(text) {
  const mcp = state.skills?.mcp || {};
  const skills = state.skills?.skills || {};
  const tokens = [...new Set((text.match(/@[\w\u4e00-\u9fff.-]+/g) || []))];
  let context = "";
  for (const token of tokens) {
    const name = token.slice(1);
    if (mcp[name]) {
      context += `\n\n[提及 MCP 工具] ${name} — ${mcp[name]}。任务需要时请通过 skill_run 工具调用。`;
    } else if (skills[name]) {
      let injected = false;
      try {
        const res = await post("/skills/execute", { skill: name, params: {} });
        if (res.code === 0 && res.data?.content) {
          context += `\n\n[提及技能: ${name}]\n请遵循以下 SKILL.md 定义完成任务：\n${res.data.content}`;
          injected = true;
        }
      } catch (e) { /* 降级为描述 */ }
      if (!injected) {
        context += `\n\n[提及技能: ${name}] — ${skills[name]}`;
      }
    }
  }
  return context;
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

// ─ Markdown 渲染：统一使用 services/markdown.js（代码块保护 + HTML 转义 + 流式部分输出兼容） ─

function normalizeMessageForRender(msg) {
  const normalized = {
    ...msg,
    role: ["system", "user", "assistant"].includes(msg?.role) ? msg.role : "assistant",
    content: typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? ""),
  };

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

// ── 会话项目徽章：记录对话发起时打开的项目 ──────────

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
  convProjectEl.title = name ? `本对话发起于项目「${name}」` : "本对话发起时未打开项目";
}

// ── 消息渲染 ────────────────────────────────

function renderMessage(msg, index) {
  msg = normalizeMessageForRender(msg);
  const div = document.createElement("div");
  div.className = `msg msg-${msg.role}`;
  div.dataset.index = index;

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

    div.appendChild(actions);
  }

  // Highlight.js
  content.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs) hljs.highlightElement(block);
  });
  attachCodeCopyButtons(content);

  return div;
}

function renderAllMessages() {
  chatScroll.innerHTML = "";
  // 空对话不挂载徽章，保留 .chat-scroll:empty 的占位提示
  if (convProjectEl && state.messages.length) {
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
  cursor.setAttribute("aria-label", "研墨中");
  cursor.innerHTML = '<span class="thinking-text">研墨中</span><span class="thinking-dots"><span></span><span></span><span></span></span>';
  msgEl.querySelector(".msg-content")?.appendChild(cursor);
  return cursor;
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
    cursor.setAttribute("aria-label", "研墨中");
    cursor.innerHTML = '<span class="thinking-text">研墨中</span><span class="thinking-dots"><span></span><span></span><span></span></span>';
  }
}

// 为代码块右上角添加一键复制按钮（每次渲染重建，无需去重）
function attachCodeCopyButtons(container) {
  container?.querySelectorAll("pre").forEach(pre => {
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "⧉ 复制";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
        btn.textContent = "✓ 已复制";
      } catch (e) {
        btn.textContent = "复制失败";
      }
      setTimeout(() => { btn.textContent = "⧉ 复制"; }, 1500);
    });
    pre.appendChild(btn);
  });
}

function renderAssistantContent(contentEl, content, cursor = null) {
  if (!contentEl) return;
  updateStreamingCursor(cursor, content);
  const displayContent = detectToolCalls(content).length > 0 ? stripToolCalls(content) : content;
  contentEl.innerHTML = renderMarkdown(displayContent);
  if (cursor) contentEl.appendChild(cursor);
  contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
  attachCodeCopyButtons(contentEl);
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
  const structured = result?._structured;
  if (structured?._type === "file_edit") {
    const path = structured.file_path_rel || structured.file_name || structured.file || call?.params?.file_path || "";
    const errors = structured.errors?.length ? `\nWarnings: ${structured.errors.join("; ")}` : "";
    return `[工具 file_edit 结果]: ${result.output}\nTarget path: ${path}\nStatus: preview only; not written to disk until the user accepts.${errors}`;
  }
  if (structured?._type === "file_create") {
    const path = structured.file_path_rel || structured.file_name || structured.file || call?.params?.file_path || "";
    const errors = structured.errors?.length ? `\nWarnings: ${structured.errors.join("; ")}` : "";
    return `[工具 file_create 结果]: ${result.output}\nTarget path: ${path}\nStatus: preview only; not written to disk until the user accepts.${errors}`;
  }
  return `[工具 ${call.name} 结果]: ${result.output}`;
}

function looksLikeInspectionStall(content) {
  if (!content || detectToolCalls(content).length > 0) return false;
  const text = content.replace(/```[\s\S]*?```/g, " ");
  const offerOrQuestion = /(需要我|要我|是否需要|要不要|你需要|如果你需要|我可以(?:直接)?(?:动手|继续|帮你|给出)|是否要|吗[？?]?|呢[？?]?)/;
  if (offerOrQuestion.test(text)) return false;
  const intent = /(我(?:先|再|来|会|需要|可以)?(?:查看|看看|看一下|看一眼|浏览|读取|检查|了解|确认|分析)|让我(?:查看|看看|看一下|浏览|读取|检查|了解)|需要(?:查看|看看|看一下|浏览|读取|检查|了解|确认)|(?:先|再)(?:查看|看看|看一下|浏览|读取|检查|了解)|I'll\s+(?:check|inspect|look|read)|I\s+need\s+to\s+(?:check|inspect|look|read))/i;
  const target = /(项目|文件|目录|代码|路径|仓库|工程|结构|数据模型|管理器|核心|黑板|技能|上下文|project|file|directory|repo|code|path|folder|context|model|manager|schema)/i;
  const waiting = /(稍等|等一下|接下来|下一步|然后|之后|before|first|next)/i;
  return intent.test(text) && (target.test(text) || waiting.test(text));
}

function extractInspectionPath(content) {
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ");
  const quoted = text.match(/[“"']([^“"']+\.[A-Za-z0-9]{1,12})[”"']/);
  const pathLike = quoted?.[1] || text.match(/([A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@ -]+)*\.[A-Za-z0-9]{1,12})/)?.[1];
  if (!pathLike) return null;
  return pathLike.replace(/\\/g, "/").replace(/[，。；：、,.!?;:]+$/g, "");
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
  btnSend.textContent = isGenerating ? "停止" : (inputQueue.length ? `发送(${inputQueue.length})` : "发送");
  btnSend.classList.toggle("is-stopping", isGenerating);
  if (queueStatus) {
    queueStatus.classList.toggle("hidden", !isGenerating && inputQueue.length === 0);
    const statusText = queueStatus.querySelector(".queue-status-text");
    if (statusText) {
      statusText.textContent = `${isGenerating ? "正在生成" : "待发送"}${inputQueue.length ? ` · 队列 ${inputQueue.length}` : ""}`;
    }
  }
  if (chatInput) {
    const queueHint = inputQueue.length ? ` · 队列 ${inputQueue.length}` : "";
    chatInput.placeholder = isGenerating
      ? `继续输入可加入队列，点击停止中断输出${queueHint}`
      : (brainstormMode
        ? "灵感发散模式：输入想法、问题、素材或方向…"
        : "输入想法、问题、素材或方向… (Enter 发送, Shift+Enter 换行)");
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
    console.warn("知识库检索失败:", e);
    setKnowledgeContext([]);
    return [];
  }
}

function isShortReviewCandidate(content) {
  const cfg = state.autoReview || {};
  if (cfg.enabled === false) return false;
  if (!content || detectToolCalls(content).length > 0) return false;
  if (/^⚠/.test(String(content).trim())) return false;
  const clean = stripToolCalls(content).replace(/```[\s\S]*?```/g, " ").trim();
  const minChars = Math.max(20, Math.min(800, parseInt(cfg.minChars) || 120));
  return clean.length > 0 && clean.length <= minChars;
}

function looksLikeContinuationStall(content) {
  if (!isShortReviewCandidate(content)) return false;
  const text = String(content || "").replace(/```[\s\S]*?```/g, " ").trim();
  if (/(需要我|要我|是否需要|要不要|你需要|如果你需要|吗[？?]?|呢[？?]?)/.test(text)) return false;
  return /(我(?:来|会|先|再)?(?:整理|分析|构思|展开|推演|发散|梳理|想想)|接下来|下面|继续|开始)/.test(text);
}

function getLastVisibleUserContent() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg?.role === "user" && !isHiddenContextMessage(msg)) return msg.content || "";
  }
  return "";
}

function buildAutoReviewMessages(lastContent, mainModelId) {
  const history = state.messages
    .slice(0, -1)
    .map(m => ({ role: m.role, content: m.content }));
  history._modelId = mainModelId;
  const messages = buildMessages(history, state.constitution);
  const reviewInstruction = `

[自动推进审查模式]
你现在不是主回复模型，而是 SLATE 的审查模型。你和主模型共用以上完整上下文：项目宪法、长期记忆、知识库片段、隐藏工具结果、历史对话和工具说明都已经包含在内。

你的唯一任务：审查主模型刚才的短回复是否因为“想查看/读取/检查/了解/生成文件/调用技能”但没有实际调用工具而卡住。

输出规则：
- 如果短回复是正常确认、向用户提问、等待用户选择、说明已完成、闲聊回应，或没有必要读取/操作环境，输出空字符串。
- 如果需要推进，只输出一个或多个工具调用块，不要解释，不要寒暄，不要输出 Markdown。
- 优先选择最小必要动作：知道路径就读文件，只知道名称就找文件，不知道目标就浏览项目根目录；需要内置技能时使用 skill_run。
- 不要替主模型回答用户，不要总结工具结果，只负责补出应该执行的工具/技能调用。`;
  if (messages[0]?.role === "system") {
    messages[0].content += reviewInstruction;
  } else {
    messages.unshift({ role: "system", content: reviewInstruction.trim() });
  }
  messages.push({ role: "assistant", content: lastContent });
  messages.push({
    role: "user",
    content: "请审查上一条主模型短回复是否需要自动补工具/技能调用。只输出工具调用块或空字符串。",
  });
  return messages;
}

async function reviewShortReplyForToolCalls(lastContent, modelId, apiKey, baseUrl, signal = null) {
  if (!isShortReviewCandidate(lastContent)) return [];
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
      max_tokens: 900,
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

function appendSyntheticToolCalls(msgEl, calls) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return false;
  const blocks = calls.map(call => `◈◈◈${call.name}\n${JSON.stringify(call.params)}\n◈◆◆`).join("\n\n");
  lastMsg.content = `${lastMsg.content.trim()}\n\n${blocks}`;
  const contentEl = msgEl?.querySelector(".msg-content");
  renderAssistantContent(contentEl, lastMsg.content);
  return true;
}

async function autoAdvanceIfStalled(msgEl, modelId, apiKey, baseUrl, params) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
  if (lastMsg.autoAdvanced) return msgEl;

  const fileCandidate = extractFileCreateCandidate(lastMsg.content);
  if (fileCandidate) {
    lastMsg.autoAdvanced = true;
    appendSyntheticToolCalls(msgEl, [{ name: "file_create", params: fileCandidate }]);
    return msgEl;
  }

  if (!looksLikeInspectionStall(lastMsg.content)) return msgEl;

  lastMsg.autoAdvanced = true;

  const wantedPath = extractInspectionPath(lastMsg.content);
  if (wantedPath) {
    const hasDirectory = /[\\/]/.test(wantedPath);
    appendSyntheticToolCalls(msgEl, [{
      name: hasDirectory ? "project_read_file" : "project_find_file",
      params: hasDirectory ? { path: wantedPath } : { query: wantedPath },
    }]);
    return msgEl;
  }

  const queries = getInspectionQueries(lastMsg.content);
  appendSyntheticToolCalls(msgEl, [
    { name: "project_files", params: { path: "" } },
    ...queries.map(query => ({ name: "project_find_file", params: { query } })),
  ]);
  return msgEl;
}

async function autoReviewIfShortReply(msgEl, modelId, apiKey, baseUrl, signal = null) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return msgEl;
  if (signal?.aborted) return msgEl;
  if (lastMsg.autoReviewed) return msgEl;
  if (!isShortReviewCandidate(lastMsg.content)) return msgEl;

  lastMsg.autoReviewed = true;
  const calls = await reviewShortReplyForToolCalls(lastMsg.content, modelId, apiKey, baseUrl, signal);
  if (calls.length > 0) {
    appendSyntheticToolCalls(msgEl, calls);
  } else if (looksLikeContinuationStall(lastMsg.content)) {
    appendSyntheticToolCalls(msgEl, [{
      name: "knowledge_search",
      params: { query: `${getLastVisibleUserContent()}\n${lastMsg.content}`.trim(), limit: 3 },
    }]);
  }
  return msgEl;
}

// ── 工具调用渲染 ─────────────────────────────

function getToolCallLabel(call) {
  const skillName = call?.name === "skill_run" ? call.params?.skill : "";
  return skillName ? `Skill · ${skillName}` : `Tool · ${call?.name || "unknown"}`;
}

function getToolCallStatus(result) {
  if (result?.success === false) return "失败";
  if (result?._structured?._type === "file_edit") return "diff 预览";
  if (result?._structured?._type === "file_create") return "文件预览";
  return "已执行";
}

function renderToolCallGroup(items) {
  const normalized = (items || []).map(item => ({ call: item.call || item, result: item.result || item }));
  if (normalized.length === 0) return document.createDocumentFragment();
  if (normalized.length === 1) return renderToolCallCard(normalized[0].call, normalized[0].result);

  const group = document.createElement("details");
  group.className = "tool-call-group";

  const summary = document.createElement("summary");
  summary.className = "tool-call-group-summary";
  const labels = normalized.map(item => getToolCallLabel(item.call)).slice(0, 3).join(" / ");
  const title = document.createElement("span");
  title.textContent = `调用 ${normalized.length} 项`;
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
  const el = document.createElement("details");
  el.className = "tool-call-card";
  el.open = result?._structured?._type === "file_edit" || result?._structured?._type === "file_create";

  const header = document.createElement("summary");
  header.className = "tool-call-header";
  const label = document.createElement("span");
  label.className = "tool-call-name";
  label.textContent = getToolCallLabel(call);
  const status = document.createElement("span");
  status.className = result?.success === false ? "tool-call-status-pill failed" : "tool-call-status-pill";
  status.textContent = getToolCallStatus(result);
  header.appendChild(label);
  header.appendChild(status);
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-call-body";

  if (call.params && Object.keys(call.params).length > 0) {
    const input = document.createElement("div");
    input.className = "tool-call-input";
    if (call.name === "file_edit" && call.params.edits) {
      const brief = { file_path: call.params.file_path, edits_count: Array.isArray(call.params.edits) ? call.params.edits.length : 0 };
      input.textContent = JSON.stringify(brief, null, 2);
    } else if (call.name === "file_create" && call.params.content) {
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
  } else {
    const output = document.createElement("div");
    output.className = "tool-call-output tool-call-status";
    output.textContent = shouldHideToolOutput(call)
      ? (result.success === false ? `执行失败: ${result.output || "未知错误"}` : "已执行，结果仅作为上下文提供给模型。")
      : (result.output || "");
    body.appendChild(output);
  }

  el.appendChild(body);
  return el;
}

// ── 文件编辑 diff 查看器 ───────────────────

function renderFileEditDiff(data) {
  const wrap = document.createElement("div");
  wrap.className = "file-edit-diff";

  const head = document.createElement("div");
  head.className = "file-edit-diff-head";
  const s = data.stats || { lines_added: 0, lines_removed: 0 };
  head.innerHTML = `<span class="file-edit-file-name">${data.file_name || "未知文件"}</span>` +
    `<span class="file-edit-stats">+${s.lines_added} −${s.lines_removed}</span>`;
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

  // 只有有 diff 内容时才渲染 pre
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
  btnAccept.textContent = "✓ 接受";
  btnAccept.addEventListener("click", async () => {
    btnAccept.disabled = true;
    btnReject.disabled = true;
    btnCopy.disabled = true;
    try {
      const res = await post("/projects/apply-edit", { file_path: data.file, content: data.new_content });
      if (res.code === 0) {
        btnAccept.textContent = "✓ 已应用";
        btnAccept.classList.add("done");
        wrap.classList.add("file-edit-resolved");
      } else {
        btnAccept.textContent = "✗ 失败";
        btnAccept.classList.add("failed");
        btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false;
      }
    } catch (e) {
      btnAccept.textContent = "✗ 失败";
      btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false;
    }
  });

  const btnReject = document.createElement("button");
  btnReject.className = "file-edit-btn file-edit-btn-reject";
  btnReject.textContent = "✗ 拒绝";
  btnReject.addEventListener("click", () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true;
    btnReject.textContent = "✓ 已拒绝";
    wrap.classList.add("file-edit-rejected");
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "⧉ 复制 diff";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.diff);
      btnCopy.textContent = "✓ 已复制";
      setTimeout(() => { btnCopy.textContent = "⧉ 复制 diff"; }, 1500);
    } catch (e) {}
  });

  if (!data.file) btnAccept.disabled = true;

  actions.appendChild(btnAccept);
  actions.appendChild(btnReject);
  actions.appendChild(btnCopy);
  wrap.appendChild(actions);

  return wrap;
}

// ── 文件创建 diff 查看器 ───────────────────

function renderFileCreateDiff(data) {
  const wrap = document.createElement("div");
  wrap.className = "file-edit-diff file-create-diff";

  const head = document.createElement("div");
  head.className = "file-edit-diff-head";
  const s = data.stats || { lines: 0, chars: 0 };
  head.innerHTML = `<span class="file-edit-file-name">✨ ${data.file_name || "未知文件"}</span>` +
    `<span class="file-edit-stats file-create-badge">新文件 · ${s.lines} 行 · ${s.chars} 字符</span>`;
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
    warn.textContent = "⚠ 模型输出长度达到上限，文件内容可能在末尾被截断。请核对完整性后再创建，必要时让模型续写补全。";
    wrap.appendChild(warn);
  }

  // 只有有 diff 内容时才渲染 pre
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
  btnAccept.textContent = "✓ 创建";
  btnAccept.addEventListener("click", async () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true; btnDownload.disabled = true;
    try {
      const res = await post("/projects/create-file", { file_path: data.file, content: data.content });
      if (res.code === 0) {
        btnAccept.textContent = "✓ 已创建";
        btnAccept.classList.add("done");
        wrap.classList.add("file-edit-resolved");
      } else {
        btnAccept.textContent = "✗ 失败";
        btnAccept.classList.add("failed");
        btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false; btnDownload.disabled = false;
      }
    } catch (e) {
      btnAccept.textContent = "✗ 失败";
      btnAccept.disabled = false; btnReject.disabled = false; btnCopy.disabled = false; btnDownload.disabled = false;
    }
  });

  const btnReject = document.createElement("button");
  btnReject.className = "file-edit-btn file-edit-btn-reject";
  btnReject.textContent = "✗ 放弃";
  btnReject.addEventListener("click", () => {
    btnAccept.disabled = true; btnReject.disabled = true; btnCopy.disabled = true; btnDownload.disabled = true;
    btnReject.textContent = "✓ 已放弃";
    wrap.classList.add("file-edit-rejected");
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "file-edit-btn file-edit-btn-copy";
  btnCopy.textContent = "⧉ 复制内容";
  btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.content);
      btnCopy.textContent = "✓ 已复制";
      setTimeout(() => { btnCopy.textContent = "⧉ 复制内容"; }, 1500);
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

  actions.appendChild(btnAccept);
  actions.appendChild(btnReject);
  actions.appendChild(btnCopy);
  actions.appendChild(btnDownload);
  wrap.appendChild(actions);

  return wrap;
}

// ── 截断自动续写 ──────────────────────────────

/**
 * 输出达到模型单次上限时，工具调用块会在末尾缺闭合标记 ◈◆◆。
 * 此时自动追加一轮请求，让模型从断点继续输出，把续写内容拼回原消息；
 * 拼合成功后 detectToolCalls 能完整解析，不再触发截断警告。
 */
const MAX_CONTINUE_ROUNDS = 3;
const CONTINUE_PROMPT_TOOL = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释、前言或代码围栏标记，一直续写到工具调用以 ◈◆◆ 闭合为止。";
const CONTINUE_PROMPT_TEXT = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释或前言，一直续写到内容完整结束为止。";

async function continueTruncatedOutput(msgEl, content, modelId, apiKey, baseUrl, params, signal, finishReason = "") {
  const contentEl = msgEl?.querySelector(".msg-content");
  let fr = finishReason;
  for (let round = 1; round <= MAX_CONTINUE_ROUNDS; round++) {
    // 工具块未闭合 或 模型自报 finish_reason=length 都视为被截断
    const stuck = hasTruncatedTail(content) || fr === "length";
    if (signal?.aborted || !stuck) break;
    const contPrompt = hasTruncatedTail(content) ? CONTINUE_PROMPT_TOOL : CONTINUE_PROMPT_TEXT;
    try {
      const { toast } = await import("../app.js?v=20260808-6");
      toast(`输出达到长度上限，自动续写中（${round}/${MAX_CONTINUE_ROUNDS}）…`);
    } catch {}

    // 历史 + 被截断的助手消息原文 + 续写指令（模型需看到断点才能接续）
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history.push({ role: "assistant", content });
    history.push({ role: "user", content: contPrompt });
    history._modelId = modelId;
    const messages = buildMessages(history, state.constitution);

    const cursor = msgEl ? addStreamingCursor(msgEl) : null;
    const contMeta = {};
    try {
      for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params?.temperature ?? 0.7, max_tokens: params?.max_tokens ?? getOutputMaxTokens(), stream: true, signal, meta: contMeta })) {
        content += chunk;
        markActivity();
        if (contentEl) renderAssistantContent(contentEl, content, cursor);
        autoScroll();
      }
      fr = contMeta.finishReason || "";
    } catch (err) {
      if (cursor) removeStreamingCursor(cursor);
      if (!isAbortError(err)) console.warn("自动续写失败:", err);
      break;
    }
    if (cursor) removeStreamingCursor(cursor);
  }
  if (contentEl) renderAssistantContent(contentEl, content);
  return content;
}

async function runToolLoop(msgEl, modelId, apiKey, baseUrl, params = { temperature: 0.7, max_tokens: getOutputMaxTokens() }, signal = null, maxRounds = 5) {
  const harnessOn = state.harness?.enabled === true;
  const MAX_TODO_NUDGES = 2; // TODOLIST 闭环催办上限，防止无限循环
  let todoNudges = 0;
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) break;
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") break;

    const calls = detectToolCalls(lastMsg.content);
    let nudged = false;
    if (calls.length === 0) {
      // Harness 闭环强制：模型想收尾但 TODOLIST 仍有未完成项 → 注入系统催办继续推进
      if (harnessOn && todoNudges < MAX_TODO_NUDGES && round < maxRounds - 1) {
        const pending = getConversationTodos(state.currentConversationId)
          .filter(t => t.status !== "done" && t.status !== "blocked");
        if (pending.length > 0) {
          todoNudges++;
          setHarnessProgress(`Harness 闭环校验 · 清单剩余 ${pending.length} 项，自动催办（${todoNudges}/${MAX_TODO_NUDGES}）`);
          addMessage({
            role: "user",
            content: `[系统校验] 任务尚未完成，TODOLIST 仍有 ${pending.length} 项未了结：\n${pending.map(t => `- [${t.id}] ${t.content}`).join("\n")}\n请继续执行剩余事项（完成后调用 todo_manage 标记 done），全部了结后再输出汇报与追溯。`,
            model: "[todo_enforce]",
            hidden: true,
          });
          nudged = true;
        }
      }
      if (!nudged) break;
    }

    if (harnessOn) {
      const todos = getConversationTodos(state.currentConversationId);
      const doneCount = todos.filter(t => t.status === "done").length;
      const todoText = todos.length ? ` · 清单 ${doneCount}/${todos.length}` : "";
      setHarnessProgress(`Harness 自主执行 · 第 ${round + 1}/${maxRounds} 轮${todoText}`);
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
      const results = await executeToolCalls(calls);
      markActivity();
      if (signal?.aborted) break;

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

      // Keep tool results in model context without rendering them as chat bubbles.
      const toolResultText = results.map((r, i) => formatToolResultForModel(calls[i], r)).join("\n\n");
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
    if (signal?.aborted) break;
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history._modelId = modelId;
    const messages = buildMessages(history, state.constitution);

    let followContent2 = "";
    const followMeta = {};
    try {
      for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature ?? 0.7, max_tokens: params.max_tokens ?? getOutputMaxTokens(), stream: true, signal, meta: followMeta })) {
        followContent2 += chunk;
        markActivity();
        renderAssistantContent(followContent, followContent2, cursor);
        autoScroll();
      }
    } catch (err) {
      followContent2 = isAbortError(err)
        ? (followContent2 ? `${followContent2}\n\n[已停止]` : "已停止")
        : `⚠ 续写失败: ${err.message}`;
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

    if (signal?.aborted) break;
    msgEl = await autoAdvanceIfStalled(followEl, modelId, apiKey, baseUrl, params);
    msgEl = await autoReviewIfShortReply(msgEl, modelId, apiKey, baseUrl, signal);
  }
  if (maxRounds > 5) setHarnessProgress(null);
}

// ── 发送消息 ────────────────────────────────

async function sendMessage(queuedPayload = null) {
  if (isGenerating) {
    if (queuedPayload) inputQueue.push(queuedPayload);
    else if (captureCurrentInputForQueue()) {
      const { toast } = await import("../app.js?v=20260808-6");
      toast(`已加入输入队列（${inputQueue.length}）`);
    }
    updateSendState();
    return;
  }

  const text = queuedPayload?.text ?? chatInput.value.trim();
  const filesForMessage = queuedPayload?.files ?? [...pendingFiles];
  if (!text && filesForMessage.length === 0) return;

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
    for (const f of filesForMessage) {
      fileMeta.push({ name: f.name, type: f.type, thumbnail: f.type === "image" ? f.content : null });
      if (f.type === "image") {
        fileContext += `\n[图片: ${f.name}]`;
      } else if (f.type === "csv") {
        fileContext += `\n\n[文件: ${f.name}]\n${f.content}`;
      } else {
        fileContext += `\n\n[文件: ${f.name}]\n\`\`\`\n${f.content.slice(0, 10000)}\n\`\`\``;
      }
    }
  }

  const mentionContext = await resolveMentions(text);
  const harnessOn = state.harness?.enabled === true;
  const fullText = (harnessOn ? HARNESS_PREFIX : "") + text + mentionContext + fileContext;
  await refreshKnowledgeContext(fullText);
  // display：气泡只展示用户输入的原文；注入的 Skill 定义 / Harness 指令 / 文件内容只进模型上下文，与后端持久化的干净文本保持一致
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
  if (brainstormMode) {
    const lastUser = historyForAdapter[historyForAdapter.length - 1];
    if (lastUser?.role === "user") {
      lastUser.content = `[头脑风暴模式]\n请先给出多个可能方向，再收束为最值得推进的 1-3 个建议。保持可执行、具体。\n\n${lastUser.content}`;
    }
  }
  historyForAdapter._modelId = modelId;
  const messages = buildMessages(historyForAdapter, state.constitution);

  let fullContent = "";
  const streamMeta = {};
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true, signal, meta: streamMeta })) {
      fullContent += chunk;
      markActivity();
      const contentEl = msgEl.querySelector(".msg-content");
      renderAssistantContent(contentEl, fullContent, cursor);
      autoScroll();
    }
  } catch (err) {
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : `⚠ 请求失败: ${err.message}`;
  }

  removeStreamingCursor(cursor);

  // 输出被截断（工具块未闭合 或 finish_reason=length）→ 自动续写拼回本条消息
  if (!signal.aborted && (hasTruncatedTail(fullContent) || streamMeta.finishReason === "length")) {
    fullContent = await continueTruncatedOutput(msgEl, fullContent, modelId, apiKey, baseUrl, params, signal, streamMeta.finishReason || "");
  }
  updateLastAssistantMessage(fullContent);

  // 估算并记录用量
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
    msgEl = await autoReviewIfShortReply(msgEl, modelId, apiKey, baseUrl, signal);
  }

  // 工具调用循环（默认 5 轮；Harness 模式提升到 maxRounds）
  const toolRounds = harnessOn ? Math.max(10, Math.min(50, state.harness?.maxRounds || 20)) : 5;
  if (harnessOn) setHarnessProgress(`自主执行已启动 · 最多 ${toolRounds} 轮工具调用，可随时点发送键停止`);
  if (!signal.aborted) await runToolLoop(msgEl, modelId, apiKey, baseUrl, params, signal, toolRounds);
  if (harnessOn) setHarnessProgress(null);

  // 后台检查上下文压缩
  if (!signal.aborted) {
    checkAndCompress(modelId, apiKey, baseUrl);
    autoRefineMemoryAndProfile({ silent: true });
  }

  } catch (err) {
    console.error("发送失败:", err);
    const { toast } = await import("../app.js?v=20260808-6");
    toast(isAbortError(err) ? "已停止输出" : `发送失败: ${err.message}`);
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

// ── 上下文压缩 ──────────────────────────────

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
    const { toast } = await import("../app.js?v=20260808-6");
    toast(`上下文已压缩：${compress_count} 条消息 → 摘要`);
  } catch (e) {
    console.warn("上下文压缩检查失败:", e);
  }
}

function toggleBrainstormMode() {
  brainstormMode = !brainstormMode;
  state.brainstormMode = brainstormMode;
  btnBrainstorm?.classList.toggle("active", brainstormMode);
  updateSendState();
}

function openCompressModal() {
  if (!compressModal) return;
  if (state.messages.length < 4) {
    import("../app.js?v=20260808-6").then(({ toast }) => toast("当前对话还不需要压缩"));
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

    const { toast } = await import("../app.js?v=20260808-6");
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
    toast(`上下文已压缩：${res.data.compress_count || 0} 条消息 → 摘要`);
  } catch (e) {
    const { toast } = await import("../app.js?v=20260808-6");
    toast("压缩失败: " + e.message);
  } finally {
    btnDoCompress.disabled = false;
    btnDoCompress.textContent = oldText;
  }
}

// ── 对话侧边栏 ──────────────────────────────

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
      usageInfo.textContent = `${msgCount}条 · ~${totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + "K" : totalTokens} tok`;
      titleWrap.appendChild(usageInfo);
    }

    item.appendChild(titleWrap);

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
    item.appendChild(delBtn);

    item.addEventListener("click", () => switchConversation(conv.id));
    convList.appendChild(item);
  }
}

async function switchConversation(convId) {
  // 保存当前对话用量
  if (state.currentConversationId) {
    setConversationUsage(state.currentConversationId, { ...state.usage });
  }
  state.currentConversationId = convId;
  const res = await get(`/chat/conversations/${convId}/messages`);
  if (res.code === 0) setMessages((res.data || []).map(normalizeMessageForRender));

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

  const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "K" : n.toLocaleString();

  usageBar.innerHTML = `
    <span class="usage-model" title="${state.currentModel?.base_url || ''}">${modelName}${hasKey ? "" : " ⚠"}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">消息 ${u.messageCount}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">输入 ${fmtTok(u.promptTokens)}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">输出 ${fmtTok(u.completionTokens)}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">总计 ${fmtTok(u.totalTokens)}</span>
    ${ctxLimit > 0 ? `<span class="usage-sep">|</span><span class="usage-stat ${ctxPercent > 80 ? "usage-warn" : ""}">上下文 ${ctxPercent}% / ${Math.round(ctxLimit / 1000)}K</span>` : ""}
  `;
}

// ── 文件附件处理 ────────────────────────────

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
    icon.textContent = f.type === "image" ? "🖼" : "📄";
    chip.appendChild(icon);

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
      const { toast } = await import("../app.js?v=20260808-6");
      toast(`文件过大，已跳过: ${file.name}`);
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
    const { toast } = await import("../app.js?v=20260808-6");
    toast("正在生成中，请稍候");
    return;
  }
  const idx = state.messages.indexOf(msg);
  if (idx < 0) return;
  const after = state.messages.slice(idx + 1).filter(m => !m.hidden && m.role !== "system");
  if (after.length > 0) {
    const { toast } = await import("../app.js?v=20260808-6");
    toast("只能重新生成最后一条助手回复");
    return;
  }
  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    const { toast } = await import("../app.js?v=20260808-6");
    toast("请先在设置中配置该模型的 API Key");
    return;
  }
  const params = getDefaultParams(modelId);

  const history = state.messages.slice(0, idx)
    .filter(m => !m.hidden && m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));
  if (!history.some(m => m.role === "user")) {
    const { toast } = await import("../app.js?v=20260808-6");
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
  const regenMeta = {};
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true, signal, meta: regenMeta })) {
      fullContent += chunk;
      markActivity();
      renderAssistantContent(contentEl, fullContent, cursor);
      autoScroll();
    }
  } catch (err) {
    fullContent = isAbortError(err)
      ? (fullContent ? `${fullContent}\n\n[已停止]` : "已停止")
      : `⚠ 请求失败: ${err.message}`;
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
  convSidebar = document.getElementById("conv-sidebar");
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
      const { toast } = await import("../app.js?v=20260808-6");
      toast("连接长时间无响应，已自动中断，可重试");
    } catch {}
  }, 15000);

  // 智能滚动跟随：用户向上滚动浏览历史时不强制拉底
  chatScroll.addEventListener("scroll", () => {
    stickToBottom = isNearBottom();
  });

  btnSend.addEventListener("click", () => {
    if (isGenerating) stopGeneration();
    else sendMessage();
  });
  btnBrainstorm?.addEventListener("click", toggleBrainstormMode);

  // Harness 自主执行开关
  btnHarness = document.getElementById("btn-harness");
  btnHarness?.classList.toggle("active", state.harness?.enabled === true);
  btnHarness?.addEventListener("click", async () => {
    state.harness = state.harness || { enabled: false, maxRounds: 20 };
    state.harness.enabled = !state.harness.enabled;
    btnHarness.classList.toggle("active", state.harness.enabled);
    savePersistent();
    const { toast } = await import("../app.js?v=20260808-6");
    toast(state.harness.enabled ? "Harness 已开启：目标→计划→执行→验证→汇报→追溯 六阶段自主闭环，大任务自动建立 TODOLIST" : "Harness 已关闭");
  });
  harnessStatusEl = document.createElement("div");
  harnessStatusEl.className = "harness-status hidden";
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", harnessStatusEl);
  todoPanelEl = document.createElement("div");
  todoPanelEl.className = "todo-panel hidden";
  document.getElementById("chat-input-area")?.insertAdjacentElement("beforebegin", todoPanelEl);
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
    renderConvList(state.conversations);
    renderTodoPanel();
    updateConvProjectBadge();
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
}

export { initChat, sendMessage, renderMarkdown };
