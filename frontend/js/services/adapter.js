/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示。
 */

import { state } from "../store.js?v=20260826-110";
import { getToolsSystemPrompt } from "./tools.js?v=20260826-110";

// ── System Prompt 模板 ──────────────────────

const SYSTEM_BASE = `你是 SLATE（砚），一个本地 AI 协作调度台助手，既能陪用户发散想法，也能像 Agent 一样直接推进本地项目任务。

## 核心职责
1. 捕捉零碎想法，帮助发散、连接、命名、追问和重组。
2. 将模糊需求整理成可执行的目标、约束、风险、验收标准与下一步。
3. 维护长期记忆、用户画像和知识中心，让灵感能跨对话沉淀与复用。
4. 当用户要求查看、修改、运行、排查、生成、提交或验证项目内容时，直接使用工具推进，不把任务停留在建议层面。

## Agent 工作协议
- 先判断任务类型：纯问答直接回答；需要环境事实或副作用的任务进入 Observe → Plan → Act → Verify → Report 循环。
- Observe：缺少项目事实时优先读取目录、文件、配置、日志或命令输出；不要臆测仓库现状。
- Plan：复杂任务用 3-6 个内部步骤收束，不必把完整计划冗长输出给用户；Harness/TODOLIST 开启时按清单推进。
- Act：能用工具完成的动作就发出工具调用；同一轮可批量调用互不依赖的读取/扫描工具。
- Verify：修改、生成、构建、修复后必须用读取、检查、测试或命令结果自证；验证失败继续修，不急着汇报完成。
- Report：只有在任务完成或确实受阻时才收尾；汇报要短，说明改了什么、验证了什么、剩余风险。

## 工具纪律
你拥有工具，调用格式见下方 [可用工具]。
- 当下一步需要查看、读取、搜索、确认、修改、执行或生成文件时，当前回复必须包含工具调用块。
- 禁止说“我先看看”“我需要查看”“接下来我会”后停住；这类句子后必须紧跟实际工具调用。
- 不要为了显得积极而滥用工具：普通解释、创意讨论、等待用户选择/确认时不调用工具。
- 不重复完全相同的失败调用；如果工具失败，换参数、换工具或先读取更多上下文。
- 不暴露冗长思维过程；给用户看清晰结论、关键依据和下一步即可。

## 回答风格
- 中文为主，技术术语保留英文；简洁、聚焦、有启发性。
- 有实质内容时用 Markdown 结构化；简单问题直接回答，不加多余格式。
- 主动指出更稳妥的路径，但不要把主动性变成没完没了的反问。`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}\n\n## 深度推理模式\n先在内部充分分析目标、约束、风险和可验证路径，再给出行动或结论；不要把长推理逐字展示给用户。`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手：中文为主，简洁、有启发性。遇到纯问答直接回答；遇到查看、修改、运行、排查、生成、提交或验证项目的请求，按 [可用工具] 的 ◈◈◈ 格式直接调用工具推进。不要只说“我来看看”；等待用户选择/确认时不调用工具。`,
};

// ── 模型分类 ────────────────────────────────

const REASONING_MODELS = ["gpt-5.6-sol", "claude-fable-5", "deepseek-reasoner"];
const LIGHTWEIGHT_MODELS = ["gpt-5.6-luna", "gemini-3.6-flash", "gemini-3.5-flash-lite", "deepseek-v4-flash", "kimi-k2.7-code", "doubao-pro-256k"];

/**
 * 根据模型 ID 获取适配的系统提示 */
function getSystemPrompt(modelId) {
  if (REASONING_MODELS.includes(modelId)) return SYSTEM_PROMPTS.reasoning;
  if (LIGHTWEIGHT_MODELS.includes(modelId)) return SYSTEM_PROMPTS.lightweight;
  return SYSTEM_PROMPTS.default;
}

function getMemorySystemPrompt() {
  const parts = [];
  const profile = state.userProfile || {};
  const profileLines = [];
  if (profile.role) profileLines.push(`- 角色: ${profile.role}`);
  if (profile.style) profileLines.push(`- 工作风格: ${profile.style}`);
  if (profile.techStack) profileLines.push(`- 技术栈: ${profile.techStack}`);
  if (profile.habits) profileLines.push(`- 协作习惯: ${profile.habits}`);
  if (profile.custom) profileLines.push(`- 其他: ${profile.custom}`);
  if (profileLines.length) {
    parts.push("[用户画像]");
    parts.push(...profileLines);
  }

  const memories = (state.memories || []).slice(-16);
  if (memories.length) {
    parts.push("[长期记忆]");
    for (const mem of memories) {
      const category = mem.category || "general";
      const content = String(mem.content || "").slice(0, 220);
      if (content) parts.push(`- [${category}] ${content}`);
    }
  }

  if (!parts.length) return "";
  return "\n\n以下是用户画像与长期记忆，用于调整回答风格与内容贴合用户，不要向用户复述它们：\n" + parts.join("\n");
}

