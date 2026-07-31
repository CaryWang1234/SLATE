/**
 * SLATE AI 工具系统：让 AI 直接操作黑板、技能、提示词工厂
 *
 * 工具调用格式（AI 输出）：
 *   ◈◈◈tool_name
 *   {"param1":"value1"}
 *   ◈◆◆
 */

import { state, addBoardCard, setBoardCards } from "../store.js?v=20260730-26";
import { post } from "../services/api.js?v=20260730-26";

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

  project_find_file: {
    name: "查找项目文件",
    description: "按文件名或相对路径在当前项目中查找文件",
    params: {
      query: { type: "string", description: "文件名或路径片段", required: true },
    },
    async execute({ query }) {
      if (!state.project) return "未打开项目";
      if (!query) return "缺少 query";
      const res = await post("/projects/find", { query, limit: 30 });
      if (res.code !== 0) return res.message || "查找失败";
      const matches = res.data?.matches || [];
      if (!matches.length) return `未找到: ${query}`;
      return matches.map(item => `${item.type === "dir" ? "📁" : "📄"} ${item.path}${item.size ? ` (${item.size}B)` : ""}`).join("\n");
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
    description: "调用内置技能。可用：file_tree(目录树), file_peek(读文件), file_edit(diff编辑文件), file_create(创建新文件), terminal(执行命令), html_render(生成HTML), css_color(CSS配色), doc_write(文档骨架)",
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

  file_edit: {
    name: "编辑文件",
    description: "基于 diff 精确编辑项目文件。只改指定内容，未提及的部分绝不触碰。用户可「接受」「拒绝」或「复制」diff。",
    params: {
      file_path: { type: "string", description: "目标文件相对路径（相对于项目根目录）", required: true },
      edits: { type: "array", description: '编辑列表，每项含 old_text 和 new_text，如 [{"old_text":"原内容","new_text":"新内容"}]', required: true },
    },
    async execute({ file_path, edits }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path";
      if (!edits || !edits.length) return "缺少 edits";

      const absPath = state.project.path + "/" + file_path.replace(/^\/+/, "");
      let res;
      try {
        res = await post("/skills/execute", {
          skill: "file_edit",
          params: { file_path: absPath, edits: JSON.stringify(edits) },
        });
      } catch (e) {
        return {
          _type: "file_edit",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          new_content: "",
          stats: { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: ["网络请求失败: " + e.message],
          applied: [],
        };
      }
      if (res.code !== 0) {
        return {
          _type: "file_edit",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          new_content: "",
          stats: { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: [res.message || "未知错误"],
          applied: [],
        };
      }
      const data = res.data;
      if (data?.error) {
        return {
          _type: "file_edit",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          new_content: "",
          stats: { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: [data.error],
          applied: [],
        };
      }

      // 返回结构化数据，chat.js 会检测 _type 渲染 diff UI
      return {
        _type: "file_edit",
        file: data.file,
        file_name: data.file_name,
        diff: data.diff,
        new_content: data.new_content,
        stats: data.stats || { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
        errors: data.errors || [],
        applied: data.applied || [],
      };
    },
  },

  file_create: {
    name: "创建文件",
    description: "在项目中创建新文件。文件内容先以 diff 预览，用户确认后才写入。",
    params: {
      file_path: { type: "string", description: "新文件相对路径（相对于项目根目录），如 src/utils/helper.js", required: true },
      content: { type: "string", description: "文件完整内容", required: true },
    },
    async execute({ file_path, content }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path";
      if (content === undefined || content === null) return "缺少 content";

      const absPath = state.project.path + "/" + file_path.replace(/^\/+/, "");
      let res;
      try {
        res = await post("/skills/execute", {
          skill: "file_create",
          params: { file_path: absPath, content },
        });
      } catch (e) {
        return {
          _type: "file_create",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: ["网络请求失败: " + e.message],
        };
      }
      if (res.code !== 0) {
        return {
          _type: "file_create",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: [res.message || "未知错误"],
        };
      }
      const data = res.data;
      if (data?.error) {
        return {
          _type: "file_create",
          file: absPath,
          file_name: file_path.split("/").pop(),
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: [data.error],
        };
      }

      return {
        _type: "file_create",
        file: data.file,
        file_name: data.file_name,
        diff: data.diff,
        content: data.content,
        stats: data.stats || { lines: content.split("\n").length, chars: content.length },
        errors: data.errors || [],
      };
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

const TOOL_RE = /◈◈◈\s*(\w+)\s*\r?\n([\s\S]*?)(?:◈◆◆|◆◆)/g;

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
    // 结构化结果（如 file_edit / file_create）直接传递，同时生成文本摘要给 AI
    if (output && typeof output === "object" && output._type) {
      let summary = `[工具 ${name}] `;
      if (output._type === "file_edit") {
        const s = output.stats;
        summary = `[工具 file_edit] 文件: ${output.file_name}，共 ${s.edits_total} 处编辑，${s.edits_applied} 处成功，+${s.lines_added} -${s.lines_removed} 行。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        summary += " diff 已展示给用户，等待用户确认。";
      } else if (output._type === "file_create") {
        const s = output.stats;
        summary = `[工具 file_create] 新文件: ${output.file_name}，${s.lines} 行，${s.chars} 字符。`;
        summary += " 预览已展示给用户，等待用户确认。";
      }
      return { success: true, output: summary, _structured: output };
    }
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
  s += "◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆\n\n";
  s += "不要回答'我无法查看'——你必须发出上面的调用！\n\n";
  s += "**调用规则：必须使用下方指定格式调用工具。不要只描述你要做什么——必须实际发出调用。**\n";
  s += "每次调用独占一行，格式严格如下（◈◈◈ 和 ◈◆◆ 是固定标记，不可省略）：\n";
  s += "◈◈◈tool_name\n{JSON参数}\n◈◆◆\n\n";
  s += "如果你准备查看任何文件、目录、项目结构、黑板内容或技能结果，当前回复必须包含工具调用块。\n";
  s += "禁止只输出“我先查看”“我需要读取”“让我看看”等意图描述后停止。\n\n";
  s += "只知道文件名但不知道相对路径时，先调用 project_find_file；拿到匹配路径后再调用 project_read_file 读取目标文件。\n\n";

  // 具体示例
  s += '**示例：当用户说"了解项目"时，你必须这样回复（不要文字描述，直接发出调用）：**\n';
  s += "```\n◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆\n```\n";
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
  s += "**再次提醒：不要只说'我来帮你查看'——必须发出 ◈◈◈ 调用。一次回复可多次调用。**";

  // file_edit 专项指导
  s += "\n\n[文件编辑规则 — file_edit 工具]\n";
  s += "当用户要求修改、编辑、修复项目中的已有文件时，你必须使用 file_edit 工具。\n";
  s += "核心原则：你说改它就真改，你不说它绝不碰。\n";
  s += "- file_path: 相对于项目根目录的路径\n";
  s += "- edits: JSON 数组，每项包含 old_text（要替换的原文）和 new_text（替换后的内容）\n";
  s += "- old_text 必须在文件中唯一出现，否则会报错\n";
  s += "- 只包含你要修改的部分，不要包含整个文件内容\n";
  s += "- 可以包含多组编辑，一次性完成所有修改\n";
  s += "- 用户会看到 diff 预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 编辑完成后，等待用户确认，不要自动继续修改\n";

  // file_create 专项指导
  s += "\n\n[文件创建规则 — file_create 工具]\n";
  s += "当用户要求创建新文件时，你必须使用 file_create 工具。\n";
  s += "- file_path: 相对于项目根目录的路径（文件不能已存在）\n";
  s += "- content: 文件的完整内容\n";
  s += "- 如果文件已存在，应使用 file_edit 工具而非 file_create\n";
  s += "- 用户会看到内容预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 创建完成后，等待用户确认\n";

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
