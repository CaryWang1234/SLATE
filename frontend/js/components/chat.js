/**
 * SLATE 聊天组件 v4：文件上传、上下文压缩、用量显示、流式输出
 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations, getModelKey, addUsage, estimateContextTokens, resetUsage } from "../store.js";
import { get, post, del, streamChat, upload } from "../services/api.js";
import { buildMessages, getDefaultParams } from "../services/adapter.js";
import { detectToolCalls, stripToolCalls, executeToolCalls } from "../services/tools.js";

let chatScroll, chatInput, btnSend, btnNewChat, convList, usageBar, convSidebar;
let filePreviewArea, btnAttachFile, fileInput;
let pendingFiles = []; // { name, size, content, type }

// ── 简易 Markdown → HTML ────────────────────

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

// ── 消息渲染 ────────────────────────────────

function renderMessage(msg, index) {
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
    chatScroll.appendChild(renderMessage(msg, i));
  });
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ── 流式光标 ────────────────────────────────

function addStreamingCursor(msgEl) {
  const cursor = document.createElement("span");
  cursor.className = "streaming-cursor";
  msgEl.querySelector(".msg-content")?.appendChild(cursor);
  return cursor;
}

function removeStreamingCursor(cursor) {
  cursor?.parentNode?.removeChild(cursor);
}

// ── 工具调用渲染 ─────────────────────────────

function renderToolCallCard(call, result) {
  const el = document.createElement("div");
  el.className = "tool-call-card";

  const header = document.createElement("div");
  header.className = "tool-call-header";
  header.textContent = `⚙ ${call.name}`;
  el.appendChild(header);

  if (call.params && Object.keys(call.params).length > 0) {
    const input = document.createElement("div");
    input.className = "tool-call-input";
    input.textContent = JSON.stringify(call.params, null, 2);
    el.appendChild(input);
  }

  const output = document.createElement("div");
  output.className = "tool-call-output";
  output.textContent = result.output || "";
  el.appendChild(output);

  return el;
}

async function runToolLoop(msgEl, modelId, apiKey, baseUrl) {
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
    for (let i = 0; i < calls.length; i++) {
      chatScroll.appendChild(renderToolCallCard(calls[i], results[i]));
    }
    chatScroll.scrollTop = chatScroll.scrollHeight;

    // 构建工具结果消息
    const toolResultText = results.map((r, i) =>
      `[工具 ${calls[i].name} 结果]: ${r.output}`
    ).join("\n\n");
    addMessage({ role: "user", content: toolResultText, model: "[tool_results]" });

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
        followContent.innerHTML = renderMarkdown(followContent2);
        followContent.appendChild(cursor);
        followContent.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
    } catch (err) {
      followContent2 = `⚠ 续写失败: ${err.message}`;
    }

    removeStreamingCursor(cursor);
    updateLastAssistantMessage(followContent2);
    followContent.innerHTML = renderMarkdown(followContent2);
    followContent.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });

    // 持久化
    if (state.currentConversationId) {
      await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: followContent2, model: modelId });
    }

    msgEl = followEl; // 下一轮用新的元素
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
    await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "user", content: text, model: "" });
  }

  const assistantMsg = { role: "assistant", content: "", model: state.currentModel?.name || "" };
  addMessage(assistantMsg);

  const msgEl = renderMessage(assistantMsg, state.messages.length - 1);
  chatScroll.appendChild(msgEl);
  const cursor = addStreamingCursor(msgEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const modelId = state.currentModel?.id || "gpt-4o";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);
  const params = getDefaultParams(modelId);
  const historyForAdapter = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  historyForAdapter._modelId = modelId;
  const messages = buildMessages(historyForAdapter, state.constitution);

  let fullContent = "";
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true })) {
      fullContent += chunk;
      const contentEl = msgEl.querySelector(".msg-content");
      if (contentEl) {
        contentEl.innerHTML = renderMarkdown(fullContent);
        contentEl.appendChild(cursor);
        contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
      }
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

  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) {
    contentEl.innerHTML = renderMarkdown(fullContent);
    contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
  }

  if (state.currentConversationId) {
    await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: fullContent, model: modelId });
  }

  // 工具调用循环（最多 5 轮）
  await runToolLoop(msgEl, modelId, apiKey, baseUrl);

  // 后台检查上下文压缩
  checkAndCompress(modelId, apiKey, baseUrl);

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
    const { toast } = await import("../app.js");
    toast(`上下文已压缩：${compress_count} 条消息 → 摘要`);
  } catch (e) {
    console.warn("上下文压缩检查失败:", e);
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

    const title = document.createElement("span");
    title.className = "conv-item-title";
    title.textContent = conv.title || conv.id;
    item.appendChild(title);

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
  state.currentConversationId = convId;
  const res = await get(`/chat/conversations/${convId}/messages`);
  if (res.code === 0) setMessages(res.data);
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

  usageBar.innerHTML = `
    <span class="usage-model" title="${state.currentModel?.base_url || ''}">${modelName}${hasKey ? "" : " ⚠"}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">消息 ${u.messageCount}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">上下文 ~${ctxTokens.toLocaleString()} tok</span>
    ${ctxLimit > 0 ? `<span class="usage-sep">|</span><span class="usage-stat ${ctxPercent > 80 ? "usage-warn" : ""}">${ctxPercent}% / ${Math.round(ctxLimit / 1000)}K</span>` : ""}
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
      const { toast } = await import("../app.js");
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

  btnSend.addEventListener("click", sendMessage);

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
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
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