function getKnowledgeSystemPrompt() {
  const items = Array.isArray(state.knowledgeContext) ? state.knowledgeContext.slice(0, 8) : [];
  if (!items.length) return "";
  const lines = ["[相关知识库片段]（仅在与当前问题相关时参考，不要生硬引用）"];
  for (const item of items) {
    const title = item.title || item.source || "知识";
    const content = String(item.content || "").slice(0, 700);
    if (content) lines.push(`- ${title}: ${content}`);
  }
  return "\n\n" + lines.join("\n");
}

/** 专家包注入：当前对话激活的专家 persona + rules */
function getExpertSystemPrompt() {
  const expert = state.activeExpert;
  if (!expert) return "";
  const parts = [`[专家包· ${expert.name || "未命名"}]（本次对话完全采纳以下人格与规则，优先于默认风格）`];
  if (String(expert.persona || "").trim()) {
    parts.push("[专家人格]");
    parts.push(String(expert.persona).trim());
  }
  if (String(expert.rules || "").trim()) {
    parts.push("[专家规则]");
    parts.push(String(expert.rules).trim());
  }
  const knowledgeNames = (expert.knowledge || []).map(f => f.name).slice(0, 20);
  if (knowledgeNames.length) {
    parts.push(`[专家知识文件] ${knowledgeNames.join("、")}`);
  }
  return parts.length > 1 ? "\n\n" + parts.join("\n") : "";
}

/**
 * 构建完整的消息列表（注入系统提示 + 宪法 + 专家/记忆/知识 + 工具）。
 * 顺序：角色定义、项目宪法、专家/记忆/知识上下文、工具说明（贴近对话，降低遗忘）。
 */
function buildMessages(userMessages, constitution) {
  const messages = [];

  // 系统提示
  const modelId = userMessages._modelId || "";
  let systemContent = getSystemPrompt(modelId);

  // 注入项目宪法（项目开发规则，先于上下文注入）
  if (constitution?.rules?.length) {
    systemContent += "\n\n[项目宪法]（涉及该项目的代码、方案与建议时必须遵守）\n";
    constitution.rules.forEach((rule, i) => {
      systemContent += `${i + 1}. ${rule}\n`;
    });
  }

  systemContent += getExpertSystemPrompt();
  systemContent += getMemorySystemPrompt();
  systemContent += getKnowledgeSystemPrompt();

  // 注入工具描述（默认使用精简 Agent 版，避免长工具目录稀释关键指令）
  systemContent += getToolsSystemPrompt({ compact: true });

  messages.push({ role: "system", content: systemContent });

  // 用户消息（带图片附件时装配为多模态内容，让模型真正“看见”图片）
  for (const msg of userMessages) {
    const images = (Array.isArray(msg.images) ? msg.images : []).filter(src => typeof src === "string" && src.startsWith("data:image"));
    if (msg.role === "user" && images.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: msg.content },
          ...images.map(src => ({ type: "image_url", image_url: { url: src } })),
        ],
      });
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  return messages;
}

/**
 * 获取模型的默认参数。
 * max_tokens 由设置页“输出控制”决定：
 * - 基础值：单次输出 Token 上限（默认 16384）
 * - 开关开启时提升到 65536：file_create 等工具调用携带完整文件内容，
 *   过小会导致输出被截断、文件内容残缺。
 */
const UNLIMITED_OUTPUT_TOKENS = 65536;

function getOutputMaxTokens() {
  const s = state.outputSettings || {};
  if (s.unlimitedFileOutput) return UNLIMITED_OUTPUT_TOKENS;
  return Math.max(1024, parseInt(s.maxTokens) || 16384);
}

function getDefaultParams(modelId) {
  const max_tokens = getOutputMaxTokens();
  if (REASONING_MODELS.includes(modelId)) {
    return { temperature: 0.6, max_tokens };
  }
  return { temperature: 0.7, max_tokens };
}

export { getSystemPrompt, buildMessages, getDefaultParams, getOutputMaxTokens, SYSTEM_PROMPTS };
