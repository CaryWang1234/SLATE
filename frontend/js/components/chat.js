/**
 * SLATE 聊天组件 v2：对话侧边栏、消息操作、流式输出
 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations } from "../store.js";
import { get, post, del, streamChat } from "../services/api.js";
import { buildMessages, getDefaultParams } from "../services/adapter.js";

let chatScroll, chatInput, btnSend, btnNewChat, convList;

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

// ── 发送消息 ────────────────────────────────

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  if (!state.currentConversationId) {
    const res = await post("/chat/conversations", { title: text.slice(0, 30) });
    if (res.code === 0) {
      state.currentConversationId = res.data.id;
      await refreshConversationList();
    }
  }

  chatInput.value = "";
  chatInput.style.height = "auto";
  btnSend.disabled = true;

  const userMsg = { role: "user", content: text, model: "" };
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

  const modelId = state.currentModel?.id || state.customModelName || "gpt-4o";
  const baseUrl = state.currentModel?.base_url || state.customBaseUrl || undefined;
  const params = getDefaultParams(modelId);
  const historyForAdapter = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  historyForAdapter._modelId = modelId;
  const messages = buildMessages(historyForAdapter, state.constitution);

  let fullContent = "";
  try {
    for await (const chunk of streamChat({ model: modelId, messages, api_key: state.apiKey, base_url: baseUrl, temperature: params.temperature, max_tokens: params.max_tokens, stream: true })) {
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

  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) {
    contentEl.innerHTML = renderMarkdown(fullContent);
    contentEl.querySelectorAll("pre code").forEach(b => { if (window.hljs) hljs.highlightElement(b); });
  }

  if (state.currentConversationId) {
    await post(`/chat/conversations/${state.currentConversationId}/messages`, { role: "assistant", content: fullContent, model: modelId });
  }

  btnSend.disabled = false;
  chatInput.focus();
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

// ── 初始化 ──────────────────────────────────

function initChat() {
  chatScroll = document.getElementById("chat-messages");
  chatInput = document.getElementById("chat-input");
  btnSend = document.getElementById("btn-send");
  btnNewChat = document.getElementById("btn-new-chat");
  convList = document.getElementById("conv-list");

  btnSend.addEventListener("click", sendMessage);

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
    renderConvList(state.conversations);
  });

  subscribe("messages", renderAllMessages);
  subscribe("conversations", (convs) => renderConvList(convs));

  refreshConversationList();
}

export { initChat, sendMessage, renderMarkdown };
