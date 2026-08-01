/**
 * SLATE API 调用封装：统一 fetch 拦截
 */

import { API_BASE } from "../store.js?v=20260730-33";

/**
 * 通用 JSON 请求
 */
async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const defaults = {
    headers: { "Content-Type": "application/json" },
  };
  const config = { ...defaults, ...options };
  if (config.body && typeof config.body === "object") {
    config.body = JSON.stringify(config.body);
  }

  const resp = await fetch(url, config);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

/** GET */
function get(path) {
  return request(path, { method: "GET" });
}

/** POST */
function post(path, body) {
  return request(path, { method: "POST", body });
}

/** PUT */
function put(path, body) {
  return request(path, { method: "PUT", body });
}

/** DELETE */
function del(path) {
  return request(path, { method: "DELETE" });
}

/** PATCH */
function patch(path, body) {
  return request(path, { method: "PATCH", body });
}

/**
 * 流式聊天请求：返回 AsyncIterator<string>
 */
async function* streamChat(payload) {
  const url = `${API_BASE}/proxy/chat`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed?.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch (e) {
        // 非 JSON 行，跳过
      }
    }
  }
}

/**
 * 上传文件（FormData）
 */
async function upload(path, formData) {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

export { get, post, put, del, patch, streamChat, upload };
