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

import { state, addBoardCard, setBoardCards, getConversationTodos, setConversationTodos } from "../store.js?v=20260818-96";
import { post } from "../services/api.js?v=20260818-96";
import { isHighRiskCommand, guardSkillParams } from "./riskguard.js?v=20260818-96";
import { t } from "./i18n.js?v=20260818-96";
import { makeId } from "./utils.js?v=20260818-96";

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

// ── 工具注册 ────────────────────────────────

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
      if (!matches.length) return `未找到 ${query}`;
      return matches.map(item => `${item.type === "dir" ? "📁" : "📄"} ${item.path}${item.size ? ` (${item.size}B)` : ""}`).join("\n");
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

  skill_run: {
    name: "执行工具",
    description: "调用内置工具。可用：file_tree(目录扫描：支持递归recursive、深度depth、glob过滤pattern如*.py、包含隐藏文件include_hidden，使用os.scandir快速扫描), file_peek(读文件：支持多编码encoding如utf-8/gbk/gb2312、自动检测编码auto_detect、行范围start_line/end_line、tail模式读最后N行、快速模式fast不统计总行数), file_edit(文件编辑：action=edit基于diff精确修改（edits JSON数组每项含old_text和new_text）/read读取内容（start_line/end_line行号范围）/insert在指定行插入（content内容、start_line行号）/delete删除行范围（start_line/end_line）/copy复制到剪贴板（start_line/end_line可选、clipboard_name剪贴板名）/paste从剪贴板粘贴（start_line行号、clipboard_name）/cut剪切到剪贴板（start_line/end_line、clipboard_name）), file_create(创建新文件), terminal(持久化终端会话：支持多会话管理、状态保持（cd/export跨命令保持）、进程管理，action=create创建会话/list列出所有会话/close关闭会话/kill终止进程/空串执行命令，command要执行的命令、work_dir工作目录、session_id会话ID默认default、timeout超时秒数默认30，高危命令双层拦截), html_render(生成HTML), css_color(CSS配色), doc_write(文档骨架), ppt_create(生成.pptx演示文稿：title标题、outline逗号分隔章节或slides传JSON数组[{title,points}]精确控制每页，theme可选slate/blue/green/wine/gray十六进制色值，返回文件路径), word_create(生成.docx Word文档：title标题、content正文支持#标题/-列表/1.有序列表标记，或sections传JSON数组[{heading,level,paragraphs,bullets}]，返回文件路径), text_summarize(文本摘要), json_tool(JSON处理), regex_test(正则测试), repo_stats(项目统计), todo_scan(待办扫描), web_search(联网搜索/网页抓取，获取实时信息：mode=search时query为关键词，mode=fetch时query为URL), web_fetch(获取指定网页内容：url为完整URL，返回标题/描述/正文纯文本，mode=html时返回原始HTML), chart_create(生成SVG图表：type=bar柱状图/hbar条形图/line折线图/pie饼图，data支持JSON数组[{label,value}]、JSON对象{标签:数值}或文本A:1, B:2（逗号/换行分隔），title图表标题可选，theme配色可选slate/blue/green/warm/gray或逗号分隔色值，返回preview_url可预览), qrcode_create(生成SVG二维码：text为文本或URL，size模块像素大小默认8，返回preview_url可预览), python_api_extract(提取Python库公共API文档：target为已安装包名如requests或本地py文件/包目录路径，depth子模块递归深度默认1，-1不限，format可选json或代码，输出函数签名、类方法、属性、源码位置，落盘返回file_path，代码附带preview_url), html_bundle(便携网页打包：src为源html路径，将该页面相对路径引用的css/js内联合并为单个html便于分发，out输出路径可选、缺省为源同目录原名.bundled.html，CDN/绝对路径保留外链并在warnings中警告，返回file_path与内联清单), code_scan(代码安全扫描：扫描项目检测硬编码密钥/SQL注入/XSS/弱加密/调试残留等，severity过滤critical/high/medium/low，category过滤类别), doc_scan(文档安全扫描：扫描文档检测不安全信息，支持md/docx/pptx/xlsx/csv/pdf/txt，检测身份证号/手机号/邮箱/密码/密钥/银行账号/薪资/机密标记/内网URL等，directory扫描目录或file_path扫描单文件，severity过滤级别，category过滤类别如'身份证号'/'硬编码密码'，max_files最大扫描文件数默认50), mcp_factory(工具工厂：根据描述自动生成新的工具，tool_name工具名称英文、description工具描述、params参数规格JSON数组、body核心逻辑代码、overwrite是否覆盖已有工具), browser_automation(浏览器自动化：Playwright控制Chromium，action=launch启动/navigate导航/screenshot截图/click点击/type输入/get_text获取文字/evaluate执行JS/scroll滚动/wait等待元素/close关闭，url目标URL、selector CSS选择器、text输入文字、expression JS表达式、headless无头模式、full_page全页截图), computer_use(桌面自动化：pyautogui控制鼠标键盘与窗口，默认快速模式，action=screenshot截图/click点击/double_click双击/right_click右键/type输入（非ASCII自动走剪贴板）/press单键按压/hotkey组合键/scroll滚动/move移动/drag拖拽/wait等待秒数/position鼠标位置/screen_size屏幕分辨率/locate图像定位/clipboard剪贴板读写/window_list列出窗口/window_focus/window_minimize/window_maximize/window_restore/window_close窗口操作，x/y坐标、text文字、keys按键、button鼠标按键、region截图区域x,y,w,h、fast快速模式默认true、screenshot_format默认jpeg可选png、quality默认80、max_width/max_height截图缩放上限、seconds等待秒数、repeats按键次数、scroll_amount滚动格数、image_path参考图片、confidence置信度、title窗口标题关键词，截图返回preview_url可内联预览), excel_tool(办公表格：action=create生成.xlsx（title标题、sheet工作表名、headers表头JSON数组或逗号分隔、rows数据JSON二维数组，或data传CSV文本首行表头），read读取.xlsx/.csv（file_path、sheet工作表、limit预览行数默认50，返回表头与数据预览），convert为csv与xlsx互转（file_path、out输出路径可选）), pdf_tool(PDF办公文档：action=info元信息页数/extract提取文本（pages页码范围如1-3,5）/tables提取表格数据，file_path必填，max_chars最大字符数默认30000), git_tool(Git只读信息：action=status分支与工作区变更/log最近提交（limit默认10）/diff变更统计（scope=unstaged未暂存/staged已暂存/all）/branches本地与远程分支/remotes远程仓库，directory仓库目录必填), screenshot_to_code(截图转代码：读取图片文件编码为base64供AI视觉分析，image_path图片路径必填、style风格偏好可选如tailwind/plain css/responsive，AI根据截图生成HTML/CSS代码还原视觉效果)。也可传入 SKILL.md 技能名读取其定义内容",
    params: {
      skill: { type: "string", description: "工具或技能名称", required: true },
      params: { type: "object", description: "工具参数" },
    },
    async execute({ skill, params }) {
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
        if (skill === "terminal" && p.command) {

          const risk = isHighRiskCommand(p.command);
          if (risk.risk && !(await guardSkillParams(skill, p))) {
            return `高危命令被用户拒绝执行（${risk.reason}）：${p.command}`;
          }
        }
        const res = await post("/skills/execute", { skill, params: p });
        if (res.code === 0) {
          const data = res.data;
          if (typeof data === "string") return data.length > 2000 ? data.slice(0, 2000) + "…" : data;
          return JSON.stringify(data, null, 2);
        }
        return `工具执行失败: ${res.message}`;
      } catch (e) {
        return `工具调用出错: ${e.message}`;
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
    description: "文件编辑：view 带行号查看 / replace 精确唯一替换 / edit diff / read / insert / delete / copy / paste / cut。默认自动应用写入（用户在设置关闭自动确认时改为预览后手动接受）。参数名 file_path（不是 path）。",
    params: {
      file_path: { type: "string", description: "目标文件相对路径（相对于项目根目录）", required: true },
      edits: { type: "array", description: '编辑列表（edit 操作），每项含 old_text 和 new_text，如 [{"old_text":"原内容","new_text":"新内容"}]' },
      old_str: { type: "string", description: "要被替换的精确字符串（replace 操作，必须唯一匹配）" },
      new_str: { type: "string", description: "替换后的新字符串（replace 操作）" },
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

      // 返回结构化数据，chat.js 会按 _type 渲染 diff UI
      const structured = {
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
    description: "查看当前对话的统计信息",
    params: {},
    async execute() {
      const msgs = state.messages;
      const ctxTokens = msgs.reduce((sum, m) => sum + Math.ceil((m.content || "").length / 3) + 4, 0);
      return [
        `模型: ${state.currentModel?.name || "未选择"}`,
        `消息数: ${msgs.length}`,
        `上下文估算: ~${ctxTokens.toLocaleString()} tokens`,
        `上下文上限: ${state.currentModel?.context_window || "未知"}`,
        `黑板卡片: ${state.boardCards.length}`,
      ].join("\n");
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
      const icons = { done: "✓", in_progress: "…", blocked: "!", pending: "·" };
      const done = list.filter(t => t.status === "done").length;
      const lines = list.map(t => `${icons[t.status] || ""} [${t.id}] ${t.content}`);
      return `TODOLIST 已更新（${done}/${list.length} 完成）：\n${lines.join("\n")}` +
        (done === list.length
          ? "\n全部完成，进入验证与汇报阶段。"
          : "\n请继续统筹推进未完成事项（能并行的多项一起处理），每完成一批立即调用 todo_manage 批量更新状态，保持清单实时准确。");
    },
  },
};

// ── 工具调用检测 ──────────────────────────────

const TOOL_RE = /◈◈◈\s*(\w+)\s*\r?\n([\s\S]*?)(?:◈◆◆|◆◆)/g;

// file_create / file_append 走原样围栏协议：内容不经 JSON 转义，根治大内容转义损坏与 file_path 丢失
const FILE_RAW_TOOLS = new Set(["file_create", "file_append"]);

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
];

const SKILL_RUN_QUICK_LIST = [
  "file_tree", "file_peek", "file_edit", "file_create", "terminal",
  "code_scan", "doc_scan", "git_tool", "web_search", "web_fetch",
  "browser_automation", "computer_use", "chart_create", "qrcode_create",
  "python_api_extract", "html_bundle", "ppt_create", "word_create", "excel_tool",
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
    if (spec.required && (params?.[key] === undefined || params?.[key] === null || params?.[key] === "")) {
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
  // 容忍模型在路径与内容之间加一行分隔符（◈── / --- / === 之类），跳过
  if (lines.length && /^[◈─—\-=:*]{2,}\s*$/.test(lines[0].trim())) lines.shift();
  // 防御：模型偶尔无视规则把内容包进 ``` 代码围栏，剥掉外层围栏还原真实内容。
  // 末尾可能带协议性空行，需在最后一个非空行上判断闭合围栏。
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
  if (lastIdx >= 1 && /^``/.test(lines[0].trim()) && /^```\s*$/.test(lines[lastIdx].trim())) {
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

function detectToolCalls(text) {
  const calls = [];
  let match;
  let lastEnd = 0;
  const re = new RegExp(TOOL_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    lastEnd = re.lastIndex;
    const name = normalizeToolName(match[1]);
    if (FILE_RAW_TOOLS.has(name)) {
      calls.push({ name, params: parseFileWriteParams(match[2]) });
      continue;
    }
    let params;
    try {
      params = JSON.parse(stripJsonFence(match[2]) || "{}");
    } catch {
      // 闭合块但 JSON 损坏：用 salvage 尽力抢救参数，而不是直接丢弃（否则 file_path 等必丢）
      params = salvageTruncatedParams(match[2] || "");
    }
    params = normalizeToolParams(name, params);
    calls.push({ name, params });
  }

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
    } else {
      try {
        params = JSON.parse(stripJsonFence(rawBody));
      } catch {
        params = salvageTruncatedParams(rawBody);
      }
      params = normalizeToolParams(name, params);
    }
    params._truncated = true;
    calls.push({ name, params });
  }
  return calls;
}

// 末尾是否存在被截断的工具调用块（缺少闭合标记 ◈◆◆，通常是输出达到 max_tokens 上限）
function hasTruncatedTail(text) {
  if (!text) return false;
  const calls = detectToolCalls(text);
  return calls.length > 0 && calls[calls.length - 1].params._truncated === true;
}

function stripToolCalls(text) {
  const stripped = text.replace(TOOL_RE, "");
  // 同时移除末尾未闭合的截断工具块，避免残缺 JSON 残留在消息正则
  return stripped

    .replace(/◈◈◈[ \t]*\w+[ \t]*\r?\n[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 工具执行 ──────────────────────────────────

async function executeTool(name, params) {
  name = normalizeToolName(name);
  params = normalizeToolParams(name, params || {});
  const tool = TOOLS[name];
  if (!tool) return { success: false, output: `未知工具: ${name}` };
  const validationError = validateToolCall(name, params);
  if (validationError) {
    return { success: false, output: `[工具 ${name}] 未执行：${validationError}。请按该工具参数说明重发完整调用。` };
  }
  try {
    const output = await tool.execute(params);
    // 结构化结果（如 file_edit / file_create）直接传递，同时生成文本摘要给 AI
    if (output && typeof output === "object" && output._type) {
      let summary = `[工具 ${name}] `;
      if (output._type === "file_edit") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_edit] 文件: ${output.file_name}（${targetPath}），${s.edits_total} 处编辑，${s.edits_applied} 处成功，+${s.lines_added} -${s.lines_removed} 行。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        summary += " diff 已展示给用户，尚未写入磁盘，等待用户确认。";
      } else if (output._type === "file_create") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_create] 新文件 ${output.file_name}（${targetPath}），${s.lines} 行，${s.chars} 字符。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        if (output.truncated) summary += " 注意：本次内容因输出截断可能不完整；若用户接受预览，请立即用 file_append 从断点补齐剩余内容。";
        summary += " 预览已展示给用户，尚未写入磁盘，等待用户确认。";
      } else if (output._type === "file_append") {
        const s = output.stats;
        const targetPath = output.file_path_rel || output.file_name || output.file || "";
        summary = `[工具 file_append] 文件: ${output.file_name}（${targetPath}），本次追加 ${s.lines} 行，${s.chars} 字符。`;
        if (output.errors?.length) summary += ` 警告: ${output.errors.join("; ")}`;
        if (output.truncated) summary += " 注意：本次追加内容因输出截断可能不完整，请继续用 file_append 补齐剩余内容。";
        summary += " 追加预览已展示给用户，尚未写入磁盘，等待用户确认。";
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
    // 截断守卫：输出达到长度上限导致工具调用块未闭合、参数不完整。
    // file_create/file_append 截断时已输出的 content 仍是有效前缀，允许执行预览并靠后续 file_append 补齐。
    // 其余工具（尤其 file_edit 的部分编辑）执行残缺参数很危险，拒绝执行并反馈模型拆分重试。
    if (call.params?._truncated && call.name !== "file_append" && call.name !== "file_create") {

      results.push({
        ...call,
        success: false,
        output: `[工具 ${call.name}] 未执行：该工具调用因输出长度达到上限被截断，参数不完整。请拆分后重试：超长文件先用 file_create 写入前半部分，再用 file_append 分一次或多次补齐剩余内容；单次调用的内容量宁小勿大。`,
      });
      continue;
    }
    const result = await executeTool(call.name, call.params);
    results.push({ ...call, ...result });
  }
  return results;
}

// ── 系统提示词工具段 ──────────────────────────

function getToolsSystemPrompt({ minimal = false } = {}) {
  let s = "\n\n[可用工具]\n";
  s += "你拥有工具，可以直接操作用户的工作环境。\n\n";
  s += "**调用纪律**\n";
  s += "1. 必须使用下方格式实际发出调用，不要只描述意图；禁止说“我先看看”“我需要查看”后停住。\n";
  s += "2. 任务需要查看文件、目录、项目结构或执行操作时，当前回复必须包含工具调用块；不要回答“我无法查看”——你可以。\n";
  s += "3. 你只是在问用户是否继续、是否要你动手时，不要调用工具，等待用户确认。\n";
  s += "4. 同一回复可以发出多个独立工具块；无依赖的读取/扫描可以批量调用，有依赖的先拿结果再继续。\n";
  s += "5. 只知道文件名但不知道相对路径时，先调用 project_find_file；拿到匹配路径后再调用 project_read_file。\n\n";
  s += "**工具选择速查**\n";
  for (const [scene, route] of TOOL_USE_RECIPES) s += `- ${scene}: ${route}\n`;
  s += "\n";
  s += "**调用格式**：每次调用独占一块，◈◈◈ 与 ◈◆◆ 是固定标记，不可省略；一次回复可多次调用：\n";
  s += "◈◈◈tool_name\n{JSON参数}\n◈◆◆\n\n";

  // 具体示例
  s += '**示例：用户说“了解项目”时，直接回复：**\n';
  s += "◈◈◈project_files\n{\"path\": \"\"}\n◈◆◆\n";
  s += "（等待工具返回目录列表后，再根据结果回答用户）\n\n";

  // 项目上下文
  if (state.project) {

    s += `[当前项目] ${state.project.name} (${state.project.path})\n`;
    if (state.project.constitution?.rules?.length) {
      s += "项目宪法:\n";
      state.project.constitution.rules.forEach((r, i) => { s += `  ${i + 1}. ${r}\n`; });
    }
    s += "\n";
  }

  for (const [key, tool] of Object.entries(TOOLS)) {
    const desc = key === "skill_run"
      ? `调用内置工具/远程 MCP/自定义技能。常用内置工具：${SKILL_RUN_QUICK_LIST.join(", ")}。复杂参数按工具名传入 params。`
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
  s += "- edits: JSON 数组，每项包含 old_text（要替换的原文）和 new_text（替换后的内容）\n";
  s += "- old_text 必须在文件中唯一出现，否则会报错\n";
  s += "- 只包含你要修改的部分，不要包含整个文件内容\n";
  s += "- 可以包含多组编辑，一次性完成所有修改\n";
  s += "- 用户会看到 diff 预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 编辑完成后，等待用户确认，不要自动继续修改\n";

  // file_create 专项指导
  s += "\n[文件创建规则 / file_create 工具]\n";
  s += "当用户要求创建新文件时，你必须使用 file_create 工具。\n";
  s += "专用格式（重要，不是 JSON）：◈◈◈file_create 后第一行写相对路径，第二行起原样直写文件完整内容，最后用 ◈◆◆ 闭合。\n";
  s += "内容区严禁 JSON 包裹、严禁转义换行/引号、严禁代码围栏（```）——像平常写代码一样直接写。\n";
  s += "- 路径只能使用项目根相对路径，不能使用磁盘绝对路径、URL、~ 或 ..\n";
  s += "- 如果用户只要求输出文件但没有指定位置，默认放到 outputs/ 下，并使用清晰的文件名\n";
  s += "- 内容必须输出完整，绝不允许用“…其余省略” / “同上”等方式缩写\n";
  s += "- 超长文件（预计超过 300 行）必须分段写入：先用 file_create 写入前半部分（在完整行边界截断），再用一次或多次 file_append 从断点精确接续补齐剩余部分；单次调用宁小勿大，避免输出被截断\n";
  s += "- 如果收到“输出被截断”相关的工具结果反馈，不要重复已写入的内容，立即用 file_append 从断点接续补齐\n";
  s += "- 如果文件已存在，应使用 file_edit 工具而非 file_create\n";
  s += "- 用户会看到内容预览，并可以选择「接受」「拒绝」或「复制」\n";
  s += "- 创建完成后，等待用户确认\n";

  // file_append 专项指导
  s += "\n[文件追加规则 / file_append 工具]\n";
  s += "向已存在文件末尾追加内容，用于分段写入超长文件。格式与 file_create 相同：第一行路径，第二行起原样直写内容，不是 JSON。\n";
  s += "- 路径对应的文件必须已存在（先 file_create 后 file_append）\n";
  s += "- 内容从上次写入结束的精确位置接续，绝不重复已有内容\n";
  s += "- 输出被截断时，系统会要求你用 file_append 补齐；每次追加控制在 300 行以内\n";

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
  TOOLS, detectToolCalls, stripToolCalls, hasTruncatedTail,
  executeTool, executeToolCalls,
  getToolsSystemPrompt,
};
