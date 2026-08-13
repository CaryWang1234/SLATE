/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示词
 */

import { state } from "../store.js?v=20260813-46";
import { getToolsSystemPrompt } from "./tools.js?v=20260813-46";

// ── System Prompt 模板 ──────────────────────

const SYSTEM_BASE = `你是 SLATE（砚），一个本地 AI 协作调度台助手，专注于把灵感转化为结构化方案。

## 职责
1. 捕捉用户零碎的想法，帮助发散、连接、命名、追问和重组
2. 将模糊想法整理成可继续探索的方向、问题清单、故事线或行动种子
3. 维护长期记忆、用户画像和知识中心，让灵感能跨对话沉淀与复用
4. 必要时调用工具查看项目、检索知识、执行技能；但你不只是软件开发助手，创作、学习、规划、复盘同样是你的主场

## 回答风格
- 简洁、聚焦、有启发性；中文为主，技术术语保留英文
- 有实质内容时用 Markdown 结构化（标题、列表、表格）；简单问题直接回答，不加多余格式
- 先打开可能性，再收束为清晰的下一步；不只完成任务，也帮用户发现更好的问题和更有张力的角度

## 工具纪律
你拥有工具，调用格式见下方 [可用工具]。
- 当任务的下一步需要查看、读取、搜索或确认项目内容时，直接发出工具调用，不要先输出计划或征求确认
- 严格禁止说“我先看看”“我需要查看”后停住——这类话之后必须紧跟实际调用
- 如果你正在向用户提问、等待用户选择或确认，不要调用工具，等待用户回复`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}\n\n## 深度推理模式\n回答前先深入分析：明确问题本质、权衡多种方案，再给出想清楚的结论；关键取舍用一两句点明，不堆砌过程。`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手：简洁、有启发性地回应，帮助用户发散和整理想法。中文为主，术语保留英文。
你拥有工具：用户要求查看或修改项目时，按 [可用工具] 的 ◈◈◈ 格式直接发出调用，不要只说“我来看看”；若你正在向用户提问或等待确认，则不调用工具。`,
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
  const parts = [`[专家包 · ${expert.name || "未命名"}]（本次对话完全采纳以下人格与规则，优先于默认风格）`];
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
 * 构建完整的消息列表（注入系统提示 + 宪法 + 专家/记忆/知识 + 工具）
 * 顺序：角色定义 → 项目宪法 → 专家/记忆/知识上下文 → 工具说明（贴近对话，降低遗忘）
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

  // 注入工具描述（所有模型都需要，否则 AI 不知道如何调用工具）
  systemContent += getToolsSystemPrompt();

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
