/**
 * SLATE AI 工具系统：让 AI 直接操作黑板、MCP 工具、提示词工厂
 *
 * 工具调用格式（AI 输出）：
 *   ◈◈◈tool_name
 *   {"param1":"value1"}
 *   ◈◆◆
 */

import { state, addBoardCard, setBoardCards } from "../store.js?v=20260807-3";
import { post } from "../services/api.js?v=20260807-3";

function normalizeProjectRelativePath(rawPath) {
  const raw = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!raw) return { error: "Missing file_path" };
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("//")) {
    return { error: "file_path must be relative to the project root" };
  }
  const parts = raw.split("/").filter(part => part && part !== ".");
  if (!parts.length) return { error: "file_path must point to a file" };
  if (parts.includes("..")) return { error: "file_path cannot contain .." };
  const relative = parts.join("/");
  const projectRoot = String(state.project?.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    relative,
    abs: `${projectRoot}/${relative}`,
    fileName: parts[parts.length - 1],
  };
}

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
    name: "执行 MCP 工具",
    description: "调用 MCP 内置工具。可用：file_tree(目录树), file_peek(读文件), file_edit(diff编辑文件), file_create(创建新文件), terminal(执行命令), html_render(生成HTML), css_color(CSS配色), doc_write(文档骨架), text_summarize(文本摘要), json_tool(JSON处理), regex_test(正则测试), repo_stats(项目统计), todo_scan(待办扫描)。也可传入 SKILL.md 技能名读取其定义内容。",
    params: {
      skill: { type: "string", description: "MCP 工具或技能名称", required: true },
      params: { type: "object", description: "工具参数" },
    },
    async execute({ skill, params }) {
      try {
        const p = params || {};
        // 自动注入项目目录作为默认工作目录
        if (state.project) {
          if (!p.directory && ["file_tree", "repo_stats", "todo_scan"].includes(skill)) p.directory = state.project.path;
          if (!p.work_dir && (skill === "terminal")) p.work_dir = state.project.path;
          if (!p.file_path && skill === "file_peek" && p.relative_path) {
            const target = normalizeProjectRelativePath(p.relative_path);
            if (target.error) return `Invalid relative_path: ${target.error}`;
            p.file_path = target.abs;
          } else if (p.file_path && ["file_peek", "file_edit", "file_create"].includes(skill)) {
            const target = normalizeProjectRelativePath(p.file_path);
            if (target.error) return `Invalid file_path: ${target.error}`;
            p.file_path = target.abs;
          }
        }
        const res = await post("/skills/execute", { skill, params: p });
        if (res.code === 0) {
          const data = res.data;
          if (typeof data === "string") return data.length > 2000 ? data.slice(0, 2000) + "…" : data;
          return JSON.stringify(data, null, 2);
        }
        return `MCP 工具执行失败: ${res.message}`;
      } catch (e) {
        return `MCP 工具调用出错: ${e.message}`;
      }
    },
  },

  knowledge_search: {
    name: "检索知识库",
    description: "从本地轻量向量知识库中检索长期记忆、资料摘录和知识中心内容",
    params: {
      query: { type: "string", description: "检索问题或关键词", required: true },
      limit: { type: "number", description: "返回片段数，默认 5" },
    },
    async execute({ query, limit }) {
      const res = await post("/knowledge/search", { query: query || "", limit: limit || 5 });
      if (res.code !== 0) return res.message || "知识库检索失败";
      const items = res.data || [];
      if (!items.length) return "未检索到相关知识";
      return items.map((item, i) => {
        const title = item.title || item.source || "知识";
        return `${i + 1}. [${title}] score=${item.score}\n${item.content}`;
      }).join("\n\n");
    },
  },

  knowledge_add: {
    name: "添加知识",
    description: "把稳定、可复用的信息保存到本地知识中心。不要保存临时任务、工具输出或一次性状态",
    params: {
      title: { type: "string", description: "知识标题", required: true },
      content: { type: "string", description: "知识正文", required: true },
      source: { type: "string", description: "来源说明" },
      kind: { type: "string", description: "类型，如 note/memory/project/fact" },
    },
    async execute({ title, content, source, kind }) {
      if (!content) return "缺少 content";
      const res = await post("/knowledge/docs", {
        title: title || "未命名知识",
        content,
        source: source || "assistant",
        kind: kind || "note",
      });
      if (res.code !== 0) return res.message || "添加知识失败";
      return `已添加知识: ${title || res.data?.id || "未命名知识"}`;
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
    async execute({ file_path, edits, _truncated }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path";
      if (!edits || !edits.length) return "缺少 edits";

      // 输出被截断时 edits 列表可能不完整，只应用部分编辑很危险，拒绝执行
      if (_truncated) {
        return {
          _type: "file_edit",
          file: "",
          file_path_rel: String(file_path || ""),
          file_name: String(file_path || "").replace(/\\/g, "/").split("/").pop() || "",
          diff: "",
          new_content: "",
          stats: { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: ["模型输出被截断，edits 可能不完整，已拒绝执行。请减少单次编辑量或重试"],
          applied: [],
          truncated: true,
        };
      }

      const target = normalizeProjectRelativePath(file_path);
      if (target.error) {
        return {
          _type: "file_edit",
          file: "",
          file_path_rel: String(file_path || ""),
          file_name: String(file_path || "").replace(/\\/g, "/").split("/").pop() || "",
          diff: "",
          new_content: "",
          stats: { edits_total: edits.length, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: [target.error],
          applied: [],
        };
      }
      const absPath = target.abs;
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
          file_path_rel: target.relative,
          file_name: target.fileName,
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
          file_path_rel: target.relative,
          file_name: target.fileName,
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
          file_path_rel: target.relative,
          file_name: target.fileName,
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
        file_path_rel: target.relative,
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
    async execute({ file_path, content, _truncated }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path";
      if (content === undefined || content === null) return "缺少 content";
      const truncated = Boolean(_truncated);

      const target = normalizeProjectRelativePath(file_path);
      if (target.error) {
        return {
          _type: "file_create",
          file: "",
          file_path_rel: String(file_path || ""),
          file_name: String(file_path || "").replace(/\\/g, "/").split("/").pop() || "",
          diff: "",
          content,
          stats: { lines: String(content).split("\n").length, chars: String(content).length },
          errors: [target.error],
          truncated,
        };
      }
      const absPath = target.abs;
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
          file_path_rel: target.relative,
          file_name: target.fileName,
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: ["网络请求失败: " + e.message],
          truncated,
        };
      }
      if (res.code !== 0) {
        return {
          _type: "file_create",
          file: absPath,
          file_path_rel: target.relative,
          file_name: target.fileName,
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: [res.message || "未知错误"],
          truncated,
        };
      }
      const data = res.data;
      if (data?.error) {
        return {
          _type: "file_create",
          file: absPath,
          file_path_rel: target.relative,
          file_name: target.fileName,
          diff: "",
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: [data.error],
          truncated,
        };
      }

      return {
        _type: "file_create",
        file: data.file,
        file_path_rel: target.relative,
        file_name: data.file_name,
        diff: data.diff,
        content: data.content,
        stats: data.stats || { lines: content.split("\n").length, chars: content.length },
        errors: data.errors || [],
        truncated,
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

/**
 * 从 start 位置（必须是 "）读取一个 JSON 字符串，正确处理转义。
 * 返回 { value, end, complete }。未闭合时 complete=false，
 * 不完整的 \uXXXX 转义整体丢弃，避免产生损坏的中文字符。
 */
function readJsonString(raw, start) {
  let out = "";
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return { value: out, end: i + 1, complete: true };
    if (ch !== "\\") { out += ch; i += 1; continue; }
    const next = raw[i + 1];
    if (next === undefined) break; // 转义序列被截断，丢弃残余
    if (next === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        break; // 不完整的 unicode 转义，丢弃以防乱码
      }
    } else {
      const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      out += map[next] !== undefined ? map[next] : next;
      i += 2;
    }
  }
  return { value: out, end: raw.length, complete: false };
}

/**
 * 从 start 位置读取一个 JSON 值（数组/对象/数字等）。
 * 被截断时自动补齐括号，并剔除末尾不完整的字符串，尽力解析出可用结果。
 */
function readJsonValueWithRepair(raw, start) {
  const stack = [];
  let i = start;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      const s = readJsonString(raw, i);
      if (!s.complete) break; // 截断点位于字符串内部，到此为止
      i = s.end;
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      if (!stack.length) break; // 当前值已结束
      stack.pop();
    } else if (c === "," && !stack.length) {
      break; // 当前值已结束
    }
    i += 1;
  }
  let seg = raw.slice(start, i).replace(/,\s*$/, "").trim();
  for (let k = stack.length - 1; k >= 0; k--) seg += stack[k] === "{" ? "}" : "]";
  try {
    return { value: JSON.parse(seg), end: i };
  } catch {
    return { value: undefined, end: i };
  }
}

/**
 * 从被截断的工具调用参数文本中尽力抢救出参数对象。
 * 典型场景：输出长度达到 max_tokens 上限，JSON 缺少闭合引号/括号。
 */
function salvageTruncatedParams(raw) {
  const params = {};
  let i = raw.indexOf("{");
  if (i < 0) return params;
  i += 1;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i += 1;
    if (i >= raw.length || raw[i] === "}") break;
    if (raw[i] !== '"') break;
    const key = readJsonString(raw, i);
    if (!key.complete) break;
    i = key.end;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] !== ":") break;
    i += 1;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length) break;
    if (raw[i] === '"') {
      const val = readJsonString(raw, i);
      params[key.value] = val.value;
      i = val.end;
      if (!val.complete) break; // 字符串值被截断，抢救到此为止
    } else {
      const val = readJsonValueWithRepair(raw, i);
      if (val.value !== undefined) params[key.value] = val.value;
      i = val.end;
      break; // 非字符串值通常是最后一项，且可能不完整，停止抢救
    }
  }
  return params;
}

