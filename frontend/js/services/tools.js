/**
 * SLATE AI 工具系统：让 AI 直接操作黑板、工具、提示词工厂
 *
 * 工具调用格式（AI 输出）：
 *   ◈◈◈tool_name
 *   {"param1":"value1"}
 *   ◈◆◆
 * 例外：file_create / file_append 使用原样格式（内容不经 JSON 转义，根治转义损坏与参数丢失）：
 *   ◈◈◈file_create
 *   相对路径（第一行）
 *   文件内容原样（第二行起）
 *   ◈◆◆
 */

import { state, addBoardCard, setBoardCards, getConversationTodos, setConversationTodos, setActions, setHarnessEnabled, requestLoopExit, effectiveConstitution } from "../store.js?v=20260922-005";
import { get, post, put, runSkillStream, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20260922-005";
import { isHighRiskCommand, guardSkillParams } from "./riskguard.js?v=20260922-005";
import { isTruncatedUnexecutable } from "./agent_common.js?v=20260922-005";
import { dlgUserAsk, dlgConfirm } from "./dialog.js?v=20260922-005";
import { t } from "./i18n.js?v=20260922-005";
import { makeId } from "./utils.js?v=20260922-005";
import { runSubAgents, getSubAgentSignal, SUBAGENT_MAX_PARALLEL, SUBAGENT_OUTPUT_LIMIT } from "./subagent.js?v=20260922-005";

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

// ── Actions（用户自定义流程说明书，data/actions/*.yml）────────────

const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Action 目录：优先用 store 里的快照，为空时回落接口（磁盘才是真源）。 */
async function getActionCatalog() {
  const cached = Array.isArray(state.actions) ? state.actions : [];
  if (cached.length) return { actions: cached, broken: state.actionsBroken || [] };
  const res = await get("/actions");
  if (res.code !== 0) return { error: res.message || "读取 Action 目录失败" };
  return {
    actions: res.data?.actions || [],
    broken: res.data?.broken || [],
  };
}

/** 写入/删除后刷新 store 快照：面板与下一次目录注入都要看到磁盘上的新状态。
 * 刷新失败不改写已成功的写入结果——面板下次打开本就会自取。 */
async function refreshActionSnapshot() {
  try {
    const res = await get("/actions");
    if (res.code === 0) setActions(res.data);
  } catch {
    /* 忽略：真源是磁盘，快照丢了只是显示滞后 */
  }
}

/** 把一份 Action 渲染成给模型看的流程单（结构化字段 → 定长文本）。 */
function renderAction(payload) {
  const a = payload?.action || {};
  const lines = [`[Action ${a.id || ""}] ${a.name || ""}`, a.description || ""];
  if (a.when) lines.push(`适用时机: ${a.when}`);
  const inputs = a.inputs || [];
  if (inputs.length) {
    lines.push("输入:");
    for (const i of inputs) {
      const opts = i.options?.length ? `，可选 ${i.options.join("/")}` : "";
      lines.push(`  - ${i.key}${i.label ? `（${i.label}）` : ""}: ${i.type}${i.required ? "，必填" : ""}${opts}`);
    }
  }
  const steps = a.steps || [];
  lines.push(`流程（${steps.length} 步）:`);
  steps.forEach((s, idx) => {
    lines.push(`  ${idx + 1}. ${s.title}${s.tool ? ` [建议工具: ${s.tool}]` : ""}`);
    String(s.detail || "").split("\n").forEach(l => lines.push(`     ${l}`));
    if (s.check) lines.push(`     验收: ${s.check}`);
  });
  const out = a.output || {};
  if (out.format || out.destination || out.path) {
    lines.push(`产出: ${out.format || "未指定"}${out.destination ? ` → ${out.destination}` : ""}${out.path ? ` ${out.path}` : ""}`);
  }
  if (a.tags?.length) lines.push(`标签: ${a.tags.join(", ")}`);
  if (Array.isArray(payload?.warnings) && payload.warnings.length) {
    lines.push(`该文件的书写提醒: ${payload.warnings.join("；")}`);
  }
  lines.push("", "以上是用户写下的流程约定，不是已完成的证据：与用户当前要求冲突时以用户要求为准；标注了建议工具的步骤必须实际调用工具并核对结果，不能只在文字里复述步骤。");
  const text = lines.join("\n");
  return text.length > 12000
    ? `${text.slice(0, 12000)}\n…（内容过长已截断，完整原文见 ${payload?.path || "data/actions"}）`
    : text;
}

// ── 工具注册 ────────────────────────────────

// 模型显式收口：只登记一次请求，真正停循环由工具循环在轮末取走（chat.js desktopPolicy）。
// 不在这里 abort：那会掐断工具结果回灌，用户只看得到半截汇报。
function exitAgentLoop(mode, summary) {
  if (mode === "target") setHarnessEnabled(false);
  requestLoopExit({ mode, reason: summary });
  const closed = mode === "target" ? "目标模式开关已关闭，后续消息不再自动推进。" : "";
  return `已登记收口，本次自主循环将在你给出最终汇报后停止。${closed}`
    + "下一条回复不要再调用工具：直接写明交付了什么、每项用什么方式验证、验证结果是什么。";
}

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
      return d.entries.map(e => `${e.type === "dir" ? "[目录]" : "[文件]"} ${e.name}${e.size ? ` (${e.size}B)` : ""}`).join("\n");
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
      if (!matches.length) return `未找到 ${query}`;
      return matches.map(item => `${item.type === "dir" ? "[目录]" : "[文件]"} ${item.path}${item.size ? ` (${item.size}B)` : ""}`).join("\n");
    },
  },

  code_search: {
    name: "全局代码搜索",
    description: "在当前项目中搜索文本或正则（类似 Ctrl+Shift+F 全局搜索）。query 必填，支持正则；默认搜索整个项目（全局），可用 scope 缩小到项目内子目录（相对路径或项目内绝对路径）；case_sensitive 控制大小写，glob 过滤文件名，limit 控制结果上限。",
    params: {
      query: { type: "string", description: "要搜索的文本或正则表达式", required: true },
      scope: { type: "string", description: "搜索范围：项目内相对路径或绝对路径，空=全局（项目根）" },
      case_sensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
      glob: { type: "string", description: "文件名过滤，如 *.py / **/*.ts" },
      limit: { type: "integer", description: "结果上限（默认 50）" },
    },
    async execute(params) {
      if (!state.project) return "未打开项目";
      const res = await post("/skills/execute", { skill: "code_search", params: params || {} });
      if (res.code !== 0) return res.message || "搜索失败";
      const d = res.data || {};
      if (d.error) return `搜索失败：${d.error}`;
      const matches = d.matches || [];
      if (!matches.length) return `未找到匹配「${(params && params.query) || ""}」`;
      const lines = matches.map(m => `${m.file}:${m.line}:${m.column}  ${m.text}`);
      const tail = d.truncated ? `\n…（已截断，仅显示前 ${matches.length} 条）` : `\n（共 ${d.count} 条，扫描 ${d.scanned_files} 个文件）`;
      return lines.join("\n") + tail;
    },
  },

  board_add: {
    name: "添加黑板卡片",
    description: "在白板上添加一张卡片，支持标题、详情、依赖关系和语义颜色。适合将想法、任务或概念可视化。",
    params: {
      title: { type: "string", description: "卡片标题", required: true },
      body: { type: "string", description: "卡片描述/详情" },
      arrows: { type: "array", description: "依赖目标卡片 ID 列表（指向已有卡片）" },
      color: { type: "string", description: "颜色: default/red/orange/yellow/green/blue/purple" },
    },
    async execute({ title, body, arrows, color }) {
      const VALID_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];
      const id = makeId("c");
      const card = {
        id,
        title: title || "未命名",
        body: body || "",
        arrows: arrows || [],
        color: VALID_COLORS.includes(color) ? color : "default",
      };
      addBoardCard(card);
      return `已添加卡片[${id}]: ${title}`;
    },
  },

  board_read: {
    name: "读取黑板",
    description: "获取当前黑板上所有卡片内容（含 ID、标题、详情、依赖、颜色）",
    params: {},
    async execute() {
      if (state.boardCards.length === 0) return "黑板为空";
      const lines = state.boardCards.map(c => {
        let s = `[${c.id}] ${c.title}`;
        if (c.color && c.color !== "default") s += ` (${c.color})`;
        if (c.body) s += ` ${c.body}`;
        if (c.arrows?.length) s += ` ${c.arrows.join(", ")}`;
        return s;
      });
      return `黑板${state.boardCards.length} 张卡片：\n${lines.join("\n")}`;
    },
  },

  board_update: {
    name: "更新黑板卡片",
    description: "更新已有卡片的标题、详情、依赖或颜色。只改传入的字段，未传的保持不变。",
    params: {
      id: { type: "string", description: "目标卡片 ID", required: true },
      title: { type: "string", description: "新标题" },
      body: { type: "string", description: "新详细" },
      arrows: { type: "array", description: "新依赖列表（覆盖原值）" },
      color: { type: "string", description: "新颜色 default/red/orange/yellow/green/blue/purple" },
    },
    async execute({ id, title, body, arrows, color }) {
      const VALID_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];
      const idx = state.boardCards.findIndex(c => c.id === id);
      if (idx === -1) return `卡片 ${id} 不存在`;
      const card = { ...state.boardCards[idx] };
      if (title !== undefined) card.title = title;
      if (body !== undefined) card.body = body;
      if (arrows !== undefined) card.arrows = arrows;
      if (color !== undefined) card.color = VALID_COLORS.includes(color) ? color : card.color;
      const cards = [...state.boardCards];
      cards[idx] = card;
      setBoardCards(cards);
      return `已更新卡片[${id}]`;
    },
  },

  board_batch: {
    name: "批量操作黑板",
    description: "一次性对黑板执行多个操作（添加、更新、删除、清空），适合整体重构黑板结构。操作按顺序执行。",
    params: {
      ops: { type: "array", description: '操作列表，每天 {action:"add",title,body,arrows,color} | {action:"update",id,title,body,arrows,color} | {action:"delete",id} | {action:"clear"}', required: true },
    },
    async execute({ ops }) {
      if (!Array.isArray(ops) || !ops.length) return "ops 必须是非空数组";
      const VALID_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];
      const results = [];
      let cards = [...state.boardCards];

      for (const op of ops) {
        if (op.action === "add") {
          const id = makeId("c");
          cards.push({
            id,
            title: op.title || "未命名",
            body: op.body || "",
            arrows: op.arrows || [],
            color: VALID_COLORS.includes(op.color) ? op.color : "default",
          });
          results.push(`+ [${id}] ${op.title || "未命名"}`);
        } else if (op.action === "update") {
          const idx = cards.findIndex(c => c.id === op.id);
          if (idx === -1) { results.push(`- 跳过 ${op.id}: 不存在`); continue; }
          const card = { ...cards[idx] };
          if (op.title !== undefined) card.title = op.title;
          if (op.body !== undefined) card.body = op.body;
          if (op.arrows !== undefined) card.arrows = op.arrows;
          if (op.color !== undefined && VALID_COLORS.includes(op.color)) card.color = op.color;
          cards[idx] = card;
          results.push(`~ [${op.id}]`);
        } else if (op.action === "delete") {
          const before = cards.length;
          cards = cards.filter(c => c.id !== op.id);
          results.push(cards.length < before ? `- [${op.id}]` : `跳过 ${op.id}: 不存在`);
        } else if (op.action === "clear") {
          cards = [];
          results.push("清空");
        }
      }

      setBoardCards(cards);
      return `执行 ${ops.length} 项操作：\n${results.join("\n")}`;
    },
  },

  board_clear: {
    name: "清空黑板",
    description: "清除黑板上所有卡片",
    params: {},
    async execute() {
      const count = state.boardCards.length;
      setBoardCards([]);
      return `已清空${count} 张卡片`;
    },
  },

  image_gen: {
    name: "生成图片",
    description: "AI 图片生成：根据描述生成图片，返回本地文件与预览链接。prompt 必填（图片内容描述，越具体效果越好），size 可选（如 1024x1024、512x512，默认 1024x1024），n 可选（生成数量，默认 1，最多 4）。需先在「设置 → 图片生成」中配置模型与 API Key，未配置会返回错误。",
    params: {
      prompt: { type: "string", description: "图片内容描述（具体、包含主体/风格/构图/色彩）", required: true },
      size: { type: "string", description: "图片尺寸，如 1024x1024 / 512x512（默认 1024x1024）" },
      n: { type: "number", description: "生成数量，默认 1，最多 4" },
    },
    async execute(params) {
      const res = await post("/skills/execute", { skill: "image_gen", params: params || {} });
      if (res.code !== 0) return `图片生成失败：${res.message || "未知错误"}`;
      const d = res.data || {};
      if (d.message && d.message !== "ok") return `图片生成失败：${d.message}`;
      return JSON.stringify(d);
    },
  },

  video_gen: {
    name: "生成视频",
    description: "AI 视频生成：根据描述生成短视频，返回本地文件与预览链接。prompt 必填（视频内容描述），duration 可选（时长秒数，默认 5，最多 30）。需先在「设置 → 视频生成」中配置模型与 API Key，未配置会返回错误。",
    params: {
      prompt: { type: "string", description: "视频内容描述（画面主体/动作/风格/运镜）", required: true },
      duration: { type: "number", description: "时长秒数，默认 5，最多 30" },
    },
    async execute(params) {
      const res = await post("/skills/execute", { skill: "video_gen", params: params || {} });
      if (res.code !== 0) return `视频生成失败：${res.message || "未知错误"}`;
      const d = res.data || {};
      if (d.message && d.message !== "ok") return `视频生成失败：${d.message}`;
      return JSON.stringify(d);
    },
  },

  user_ask: {
    name: "询问用户",
    description: "任务需要额外条件输入时调用：向用户提出一个选择题并等待回答。question 必填（向用户提出的问题，如“希望用什么风格生成？”），options 可选（2-6 个选项的数组；用户也可自由输入自定义答案）。调用后返回用户的选择，请基于答案继续任务。仅在任务关键条件缺失且无法基于上下文合理假设时使用，不要过度打扰用户。",
    params: {
      question: { type: "string", description: "向用户提出的问题", required: true },
      options: { type: "array", description: "选择题选项（2-6 个字符串），用户也可自由输入" },
    },
    async execute({ question, options }) {
      const answer = await dlgUserAsk(String(question || "").trim(), options);
      if (answer === null) return "用户未提供条件，请基于现有信息继续，或向用户说明还缺少什么。";
      return `用户回答: ${answer}`;
    },
  },

  skill_search: {
    name: "技能搜索",
    description: "搜索可用技能/工具：按关键词查找内置工具、SKILL.md 自定义技能与远程 MCP 工具，关键词匹配技能名或描述。keyword 留空则列出全部。命中结果中的技能名可直接通过 skill_run 调用（skill 参数传技能名）读取其定义。",
    params: {
      keyword: { type: "string", description: "搜索关键词（匹配技能名或描述），留空列出全部技能", required: false },
    },
    async execute({ keyword }) {
      try {
        let mcp = {}, skills = {}, remoteTools = [];
        if (state.skills) {
          mcp = state.skills.mcp || {};
          skills = state.skills.skills || {};
          remoteTools = state.skills.remoteTools || [];
        }
        if (!Object.keys(mcp).length && !Object.keys(skills).length && !remoteTools.length) {
          const res = await get("/skills");
          if (res.code === 0) {
            mcp = res.data.mcp || {};
            skills = res.data.skills || {};
            remoteTools = res.data.remoteTools || [];
          }
        }
        const kw = String(keyword || "").trim().toLowerCase();
        const all = [
          ...Object.entries(mcp).map(([name, desc]) => ({ name, desc: String(desc), type: "内置工具" })),
          ...Object.entries(skills).map(([name, desc]) => ({ name, desc: String(desc), type: "SKILL.md 技能" })),
          ...(remoteTools || []).map(t => ({ name: `mcp__${t.serverId}__${t.name}`, desc: `[MCP:${t.server}] ${t.description || ""}`, type: "远程 MCP" })),
        ];
        const hits = kw
          ? all.filter(x => x.name.toLowerCase().includes(kw) || x.desc.toLowerCase().includes(kw))
          : all;
        if (!hits.length) return `未找到与「${keyword}」相关的技能。可尝试其他关键词，或留空 keyword 列出全部技能。`;
        const lines = hits.map((x, i) => `${i + 1}. ${x.name}（${x.type}）：${compactDescription(x.desc, 120)}`);
        return `共找到 ${hits.length} 个相关技能：\n${lines.join("\n")}\n\n需要使用时通过 skill_run 调用，skill 参数传技能名（自定义技能会返回 SKILL.md 定义内容）。`;
      } catch (e) {
        return `技能搜索失败: ${e.message}`;
      }
    },
  },

  skill_run: {
    name: "执行工具",
    description: "调用内置工具。可用：file_tree(目录扫描：支持递归recursive、深度depth、glob过滤pattern如*.py、包含隐藏文件include_hidden，使用os.scandir快速扫描), file_peek(读文件：支持多编码encoding如utf-8/gbk/gb2312、自动检测编码auto_detect、行范围start_line/end_line、tail模式读最后N行、快速模式fast不统计总行数), file_edit(文件编辑：action=edit基于diff精确修改（edits JSON数组每项含old_text和new_text）/replace_range按行号范围替换（start_line/end_line/content，推荐先view确认行号）/read读取内容（start_line/end_line行号范围）/insert在指定行插入（content内容、start_line行号）/delete删除行范围（start_line/end_line）/copy复制到剪贴板（start_line/end_line可选、clipboard_name剪贴板名）/paste从剪贴板粘贴（start_line行号、clipboard_name）/cut剪切到剪贴板（start_line/end_line、clipboard_name）), file_create(创建新文件), terminal(终端会话：支持多会话管理、状态保持（cd/$env: 跨命令保持，PowerShell 变量不跨命令）、进程管理，action=create创建会话/list列出所有会话/close关闭会话/kill终止进程/空串执行命令，command要执行的命令、work_dir工作目录、session_id会话ID默认default、timeout超时秒数默认30，Windows 每条命令一个 PowerShell 进程：多行块与 &&/|| 均可用，交互式 REPL（裸 python/node）拿不到输入会拖到超时故别用，高危命令双层拦截), html_render(生成HTML), css_color(CSS配色), doc_write(文档骨架), ppt_create(生成.pptx演示文稿：title标题、outline逗号分隔章节或slides传JSON数组[{title,points}]精确控制每页，theme可选slate/blue/green/wine/gray十六进制色值，返回文件路径), word_create(生成.docx Word文档：title标题、content正文支持#标题/-列表/1.有序列表标记，或sections传JSON数组[{heading,level,paragraphs,bullets}]，返回文件路径), text_summarize(文本摘要), json_tool(JSON处理), regex_test(正则测试), repo_stats(项目统计), todo_scan(待办扫描), web_search(联网搜索/网页抓取，获取实时信息：mode=search时query为关键词，engine可选auto（Bing+DuckDuckGo并发合并去重，推荐）/bing/ddg，mode=fetch时query为URL), web_fetch(获取指定网页内容：url为完整URL，返回标题/描述/正文Markdown，支持JS渲染页面与PDF，mode=html时返回原始HTML，render_js可选auto（正文过短自动渲染）/on/off，max_chars截断长度默认20000上限60000), chart_create(生成SVG图表：type=bar柱状图/hbar条形图/line折线图/pie饼图，data支持JSON数组[{label,value}]、JSON对象{标签:数值}或文本A:1, B:2（逗号/换行分隔），title图表标题可选，theme配色可选slate/blue/green/warm/gray或逗号分隔色值，返回preview_url可预览), qrcode_create(生成SVG二维码：text为文本或URL，size模块像素大小默认8，返回preview_url可预览), python_api_extract(提取Python库公共API文档：target为已安装包名如requests或本地py文件/包目录路径，depth子模块递归深度默认1，-1不限，format可选json或代码，输出函数签名、类方法、属性、源码位置，落盘返回file_path，代码附带preview_url), html_bundle(便携网页打包：src为源html路径，将该页面相对路径引用的css/js内联合并为单个html便于分发，out输出路径可选、缺省为源同目录原名.bundled.html，CDN/绝对路径保留外链并在warnings中警告，返回file_path与内联清单), code_scan(代码安全扫描：扫描项目检测硬编码密钥/SQL注入/XSS/弱加密/调试残留等，severity过滤critical/high/medium/low，category过滤类别), doc_scan(文档安全扫描：扫描文档检测不安全信息，支持md/docx/pptx/xlsx/csv/pdf/txt，检测身份证号/手机号/邮箱/密码/密钥/银行账号/薪资/机密标记/内网URL等，directory扫描目录或file_path扫描单文件，severity过滤级别，category过滤类别如'身份证号'/'硬编码密码'，max_files最大扫描文件数默认50), mcp_factory(工具工厂：根据描述自动生成新的工具，tool_name工具名称英文、description工具描述、params参数规格JSON数组、body核心逻辑代码、overwrite是否覆盖已有工具), browser_automation(浏览器自动化：Playwright控制Chromium，action=launch启动/navigate导航/screenshot截图/click点击/type输入/get_text获取文字/evaluate执行JS/scroll滚动/wait等待元素/close关闭，url目标URL、selector CSS选择器、text输入文字、expression JS表达式、headless无头模式、full_page全页截图), computer_use(桌面自动化：pyautogui控制鼠标键盘与窗口，默认快速模式，action=screenshot截图/click点击/double_click双击/right_click右键/type输入（非ASCII自动走剪贴板）/press单键按压/hotkey组合键/scroll滚动/move移动/drag拖拽/wait等待秒数/position鼠标位置/screen_size屏幕分辨率/locate图像定位/clipboard剪贴板读写/window_list列出窗口/window_focus/window_minimize/window_maximize/window_restore/window_close窗口操作，x/y坐标、text文字、keys按键、button鼠标按键、region截图区域x,y,w,h、fast快速模式默认true、screenshot_format默认jpeg可选png、quality默认80、max_width/max_height截图缩放上限、seconds等待秒数、repeats按键次数、scroll_amount滚动格数、image_path参考图片、confidence置信度、title窗口标题关键词，截图返回preview_url可内联预览), excel_tool(办公表格：action=create生成.xlsx（title标题、sheet工作表名、headers表头JSON数组或逗号分隔、rows数据JSON二维数组，或data传CSV文本首行表头），read读取.xlsx/.csv（file_path、sheet工作表、limit预览行数默认50，返回表头与数据预览），convert为csv与xlsx互转（file_path、out输出路径可选）), pdf_tool(PDF办公文档：action=info元信息页数/extract提取文本（pages页码范围如1-3,5）/tables提取表格数据，file_path必填，max_chars最大字符数默认30000), git_tool(Git只读信息：action=status分支与工作区变更/log最近提交（limit默认10）/diff变更统计（scope=unstaged未暂存/staged已暂存/all）/branches本地与远程分支/remotes远程仓库，directory仓库目录必填), screenshot_to_code(截图转代码：读取图片文件编码为base64供AI视觉分析，image_path图片路径必填、style风格偏好可选如tailwind/plain css/responsive，AI根据截图生成HTML/CSS代码还原视觉效果), image_gen(AI图片生成：prompt描述必填、size尺寸可选如1024x1024、n数量默认1最多4，需先在设置中配置模型与Key，返回preview_url可预览), video_gen(AI视频生成：prompt描述必填、duration时长秒数默认5最多30，需先在设置中配置模型与Key，返回preview_url可预览)。也可传入 SKILL.md 技能名读取其定义内容",
    params: {
      skill: { type: "string", description: "工具或技能名称", required: true },
      params: { type: "object", description: "工具参数" },
    },
    async execute({ skill, params }, callCtx = {}) {
      try {
        const p = params || {};
        // 自动注入项目目录作为默认工作目录
        if (state.project) {
          if (!p.directory && ["file_tree", "repo_stats", "todo_scan", "git_tool", "code_scan", "doc_scan"].includes(skill)) p.directory = state.project.path;
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
        // 高危命令审批：写死规则判定，命中后弹框并用模型解释目的
        // 移动端通过 window.__slateGuardOverride 接管审批 UI（底部 sheet），桌面不受影响
        if (skill === "terminal" && p.command) {

          const risk = isHighRiskCommand(p.command);
          const guard = window.__slateGuardOverride || guardSkillParams;
          if (risk.risk && !(await guard(skill, p))) {
            return `高危命令被用户拒绝执行（${risk.reason}）：${p.command}`;
          }
        }
        // 联网搜索默认配置：模型未显式指定时注入设置面板的默认引擎 / JS 渲染策略
        if (skill === "web_search" && !p.engine && state.webSearch) p.engine = state.webSearch.engine;
        if (skill === "web_fetch" && !p.render_js && state.webSearch) p.render_js = state.webSearch.renderJs;
        // 一笔一流：进度/输出实时回推，signal 关闭即取消该笔；
        // 仅在「连接从未建立」时回落 /execute，避免重放已经发生的副作用。
        const streamed = await runSkillStream(skill, p, {
          signal: callCtx.signal,
          callId: callCtx.callId,
          onEvent: callCtx.onEvent,
        });
        const res = streamed.fallback
          ? await post("/skills/execute", { skill, params: p })
          : (streamed.result || { code: -1, data: null, message: t("工具流式执行失败") });
        if (res.code === 0) {
          const data = res.data;
          if (data && data.type === "custom_skill" && data.content) return data.content;
          if (typeof data === "string") return data.length > 2000 ? data.slice(0, 2000) + "…" : data;
          return JSON.stringify(data, null, 2);
        }
        return `工具执行失败: ${res.message}`;
      } catch (e) {
        return `工具调用出错: ${e.message}`;
      }
    },
  },

  actions_list: {
    name: "Action 目录",
    description: "列出用户自定义的 Actions（每个是一份「干某件事的必要流程」说明书）。keyword 匹配 id/名称/描述/适用时机/标签，留空则列出全部。只返回摘要（id、名称、描述、适用时机、步骤数），完整流程要用 actions_read 按 id 读取。",
    params: {
      keyword: { type: "string", description: "搜索关键词，留空列出全部 Action", required: false },
    },
    async execute({ keyword }) {
      try {
        const catalog = await getActionCatalog();
        if (catalog.error) return `Action 目录读取失败: ${catalog.error}`;
        const kw = String(keyword || "").trim().toLowerCase();
        const hits = kw
          ? catalog.actions.filter(a => [a.id, a.name, a.description, a.when, (a.tags || []).join(" ")]
            .some(x => String(x || "").toLowerCase().includes(kw)))
          : catalog.actions;
        const lines = [];
        if (!hits.length) {
          lines.push(kw ? `没有匹配「${keyword}」的 Action。可换个关键词，或留空 keyword 列出全部。`
            : "用户还没有配置任何 Action（data/actions/*.yml 为空）。");
        } else {
          lines.push(`共 ${hits.length} 个 Action：`);
          hits.forEach((a, i) => {
            lines.push(`${i + 1}. ${a.id}｜${a.name}：${compactDescription(a.description, 120)}`
              + (a.when ? `（适用：${compactDescription(a.when, 80)}）` : "")
              + `，${a.stepCount} 步`);
          });
          lines.push("用 actions_read 读取完整流程后再决定是否照此执行。");
        }
        if (catalog.broken?.length) {
          lines.push(`以下 ${catalog.broken.length} 个 Action 文件解析失败、暂不可用：`
            + catalog.broken.map(b => `${b.id}（${b.error}）`).join("、"));
        }
        return lines.join("\n");
      } catch (e) {
        return `Action 目录读取出错: ${e.message}`;
      }
    },
  },

  actions_read: {
    name: "读取 Action",
    description: "按 id 读取一个 Action 的完整流程（输入项、步骤与建议工具、验收点、产出要求）。当用户请求与某个 Action 的适用时机吻合时调用，然后按步骤推进；读到流程不等于做过流程，标了建议工具的步骤仍要实际调用工具完成。",
    params: {
      id: { type: "string", description: "Action id（即 yml 文件名，如 weekly_report）", required: true },
    },
    async execute({ id }) {
      try {
        const clean = String(id || "").trim();
        if (!ACTION_ID_RE.test(clean)) {
          return `无效的 Action id: ${id}。id 只能是小写字母开头的 a-z0-9_-，请先用 actions_list 确认。`;
        }
        const res = await get(`/actions/${clean}`);
        if (res.code !== 0) return `读取 Action ${clean} 失败: ${res.message}`;
        return renderAction(res.data);
      } catch (e) {
        return `读取 Action 出错: ${e.message}`;
      }
    },
  },

  actions_write: {
    name: "写入 Action",
    description: "创建或整份覆盖一个 Action（data/actions/<id>.yml），把与用户当面确认过的流程固化成以后可复用的说明书。id 是 yml 文件名（小写字母开头的 a-z0-9_-，如 weekly_report）；content 是完整的 SAY-1 YAML 原文（换行写成 \\n），必须含 name/description/steps，并写 author: model 声明由模型代写。格式约束：缩进只用 2 个空格、禁止 Tab，列表用块式写法（- 开头），禁止行内 {}/[]。写入前后端会按行校验，未通过不会落盘；覆盖已有文件前会自动留底（设置 → 技能与工具 里可回滚）。人工审批模式下会弹确认框给用户看原文，用户拒绝即不写入——此时不要反复重试，应把要点讲清楚或改用普通回复。只在用户明确要求「以后都按这套流程」时使用，不要擅自替用户发明流程。",
    params: {
      id: { type: "string", description: "Action id（yml 文件名，小写字母开头的 a-z0-9_-）", required: true },
      content: { type: "string", description: "完整的 SAY-1 YAML 原文", required: true },
    },
    async execute({ id, content }) {
      try {
        const clean = String(id || "").trim();
        if (!ACTION_ID_RE.test(clean)) {
          return `无效的 Action id: ${id}。id 只能是小写字母开头的 a-z0-9_-（不超过 48 字），请修正后重发。`;
        }
        const text = String(content || "");
        if (!text.trim()) return "缺少 content：需给出完整的 SAY-1 YAML 原文，不是 JSON、也不是字段清单。";
        const check = await post("/actions/validate", { content: text });
        if (check.code !== 0) return `Action ${clean} 校验请求失败: ${check.message}`;
        const draft = check.data || {};
        if (!draft.ok) {
          const errs = (draft.errors || []).map(e => `第 ${e.line} 行：${e.reason}`).join("；") || "未知原因";
          return `Action ${clean} 未写入：SAY-1 校验未通过（${errs}）。请按行号修正 content 后重发，或先 actions_read 一个既有 Action 作为格式参照。`;
        }
        if (draft.action?.author !== "model") {
          return `Action ${clean} 未写入：content 里必须写明 author: model（面板要据此标出这份流程由模型代写）。加上后重发即可。`;
        }
        const warnings = draft.warnings || [];
        if (state.permissionMode !== "auto" && state.permissionMode !== "full") {
          const approved = await dlgConfirm(
            `模型要把下面这份流程写成 Action「${clean}」（data/actions/${clean}.yml）。\n\n`
            + `${text.length > 3000 ? `${text.slice(0, 3000)}\n…（原文过长已截断，完整内容写入后可在 设置 → 技能与工具 查看）` : text}\n\n`
            + (warnings.length ? `书写提醒：${warnings.join("；")}\n` : "")
            + "确认后会覆盖同名 Action（覆盖前自动留底，可回滚）。",
            { title: "写入 Action", okText: "允许写入", cancelText: "拒绝" },
          );
          if (!approved) {
            return `用户拒绝了本次 Action 写入（${clean} 未改动）。请不要重复调用本工具，可在回复里说明这份流程的要点，或询问用户想改哪里。`;
          }
        }
        const res = await put(`/actions/${clean}`, { content: text });
        if (res.code !== 0) return `Action ${clean} 写入失败: ${res.message}`;
        const d = res.data || {};
        await refreshActionSnapshot();
        const lines = [`已${d.created ? "创建" : "更新"} Action ${clean}（${d.stepCount} 步、${d.inputCount} 个输入项），文件 ${d.path}。`];
        if (d.backedUp) lines.push(`原内容已留底（${d.backedUp}），可在 设置 → 技能与工具 → Actions 的历史里回滚。`);
        if (warnings.length) lines.push(`书写提醒：${warnings.join("；")}`);
        lines.push("Action 只是流程约定，本次任务仍要按步骤实际执行并完成验证。");
        return lines.join("\n");
      } catch (e) {
        return `写入 Action 出错: ${e.message}`;
      }
    },
  },

  subagent_run: {
    name: "并行子代理",
    description: "一次性派出多个子代理并行执行相互独立的子任务，全部完成后汇总各子代理结论返回。适用场景：互不依赖的多路调研/扫描/分析（如同时调研多个目录、多个技术方案并行试错、多文件独立审查）。每个子代理拥有与你相同的工具（读文件/执行命令/联网搜索等）与独立的运行上下文——子代理看不到主对话历史，因此每个 task 必须自包含（写清背景、目标、路径、期望产出）。agents 为对象数组，每项 {name: 简短中文名, task: 完整任务描述}；单次最多 5 个并行，多给的会被忽略。有依赖关系或需要共享上下文的任务不要用本工具，应分多轮串行处理。",
    params: {
      agents: { type: "array", description: "子代理定义数组 [{name: 名称, task: 自包含任务描述}]，required: true" },
    },
    async execute({ agents }, callCtx = {}) {
      if (!Array.isArray(agents) || agents.length === 0 || !agents.some(a => a && String(a.task || "").trim())) {
        return "参数错误：agents 必须是非空数组，每项包含 {name, task}，且至少一项 task 非空。请修正后重发调用。";
      }
      try {
        const { results, skipped } = await runSubAgents(agents, {
          detect: detectToolCalls,
          strip: stripToolCalls,
          exec: executeTool,
          toolsPrompt: getToolsSystemPrompt({ compact: true }),
          // 事件账本 + 父调用 id：子代理的 started/finished 落在这一行账本上，星图据此画 spawn 边
          ledger: callCtx.ledger || null,
          parentCallId: callCtx.ledgerCallId || "",
        }, getSubAgentSignal());

        const statusText = { done: "完成", failed: "失败", stopped: "已停止", max_rounds: "轮次用尽" };
        const ok = results.filter(r => r.status === "done").length;
        const failed = results.filter(r => r.status === "failed").length;
        const parts = results.map(r => {
          const body = (r.output || "").trim() || "（无文本输出）";
          const clipped = body.length > SUBAGENT_OUTPUT_LIMIT ? body.slice(0, SUBAGENT_OUTPUT_LIMIT) + "…（超出长度上限已截断）" : body;
          return `## 子代理「${r.name}」（${statusText[r.status] || r.status}，${r.rounds} 轮，${r.toolCalls} 次工具调用）\n${clipped}`;
        });
        let head = `[子代理执行完成] 共 ${results.length} 个（完成 ${ok} / 失败 ${failed}${results.some(r => r.status === "stopped") ? " / 部分被用户停止" : ""}）。请基于以下各子代理结论汇总回答用户。`;
        if (skipped > 0) head += `\n注意：另有 ${skipped} 个子代理因超出单次 ${SUBAGENT_MAX_PARALLEL} 个并行上限被忽略，如需执行请再次调用。`;
        return `${head}\n\n${parts.join("\n\n")}`;
      } catch (e) {
        return `子代理执行出错: ${e.message}`;
      }
    },
  },

  system_info: {
    name: "系统元认知",
    description: "获取本机系统信息：当前日期时间、CPU/内存/存储配置、GPU（独显+集显）、电池电量、网络连接状态。让模型了解运行环境。",
    params: {},
    async execute() {
      try {
        const res = await get("/system/info");
        if (res.code !== 0) return res.message || "获取系统信息失败";
        
        const info = res.data;
        const lines = [];
        
        // 日期时间
        lines.push(`## 📅 日期时间`);
        lines.push(`- **当前时间**: ${info.datetime}`);
        lines.push(`- **时区**: ${info.timezone}`);
        
        // CPU
        lines.push(`\n## 💻 CPU`);
        lines.push(`- **物理核心**: ${info.cpu.cores_physical} 核`);
        lines.push(`- **逻辑线程**: ${info.cpu.cores_logical} 线程`);
        if (info.cpu.frequency_mhz) {
          lines.push(`- **主频**: ${info.cpu.frequency_mhz} MHz`);
        }
        lines.push(`- **使用率**: ${info.cpu.percent}%`);
        
        // 内存
        lines.push(`\n## 🧠 内存`);
        lines.push(`- **总容量**: ${info.memory.total_gb} GB`);
        lines.push(`- **可用**: ${info.memory.available_gb} GB (${100 - info.memory.percent}%)`);
        if (info.memory.swap_total_gb > 0) {
          lines.push(`- **交换空间**: ${info.memory.swap_total_gb} GB`);
        }
        
        // GPU
        if (info.gpus && info.gpus.length > 0) {
          lines.push(`\n## 🎮 GPU`);
          info.gpus.forEach((gpu, i) => {
            const typeLabel = gpu.type === "integrated" ? "集成显卡" : "独立显卡";
            lines.push(`- **${typeLabel}**: ${gpu.name}${gpu.vram_gb ? ` (${gpu.vram_gb} GB)` : ""}`);
          });
        }
        
        // 存储
        if (info.storage && info.storage.length > 0) {
          lines.push(`\n## 💾 存储`);
          info.storage.forEach(disk => {
            lines.push(`- **${disk.mountpoint}** (${disk.fstype}): 共 ${disk.total_gb} GB，已用 ${disk.used_gb} GB (${disk.percent}%)`);
          });
        }
        
        // 电池
        if (info.battery) {
          lines.push(`\n## 🔋 电池`);
          lines.push(`- **电量**: ${info.battery.percent}%`);
          lines.push(`- **电源**: ${info.battery.power_plugged ? "已连接" : "未连接"}`);
          if (typeof info.battery.secsleft === "number") {
            const mins = Math.round(info.battery.secsleft / 60);
            lines.push(`- **剩余续航**: 约 ${mins} 分钟`);
          } else if (info.battery.secsleft === "unlimited") {
            lines.push(`- **剩余续航**: 无限制（充电中）`);
          }
        }
        
        // 网络
        lines.push(`\n## 🌐 网络`);
        lines.push(`- **活跃连接数**: ${info.network.connections_count}`);
        if (info.network.interfaces && Object.keys(info.network.interfaces).length > 0) {
          Object.entries(info.network.interfaces).forEach(([name, iface]) => {
            if (iface.isup) {
              const ipv4 = iface.addresses.find(a => a.type === "ipv4");
              if (ipv4) {
                lines.push(`- **${name}**: ${ipv4.address} (${iface.speed_mbps} Mbps)`);
              }
            }
          });
        } else {
          lines.push(`- **接口**: 未检测到活跃网络接口`);
        }
        
        return lines.join("\n");
      } catch (e) {
        return `获取系统信息失败: ${e.message}`;
      }
    },
  },

  knowledge_search: {
    name: "检索知识库",
    description: "从本地轻量向量知识库中检索长期记忆、资料摘录和知识中心内容",
    params: {
      query: { type: "string", description: "检索问题或关键词, required: true "},
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
    description: "把稳定、可复用的信息保存到本地知识中心。不要保存临时任务、工具输出或一次性状态。",
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
      return `已添加知识 ${title || res.data?.id || "未命名知识"}`;
    },
  },

  prompt_gen: {
    name: "生成提示词",
    description: "用提示词工厂生成结构建Prompt，供外部 Agent 使用",
    params: {
      task: { type: "string", description: "任务描述", required: true },
      context: { type: "string", description: "相关文件/上下文" },
      constraints: { type: "string", description: "约束条件" },
    },
    async execute({ task, context, constraints }) {
      const parts = [];
      const c = effectiveConstitution();
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
    description: "文件编辑：view 带行号查看 / edit 精确文本替换 / replace_range 按行号替换 / read / insert / delete / copy / paste / cut。自动识别并保留 UTF-8/BOM/GB18030/GBK/UTF-16 等文本编码，中文和 emoji 会原样传递；必要时可传 encoding 强制指定。默认自动应用写入（用户在设置关闭自动确认时改为预览后手动接受）。参数名 file_path（不是 path）。",
    params: {
      file_path: { type: "string", description: "目标文件相对路径（相对于项目根目录）", required: true },
      action: { type: "string", description: "操作类型：edit / replace_range / view / read / insert / delete / copy / paste / cut" },
      edits: { type: "array", description: '编辑列表（edit 操作），每项含 old_text 和 new_text，如 [{"old_text":"原内容","new_text":"新内容"}]' },
      old_str: { type: "string", description: "要被替换的精确字符串（replace 操作，必须唯一匹配）" },
      new_str: { type: "string", description: "替换后的新字符串（replace 操作）" },
      content: { type: "string", description: "插入或替换内容（insert/replace_range 操作）" },
      start_line: { type: "number", description: "起始行号（1-based，用于 replace_range/view/read/insert/delete/copy/paste/cut）" },
      end_line: { type: "number", description: "结束行号（1-based，用于 replace_range/view/read/delete/copy/cut）" },
      encoding: { type: "string", description: "可选文件编码，如 utf-8、utf-8-sig、gb18030、gbk、utf-16；留空自动检测并保留原编码" },
    },
    async execute({ file_path, action = "edit", edits, content = "", old_str = "", new_str = "", start_line = 0, end_line = 0, clipboard_name = "default", encoding = "", _truncated }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path";
      const normalizedAction = String(action || "edit").trim().toLowerCase();
      const editList = Array.isArray(edits) ? edits : [];
      const editsTotal = normalizedAction === "edit" ? editList.length : 1;
      if (normalizedAction === "edit" && !editList.length) return "缺少 edits";
      if (normalizedAction === "replace_range" && (!start_line || !end_line)) return "replace_range 需要 start_line 和 end_line";

      // 输出被截断时写入参数可能不完整，只应用部分编辑很危险，拒绝执行
      if (_truncated && !["view", "read", "copy"].includes(normalizedAction)) {

        return {
          _type: "file_edit",
          file: "",
          file_path_rel: String(file_path || ""),
          file_name: String(file_path || "").replace(/\\/g, "/").split("/").pop() || "",
          diff: "",
          new_content: "",
          stats: { edits_total: editsTotal, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: ["模型输出被截断，文件修改参数可能不完整，已拒绝执行。请减少单次编辑量或重试"],
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
          stats: { edits_total: editsTotal, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: [target.error],
          applied: [],
        };
      }
      const absPath = target.abs;
      const params = {
        file_path: absPath,
        action: normalizedAction,
        content,
        old_str,
        new_str,
        start_line: Number.parseInt(start_line, 10) || 0,
        end_line: Number.parseInt(end_line, 10) || 0,
        clipboard_name,
        encoding,
      };
      if (normalizedAction === "edit") params.edits = JSON.stringify(editList);
      let res;
      try {
        res = await post("/skills/execute", {
          skill: "file_edit",
          params,
        });
      } catch (e) {
        return {
          _type: "file_edit",
          file: absPath,
          file_path_rel: target.relative,
          file_name: target.fileName,
          diff: "",
          new_content: "",
          stats: { edits_total: editsTotal, edits_applied: 0, lines_added: 0, lines_removed: 0 },
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
          stats: { edits_total: editsTotal, edits_applied: 0, lines_added: 0, lines_removed: 0 },
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
          stats: { edits_total: editsTotal, edits_applied: 0, lines_added: 0, lines_removed: 0 },
          errors: [data.error],
          applied: [],
        };
      }
      if (["view", "read"].includes(normalizedAction)) {
        const range = data.range ? ` (${data.range})` : "";
        return `[${target.relative}${range}]\n${data.content || ""}`;
      }
      if (normalizedAction === "copy") {
        return `已复制 ${data.copied_lines || 0} 行、${data.copied_chars || 0} 字符到剪贴板 ${data.clipboard || "default"}。\n${data.preview || ""}`;
      }

      // 返回结构化数据，chat.js 会按 _type 渲染 diff UI
      const structured = {
        _type: "file_edit",
        file: data.file || absPath,
        file_path_rel: target.relative,
        file_name: data.file_name || target.fileName,
        diff: data.diff || "",
        new_content: data.new_content,
        stats: data.stats || { edits_total: editsTotal, edits_applied: data.new_content ? 1 : 0, lines_added: 0, lines_removed: 0 },
        errors: data.errors || [],
        applied: data.applied || [],
        encoding: data.encoding || "",
      };

      // 自动确认：预览无错误时直接写入（部分编辑未命中时保留手动确认，避免半套写入）
      if (fileAutoApplyEnabled() && structured.file && structured.new_content && structured.errors.length === 0) {
        try {
          const applyRes = await post("/projects/apply-edit", { file_path: structured.file, content: structured.new_content });
          if (applyRes.code === 0) structured.applied = "auto";
          else structured.errors = [t("自动应用失败：{msg}，可手动点「接受」重试", { msg: applyRes.message || t("未知错误") })];
        } catch (e) {
          structured.errors = [t("自动应用失败：{msg}，可手动点「接受」重试", { msg: e.message })];
        }
      }
      return structured;
    },
  },

  file_create: {
    name: "创建新文件",
    description: "在项目中创建新文件。默认自动写入（用户在设置关闭自动确认时改为 diff 预览后手动确认）。专用格式：第一行写相对路径，第二行起原样写文件内容（不是 JSON、不转义）。",
    params: {
      file_path: { type: "string", description: "新文件相对路径（相对于项目根目录），如 src/utils/helper.js", required: true },
      content: { type: "string", description: "文件完整内容（原样写入，不经 JSON 转义）", required: true },
    },
    rawContent: true,
    async execute({ file_path, content, _truncated }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path：请按专用格式重发——◈◈◈file_create 后第一行写相对路径（如 src/utils/helper.js），第二行起原样写文件内容，不要 JSON 包裹。";
      if (content === undefined || content === null) return "缺少 content：第一行路径之后应原样输出完整文件内容（不是 JSON、不转义、不加代码围栏）。";
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

      const structured = {
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

      // 自动确认：预览无错误时直接创建（截断内容也先写入，由后续 file_append 补齐）
      if (fileAutoApplyEnabled() && structured.file && structured.errors.length === 0) {

        try {
          const applyRes = await post("/projects/create-file", { file_path: structured.file, content: structured.content });
          if (applyRes.code === 0) structured.applied = "auto";
          else structured.errors = [t("自动创建失败：{msg}，可手动点「创建」重试", { msg: applyRes.message || t("未知错误") })];
        } catch (e) {
          structured.errors = [t("自动创建失败：{msg}，可手动点「创建」重试", { msg: e.message })];
        }
      }
      return structured;
    },
  },

  file_append: {
    name: "追加文件内容",
    description: "向已存在文件的末尾追加内容。用于分段写入超长文件：先用 file_create 写入前半部分，再用一次或多次 file_append 补齐剩余部分。",
    params: {
      file_path: { type: "string", description: "目标文件相对路径（相对于项目根目录），文件必须已存在", required: true },
      content: { type: "string", description: "要追加到文件末尾的内容（原样写入，不经 JSON 转义；从上次写入结束的精确位置接续，不要重复已有内容）", required: true },
    },
    rawContent: true,
    async execute({ file_path, content, _truncated }) {
      if (!state.project) return "未打开项目";
      if (!file_path) return "缺少 file_path：请按专用格式重发——◈◈◈file_append 后第一行写相对路径，第二行起原样写要追加的内容，不要 JSON 包裹。";
      if (content === undefined || content === null) return "缺少 content：第一行路径之后应原样输出要追加的内容（不是 JSON、不转义、不加代码围栏）。";
      const truncated = Boolean(_truncated);

      const target = normalizeProjectRelativePath(file_path);
      if (target.error) {
        return {
          _type: "file_append",
          file: "",
          file_path_rel: String(file_path || ""),
          file_name: String(file_path || "").replace(/\\/g, "/").split("/").pop() || "",
          content,
          stats: { lines: String(content).split("\n").length, chars: String(content).length },
          errors: [target.error],
          truncated,
        };
      }
      let res;
      try {
        res = await post("/projects/append-file", {
          file_path: target.abs,
          content,
        });
      } catch (e) {
        return {
          _type: "file_append",
          file: target.abs,
          file_path_rel: target.relative,
          file_name: target.fileName,
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: ["网络请求失败: " + e.message],
          truncated,
        };
      }
      if (res.code !== 0) {
        return {
          _type: "file_append",
          file: target.abs,
          file_path_rel: target.relative,
          file_name: target.fileName,
          content,
          stats: { lines: content.split("\n").length, chars: content.length },
          errors: [res.message || "未知错误"],
          truncated,
        };
      }
      // 追加在调用时已直接写入磁盘（无预览端点）；applied 标记防止 UI 重复追加
      return {
        _type: "file_append",
        file: target.abs,
        file_path_rel: target.relative,
        file_name: target.fileName,
        content,
        stats: { lines: content.split("\n").length, chars: content.length },
        errors: [],
        truncated,
        applied: "auto",
      };
    },
  },

  chat_context: {
    name: "查看对话上下文",
    description: "查看当前对话的统计信息。上下文按系统提示词/工具目录/Skill 注入/工具调用与结果/对话消息分桶给出，用于判断是哪一类内容占用了上下文",
    params: {},
    async execute() {
      const msgs = state.messages;
      const snap = state.contextSnapshot;
      const lines = [
        `模型: ${state.currentModel?.name || "未选择"}`,
        `消息数: ${msgs.length}`,
      ];
      if (snap) {
        lines.push(`上下文估算: ~${snap.total.toLocaleString()} tokens`);
        lines.push(snap.buckets.filter(b => b.tokens > 0).map(b => `  ${b.label}: ${b.tokens.toLocaleString()}`).join("\n"));
      } else {
        lines.push("上下文估算: 未测量");
      }
      lines.push(`上下文上限: ${state.currentModel?.context_window || "未知"}`);
      lines.push(`黑板卡片: ${state.boardCards.length}`);
      return lines.join("\n");
    },
  },

  todo_manage: {
    name: "任务清单",
    description: "为当前任务创建并推进 TODOLIST。面临大任务（多步骤、多文件、复杂修改）时必须先 action=init 拆解计划；执行中有意识地主动同步进度：每完成一项或一批事项立即 action=update 批量标记 done，受阻标记 blocked，不要等全部做完才一次性更新。任务结束前所有项必须为 done 或 blocked。status 可取 pending/in_progress/done/blocked",
    params: {
      action: { type: "string", description: "init(创建或整体替换清空 / add(追加事项) / update(更新状态或描述) / remove(删除事项) / clear(清空)", required: true },
      items: { type: "array", description: 'init/add: [{"content":"事项描述"}]；update: [{"id":"t1","status":"done"}]（可附 content 改描述）；remove: [{"id":"t1"}]' },
    },
    async execute({ action, items }) {
      const convId = state.currentConversationId;
      let list = getConversationTodos(convId).map(t => ({ ...t }));
      const input = Array.isArray(items) ? items : [];
      const VALID_STATUS = ["pending", "in_progress", "done", "blocked"];

      if (action === "init") {
        const contents = input.filter(i => i && i.content).map(i => String(i.content));
        if (!contents.length) return '缺少 items：init 需要 [{"content": "事项描述"}] 形式的列表';
        list = contents.map((c, i) => ({ id: "t" + (i + 1), content: c, status: "pending" }));
      } else if (action === "add") {
        const contents = input.filter(i => i && i.content).map(i => String(i.content));
        if (!contents.length) return '缺少 items：add 需要 [{"content": "事项描述"}]';
        let seq = list.reduce((m, t) => Math.max(m, parseInt(String(t.id || "").slice(1), 10) || 0), 0);
        for (const c of contents) list.push({ id: "t" + (++seq), content: c, status: "pending" });
      } else if (action === "update") {
        if (!input.length) return "缺少 items：update 需要 [{\"id\": \"t1\", \"status\": \"done\"}]";
        let changed = 0;
        for (const patch of input) {
          if (!patch?.id) continue;
          const target = list.find(t => t.id === String(patch.id));
          if (!target) continue;
          if (patch.status && VALID_STATUS.includes(patch.status)) target.status = patch.status;
          if (patch.content) target.content = String(patch.content);
          changed++;
        }
        if (!changed) return `未找到可更新的事项（现有 ID: ${list.map(t => t.id).join(", ") || ""}）`;
      } else if (action === "remove") {
        const ids = input.map(i => String(i?.id || "")).filter(Boolean);
        if (!ids.length) return "缺少 items：remove 需要 [{\"id\": \"t1\"}]";
        list = list.filter(t => !ids.includes(t.id));
      } else if (action === "clear") {
        list = [];
      } else {
        return `未知 action: ${action}（可用 init/add/update/remove/clear）`;
      }

      setConversationTodos(convId, list);
      if (!list.length) return "TODOLIST 已清空";
      const labels = { done: "done", in_progress: "doing", blocked: "blocked", pending: "todo" };
      const done = list.filter(t => t.status === "done").length;
      const lines = list.map(t => `[${labels[t.status] || "todo"}] [${t.id}] ${t.content}`);
      return `TODOLIST 已更新（${done}/${list.length} 完成）：\n${lines.join("\n")}` +
        (done === list.length
          ? "\n全部完成，进入验证与汇报阶段。"
          : "\n请继续统筹推进未完成事项（能并行的多项一起处理），每完成一批立即调用 todo_manage 批量更新状态，保持清单实时准确。");
    },
  },
  exit_target_mode: {
    name: "退出目标模式",
    description: "目标模式（六阶段自主闭环）的显式收口：关闭目标模式开关并结束本次自主循环。只有当全部交付物都已产出、且每一项都用工具实测验证通过时才调用；任务还有未完成或未验证的部分时绝对不要调用，继续推进才是正解。调用后下一条回复直接把 summary 展开成最终汇报，不要再调用工具。",
    params: {
      summary: { type: "string", description: "一句话收口摘要：交付了什么 + 用什么方式验证 + 验证结果", required: true },
    },
    async execute({ summary }) {
      return exitAgentLoop("target", summary);
    },
  },

  exit_autopilot: {
    name: "退出自主推进",
    description: "Autopilot 自主推进的显式收口：结束本次自动续跑，把主动权交回用户（不改动目标模式开关）。仅在任务确实完成并已用工具验证后调用；没做完不要调用，也不要靠轮数耗尽或反复复述计划来结束循环。调用后下一条回复直接把 summary 展开成最终汇报，不要再调用工具。",
    params: {
      summary: { type: "string", description: "一句话收口摘要：交付了什么 + 用什么方式验证 + 验证结果", required: true },
    },
    async execute({ summary }) {
      return exitAgentLoop("autopilot", summary);
    },
  },
};

// ── 工具调用检测 ──────────────────────────────

const TOOL_RE = /◈◈◈\s*(\w+)\s*\r?\n([\s\S]*?)(?:◈◆◆|◆◆)/g;

// file_create / file_append 走原样围栏协议：内容不经 JSON 转义，根治大内容转义损坏与 file_path 丢失
const FILE_RAW_TOOLS = new Set(["file_create", "file_append"]);

// 部分模型按 HTML/XML 书写习惯把开标记写成 <tool_name>，收尾仍是 ◈◆◆ 或 </tool_name>。
// 名称独占一行 + 必须是已注册工具，是防误伤 <div>/<Button> 等正文标签的唯一闸门。
const TOOL_TAG_NAME = "([a-z][a-z0-9_]{2,})";
const TOOL_TAG_OPEN = `(?:^|\\r?\\n)[ \\t]*<${TOOL_TAG_NAME}>[ \\t]*\\r?\\n`;
const TOOL_TAG_RE = `${TOOL_TAG_OPEN}([\\s\\S]*?)(?:◈◆◆|◆◆|<\\/\\1>)`;
const TOOL_TAG_TAIL_RE = `${TOOL_TAG_OPEN}([\\s\\S]*)$`;

const TOOL_ALIASES = {
  read_file: "project_read_file",
  file_read: "project_read_file",
  browse_files: "project_files",
  list_files: "project_files",
  find_file: "project_find_file",
  search_file: "project_find_file",
  edit_file: "file_edit",
  create_file: "file_create",
  append_file: "file_append",
  run_skill: "skill_run",
  skill: "skill_run",
};

const TOOL_USE_RECIPES = [
  ["了解项目/目录", "project_files path=\"\"，再按结果读取关键文件"],
  ["知道文件路径", "project_read_file"],
  ["只知道文件名", "project_find_file -> project_read_file"],
  ["修改已有文件", "project_read_file 确认现状 -> file_edit"],
  ["创建新文件", "file_create 原样格式；超长内容用 file_append 分段"],
  ["运行仓库检查/命令", "skill_run terminal（默认注入项目 work_dir）"],
  ["代码/文档安全扫描", "skill_run code_scan / doc_scan"],
  ["桌面操作", "skill_run computer_use，截图默认 jpeg/fast"],
  ["生成图表/二维码/文档", "skill_run chart_create/qrcode_create/doc_write/ppt_create/word_create/excel_tool"],
  ["生成图片/视频", "image_gen / video_gen（需先在设置中配置模型与 Key）"],
  ["多个互不依赖的子任务并行", "subagent_run agents=[{name,task}] 一次并行派出，task 写清背景与期望产出"],
  ["需要技能但不知名字", "skill_search 搜索 -> skill_run 调用"],
  ["用户的事像某个既有流程/说过要固化流程", "actions_list keyword=关键词 -> actions_read id=... -> 按步骤实际执行"],
  ["用户要求把流程固化成以后可复用", "actions_list 查重（有则 actions_read 读原文再覆盖）-> actions_write id=... content=SAY-1 原文（含 author: model）"],
  ["任务缺少关键条件（风格/受众/格式/语言等）", "user_ask question=问题 options=[选项]"],
  ["事实性问答（可查证）", "先 project_files/project_read_file 或 web_search 佐证，再基于事实回答"],
  ["在海量代码中定位关键字/函数/符号", "code_search query=关键词（可 scope 缩小范围）-> project_read_file 精读"],
];

const SKILL_RUN_QUICK_LIST = [
  "file_tree", "file_peek", "file_edit", "file_create", "terminal",
  "repo_stats", "todo_scan", "git_tool", "code_scan", "doc_scan",
  "code_search",
  "web_search", "web_fetch", "browser_automation", "computer_use",
  "html_render", "css_color", "doc_write", "text_summarize", "json_tool",
  "regex_test", "chart_create", "qrcode_create", "python_api_extract",
  "html_bundle", "ppt_create", "word_create", "excel_tool", "pdf_tool",
  "mcp_factory", "screenshot_to_code", "image_gen", "video_gen",
];

const CORE_AGENT_TOOLS = [
  "project_info", "project_files", "project_find_file", "project_read_file",
  "code_search", "skill_search", "skill_run", "actions_list", "actions_read", "actions_write",
  "file_edit", "file_create", "file_append",
  "todo_manage", "board_read", "board_batch",
  // 收口工具必须在精简目录里可见：弱端点只看得到核心集，缺了它们就只能靠轮数耗尽退出
  "exit_target_mode", "exit_autopilot",
];

const AGENT_TOOL_DECISION_RULES = [
  "需要仓库事实：先 project_files / project_find_file / project_read_file，再回答或修改。",
  "定位代码位置：code_search 搜内容/符号（可限定 scope），再 project_read_file 精读。",
  "修改已有文件：先读现状与行号，再 file_edit；改完后读取或运行检查验证。",
  "创建新文件：file_create 用原样格式；长文件分段 file_append，不要省略内容。",
  "运行命令/测试/构建/Git：skill_run terminal 或 git_tool，默认会注入项目目录。",
  "搜索实时信息：web_search（默认 Bing+DDG 双引擎合并）/ web_fetch（精读网页，自动 JS 渲染与 PDF）；有本地证据优先本地。",
  "桌面/浏览器操作：优先 browser_automation；必须操作系统 UI 时再 computer_use。",
  "复杂多步任务：用 todo_manage 维护状态；完成一批就更新，不等最后。",
  "可视化梳理：用 board_batch 一次性组织卡片和依赖。",
  "干完了就停：自主推进（Autopilot / 目标模式）下，全部交付已验证后必须调 exit_autopilot / exit_target_mode 收口；没做完继续动手，不要靠停发工具或复述计划来结束循环。",
];

function compactDescription(text, limit = 260) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function normalizeToolName(name) {
  const key = String(name || "").trim();
  return TOOL_ALIASES[key] || key;
}

function stripJsonFence(raw) {
  let text = String(raw || "").trim();
  const fenced = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

/** 自动确认开关（设置页可调，默认开）：开启时文件创建/修改直接落盘，不再等用户手动点「接受」 */
function fileAutoApplyEnabled() {
  return state.fileOutput?.autoApply !== false;
}

/** 参数名别名归一：模型常把 file_path 写成 path / file 等，映射为 file_path 而不是报错 */
function normalizeFilePathAlias(params) {
  if (params && !params.file_path) {
    for (const alias of ["path", "file", "filepath", "file_name", "filename", "relative_path", "target_path", "target"]) {
      if (params[alias]) {
        params.file_path = params[alias];
        break;
      }
    }
  }
  return params;
}

function normalizeToolParams(name, params) {
  const p = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
  if (name === "project_read_file" || name === "project_files") {
    if (p.file_path && !p.path) p.path = p.file_path;
    if (p.relative_path && !p.path) p.path = p.relative_path;
  }
  if (name === "project_find_file" && p.path && !p.query) p.query = p.path;
  if (name === "skill_run") {
    if (p.name && !p.skill) p.skill = p.name;
    if (p.tool && !p.skill) p.skill = p.tool;
    if (p.arguments && !p.params) p.params = p.arguments;
  }
  return normalizeFilePathAlias(p);
}

function validateToolCall(name, params) {
  const tool = TOOLS[name];
  if (!tool) return "";
  const missing = [];
  for (const [key, spec] of Object.entries(tool.params || {})) {
    // 空字符串是合法值（如 file_create 的 content="" 创建空文件）
    if (spec.required && (params?.[key] === undefined || params?.[key] === null)) {
      missing.push(key);
    }
  }
  return missing.length ? `缺少必填参数: ${missing.join(", ")}` : "";
}

/**
 * 解析 file_create / file_append 的参数块，支持两种协议：
 * 新协议（推荐）：第一行是相对路径，其余全部是原样文件内容——无 JSON、无转义。
 * 模型写大文件时不再需要转义换行/引号，从根本上消除 JSON 解析失败导致的丢参。
 * 旧协议（兼容）：块内容以 { 开头时仍按 JSON 解析，失败退回 salvage 抢救 + 别名映射。
 */
function parseFileWriteParams(body) {
  const text = String(body || "").replace(/^\uFEFF/, "");
  if (text.trimStart().startsWith("{")) {
    let params;
    try {
      params = JSON.parse(text.trim());
    } catch {
      params = salvageTruncatedParams(text);
    }
    return normalizeFilePathAlias(params);
  }
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift(); // 跳过前导空行
  const filePath = (lines.shift() || "").trim();
  // 容忍模型在路径与内容之间加一行分隔符（◈── / === 之类），跳过。
  // `---` 可能是 Markdown 的 YAML frontmatter 首行（合法内容）：后续行形如 `key: value` 时按内容保留。
  if (lines.length && /^[◈─—\-=:*]{2,}\s*$/.test(lines[0].trim())) {
    const sep = lines[0].trim();
    const nextLine = (lines[1] || "").trim();
    const yamlFrontmatter = sep === "---" && /^[A-Za-z0-9_."'\-]+\s*:/.test(nextLine);
    if (!yamlFrontmatter) lines.shift();
  }
  // 防御：模型偶尔无视规则把内容包进 ``` 代码围栏，剥掉外层围栏还原真实内容。
  // 仅对非 Markdown 文件剥离——.md 内容以 ``` 开头结尾是合法的（如单个代码块的笔记）。
  // 末尾可能带协议性空行，需在最后一个非空行上判断闭合围栏。
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
  const isMarkdownFile = /\.(md|markdown|mdown|mkd)$/i.test(filePath);
  if (lastIdx >= 1 && /^```/.test(lines[0].trim()) && /^```\s*$/.test(lines[lastIdx].trim()) && !isMarkdownFile) {
    lines.shift();
    lines.splice(lastIdx - 1, 1);
  }
  // 末尾单个换行属于协议本身（◈◆◆ 独占一行前的分隔），不属于文件内容
  const content = lines.join("\n").replace(/\n$/, "");
  return { file_path: filePath, content };
}

/**
 * 从 start 位置（必须是 "）读取一段 JSON 字符串，正确处理转义。
 * 返回 { value, end, complete }。未闭合时 complete=false。
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
 * 从 start 位置读取一段 JSON 值（数组/对象/数字等）。
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

function _knownToolName(raw) {
  const name = normalizeToolName(String(raw || "").trim());
  return TOOLS[name] ? name : "";
}

// 标签块 → 调用；不满足白名单/正文形态时返回 null，交给正则当普通正文保留
function _tagCallFrom(rawName, rawBody, allowOpenJson) {
  const name = _knownToolName(rawName);
  if (!name) return null;
  const body = String(rawBody || "");
  if (!body.trim()) return null;
  if (FILE_RAW_TOOLS.has(name)) {
    const params = parseFileWriteParams(body);
    if (!params || !params.file_path) return null;
    // 路径行带尖括号说明那是标签残留（空块的 </file_create> 会被当成路径），不是真调用
    if (/[<>]/.test(params.file_path)) return null;
    if (!allowOpenJson && !String(params.content || "").trim()) return null;
    // 原样围栏正文没有可判定的终点，尾块一律按截断处理
    if (allowOpenJson) params._truncated = true;
    return { name, params };
  }
  const jsonish = stripJsonFence(body);
  if (!/^\{/.test(jsonish)) return null;
  const openEnded = !/\}$/.test(jsonish);
  if (openEnded && !allowOpenJson) return null;
  let params;
  try {
    // 解得动说明调用本身完整，收尾写成 </tool_name> 之类变体不该算截断
    params = JSON.parse(jsonish);
  } catch {
    params = salvageTruncatedParams(jsonish);
  }
  params = normalizeToolParams(name, params);
  if (openEnded) params._truncated = true;
  return { name, params };
}

function detectToolCalls(text) {
  const found = [];
  let lastEnd = 0;
  let match;
  const re = new RegExp(TOOL_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    lastEnd = re.lastIndex;
    const name = normalizeToolName(match[1]);
    let call;
    if (FILE_RAW_TOOLS.has(name)) {
      call = { name, params: parseFileWriteParams(match[2]) };
    } else {
      let params;
      try {
        // 闭合块但 JSON 损坏：用 salvage 尽力抢救参数，而不是直接丢弃（否则 file_path 等必丢）
        params = JSON.parse(stripJsonFence(match[2]) || "{}");
      } catch {
        params = salvageTruncatedParams(match[2] || "");
      }
      call = { name, params: normalizeToolParams(name, params) };
    }
    found.push({ at: match.index, end: re.lastIndex, call });
  }

  // 标签式开标记：先把 ◈◈◈ 命中区间打成等长空白（保留换行），同一段不会被两种格式各计一次
  let masked = text;
  for (const f of found) {
    const blank = masked.slice(f.at, f.end).replace(/[^\n]/g, " ");
    masked = masked.slice(0, f.at) + blank + masked.slice(f.end);
  }
  const tagRe = new RegExp(TOOL_TAG_RE, "g");
  while ((match = tagRe.exec(masked)) !== null) {
    const call = _tagCallFrom(match[1], match[2]);
    if (!call) continue;
    lastEnd = Math.max(lastEnd, tagRe.lastIndex);
    found.push({ at: match.index, call });
  }
  found.sort((a, b) => a.at - b.at);
  const calls = found.map((f) => f.call);

  // 处理末尾被截断的工具调用块（缺少闭合标记 ◈◆◆，通常是输出达到 max_tokens 上限）
  // 不能直接丢弃：file_create 的 content 往往已输出了大部分内容，应尽力抢救。
  const rest = text.slice(lastEnd);

  const openMatch = /◈◈◈[ \t]*(\w+)[ \t]*\r?\n([\s\S]*)$/.exec(rest);
  if (openMatch) {
    const name = normalizeToolName(openMatch[1]);
    const rawBody = openMatch[2];
    let params;
    if (FILE_RAW_TOOLS.has(name)) {
      params = parseFileWriteParams(rawBody);
      params._truncated = true; // 原样正文没有可判定的终点，只能按截断处理
    } else {
      // 反向混排：开标记 ◈◈◈、收尾写成 </tool_name>，JSON 其实完整，不该按截断跳过白跑一轮
      const body = rawBody.replace(/\s*<\/[a-z][a-z0-9_]*>\s*$/, "");
      try {
        params = normalizeToolParams(name, JSON.parse(stripJsonFence(body)));
      } catch {
        params = normalizeToolParams(name, salvageTruncatedParams(body));
        params._truncated = true;
      }
    }
    calls.push({ name, params });
  } else {
    const tagTail = new RegExp(TOOL_TAG_TAIL_RE).exec(rest);
    const tailCall = tagTail ? _tagCallFrom(tagTail[1], tagTail[2], true) : null;
    if (tailCall) calls.push(tailCall);
  }
  return calls;
}

// 末尾是否存在被截断的工具调用块（缺少闭合标记 ◈◆◆，通常是输出达到 max_tokens 上限）
function hasTruncatedTail(text) {
  if (!text) return false;
  const calls = detectToolCalls(text);
  return calls.length > 0 && calls[calls.length - 1].params._truncated === true;
}

// ── DSML 兜底：DeepSeek 系模型有时把内部工具调用标记当正文吐出来 ──────────
// 分隔符按码位收类：官方 tokenizer 是全角竖线，端点与复制链路会换成双竖线等形近字符
const DSML_SEP = "[\\u007C\\uFF5C\\u00A6\\u01C0\\u2016\\u2223]{1,3}";
const DSML_TAG = `<${DSML_SEP}DSML${DSML_SEP}[ \\t\\r\\n]*`;
const DSML_END_TAG = `</${DSML_SEP}DSML${DSML_SEP}[ \\t\\r\\n]*`;
const DSML_INVOKE_RE = `${DSML_TAG}invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)${DSML_END_TAG}invoke\\s*>`;
const DSML_PARAM_RE = `${DSML_TAG}parameter\\s+name\\s*=\\s*"([^"]*)"([^>]*)>([\\s\\S]*?)${DSML_END_TAG}parameter\\s*>`;

function hasDsmlMarkup(text) {
  if (!text) return false;
  return new RegExp(`${DSML_TAG}(?:invoke|parameter|tool_calls|calls)`).test(text);
}

// string="true" 时值是原文；其余按 JSON 解析，解不动再退回字符串
function _dsmlValue(raw, attrs) {
  const val = String(raw || "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  if (/string\s*=\s*"true"/i.test(attrs || "")) return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

// 只认闭合完整的 invoke：半截的 file_edit 参数宁可让模型重发，也不能猜着执行
function detectDsmlCalls(text) {
  if (!hasDsmlMarkup(text)) return [];
  const calls = [];
  const invokeRe = new RegExp(DSML_INVOKE_RE, "g");
  let m;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = normalizeToolName(m[1]);
    const params = {};
    const paramRe = new RegExp(DSML_PARAM_RE, "g");
    let p;
    while ((p = paramRe.exec(m[2])) !== null) params[p[1]] = _dsmlValue(p[3], p[2]);
    calls.push({ name, params: normalizeToolParams(name, params) });
  }
  return calls;
}

// 「这条回复里有没有工具调用」的统一判据：只看 ◈◈ 会把 DSML 泄漏当成纯文本轮
function detectAllCalls(text) {
  return [...detectToolCalls(text || ""), ...detectDsmlCalls(text || "")];
}

function hasToolMarkup(text) {
  const body = text || "";
  return detectToolCalls(body).length > 0 || hasDsmlMarkup(body);
}

function stripToolCalls(text) {
  let stripped = text.replace(TOOL_RE, "");
  // 标签式调用块：仅当名称命中工具白名单且正文形态合法时才删，<div> 之类正文标签原样保留
  stripped = stripped.replace(
    new RegExp(TOOL_TAG_RE, "g"),
    (full, name, body) => (_tagCallFrom(name, body) ? "" : full)
  );
  // 先整块摘除已闭合的 invoke（其内部 parameter 一并带走），再清包裹标记，
  // 然后从残留的裸标记处截断（说明这里是被截断的半截调用），最后兜底扫尾
  stripped = stripped
    .replace(new RegExp(DSML_INVOKE_RE, "g"), "")
    .replace(new RegExp(`${DSML_TAG}(?:tool_calls|calls)\\s*>`, "g"), "")
    .replace(new RegExp(`${DSML_END_TAG}(?:tool_calls|calls)\\s*>`, "g"), "")
    .replace(new RegExp(`${DSML_END_TAG}(?:parameter|invoke)\\s*>`, "g"), "")
    .replace(new RegExp(`${DSML_TAG}[\\s\\S]*$`), "")
    .replace(new RegExp(`${DSML_TAG}[^>]*>`, "g"), "")
    .replace(/<\s*\/?\s*DSML[^>]*>/gi, "")
    .replace(new RegExp(`${DSML_SEP}DSML${DSML_SEP}`, "g"), "");
  // 移除 reasoning 标记前缀（子代理输出中不应包含）
  stripped = stripped
    .replace(new RegExp(REASONING_PREFIX, "g"), "")
    .replace(new RegExp(REASONING_INLINE_PREFIX, "g"), "");
  // 同时移除末尾未闭合的截断工具块，避免残缺 JSON 残留在消息正则
  return stripped
    .replace(/◈◈◈[ \t]*\w+[ \t]*\r?\n[\s\S]*$/, "")
    .replace(new RegExp(TOOL_TAG_TAIL_RE), (full, name, body) =>
      _tagCallFrom(name, body, true) ? "" : full
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 工具执行 ──────────────────────────────────

async function executeTool(name, params, callCtx = {}) {
  name = normalizeToolName(name);
  params = normalizeToolParams(name, params || {});
  const tool = TOOLS[name];
  if (!tool) return { success: false, output: `未知工具: ${name}` };
  const validationError = validateToolCall(name, params);
  if (validationError) {
    return { success: false, output: `[工具 ${name}] 未执行：${validationError}。请按该工具参数说明重发完整调用。` };
  }
  try {
    const output = await tool.execute(params, callCtx);
    // 结构化结果（如 file_edit / file_create）直接传递，同时生成文本摘要给 AI
    if (output && typeof output === "object" && output._type) {
      let summary = `[工具 ${name}] `;
      const applied = output.applied === "auto" || output.applied === true;
      if (output._type === "file_edit") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_edit] 文件: ${output.file_name}（${targetPath}），${s.edits_total} 处编辑，${s.edits_applied} 处成功，+${s.lines_added} -${s.lines_removed} 行。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        summary += applied
          ? " 已自动写入磁盘。"
          : " diff 已展示给用户，尚未写入磁盘，等待用户确认。";
      } else if (output._type === "file_create") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_create] 新文件 ${output.file_name}（${targetPath}），${s.lines} 行，${s.chars} 字符。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        if (output.truncated) summary += " 注意：本次内容因输出截断可能不完整；若用户接受预览，请立即用 file_append 从断点补齐剩余内容。";
        summary += applied
          ? " 已自动创建并写入磁盘。"
          : " 预览已展示给用户，尚未写入磁盘，等待用户确认。";
      } else if (output._type === "file_append") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_append] 文件: ${output.file_name}（${targetPath}），本次追加 ${s.lines} 行，${s.chars} 字符。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        if (output.truncated) summary += " 注意：本次追加内容因输出截断可能不完整，请继续用 file_append 补齐剩余内容。";
        summary += applied
          ? " 已自动追加到磁盘。"
          : " 追加预览已展示给用户，尚未写入磁盘，等待用户确认。";
      }
      return { success: true, output: summary, _structured: output };
    }
    return { success: true, output };
  } catch (e) {
    return { success: false, output: `执行出错: ${e.message}` };
  }
}

async function executeToolCalls(calls, ctx = {}) {
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    // 截断守卫（例外与理由见 agent_common.js 的 isTruncatedUnexecutable）
    if (isTruncatedUnexecutable(call)) {
      const result = {
        success: false,
        output: `[工具 ${call.name}] 未执行：该工具调用因输出长度达到上限被截断，参数不完整。请拆分后重试：超长文件先用 file_create 写入前半部分，再用 file_append 分一次或多次补齐剩余内容；单次调用的内容量宁小勿大。`,
      };
      ctx.onCallStart?.(call, i);
      ctx.onCallEnd?.(call, i, result);
      results.push({ ...call, ...result });
      continue;
    }
    ctx.onCallStart?.(call, i);
    let result;
    try {
      result = await executeTool(call.name, call.params, {
        signal: ctx.signal,
        callId: call.id,
        // 账本一侧的 callId（kernel 注入）与账本本身：subagent_run 靠它们画 spawn 边。
        // 与 callId 分开传，因为 call.id 还承担"原生调用/文本调用"的分流判据，不能改写。
        ledgerCallId: ctx.callIdFor?.(i) || call.id || "",
        ledger: ctx.ledger || null,
        onEvent: ctx.onEvent ? (env => ctx.onEvent(env, call, i)) : null,
      });
    } finally {
      ctx.onCallEnd?.(call, i, result);  // result 为 undefined 表示这次调用抛了异常
    }
    results.push({ ...call, ...result });
  }
  return results;
}

// ── 系统提示词工具段 ──────────────────────────

function getToolsSystemPrompt({ minimal = false, compact = false } = {}) {
  let s = "\n\n[可用工具]\n";
  s += "你拥有工具，可以直接操作用户的工作环境。\n\n";
  s += "**Agent 调用纪律**\n";
  s += "工具优先：能查证就不猜，能执行就不描述——凡涉及项目现状、实时信息、生成/计算/验证的内容，默认先调用对应工具获取事实再回答，不要凭记忆或推测作答。\n";
  s += "1. 必须使用下方格式实际发出调用，不要只描述意图；禁止说“我先看看”“我需要查看”后停住。\n";
  s += "2. 任务需要查看文件、目录、项目结构、执行命令、联网搜索、生成文档/图表/图片/视频或写文件时，当前回复必须包含工具调用块。\n";
  s += "3. 同一回复可批量调用互不依赖的读取/扫描工具；有依赖的等工具结果后再继续。\n";
  s += "4. 工具失败后换参数、换工具或读取更多上下文；不要重复完全相同的失败调用。\n";
  s += "5. 等待用户选择、确认、补充隐私信息或许可时，不调用工具；但任务缺少用户必须提供的关键条件（如生成风格、目标受众、输出格式、尺寸、语言）且无法合理假设时，调用 user_ask 以选择题形式询问，拿到回答后继续。\n";
  s += "6. 工具/技能纪律：优先用工具佐证再回答——事实性、现状性问题默认查项目文件或联网搜索；仅当回答不依赖外部事实（纯闲聊、纯观点、无需佐证的概念解释）时才直接回答。不确定技能是否存在时，先 skill_search 搜索确认，再决定是否 skill_run；搜索到的技能与任务无关时，绝不强行使用。\n";
  s += "7. 收口纪律：任务全部交付且逐项验证通过后，必须显式收口——目标模式调 exit_target_mode、Autopilot 调 exit_autopilot，然后在下一条回复里给出最终汇报。干完了就停，不要继续多读多改来\"再确认一遍\"；反过来，任务没做完时不要靠停发工具、只说\"已完成\"或反复复述计划来结束循环。\n\n";
  s += "**工具选择速查**\n";
  for (const [scene, route] of TOOL_USE_RECIPES) s += `- ${scene}: ${route}\n`;
  for (const rule of AGENT_TOOL_DECISION_RULES) s += `- ${rule}\n`;
  s += "\n";
  s += "**调用格式**：每次调用独占一块，◈◈◈ 与 ◈◆◆ 是固定标记，不可省略；一次回复可多次调用：\n";
  s += "（开标记必须原样写 ◈◈◈，不要改写成 <tool_name> 之类的标签形式，那样系统解析不到、本轮会直接终止）\n";
  s += "◈◈◈tool_name\n{JSON参数}\n◈◆◆\n\n";

  // 具体示例
  s += '**示例：用户说“了解项目”时，直接回复：**\n';
  s += "◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆\n";
  s += "（等待工具返回目录列表后，再根据结果回答用户）\n\n";

  // 项目上下文（宪法不在这里重复：buildSystemContent 已经把生效的那份按 [项目宪法] 注入了，
  // 两处都写会在同一条系统提示里翻来覆去说同一批规则，还占上下文）
  if (state.project) {
    s += `[当前项目] ${state.project.name} (${state.project.path})\n`;
    const roots = Array.isArray(state.project.roots) ? state.project.roots : [];
    const otherRoots = roots.filter(r => r !== state.project.path);
    if (otherRoots.length) {
      s += `这是一个工作区：除当前根外还含 ${otherRoots.length} 个文件夹（${otherRoots.join("、")}）。`
        + `工具默认的工作目录只是上面那个当前根，碰其他文件夹要传它们的绝对路径。\n`;
    }
    s += "\n";
  }

  const toolEntries = compact || minimal
    ? CORE_AGENT_TOOLS.filter(key => TOOLS[key]).map(key => [key, TOOLS[key]])
    : Object.entries(TOOLS);

  s += compact || minimal ? "**核心 Agent 工具**\n" : "**工具目录**\n";
  for (const [key, tool] of toolEntries) {
    const desc = key === "skill_run"
      ? `调用内置工具/远程 MCP/自定义技能。不确定技能名时先调用 skill_search 搜索。常用内置工具：${SKILL_RUN_QUICK_LIST.join(", ")}。复杂参数按工具名传入 params。`
      : compactDescription(tool.description);
    s += `### ${key} ${desc}\n`;
    if (tool.rawContent) {
      s += "专用格式（不是 JSON！内容原样直写，零转义）：\n";
      s += `◈◈◈${key}\n`;
      s += "相对路径（第一行，如 src/utils/helper.js）\n";
      s += "文件内容（第二行起原样直写，不要 JSON、不要代码围栏、不要任何转义）\n";
      s += "◈◆◆\n\n";
      continue;
    }
    const pEntries = Object.entries(tool.params || {});
    if (pEntries.length > 0) {
      s += "参数 (JSON):\n";
      for (const [pk, pv] of pEntries) {
        s += `  - ${pk}: ${pv.type}${pv.required ? " (必填)" : ""} ${compactDescription(pv.description, 120)}\n`;
      }
    }
    s += `示例:\n◈◈◈${key}\n${JSON.stringify(_example(tool.params))}\n◈◆◆\n\n`;
  }

  if (compact || minimal) {
    const extraNames = Object.keys(TOOLS).filter(key => !CORE_AGENT_TOOLS.includes(key));
    if (extraNames.length) {
      s += `其他可用工具名：${extraNames.join(", ")}。不确定参数时优先使用 skill_run 调用内置技能或先读取相关上下文。\n\n`;
    }
  }

  // 远程 MCP 工具（动态注入）
  const remoteTools = state.skills?.remoteTools || [];
  if (remoteTools.length > 0) {
    s += "### \u8fdc\u7a0b MCP \u5de5\u5177\uff08\u901a\u8fc7 skill_run \u8c03\u7528\uff09\n";
    s += "\u4ee5\u4e0b\u5de5\u5177\u6765\u81ea\u5df2\u8fde\u63a5\u7684\u5916\u90e8 MCP Server\uff0c\u901a\u8fc7 skill_run \u8c03\u7528\uff0cskill \u53c2\u6570\u683c\u5f0f\u4e3a mcp__serverId__toolName\n";
    for (const rt of remoteTools) {
      s += `- mcp__${rt.serverId}__${rt.name}: [${rt.server}] ${rt.description}\n`;
    }
    s += "\n";
  }

  if (minimal) return s;

  // 黑板策略
  s += "[黑板策略 / board_* 工具]\n";
  s += "黑板是你的可视化工作区，卡片是结构化的思维单元。主动利用黑板帮助用户思考和组织信息。\n\n";
  s += "**何时主动使用黑板**\n";
  s += "- 用户讨论复杂问题、多步骤任务、系统设计时，主动用 board_batch 将拆解结果投到黑板\n";
  s += "- 用户头脑风暴时，将想法整理成卡片并按逻辑关系连接\n";
  s += "- 任务拆解时，用卡片表示每个步骤，用 arrows 表示依赖关系\n";
  s += "- 用户说“整理一下”“梳理一下”“画个流程图”时，直接操作黑板\n\n";
  s += "**颜色语义（主动使用）**\n";
  s += "- red: 问题/风险/阻塞项\n";
  s += "- orange: 进行中/待处理\n";
  s += "- yellow: 想法/待讨论\n";
  s += "- green: 已完成通过/确认\n";
  s += "- blue: 信息/数据/资源\n";
  s += "- purple: 创意/设计/灵感\n\n";
  s += "**最佳实践：**\n";
  s += "1. 批量操作优先：用 board_batch 一次性构建完整结构，而非逐个 board_add\n";
  s += "2. 先读后改：修改前用 board_read 了解现有结构\n";
  s += "3. 建立连接：用 arrows 明确卡片间的依赖/数据流关系\n";
  s += "4. 语义着色：根据卡片性质主动分配颜色，让用户一目了然\n";
  s += "5. 保持简洁：卡片标题不超过 10 字，详情不超过 3 行\n\n";

  // file_edit 专项指导
  s += "[文件编辑规则 / file_edit 工具]\n";
  s += "当用户要求修改、编辑、修复项目中的已有文件时，你必须使用 file_edit 工具。\n";
  s += "核心原则：你说改它就真改，你不说它绝不碰。\n";
  s += "- file_path: 相对于项目根目录的路径\n";
  s += "- file_path 只能使用项目根相对路径，不能使用磁盘绝对路径、URL、~ 或 ..\n";
  s += "- 中文、emoji、全角符号等特殊字符必须原样放入 old_text/new_text/content，不要写成 Unicode 转义、HTML 实体或乱码占位；工具会自动识别并保留常见文本编码\n";
  s += "- 遇到非 UTF-8 文件时，先用 file_peek auto_detect=true 或 file_edit action=view 确认内容；必要时给 file_edit 传 encoding（如 gb18030、utf-16、utf-8-sig）\n";
  s += "- 修改前必须先用 project_read_file、file_peek 或 file_edit action=view/read 确认最新内容与行号\n";
  s += "- 推荐路径：已确认行号时使用 action=replace_range，传 start_line、end_line、content，按完整行范围替换，最稳妥\n";
  s += "- 小范围且 old_text 唯一时可使用 action=edit，edits 为 JSON 数组，每项包含 old_text 和 new_text\n";
  s += "- action=edit 的 old_text 必须在文件中唯一出现；不唯一或找不到时，重新读取并改用 replace_range\n";
  s += "- 只包含你要修改的部分，不要包含整个文件内容；replace_range 的 content 只写目标行范围的新内容\n";
  s += "- 可以包含多组 edits 一次性完成所有修改；跨远距离的大修改优先分多次 replace_range\n";
  s += "- 用户会看到 diff 预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 编辑完成后，简要汇报改动与验证结果；没有新指令时不要自动继续无关修改\n";

  // file_create 专项指导
  s += "\n[文件创建规则 / file_create 工具]\n";
  s += "当用户要求创建新文件时，你必须使用 file_create 工具。\n";
  s += "专用格式（重要，不是 JSON）：◈◈◈file_create 后第一行写相对路径，第二行起原样直写文件完整内容，最后用 ◈◆◆ 闭合。\n";
  s += "内容区严禁 JSON 包裹、严禁转义换行/引号、严禁代码围栏（```）——像平常写代码一样直接写。\n";
  s += "中文、emoji、全角符号等必须原样直写，禁止替换成 ?、□、\\uXXXX 或 HTML 实体。\n";
  s += "- 路径只能使用项目根相对路径，不能使用磁盘绝对路径、URL、~ 或 ..\n";
  s += "- 如果用户只要求输出文件但没有指定位置，默认放到 outputs/ 下，并使用清晰的文件名\n";
  s += "- 内容必须输出完整，绝不允许用“…其余省略” / “同上”等方式缩写\n";
  s += "- 超长文件（预计超过 300 行）必须分段写入：先用 file_create 写入前半部分（在完整行边界截断），再用一次或多次 file_append 从断点精确接续补齐剩余部分；单次调用宁小勿大，避免输出被截断\n";
  s += "- 如果收到“输出被截断”相关的工具结果反馈，不要重复已写入的内容，立即用 file_append 从断点接续补齐\n";
  s += "- 如果文件已存在，应使用 file_edit 工具而非 file_create\n";
  s += "- 用户会看到内容预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 创建完成后，简要汇报文件路径与内容概览\n";

  // file_append 专项指导
  s += "\n[文件追加规则 / file_append 工具]\n";
  s += "向已存在文件末尾追加内容，用于分段写入超长文件。格式与 file_create 相同：第一行路径，第二行起原样直写内容，不是 JSON。\n";
  s += "- 路径对应的文件必须已存在（先 file_create 后 file_append）\n";
  s += "- 内容从上次写入结束的精确位置接续，绝不重复已有内容\n";
  s += "- 输出被截断时，系统会要求你用 file_append 补齐；每次追加控制在 300 行以内\n";

  // actions_write 专项指导
  s += "\n[Action 书写规则 / actions_write 工具]\n";
  s += "Action 是用户写给模型看的流程说明书（data/actions/<id>.yml），会被注入系统提示目录、由 actions_read 读取。只有用户明确要「固化流程 / 以后都这样做」时才写。\n";
  s += "content 用受限 YAML 子集（SAY-1），违反即整份拒绝落盘并按行号报错：\n";
  s += "- 缩进只能用空格且每层 2 格，禁止 Tab；列表一律块式写法（单独一行以「- 」开头），禁止行内 {…} / […]\n";
  s += "- 第一行直接写 name:，不要加 --- 文档分隔符（会被整份拒绝）；注释只能独占一行以 # 开头，值后面跟的 # 会被当成值的一部分\n";
  s += "- 顶层可用字段：name、description、when、inputs、steps、output、tags、author、version；未知字段会被忽略\n";
  s += "- 必填 name（≤40 字）与 description（≤120 字）；steps 至少 1 步、最多 24 步\n";
  s += "- steps 每项：title（必填）+ detail（多行用 | 或 |-）+ tool（建议工具名，仅建议不执行）+ check（验收点）\n";
  s += "- inputs 每项：key（小写字母开头的 a-z0-9_）+ label + type（text/number/textarea/select）+ required + options（type 为 select 时必填）；最多 8 项\n";
  s += "- output 是对象：format + destination（message/file/board，写 file 时必须给 path）\n";
  s += "- 必须写 author: model（标明这份流程由模型代写，面板会据此显示）\n";
  s += "- 不要把 API Key、密码等明文凭证写进 Action，改成写「从环境变量 X 读取」\n";
  s += "示例（content 的形态）：\n";
  s += "name: 周报整理\ndescription: 把本周记录整理成班级周报长图\nwhen: 用户提到周报时\nauthor: model\nsteps:\n  - title: 收集素材\n    detail: |-\n      读取本周的会议记录\n    tool: project_read_file\n    check: 素材条数与本周记录一致\n";
  s += "- 写之前先 actions_list 查重：已有同主题 Action 就 actions_read 读原文，在其基础上覆盖改进，不要另起一份重复流程\n";
  s += "- 写入成功不等于任务完成：本次仍要按这份流程实际执行并验证\n";

  return s;
}

// ── 原生工具调用（OpenAI function calling）────────────────────
// OpenAI 工具名约束 ^[a-zA-Z0-9_-]+$：直接使用 TOOLS 对象键（ASCII），
// 中文 name 拼进 description 首行，模型仍能理解工具语义。

function buildOpenAITools() {
  const tools = [];
  for (const [key, tool] of Object.entries(TOOLS)) {
    const properties = {};
    const required = [];
    for (const [pkey, pval] of Object.entries(tool.params || {})) {
      properties[pkey] = { type: pval.type, description: pval.description || "" };
      if (pval.required) required.push(pkey);
    }
    tools.push({
      type: "function",
      function: {
        name: key,
        description: tool.name ? `${tool.name} - ${tool.description}` : tool.description,
        parameters: { type: "object", properties, required },
      },
    });
  }
  return tools;
}

// 流式累积的 {index, id, name, arguments} → 执行器统一形态 {name, params, id, index}
function openAICallsToCalls(toolCalls) {
  const calls = [];
  for (const tc of toolCalls || []) {
    if (!tc?.name) continue;
    let params;
    if (!tc.arguments) {
      params = {};
    } else {
      try {
        params = JSON.parse(stripJsonFence(tc.arguments));
      } catch {
        params = salvageTruncatedParams(tc.arguments);
        params._truncated = true;
      }
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) params = {};
    params = normalizeToolParams(tc.name, params);
    calls.push({ name: tc.name, params, id: tc.id || undefined, index: tc.index });
  }
  return calls;
}

function _toolCapKey(modelId) {
  return `slate_tool_cap_${modelId}`;
}

// 模型工具能力判定：localStorage 记忆（失败自动降级后写入）优先，其次 provider==="openai" 默认原生
function getModelToolCapability(modelId, provider) {
  try {
    const saved = localStorage.getItem(_toolCapKey(modelId));
    if (saved === "native" || saved === "text") return saved;
  } catch {}
  return provider === "openai" ? "native" : "text";
}

function setModelToolCapability(modelId, mode) {
  try {
    if (mode === "native" || mode === "text") localStorage.setItem(_toolCapKey(modelId), mode);
  } catch {}
}

// 本轮实际生效的工具模式：对话态一律 "none"（请求不带 tools、系统提示不带工具目录），
// 智能体态才按模型能力判定。"none" 不写入能力记忆——那是用户的选择，不是模型的限制，
// 写进去会让切回智能体后白白丢掉原生工具能力。
function effectiveToolMode(modelId, provider, chatMode = "agent") {
  return chatMode === "chat" ? "none" : getModelToolCapability(modelId, provider);
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
  TOOLS, detectToolCalls, detectDsmlCalls, detectAllCalls, hasToolMarkup, hasDsmlMarkup, stripToolCalls, hasTruncatedTail,
  executeTool, executeToolCalls,
  getToolsSystemPrompt,
  buildOpenAITools, openAICallsToCalls,
  getModelToolCapability, setModelToolCapability, effectiveToolMode,
  renderAction,
};
