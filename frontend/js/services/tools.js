/**
 * SLATE AI 工具系统：让 AI 直接操作黑板、技能、提示词工厂
 *
 * 工具调用格式（AI 输出）：
 *   ◈◈◈tool_name
 *   {"param1":"value1"}
 *   ◈◆◆
 */

import { state, addBoardCard, setBoardCards } from "../store.js";
import { post } from "../services/api.js";

// ── 工具注册表 ────────────────────────────────

const TOOLS = {

  board_add: {
    name: "添加黑板卡片",
    description: "在白板上添加一张任务/想法卡片，支持依赖关系",
    params: {
      title: { type: "string", description: "卡片标题", required: true },
      body: { type: "string", description: "卡片描述/详情" },
      arrows: { type: "array", description: "依赖目标卡片 ID 列表" },
    },
    async execute({ title, body, arrows }) {
      const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      const card = { id, title: title || "未命名", body: body || "", arrows: arrows || [] };
      addBoardCard(card);
      return `已添加卡片 [${id}]: ${title}`;
    },
  },

  board_read: {
    name: "读取黑板",
    description: "获取当前黑板上所有卡片内容",
    params: {},
    async execute() {
      if (state.boardCards.length === 0) return "黑板为空";
      const lines = state.boardCards.map(c => {
        let s = `[${c.id}] ${c.title}`;
        if (c.body) s += ` — ${c.body}`;
        if (c.arrows?.length) s += ` → ${c.arrows.join(", ")}`;
        return s;
      });
      return `黑板共 ${state.boardCards.length} 张卡片：\n${lines.join("\n")}`;
    },
  },

  board_clear: {
    name: "清空黑板",
    description: "清除黑板上所有卡片",
    params: {},
    async execute() {
      const count = state.boardCards.length;
      setBoardCards([]);
      return `已清空 ${count} 张卡片`;
    },
  },

  skill_run: {
    name: "执行技能",
    description: "调用内置技能。可用：file_tree(目录树), file_peek(读文件), terminal(执行命令), html_render(生成HTML), css_color(CSS配色), doc_write(文档骨架)",
    params: {
      skill: { type: "string", description: "技能名称", required: true },
      params: { type: "object", description: "技能参数" },
    },
    async execute({ skill, params }) {
      try {
        const res = await post("/skills/execute", { skill, params: params || {} });
        if (res.code === 0) {
          const data = res.data;
          if (typeof data === "string") return data.length > 2000 ? data.slice(0, 2000) + "…" : data;
          return JSON.stringify(data, null, 2);
        }
        return `技能执行失败: ${res.message}`;
      } catch (e) {
        return `技能调用出错: ${e.message}`;
      }
    },
  },

  prompt_gen: {
    name: "生成提示词",
    description: "用提示词工厂生成结构化 Prompt，供外部 Agent 使用",
    params: {
      task: { type: "string", description: "任务描述", required: true },
      context: { type: "string", description: "相关文件/上下文" },
      constraints: { type: "string", description: "约束条件" },
    },
    async execute({ task, context, constraints }) {
      const parts = [];
      const c = state.constitution;
      if (c?.rules?.length) {
        parts.push("【项目宪法】");
        c.rules.forEach((r, i) => parts.push(`  ${i + 1}. ${r}`));
        parts.push("");
      }
      if (context) {
        parts.push("【相关文件上下文】");
        context.split("\n").forEach(l => parts.push(`  ${l}`));
        parts.push("");
      }
      parts.push("【任务描述】");
      task.split("\n").forEach(l => parts.push(`  ${l}`));
      parts.push("");
      if (constraints) {
        parts.push("【约束条件】");
        constraints.split("\n").forEach(l => parts.push(`  ${l}`));
        parts.push("");
      }
      parts.push("【交付物要求】");
      parts.push("  输出完整代码文件，含必要注释。如需修改现有文件，标注路径和修改位置。");
      return parts.join("\n");
    },
  },

  chat_context: {
    name: "查看对话上下文",
    description: "查看当前对话的统计信息",
    params: {},
    async execute() {
      const msgs = state.messages;
      const ctxTokens = msgs.reduce((sum, m) => sum + Math.ceil((m.content || "").length / 3) + 4, 0);
      return [
        `模型: ${state.currentModel?.name || "未选择"}`,
        `消息数: ${msgs.length}`,
        `上下文估算: ~${ctxTokens.toLocaleString()} tokens`,
        `上下文限制: ${state.currentModel?.context_window || "未知"}`,
        `黑板卡片: ${state.boardCards.length}`,
      ].join("\n");
    },
  },
};

// ── 工具调用检测 ────────────────────────────────

const TOOL_RE = /◈◈◈(\w+)\n([\s\S]*?)◈◆◆/g;

function detectToolCalls(text) {
  const calls = [];
  let match;
  const re = new RegExp(TOOL_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    try {
      calls.push({ name: match[1], params: JSON.parse(match[2] || "{}") });
    } catch {
      calls.push({ name: match[1], params: {} });
    }
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(TOOL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── 工具执行 ──────────────────────────────────

async function executeTool(name, params) {
  const tool = TOOLS[name];
  if (!tool) return { success: false, output: `未知工具: ${name}` };
  try {
    const output = await tool.execute(params || {});
    return { success: true, output };
  } catch (e) {
    return { success: false, output: `执行出错: ${e.message}` };
  }
}

async function executeToolCalls(calls) {
  const results = [];
  for (const call of calls) {
    const result = await executeTool(call.name, call.params);
    results.push({ ...call, ...result });
  }
  return results;
}

// ── 系统提示词工具段 ──────────────────────────

function getToolsSystemPrompt() {
  let s = "\n\n[可用工具]\n你可以直接调用以下工具来操作用户的工作环境。需要时就调用，不必征求许可。\n\n";
  for (const [key, tool] of Object.entries(TOOLS)) {
    s += `### ${key} — ${tool.description}\n`;
    const pEntries = Object.entries(tool.params || {});
    if (pEntries.length > 0) {
      s += "参数 (JSON):\n";
      for (const [pk, pv] of pEntries) {
        s += `  - ${pk}: ${pv.type}${pv.required ? " (必填)" : ""} — ${pv.description}\n`;
      }
    }
    s += `调用格式:\n◈◈◈${key}\n${JSON.stringify(_example(tool.params))}\n◈◆◆\n\n`;
  }
  s += "你可以在一次回复中多次调用工具。调用后继续正常回答。";
  return s;
}

function _example(params) {
  const obj = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v.type === "string") obj[k] = "...";
    else if (v.type === "array") obj[k] = [];
    else if (v.type === "number") obj[k] = 0;
    else obj[k] = {};
  }
  return obj;
}

export {
  TOOLS, detectToolCalls, stripToolCalls,
  executeTool, executeToolCalls,
  getToolsSystemPrompt,
};
