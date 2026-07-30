/**
 * SLATE AI 工具系统：让 AI 直接操作黑板、技能、提示词工厂
 *
 * 工具调用格式（AI 输出）：
 *   ◈◈◈tool_name
 *   {"param1":"value1"}
 *   ◈◆◆
 */

import { state, addBoardCard, setBoardCards } from "../store.js?v=20260730-2";
import { post } from "../services/api.js?v=20260730-2";

// ── 工具注册表 ────────────────────────────────

const TOOLS = {

  project_info: {
    name: "查看项目",
    description: "查看当前打开的项目信息（路径、配置、宪法）",
    params: {},
    async execute() {
      const p = state.project;
      if (!p) return "当前未打开任何项目";
      const lines = [`项目: ${p.name}`, `路径: ${p.path}`];
      if (p.constitution?.rules?.length) {
        lines.push("项目宪法:");
        p.constitution.rules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
      }
      return lines.join("\n");
    },
  },

  project_files: {
    name: "浏览项目文件",
    description: "浏览当前项目的文件目录，或读取文件内容",
    params: {
      path: { type: "string", description: "相对路径（空=根目录）" },
    },
    async execute({ path }) {
      if (!state.project) return "未打开项目";
      const res = await post("/projects/browse", { path: path || "" });
      if (res.code !== 0) return res.message || "浏览失败";
      const d = res.data;
      if (d.type === "file") return `[${d.name}] (${d.size} bytes)\n${d.content?.slice(0, 5000) || ""}`;
      if (!d.entries?.length) return `[${d.path}] 空目录`;
      return d.entries.map(e => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.size ? ` (${e.size}B)` : ""}`).join("\n");
    },
  },

  project_read_file: {
    name: "读取项目文件",
    description: "读取项目中的指定文件内容",
    params: {
      path: { type: "string", description: "文件相对路径", required: true },
    },
    async execute({ path }) {
      if (!state.project) return "未打开项目";
      const res = await post("/projects/browse", { path });
      if (res.code !== 0) return res.message || "读取失败";
      if (res.data.type !== "file") return "路径不是文件";
      return res.data.content?.slice(0, 10000) || "(空文件)";
    },
  },

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
        const p = params || {};
        // 自动注入项目目录作为默认工作目录
        if (state.project) {
          if (!p.directory && (skill === "file_tree")) p.directory = state.project.path;
          if (!p.work_dir && (skill === "terminal")) p.work_dir = state.project.path;
          if (!p.file_path && skill === "file_peek" && p.relative_path) {
            p.file_path = state.project.path + "/" + p.relative_path;
          }
        }
        const res = await post("/skills/execute", { skill, params: p });
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
  let s = "\n\n[可用工具 - 必须调用]\n";
  s += "你拥有工具，可以直接操作用户的工作环境。\n\n";
  s += '**当用户说"了解项目"、"看看文件"、"浏览目录"时，你必须立即调用 project_files 工具，格式如下：**\n';
  s += "◈◈project_files\n{\"path\": \"\"}\n◆◆\n\n";
  s += "不要回答'我无法查看'——你必须发出上面的调用！\n\n";
  s += "**调用规则：必须使用下方指定格式调用工具。不要只描述你要做什么——必须实际发出调用。**\n";
  s += "每次调用独占一行，格式严格如下（◈◈◈ 和 ◈◆◆ 是固定标记，不可省略）：\n";
  s += "◈◈◈tool_name\n{JSON参数}\n◈◆◆\n\n";

  // 具体示例
  s += '**示例：当用户说"了解项目"时，你必须这样回复（不要文字描述，直接发出调用）：**\n';
  s += "```\n◈project_files\n{\"path\": \"\"}\n◆◆\n```\n";
  s += "（等待工具返回目录列表后，再根据结果回答用户）\n\n";

  // 项目上下文
  if (state.project) {
    s += `[当前项目] ${state.project.name} (${state.project.path})\n`;
    if (state.project.constitution?.rules?.length) {
      s += "项目宪法:\n";
      state.project.constitution.rules.forEach((r, i) => { s += `  ${i + 1}. ${r}\n`; });
    }
    s += "用户提到项目/文件时，你必须先调用 project_files 浏览目录。\n\n";
  }

  for (const [key, tool] of Object.entries(TOOLS)) {
    s += `### ${key} — ${tool.description}\n`;
    const pEntries = Object.entries(tool.params || {});
    if (pEntries.length > 0) {
      s += "参数 (JSON):\n";
      for (const [pk, pv] of pEntries) {
        s += `  - ${pk}: ${pv.type}${pv.required ? " (必填)" : ""} — ${pv.description}\n`;
      }
    }
    s += `示例:\n◈◈◈${key}\n${JSON.stringify(_example(tool.params))}\n◈◆◆\n\n`;
  }
  s += "**再次提醒：不要只说'我来帮你查看'——必须发出 ◈◈ 调用。一次回复可多次调用。**";
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
