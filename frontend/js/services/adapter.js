/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示词
 */

import { state } from "../store.js?v=20260808-6";
import { getToolsSystemPrompt } from "./tools.js?v=20260808-6";

// ── System Prompt 模板 ──────────────────────

const SYSTEM_BASE = `你是 SLATE（砚），一个本地灵感激发与知识协作台助手。
你的核心能力：
1. 捕捉用户的零碎灵感，帮助发散、连接、命名、追问和重组
2. 将模糊想法整理成可继续探索的方向、草图、问题清单、故事线或行动种子
3. 维护长期记忆、用户画像和知识中心，让灵感能跨对话沉淀与复用
4. 必要时调用工具查看环境、检索知识、执行技能、整理黑板或辅助项目，但不要把自己限制为软件开发助手

**重要：你拥有工具。只有当用户明确要求了解、查看、修改当前项目，或你的回答必须依赖真实项目内容时，才主动调用 project_files、project_find_file 或 project_read_file 查看实际内容。**
当用户在探索想法、创作、学习、规划、复盘或知识整理时，优先帮助打开可能性，再收束为清晰的下一步。
如果你已经在向用户询问是否继续、是否需要方案、是否要你动手，不要自行调用工具，等待用户确认。
如果你判断当前任务下一步必须查看、读取、浏览、搜索或确认项目内容，不要输出计划或等待用户确认，直接发出对应工具调用。
严格禁止说“我先看看”、“我需要查看”、“我会浏览一下”后停住；这类话后必须进行实际工具调用。
回答风格：简洁、有启发性，中文为主，技术术语保留英文。
不要只追求完成任务；也要帮助用户发现更好的问题、更有张力的角度和可继续生长的想法。`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}\n\n当前处于深度推理模式，请在回答前仔细分析问题，给出思考过程。`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手。简洁、有启发性地回应，帮助用户发散和整理想法。用户明确要求查看或修改项目时，调用 tool 查看实际内容；如果只是在询问用户是否继续，等待用户确认。`,
};

// ── 模型分类 ────────────────────────────────

const REASONING_MODELS = ["gpt-5.6-sol", "claude-fable-5", "deepseek-reasoner"];
const LIGHTWEIGHT_MODELS = ["gpt-5.6-luna", "gemini-3.6-flash", "gemini-3.5-flash-lite", "deepseek-v4-flash", "kimi-k2.7-code", "doubao-pro-256k"];

/**
 * 根据模型 ID 获取适配的系统提示
 */
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
  return "\n\n" + parts.join("\n");
}

function getKnowledgeSystemPrompt() {
  const items = Array.isArray(state.knowledgeContext) ? state.knowledgeContext.slice(0, 8) : [];
  if (!items.length) return "";
  const lines = ["[相关知识库片段]"];
  for (const item of items) {
    const title = item.title || item.source || "知识";
    const content = String(item.content || "").slice(0, 700);
    if (content) lines.push(`- ${title}: ${content}`);
  }
  return "\n\n" + lines.join("\n");
}

/**
 * 构建完整的消息列表（注入系统提示 + 宪法 + 工具 + 黑板上下文）
 */
function buildMessages(userMessages, constitution) {
  const messages = [];

  // 系统提示
  const modelId = userMessages._modelId || "";
  let systemContent = getSystemPrompt(modelId);
  systemContent += getMemorySystemPrompt();
  systemContent += getKnowledgeSystemPrompt();

  // 注入项目宪法
  if (constitution) {
    systemContent += "\n\n[项目宪法]\n";
    if (constitution.rules) {
      constitution.rules.forEach((rule, i) => {
        systemContent += `${i + 1}. ${rule}\n`;
      });
    }
  }

  // 注入工具描述（所有模型都需要，否则 AI 不知道如何调用工具）
  systemContent += getToolsSystemPrompt();

  messages.push({ role: "system", content: systemContent });

  // 用户消息
  for (const msg of userMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return messages;
}

/**
 * 获取模型的默认参数
 * max_tokens 由设置页“输出控制”决定：
 * - 基础值：单次输出 Token 上限（默认 16384）
 * - 开关开启时提升到 65536：file_create 等工具调用携带完整文件内容，
 *   过小会导致输出被截断、文件内容残缺
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
