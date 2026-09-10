/**
 * 上下文用量估算：把真正会发往模型的每一段都算进来，并按来源分桶。
 *
 * 口径与 services/adapter.js 的 buildMessages 同源：系统提示词直接调用
 * buildSystemContent，工具结果按「历史里已有 role:"tool" 消息优先」配对，
 * 避免与 assistant.toolResults 双计。数字仍是估算（约 3 字符/token），
 * 可信的是占比与趋势，不是与上游账单的逐位一致。
 */

import { state, estimateTokens } from "../store.js?v=20260910-004";
import { buildSystemContent } from "./adapter.js?v=20260910-004";
import { getToolsSystemPrompt } from "./tools.js?v=20260910-004";

// 每条消息的角色与分隔符开销（OpenAI 风格 chatml 的近似值）
const MSG_OVERHEAD = 4;

function measurePromptSide() {
  const whole = buildSystemContent(state.currentModel?.id || "", state.constitution);
  const tools = getToolsSystemPrompt({ compact: true });
  // 工具目录始终追加在系统提示词末尾，按长度差切出前段即可，无需依赖 endsWith
  const head = whole.slice(0, Math.max(0, whole.length - tools.length));
  return {
    system: estimateTokens(head),
    tools: estimateTokens(tools),
  };
}

function toolResultsOf(msg) {
  return Array.isArray(msg.toolResults) ? msg.toolResults
    : (Array.isArray(msg.metadata?.toolResults) ? msg.metadata.toolResults : []);
}

function measureHistory(messages) {
  // 原生协议里工具结果以 role:"tool" 消息回灌，先收集已配对的结果 id
  const pairedToolIds = new Set();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) pairedToolIds.add(m.tool_call_id);
  }

  let convo = 0;
  let injected = 0;
  let toolSide = 0;

  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    const text = estimateTokens(content);

    if (m.role === "tool") {
      toolSide += text + MSG_OVERHEAD;
      continue;
    }
    // 文本协议的工具结果与推进指令走这条隐藏回灌消息
    if (m.role === "user" && m.model === "[tool_results]") {
      toolSide += text + MSG_OVERHEAD;
      continue;
    }
    if (m.role === "user") {
      // @提及解析出的 SKILL.md / 项目文件 / MCP 注入追加在用户原文之后，display 才是原文
      const own = typeof m.display === "string" && content.startsWith(m.display) ? m.display : content;
      convo += estimateTokens(own) + MSG_OVERHEAD;
      if (own !== content) injected += estimateTokens(content.slice(own.length));
      continue;
    }
    convo += text + MSG_OVERHEAD;

    if (m.role !== "assistant") continue;
    const results = toolResultsOf(m);
    for (const call of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
      if (typeof call?.arguments === "string") toolSide += estimateTokens(call.arguments);
      // 无 id 的是文本协议调用，其结果已在隐藏回灌消息里计过；有 id 且已有 tool 消息的同样跳过
      if (!call?.id || pairedToolIds.has(call.id)) continue;
      const entry = results.find(r => r?.call?.id === call.id);
      const output = entry?.result?.output ?? entry?.output;
      if (typeof output === "string" && output) toolSide += estimateTokens(output) + MSG_OVERHEAD;
    }
  }

  return { convo, injected, toolSide };
}

/** 返回 { total, limit, buckets:[{key,label,tokens}] }，buckets 按占用量降序。 */
export function measureContext(messages = state.messages) {
  const prompt = measurePromptSide();
  const history = measureHistory(Array.isArray(messages) ? messages : []);
  const buckets = [
    { key: "system", label: "系统提示词", tokens: prompt.system },
    { key: "tools", label: "工具目录", tokens: prompt.tools },
    { key: "skills", label: "Skill 注入", tokens: history.injected },
    { key: "toolCalls", label: "工具调用与结果", tokens: history.toolSide },
    { key: "messages", label: "对话消息", tokens: history.convo },
  ];
  buckets.sort((a, b) => b.tokens - a.tokens);
  const result = {
    total: buckets.reduce((sum, b) => sum + b.tokens, 0),
    limit: state.currentModel?.context_window || 0,
    buckets,
  };
  // chat_context 工具读本快照，保证与用量条同一个数字（tools.js 不能反向 import 本模块）
  state.contextSnapshot = { at: Date.now(), total: result.total, limit: result.limit, buckets: result.buckets };
  return result;
}
