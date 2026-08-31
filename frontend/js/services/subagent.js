/**
 * SLATE SubAgent 并行引擎
 * 主模型通过 subagent_run 工具一次性派出多个子代理，各自以独立的迷你
 * Agent Loop（streamChat + 文本协议工具调用）并行执行，互不共享上下文；
 * 全部结束后汇总结果回注主循环。
 * tools 相关函数经 deps 注入，避免与 tools.js 循环导入。
 */

import { state, getModelKey } from "../store.js?v=20260831-001";
import { streamChat } from "./api.js?v=20260831-001";

export const SUBAGENT_MAX_PARALLEL = 5;     // 单次派出的并行上限
export const SUBAGENT_MAX_ROUNDS = 8;       // 每个子代理的工具轮次预算
export const SUBAGENT_OUTPUT_LIMIT = 4000;  // 单个子代理结果回注主模型的最大字符数

const SUBAGENT_SYSTEM_PREFIX = `你是主代理派出的子代理，负责独立完成一个明确的子任务。

工作纪律：
1. 只专注自己的任务，不与用户对话，最终产出会被主代理汇总使用。
2. 需要信息时主动调用工具获取，不要臆测。
3. 禁止调用 subagent_run（子代理不得再派生子代理）。
4. 任务完成或信息已足够时，停止调用工具，直接输出最终结论：完整、自包含、结构清晰（可用要点列表），包含主代理需要的全部细节；不要输出工具调用块，不要输出"我将要…"的过程描述。
`;

// ── 进度事件总线（chat.js 订阅渲染实时面板）──────────────────
// 事件：{type:"start", specs, total} / {type:"text", index, text}
//      {type:"progress", index, round, toolCalls} / {type:"end", index, status, summary}

const listeners = new Set();

export const subagentEvents = {
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(event) {
    for (const fn of listeners) {
      try { fn(event); } catch { /* 渲染失败不影响执行 */ }
    }
  },
};

// ── 主循环 AbortSignal 桥接（chat.js 在生成开始/结束时设置）────

let activeSignal = null;

export function setSubAgentSignal(signal) {
  activeSignal = signal || null;
}

export function getSubAgentSignal() {
  return activeSignal;
}

// ── 引擎 ────────────────────────────────────────────────────

function normalizeSpecs(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map((s, i) => ({
      name: String(s?.name || "").trim() || `子代理 ${i + 1}`,
      task: String(s?.task || "").trim(),
    }))
    .filter(s => s.task);
}

function previewTail(text, max = 60) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(-max) : s;
}

/** 单个子代理：独立迷你工具循环。任何异常都不外抛，转为 failed/stopped 结果。 */
async function runOneSubAgent(spec, index, deps, signal) {
  const { detect, strip, exec, toolsPrompt } = deps;
  const modelId = state.currentModel?.id || "gpt-5.6-terra";
  const baseUrl = state.currentModel?.base_url || undefined;
  const apiKey = getModelKey(modelId);

  const messages = [
    { role: "system", content: SUBAGENT_SYSTEM_PREFIX + toolsPrompt },
    { role: "user", content: spec.task },
  ];

  let rounds = 0;
  let toolCalls = 0;
  let lastOutput = "";

  const finish = (status, output) => {
    subagentEvents.emit("end", { index, status, summary: previewTail(output, 80) });
    return { name: spec.name, task: spec.task, status, output, toolCalls, rounds };
  };

  try {
    for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
      if (signal?.aborted) return finish("stopped", lastOutput);
      rounds = round + 1;

      let content = "";
      let lastEmit = 0;
      for await (const chunk of streamChat({
        model: modelId,
        provider: state.currentModel?.provider,
        messages,
        api_key: apiKey,
        base_url: baseUrl,
        temperature: 0.3,
        stream: true,
        signal,
      })) {
        content += chunk;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          subagentEvents.emit("text", { index, text: previewTail(content) });
        }
      }
      lastOutput = strip(content).trim();

      const calls = detect(content);
      if (!calls.length) return finish(signal?.aborted ? "stopped" : "done", lastOutput);
      if (signal?.aborted) return finish("stopped", lastOutput);

      // 递归守卫 + 截断守卫 + 执行工具（与主循环同款执行器，天然带校验与高危审批）
      const resultParts = [];
      for (const call of calls) {
        if (call.name === "subagent_run") {
          resultParts.push("[工具 subagent_run] 未执行：子代理不允许再派生子代理，请自行完成该部分任务。");
          continue;
        }
        if (call.params?._truncated && call.name !== "file_append" && call.name !== "file_create") {
          resultParts.push(`[工具 ${call.name}] 未执行：该调用因输出长度上限被截断、参数不完整。请拆分为更小的调用后重试。`);
          continue;
        }
        toolCalls++;
        const res = await exec(call.name, call.params);
        const text = typeof res?.output === "string" ? res.output : JSON.stringify(res ?? {});
        resultParts.push(`[工具 ${call.name}] ${text.length > 2000 ? text.slice(0, 2000) + "…（已截断）" : text}`);
      }

      subagentEvents.emit("progress", { index, round: rounds, toolCalls });

      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `[工具结果]\n${resultParts.join("\n\n")}\n\n请继续推进任务；若任务已完成，直接输出最终结论（纯文本，不带工具调用块）。`,
      });
    }
    return finish("max_rounds", lastOutput);
  } catch (e) {
    const stopped = signal?.aborted || e?.name === "AbortError";
    return finish(stopped ? "stopped" : "failed", stopped ? lastOutput : `执行出错: ${e?.message || e}`);
  }
}

/**
 * 并行执行多个子代理。
 * @param {Array<{name?, task}>} specs 子代理定义
 * @param {{detect, strip, exec, toolsPrompt}} deps 由 tools.js 注入的工具函数
 * @param {AbortSignal|null} signal 主循环的中断信号
 * @returns {{results: Array, skipped: number}}
 */
export async function runSubAgents(specs, deps, signal = null) {
  const sig = signal || getSubAgentSignal();
  const all = normalizeSpecs(specs);
  const list = all.slice(0, SUBAGENT_MAX_PARALLEL);
  const skipped = Math.max(0, all.length - SUBAGENT_MAX_PARALLEL);

  subagentEvents.emit("start", { specs: list, total: all.length });

  const results = await Promise.all(
    list.map((spec, i) => runOneSubAgent(spec, i, deps, sig)),
  );
  return { results, skipped };
}
