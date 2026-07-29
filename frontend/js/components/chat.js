/**
 * SLATE 聊天组件：气泡渲染、流式输出、模型切换
 */

import { state, subscribe, addMessage, updateLastAssistantMessage, setMessages, setConversations } from "../store.js";
import { get, post, del, streamChat } from "../services/api.js";
import { buildMessages, getDefaultParams } from "../services/adapter.js";

// ── DOM 引用 ─────────────────────────────────

let chatScroll, chatInput, btnSend, convSelect, btnNewChat;

/**
 * 简单 Markdown 转 HTML（不引入外部库）
 */
function renderMarkdown(text) {
  if (!text) return "";
  let html = text
    // 代码块
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="language-${lang || "text"}">${escaped}</code></pre>`;
    })
    // 行内代码
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // 加粗
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // 斜体
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // 标题
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // 引用
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    // 无序列表
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    // 换行
    .replace(/\n/g, "<br>");

  // 包裹连续 li
  html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, (match) => {
    const items = match.replace(/<br>/g, "");
    return `<ul>${items}</ul>`;
  });

  return html;
}

/**
 * 渲染单条消息
 */
function renderMessage(msg) {
  const div = document.createElement("div");
  div.className = `msg msg-${msg.role}`;

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

  // Highlight.js 高亮代码块
  content.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs) hljs.highlightElement(block);
  });

  return div;
}

/**
 * 重绘所有消息
 */
function renderAllMessages() {
  chatScroll.innerHTML = "";
  for (const msg of state.messages) {
    chatScroll.appendChild(renderMessage(msg));
  }
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

/**
 * 添加流式光标
 */
function addStreamingCursor(msgEl) {
  const cursor = document.createElement("span");
  cursor.className = "streaming-cursor";
  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) contentEl.appendChild(cursor);
  return cursor;
}

/**
 * 移除流式光标
 */
function removeStreamingCursor(cursor) {
  if (cursor && cursor.parentNode) {
    cursor.parentNode.removeChild(cursor);
  }
}

/**
 * 发送消息
 */
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  // 确保有对话
  if (!state.currentConversationId) {
    const res = await post("/chat/conversations", { title: text.slice(0, 30) });
    if (res.code === 0) {
      state.currentConversationId = res.data.id;
      await refreshConversationList();
    }
  }

  // 清空输入
  chatInput.value = "";
  chatInput.style.height = "auto";
  btnSend.disabled = true;

  // 添加用户消息
  const userMsg = { role: "user", content: text, model: "" };
  addMessage(userMsg);

  // 保存到后端
  if (state.currentConversationId) {
    await post(`/chat/conversations/${state.currentConversationId}/messages`, {
      role: "user", content: text, model: "",
    });
  }

  // 创建助手消息占位
  const assistantMsg = { role: "assistant", content: "", model: state.currentModel?.name || "" };
  addMessage(assistantMsg);

  // 渲染占位消息
  const msgEl = renderMessage(assistantMsg);
  chatScroll.appendChild(msgEl);
  const cursor = addStreamingCursor(msgEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  // 构建请求
  const modelId = state.currentModel?.id || state.customModelName || "gpt-4o";
  const baseUrl = state.currentModel?.base_url || state.customBaseUrl || undefined;
  const params = getDefaultParams(modelId);
  const historyForAdapter = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  historyForAdapter._modelId = modelId;
  const messages = buildMessages(historyForAdapter, state.constitution);

  let fullContent = "";

  try {
    const payload = {
      model: modelId,
      messages,
      api_key: state.apiKey,
      base_url: baseUrl,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      stream: true,
    };

    for await (const chunk of streamChat(payload)) {
      fullContent += chunk;
      // 更新 DOM（增量）
      const contentEl = msgEl.querySelector(".msg-content");
      if (contentEl) {
        contentEl.innerHTML = renderMarkdown(fullContent);
        contentEl.appendChild(cursor);
        // 高亮新代码块
        contentEl.querySelectorAll("pre code").forEach((block) => {
          if (window.hljs) hljs.highlightElement(block);
        });
      }
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  } catch (err) {
    fullContent = `⚠ 请求失败: ${err.message}`;
  }

  // 完成
  removeStreamingCursor(cursor);
  updateLastAssistantMessage(fullContent);

  // 高亮最终代码块
  const contentEl = msgEl.querySelector(".msg-content");
  if (contentEl) {
    contentEl.innerHTML = renderMarkdown(fullContent);
    contentEl.querySelectorAll("pre code").forEach((block) => {
      if (window.hljs) hljs.highlightElement(block);
    });
  }

  // 保存到后端
  if (state.currentConversationId) {
    await post(`/chat/conversations/${state.currentConversationId}/messages`, {
      role: "assistant", content: fullContent, model: modelId,
    });
  }

  btnSend.disabled = false;
  chatInput.focus();
}

/**
 * 刷新对话列表
 */
async function refreshConversationList() {
  const res = await get("/chat/conversations");
  if (res.code === 0) {
    setConversations(res.data);
    // 更新下拉
    convSelect.innerHTML = '<option value="">新对话</option>';
    for (const conv of res.data) {
      const opt = document.createElement("option");
      opt.value = conv.id;
      opt.textContent = conv.title || conv.id;
      convSelect.appendChild(opt);
    }
    if (state.currentConversationId) {
      convSelect.value = state.currentConversationId;
    }
  }
}

/**
 * 切换对话
 */
async function switchConversation(convId) {
  if (!convId) {
    state.currentConversationId = null;
    setMessages([]);
    return;
  }
  state.currentConversationId = convId;
  const res = await get(`/chat/conversations/${convId}/messages`);
  if (res.code === 0) {
    setMessages(res.data);
  }
}

/**
 * 初始化
 */
function initChat() {
  chatScroll = document.getElementById("chat-messages");
  chatInput = document.getElementById("chat-input");
  btnSend = document.getElementById("btn-send");
  convSelect = document.getElementById("conversation-select");
  btnNewChat = document.getElementById("btn-new-chat");

  // 发送按钮
  btnSend.addEventListener("click", sendMessage);

  // Enter 发送，Shift+Enter 换行
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 自动调整高度
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  // 对话切换
  convSelect.addEventListener("change", (e) => {
    switchConversation(e.target.value);
  });

  // 新建对话
  btnNewChat.addEventListener("click", () => {
    state.currentConversationId = null;
    convSelect.value = "";
    setMessages([]);
  });

  // 订阅消息变化
  subscribe("messages", renderAllMessages);

  // 加载历史对话列表
  refreshConversationList();
}

export { initChat, sendMessage, renderMarkdown };