function detectToolCalls(text) {
  const calls = [];
  let match;
  let lastEnd = 0;
  const re = new RegExp(TOOL_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    lastEnd = re.lastIndex;
    try {
      calls.push({ name: match[1], params: JSON.parse(match[2] || "{}") });
    } catch {
      calls.push({ name: match[1], params: {} });
    }
  }

  // 处理末尾被截断的工具调用块（缺少闭合标记 ◈◆◆，通常是输出达到 max_tokens 上限）
  // 不能直接丢弃：file_create 的 content 往往已输出了大部分内容，应尽力抢救
  const rest = text.slice(lastEnd);
  const openMatch = /◈◈◈[ \t]*(\w+)[ \t]*\r?\n([\s\S]*)$/.exec(rest);
  if (openMatch) {
    const name = openMatch[1];
    const rawBody = openMatch[2];
    let params;
    try {
      params = JSON.parse(rawBody.trim());
    } catch {
      params = salvageTruncatedParams(rawBody);
    }
    params._truncated = true;
    calls.push({ name, params });
  }
  return calls;
}

function stripToolCalls(text) {
  const stripped = text.replace(TOOL_RE, "");
  // 同时移除末尾未闭合的截断工具块，避免残缺 JSON 残留在消息正文
  return stripped
    .replace(/◈◈◈[ \t]*\w+[ \t]*\r?\n[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_edit] 文件: ${output.file_name}（${targetPath}），共 ${s.edits_total} 处编辑，${s.edits_applied} 处成功，+${s.lines_added} -${s.lines_removed} 行。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        summary += " diff 已展示给用户，尚未写入磁盘，等待用户确认。";
      } else if (output._type === "file_create") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_create] 新文件: ${output.file_name}（${targetPath}），${s.lines} 行，${s.chars} 字符。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        summary += " 预览已展示给用户，尚未写入磁盘，等待用户确认。";
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
  let s = "\n\n[可用工具]\n";
  s += "你拥有工具，可以直接操作用户的工作环境。\n\n";
  s += '**当用户说"了解项目"、"看看文件"、"浏览目录"时，你必须立即调用 project_files 工具，格式如下：**\n';
  s += "◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆\n\n";
  s += "不要回答'我无法查看'——你必须发出上面的调用！\n\n";
  s += "**调用规则：必须使用下方指定格式调用工具。不要只描述你要做什么——必须实际发出调用。**\n";
  s += "每次调用独占一行，格式严格如下（◈◈◈ 和 ◈◆◆ 是固定标记，不可省略）：\n";
  s += "◈◈◈tool_name\n{JSON参数}\n◈◆◆\n\n";
  s += "如果当前任务已经需要你查看文件、目录、项目结构、黑板内容或 MCP 工具结果，当前回复必须包含工具调用块。\n";
  s += "如果你只是在问用户是否需要继续、是否要你动手、是否要给出方案，不要调用工具。\n";
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
    s += "用户明确要求查看或修改项目/文件时，你必须先调用 project_files 浏览目录。\n\n";
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
  s += "- file_path 只能使用项目根相对路径，不能使用磁盘绝对路径、URL、~ 或 ..\n";
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
  s += "- file_path 只能使用项目根相对路径，不能使用磁盘绝对路径、URL、~ 或 ..\n";
  s += "- 如果用户只要求输出文件但没有指定位置，默认放在 outputs/ 下，并使用清晰的文件名\n";
  s += "- content: 文件的完整内容\n";
  s += "- content 必须输出完整内容，绝不允许用“…其余省略”“// 同上”等方式缩写\n";
  s += "- 超长文件（预计超过 300 行）应拆分为多次 file_create/file_edit 调用，不要单次硬塞\n";
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
