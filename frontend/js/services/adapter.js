/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示词
 */

import { state } from "../store.js?v=20260802-02";
import { getToolsSystemPrompt } from "./tools.js?v=20260802-02";

// ── System Prompt 模板 ──────────────────────

const SYSTEM_BASE = `你是 SLATE（砚），一个本地 AI 协作调度台助手。
你的核心能力：
1. 将用户的零碎灵感整理为结构化方案
2. 生成高质量提示词，供外部 Coding Agent 执行
3. 在白板上整理逻辑链和思维导图
4. 调用工具直接操作环境（文件浏览、技能执行、黑板管理等）

**重要：你拥有工具。只有当用户明确要求了解、查看、修改当前项目，或你的回答必须依赖真实项目内容时，才主动调用 project_files、project_find_file 或 project_read_file 查看实际内容。**
如果你已经在向用户询问是否继续、是否需要方案、是否要你动手，不要自行调用工具，等待用户确认。
如果你判断当前任务下一步必须查看、读取、浏览、搜索或确认项目内容，不要输出计划或等待用户确认，直接发出对应工具调用。
严格禁止说“我先看看”、“我需要查看”、“我会浏览一下”后停住；这类话后必须进行实际工具调用。
回答风格：简洁务实，中文为主，技术术语保留英文。
不使用冗余的客套话，直接给出方案。`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}\n\n当前处于深度推理模式，请在回答前仔细分析问题，给出思考过程。`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手。简洁回答。用户明确要求查看或修改项目时，调用 tool 查看实际内容；如果只是在询问用户是否继续，等待用户确认。`,
};

// ── 模型分类 ────────────────────────────────

const REASONING_MODELS = ["deepseek-v4-pro", "o3-mini"];
const LIGHTWEIGHT_MODELS = ["gemini-2.5-flash", "deepseek-v4-flash", "kimi-k2.7-code", "doubao-pro-256k"];

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
 */
function getDefaultParams(modelId) {
  if (REASONING_MODELS.includes(modelId)) {
    return { temperature: 0.6, max_tokens: 8192 };
  }
  return { temperature: 0.7, max_tokens: 4096 };
}

export { getSystemPrompt, buildMessages, getDefaultParams, SYSTEM_PROMPTS };
