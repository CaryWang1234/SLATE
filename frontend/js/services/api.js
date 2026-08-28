/**
 * SLATE API 调用封装：统一 fetch 拦截
 */

import { API_BASE } from "../store.js?v=20260828-137";
import { t } from "./i18n.js?v=20260828-137";

// 思考内容标记前缀（用于在流式输出中区分 reasoning 与 content）
export const REASONING_PREFIX = "\x00\x01R\x01\x00";
export const REASONING_INLINE_PREFIX = "\x01R\x01";

function normalizeReasoningChunk(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(item => typeof item === "string" ? item : (item?.text || item?.content || ""))
      .filter(Boolean)
      .join("");
  }
  return value.text || value.content || "";
}

// ── 超时与重试常量（参考主 Agent：idle watchdog + 零内容自动重试） ──
const REQUEST_TIMEOUT_MS = 180000;      // 普通请求（含工具）总超时
const STREAM_IDLE_TIMEOUT_MS = 90000;   // 流式 90 秒无任何数据视为连接已死
const STREAM_MAX_RETRIES = 2;           // 未产出任何内容时的自动重试次数

function compactErrorText(text, max = 900) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function readErrorBody(resp) {
  try {
    const text = await resp.text();
    if (!text) return "";
    try {
      const data = JSON.parse(text);
      const err = data.error || data.detail || data.message || data;
      if (typeof err === "string") return err;
      return err.message || err.msg || JSON.stringify(err);
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

function statusDiagnosis(status) {
  if (status === 400) return "请求格式不被上游接受，常见原因是 Responses API 与模型/服务商不兼容、参数名不支持或消息格式异常";
  if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、Base URL、账号权限或局域网鉴权";
  if (status === 404) return "模型或接口地址不存在，请检查模型 ID、Base URL，以及是否误开 Responses API";
  if (status === 408 || status === 504) return "上游响应超时，可能是网络波动、模型排队或代理链路过慢";
  if (status === 409) return "上游拒绝当前请求状态，可能存在并发会话或工具调用状态不匹配";
  if (status === 413) return "请求体过大，建议压缩上下文、减少附件或降低历史消息数量";
  if (status === 429) return "触发限流或额度不足，请稍后重试或检查服务商额度";
  if (status >= 500) return "上游服务或代理返回服务器错误，通常不是本地输入问题，可稍后重试或切换模型";
  return "请求失败，请检查网络、模型配置和服务商返回信息";
}

function formatHttpError(status, statusText, detail = "") {
  const parts = [`HTTP ${status}${statusText ? ` ${statusText}` : ""}`];
  parts.push(statusDiagnosis(status));
  if (detail) parts.push(`上游详情：${compactErrorText(detail)}`);
  return parts.join("\n");
}

function formatUpstreamError(error) {
  if (!error) return "上游返回错误，但没有提供详情";
  if (typeof error === "string") return compactErrorText(error);
  const status = error.status || error.status_code;
  const code = error.code || error.type || error.param || "";
  const message = error.message || error.msg || error.detail || JSON.stringify(error);
  const prefix = status ? formatHttpError(Number(status), error.statusText || "", "") : "上游返回错误";
  return `${prefix}${code ? `\n错误代码：${code}` : ""}\n上游详情：${compactErrorText(message)}`;
}

function formatFetchError(err, { idleAborted = false, timeoutMs = 0 } = {}) {
  if (idleAborted) {
    return t("流式响应 {n} 秒无响应，已自动中断连接", { n: STREAM_IDLE_TIMEOUT_MS / 1000 })
      + "\n诊断：已建立连接但长时间没有收到任何字节，常见原因是模型排队、代理读超时或网络中断。";
  }
  if (err?.name === "AbortError") return err.message || "请求已中断";
  const msg = String(err?.message || err || "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return "网络连接失败：浏览器无法连接到 SLATE 后端或模型代理。\n诊断：请检查后端是否仍在运行、Base URL 是否可达、代理/VPN/防火墙是否拦截。";
  }
  if (/timeout|timed out|请求超时/i.test(msg)) {
    return `请求超时${timeoutMs ? `（${Math.round(timeoutMs / 1000)}s）` : ""}：上游没有及时响应。\n诊断：可重试、切换网络/模型，或减少上下文与附件。`;
  }
  return msg || "请求失败，但未获得具体错误信息";
}

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
    throw new Error(formatFetchError(err, { timeoutMs }));
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const detail = await readErrorBody(resp);
    throw new Error(formatHttpError(resp.status, resp.statusText, detail));
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
    let yieldedAny = false;
    try {
      resetIdle();
      const resp = await fetch(`${API_BASE}/proxy/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const detail = await readErrorBody(resp);
        const err = new Error(formatHttpError(resp.status, resp.statusText, detail));
        err.noRetry = true;
        throw err;
      }
      if (!resp.body) throw new Error("浏览器没有拿到流式响应体，可能是代理或浏览器拦截了 SSE 连接");

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
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            // 非 JSON 行，跳过
            continue;
          }
          if (parsed?.error) throw new Error(formatUpstreamError(parsed.error));
          const fr = parsed?.choices?.[0]?.finish_reason;
          if (fr && meta) meta.finishReason = fr;
          const delta = parsed?.choices?.[0]?.delta || {};
          const content = delta.content;
          if (content) chunks.push(content);
          // 提取 reasoning 字段（DeepSeek/OpenAI o-series/Anthropic thinking）
          const reasoning = normalizeReasoningChunk(delta.reasoning ?? delta.reasoning_content ?? delta.thinking ?? delta.reasoning_details);
          if (reasoning) chunks.push(REASONING_PREFIX + reasoning);
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
        for (const chunk of parseLines(lines)) {
          yieldedAny = true;
          yield chunk;
        }
      }

      // 流结束：flush 解码器内残留字节（跨 chunk 截断的多字节中文字符）并处理缓冲区尾部
      if (!done) {

        buffer += decoder.decode();
        for (const chunk of parseLines(buffer.split("\n"))) {
          yieldedAny = true;
          yield chunk;
        }
      }
      if (!yieldedAny) {
        throw new Error("模型连接已结束，但没有返回任何可显示内容。\n诊断：可能是上游返回空 SSE、只返回了错误但被代理吞掉、Responses API 与当前模型不兼容，或模型输出被服务商过滤。");
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;   // 用户主动停止：保存AbortError 语义
      // 未产出任何内容时自动重试（连接失败瞬断/服务端无响应）
      if (!err?.noRetry && !receivedAny && attempt <= STREAM_MAX_RETRIES) {

        await new Promise(r => setTimeout(r, 700 * attempt));
        continue;
      }
      throw new Error(formatFetchError(err, { idleAborted }));
    } finally {
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener("abort", onUserAbort);
    }
  }
}

/**
 * 上传文件（FormData）
 * 与 request 相同：180s 超时防挂起；失败时解析后端中文 message（如 413 超大小提示）
 */
async function upload(path, formData, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error(t("上传超时（{s}s），可重试", { s: Math.round(timeoutMs / 1000) }));
    throw new Error(formatFetchError(err, { timeoutMs }));
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const detail = await readErrorBody(resp);
    throw new Error(formatHttpError(resp.status, resp.statusText, detail));
  }
  return resp.json();
}

export { get, post, put, del, patch, streamChat, upload };
