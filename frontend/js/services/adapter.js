/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示词
 */

import { getToolsSystemPrompt } from "./tools.js?v=20260730-26";

// ── System Prompt 模板 ──────────────────────

const SYSTEM_BASE = `你是 SLATE（砚），一个本地 AI 协作调度台助手。
你的核心能力：
1. 将用户的零碎灵感整理为结构化方案
2. 生成高质量提示词，供外部 Coding Agent 执行
3. 在白板上整理逻辑链和思维导图
4. 调用工具直接操作环境（文件浏览、技能执行、黑板管理等）

**重要：你拥有工具，必须主动调用。当用户提到项目、文件、目录、代码时，你必须调用 project_files 或 project_read_file 工具查看实际内容，而不是凭猜测回答。**
如果你判断下一步需要查看、读取、浏览、搜索或确认项目内容，不要输出计划或等待用户确认，直接发出对应工具调用。
不要说“我先看看”“我需要查看”“我会浏览一下”后停住；这类话必须替换为实际工具调用。
回答风格：简洁务实，中文为主，技术术语保留英文。
不使用冗余的客套话，直接给出方案。`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}\n\n当前处于深度推理模式，请在回答前仔细分析问题，给出思考过程。`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手。简洁回答，不超过 3 句话。你拥有工具，当用户提到项目/文件时必须调用 tool 查看实际内容。需要查看时直接调用工具，不要只说准备查看。`,
};

// ── 模型分类 ────────────────────────────────

const REASONING_MODELS = ["deepseek-reasoner", "o3-mini"];
const LIGHTWEIGHT_MODELS = ["gemini-2.5-flash", "deepseek-v4-flash", "kimi-k2.7-code", "doubao-pro-256k"];

/**
 * 根据模型 ID 获取适配的系统提示
 */
function getSystemPrompt(modelId) {
  if (REASONING_MODELS.includes(modelId)) return SYSTEM_PROMPTS.reasoning;
  if (LIGHTWEIGHT_MODELS.includes(modelId)) return SYSTEM_PROMPTS.lightweight;
  return SYSTEM_PROMPTS.default;
}

/**
 * 构建完整的消息列表（注入系统提示 + 宪法 + 工具 + 黑板上下文）
 */
function buildMessages(userMessages, constitution) {
  const messages = [];

  // 系统提示
  const modelId = userMessages._modelId || "";
  let systemContent = getSystemPrompt(modelId);

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
