/**
 * SLATE 聊天组件 v4：文件上传、上下文压缩、用量显示、流式输出
 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations, getModelKey, addUsage, estimateContextTokens, resetUsage, restoreUsageForConversation, setConversationUsage } from "../store.js?v=20260801-04";
import { get, post, del, patch, streamChat, upload } from "../services/api.js?v=20260801-04";
import { buildMessages, getDefaultParams } from "../services/adapter.js?v=20260801-04";
import { detectToolCalls, stripToolCalls, executeToolCalls } from "../services/tools.js?v=20260801-04";
import { openMemoryModal, openSnippetModal, autoRefineMemoryAndProfile } from "./memory.js?v=20260801-04";

let chatScroll, chatInput, btnSend, btnNewChat, convList, usageBar, convSidebar;
let filePreviewArea, btnAttachFile, fileInput;
let btnBrainstorm, btnCompress, btnMemory, btnSnippets, btnDoCompress, compressModal;
let pendingFiles = []; // { name, size, content, type }
let brainstormMode = false;

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

// ─ 简易 Markdown → HTML ────────────────────

function renderMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="language-${lang || "text"}">${escaped}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n/g, "<br>");

  html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, (match) => {
    const items = match.replace(/<br>/g, "");
    return `<ul>${items}</ul>`;
  });
  return html;
}

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
  content.innerHTML = renderMarkdown(msg.content);
  div.appendChild(content);

  if (Array.isArray(msg.toolResults)) {
    for (const item of msg.toolResults) {
      div.appendChild(renderToolCallCard(item.call || item, item.result || item));
    }
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
        await navigator.clipboard.writeText(msg.content);
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);
    div.appendChild(actions);
  }

  // Highlight.js
  content.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs) hljs.highlightElement(block);
  });

  return div;
}

function renderAllMessages() {
  chatScroll.innerHTML = "";
  state.messages.forEach((msg, i) => {
    if (isHiddenContextMessage(msg)) return;
    chatScroll.appendChild(renderMessage(msg, i));
  });
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

function renderAssistantContent(contentEl, content, cursor = null) {
  if (!contentEl) return;
  updateStreamingCursor(cursor, content);
  const displayContent = detectToolCalls(content).length > 0 ? stripToolCalls(content) : content;
  contentEl.innerHTML = renderMarkdown(displayContent);
  if (cursor) contentEl.appendChild(cursor);
  contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
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
  return ["skill_run", "project_files", "project_read_file", "project_find_file", "board_read", "chat_context"].includes(call?.name);
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

// ── 工具调用渲染 ─────────────────────────────

function renderToolCallCard(call, result) {
  const el = document.createElement("div");
  el.className = "tool-call-card";

  const header = document.createElement("div");
  header.className = "tool-call-header";
  const skillName = call.name === "skill_run" ? call.params?.skill : "";
  header.textContent = skillName ? `Skill · ${skillName}` : `Tool · ${call.name}`;
  el.appendChild(header);

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
    el.appendChild(input);
  }

  // 检测结构化结果
  if (result._structured && result._structured._type === "file_edit") {
    el.appendChild(renderFileEditDiff(result._structured));
  } else if (result._structured && result._structured._type === "file_create") {
    el.appendChild(renderFileCreateDiff(result._structured));
  } else {
    const output = document.createElement("div");
    output.className = "tool-call-output tool-call-status";
    output.textContent = shouldHideToolOutput(call)
      ? (result.success === false ? `执行失败: ${result.output || "未知错误"}` : "已执行，结果仅作为上下文提供给模型。")
      : (result.output || "");
    el.appendChild(output);
  }

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

async function runToolLoop(msgEl, modelId, apiKey, baseUrl, params = { temperature: 0.7, max_tokens: 4096 }) {
  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") break;

    const calls = detectToolCalls(lastMsg.content);
    if (calls.length === 0) break;

    // 更新最后一条 assistant 消息（去掉工具标记）
    const cleanContent = stripToolCalls(lastMsg.content);
    lastMsg.content = cleanContent;

    // 重新渲染当前消息（去掉标记）
    const contentEl = msgEl.querySelector(".msg-content");
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(cleanContent);
      contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
    }

    // 执行工具
    const results = await executeToolCalls(calls);

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
    chatScroll.scrollTop = chatScroll.scrollHeight;

    // Keep tool results in model context without rendering them as chat bubbles.
    const toolResultText = results.map((r, i) => formatToolResultForModel(calls[i], r)).join("\n\n");
    addMessage({ role: "user", content: toolResultText, model: "[tool_results]", hidden: true });

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
    chatScroll.scrollTop = chatScroll.scrollHeight;

    // 流式续写
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history._modelId = modelId;
    const messages = buildMessages(history, state.constitution);

    let followContent2 = "";
    try {
      for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: 0.7, max_tokens: 4096, stream: true })) {
        followContent2 += chunk;
        renderAssistantContent(followContent, followContent2, cursor);
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
    } catch (err) {
      followContent2 = `⚠ 续写失败: ${err.message}`;
    }

    removeStreamingCursor(cursor);
    updateLastAssistantMessage(followContent2);
    renderAssistantContent(followContent, followContent2);

    // 持久化
    if (state.currentConversationId) {
      const saved = await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: followContent2, model: modelId });
      if (saved.code === 0 && saved.data?.id) followUp.id = saved.data.id;
    }

    msgEl = await autoAdvanceIfStalled(followEl, modelId, apiKey, baseUrl, params);
  }
}

// ── 发送消息 ────────────────────────────────

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && pendingFiles.length === 0) return;

  if (!state.currentConversationId) {
    const res = await post("/chat/conversations", { title: (text || pendingFiles[0]?.name || "新对话").slice(0, 30) });
    if (res.code === 0) {
      state.currentConversationId = res.data.id;
      await refreshConversationList();
    }
  }

  chatInput.value = "";
  chatInput.style.height = "auto";
  btnSend.disabled = true;

  // 收集文件内容
  const fileMeta = [];
  let fileContext = "";
  if (pendingFiles.length > 0) {
    for (const f of pendingFiles) {
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

  const fullText = text + fileContext;
  const userMsg = { role: "user", content: fullText, model: "", files: fileMeta.length > 0 ? fileMeta : undefined };
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
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const modelId = state.currentModel?.id || "gpt-4o";
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
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true })) {
      fullContent += chunk;
      const contentEl = msgEl.querySelector(".msg-content");
      renderAssistantContent(contentEl, fullContent, cursor);
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  } catch (err) {
    fullContent = `⚠ 请求失败: ${err.message}`;
  }

  removeStreamingCursor(cursor);
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

  msgEl = await autoAdvanceIfStalled(msgEl, modelId, apiKey, baseUrl, params);

  // 工具调用循环（最多 5 轮）
  await runToolLoop(msgEl, modelId, apiKey, baseUrl, params);

  // 后台检查上下文压缩
  checkAndCompress(modelId, apiKey, baseUrl);
  autoRefineMemoryAndProfile({ silent: true });

  // 清除已发送的文件附件
  pendingFiles = [];
  renderFilePreview();

  btnSend.disabled = false;
  chatInput.focus();
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
    const { toast } = await import("../app.js?v=20260801-04");
    toast(`上下文已压缩：${compress_count} 条消息 → 摘要`);
  } catch (e) {
    console.warn("上下文压缩检查失败:", e);
  }
}

function toggleBrainstormMode() {
  brainstormMode = !brainstormMode;
  state.brainstormMode = brainstormMode;
  btnBrainstorm?.classList.toggle("active", brainstormMode);
  chatInput.placeholder = brainstormMode
    ? "头脑风暴模式：先发散想法，再收束结论…"
    : "输入消息… (Enter 发送, Shift+Enter 换行)";
}

function openCompressModal() {
  if (!compressModal) return;
  if (state.messages.length < 4) {
    import("../app.js?v=20260801-04").then(({ toast }) => toast("当前对话还不需要压缩"));
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

    const { toast } = await import("../app.js?v=20260801-04");
    if (res.code !== 0) {
      toast("压缩失败: " + (res.message || "未知错误"));
      return;
    }
    if (!res.data?.need_compress) {
      toast("当前对话还不需要压缩");
      closeCompressModal();
      return;
    }

    const modelId = state.currentModel?.id || "gpt-4o";
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
    const { toast } = await import("../app.js?v=20260801-04");
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
      const { toast } = await import("../app.js?v=20260801-04");
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

  btnSend.addEventListener("click", sendMessage);
  btnBrainstorm?.addEventListener("click", toggleBrainstormMode);
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
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";
  });

  btnNewChat.addEventListener("click", () => {
    state.currentConversationId = null;
    setMessages([]);
    resetUsage();
    renderConvList(state.conversations);
  });

  subscribe("messages", renderAllMessages);
  subscribe("conversations", (convs) => renderConvList(convs));
  subscribe("usage", renderUsageBar);
  subscribe("model", renderUsageBar);

  refreshConversationList();
  renderUsageBar();
}

export { initChat, sendMessage, renderMarkdown };
