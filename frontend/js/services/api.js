/**
 * SLATE API 调用封装：统一 fetch 拦截
 */

import { API_BASE } from "../store.js?v=20260818-77";
import { t } from "./i18n.js?v=20260818-77";

// 思考内容标记前缀（用于在流式输出中区分 reasoning 与 content）
export const REASONING_PREFIX = "\x00\x01R\x01\x00";

// ── 超时与重试常量（参考主 Agent：idle watchdog + 零内容自动重试） ──
const REQUEST_TIMEOUT_MS = 180000;      // 普通请求（含工具）总超时
const STREAM_IDLE_TIMEOUT_MS = 90000;   // 流式 90 秒无任何数据视为连接已死
const STREAM_MAX_RETRIES = 2;           // 未产出任何内容时的自动重试次数
/**
 * 通用 JSON 请求（带超时保护，防止工厂接口挂起导致界面永久卡死）
 */
async function request(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = `${API_BASE}${path}`;
  const defaults = {
    headers: { "Content-Type": "application/json" },
  };
  const config = { ...defaults, ...options };
  if (config.body && typeof config.body === "object") {
    config.body = JSON.stringify(config.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { ...config, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error(t("请求超时（{s}s），可重试", { s: Math.round(timeoutMs / 1000) }));
    throw err;
  }
  clearTimeout(timer);
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
 * 参考主 Agent 的流式健壮性方案：
 * - Idle watchdog：超过 STREAM_IDLE_TIMEOUT_MS 无任何数据则主动中断（区分“慢”与“已死”）
 * - 零内容自动重试：连接失败/挂死且未产出任何内容时，退避重试
 * - payload.meta：可选对象，回写 finish_reason 到 meta.finishReason
 */
async function* streamChat(payload) {
  const { signal, meta, ...body } = payload || {};
  let attempt = 0;

  while (true) {
    attempt++;
    if (signal?.aborted) return;

    const controller = new AbortController();
    let idleAborted = false;
    let idleTimer = 0;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleAborted = true; controller.abort(); }, STREAM_IDLE_TIMEOUT_MS);
    };
    const onUserAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onUserAbort);

    let receivedAny = false;
    try {
      resetIdle();
      const resp = await fetch(`${API_BASE}/proxy/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let done = false;

      // 解析 SSE 行：收集 content 增量，回写 finish_reason，遇 [DONE] 结束
      // 同时提取 delta.reasoning 字段，以 REASONING_PREFIX 标记后 yield
      const parseLines = (lines) => {
        const chunks = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") { done = true; break; }
          try {
            const parsed = JSON.parse(data);
            const fr = parsed?.choices?.[0]?.finish_reason;
            if (fr && meta) meta.finishReason = fr;
            const delta = parsed?.choices?.[0]?.delta || {};
            const content = delta.content;
            if (content) chunks.push(content);
            // 提取 reasoning 字段（DeepSeek/OpenAI o-series/Anthropic thinking）
            const reasoning = delta.reasoning;
            if (reasoning) chunks.push(REASONING_PREFIX + reasoning);
          } catch (e) {
            // 非 JSON 行，跳过
          }
        }
        return chunks;
      };

      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        receivedAny = true;   // 任何数据到达（含心跳注释）都重置看门狗
        resetIdle();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const chunk of parseLines(lines)) yield chunk;
      }

      // 流结束：flush 解码器内残留字节（跨 chunk 截断的多字节中文字符）并处理缓冲区尾部
      if (!done) {

        buffer += decoder.decode();
        for (const chunk of parseLines(buffer.split("\n"))) yield chunk;
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;   // 用户主动停止：保存AbortError 语义
      // 未产出任何内容时自动重试（连接失败瞬断/服务端无响应）
      if (!receivedAny && attempt <= STREAM_MAX_RETRIES) {

        await new Promise(r => setTimeout(r, 700 * attempt));
        continue;
      }
      if (idleAborted) throw new Error(t("流式响应 {n} 秒无响应，已自动中断连接", { n: STREAM_IDLE_TIMEOUT_MS / 1000 }));
      throw err;
    } finally {
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener("abort", onUserAbort);
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
