/**
 * SLATE 工具 / 技能面板：内置工具列表 + SKILL.md 技能（上传/导入/删除首 */

import { state, subscribe, setSkills } from "../store.js?v=20260818-81";
import { get, post, del, upload } from "../services/api.js?v=20260818-81";
import { guardSkillParams } from "../services/riskguard.js?v=20260818-81";
import { dlgConfirm, dlgPrompt } from "../services/dialog.js?v=20260818-81";
import { t } from "../services/i18n.js?v=20260818-81";

let skillList, btnUpload, btnImport, btnDiscover, btnGithubImport, skillModal, skillModalTitle, skillParams, skillResult, btnRunSkill;

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

// ── 技能参数定首─────────────────────────────

const SKILL_PARAM_DEFS = {
  file_tree: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "recursive", label: "递归扫描", type: "text", placeholder: "true / false" },
    { key: "depth", label: "递归深度", type: "number", placeholder: "1" },
    { key: "pattern", label: "glob 过滤", type: "text", placeholder: "*.py" },
    { key: "include_hidden", label: "包含隐藏文件", type: "text", placeholder: "false" },
  ],
  file_peek: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "C:\\path\\to\\file.txt" },
    { key: "lines", label: "行数（上限 50）", type: "number", placeholder: "30" },
    { key: "encoding", label: "编码", type: "text", placeholder: "utf-8 / gbk / gb2312" },
    { key: "auto_detect", label: "自动检测编码", type: "text", placeholder: "true / false" },
    { key: "start_line", label: "起始行号", type: "number", placeholder: "1" },
    { key: "end_line", label: "结束行号", type: "number", placeholder: "30" },
    { key: "tail", label: "读取最后 N 行", type: "text", placeholder: "true / false" },
    { key: "fast", label: "快速模式", type: "text", placeholder: "true / false" },
  ],
  terminal: [
    { key: "command", label: "命令", type: "text", placeholder: "ls -la" },
    { key: "work_dir", label: "工作目录", type: "text", placeholder: "." },
    { key: "action", label: "操作类型", type: "text", placeholder: "create / list / close / kill / 空串执行命令" },
    { key: "session_id", label: "会话 ID", type: "text", placeholder: "default" },
    { key: "timeout", label: "超时秒数", type: "number", placeholder: "30" },
  ],
  html_render: [
    { key: "title", label: "页面标题", type: "text", placeholder: "SLATE 页面" },
    { key: "body", label: "HTML 内容", type: "textarea", placeholder: "<p>Hello</p>" },
  ],
  css_color: [
    { key: "description", label: "样式描述", type: "text", placeholder: "高对比度代码编辑器风格 "},
    { key: "component", label: "组件类型", type: "text", placeholder: "page / card / button / nav / form / code" },
  ],
  doc_write: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目技术文档 "},
    { key: "doc_type", label: "文档类型", type: "text", placeholder: "technical / requirement / api / readme / changelog" },
    { key: "sections", label: "章节（逗号分隔）", type: "text", placeholder: "概述,安装,配置,API" },
    { key: "content_hint", label: "内容提示", type: "textarea", placeholder: "关键信息或要点 "},
  ],
  ppt_create: [
    { key: "title", label: "演示文稿标题", type: "text", placeholder: "Q3 项目汇报" },
    { key: "subtitle", label: "副标题", type: "text", placeholder: "进展 · 风险 · 计划" },
    { key: "outline", label: "大纲章节（逗号分隔）", type: "text", placeholder: "背景,方案,实施计划,总结" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / wine / gray / #RRGGBB" },
  ],
  word_create: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目方案书 "},
    { key: "author", label: "作者", type: "text", placeholder: "SLATE" },
    { key: "content", label: "正文（支持 # 标题 / - 列表标记）", type: "textarea", placeholder: "# 概述\n项目背景说明\n## 目标\n- 目标一" },
  ],
  file_edit: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/app.js" },
    { key: "action", label: "操作类型", type: "text", placeholder: "view / replace / edit / read / insert / delete / copy / paste / cut" },
    { key: "edits", label: "编辑操作（edit 操作，JSON 数组）", type: "textarea", placeholder: '[{"old_text": "原内容", "new_text": "新内容"}]' },
    { key: "old_str", label: "精确匹配字符串（replace 操作）", type: "textarea", placeholder: "要被替换的精确文本" },
    { key: "new_str", label: "替换后内容（replace 操作）", type: "textarea", placeholder: "替换后的新文本" },
    { key: "content", label: "插入内容（insert 操作）", type: "textarea", placeholder: "要插入的文本" },
    { key: "start_line", label: "起始行号（1-based）", type: "number", placeholder: "1" },
    { key: "end_line", label: "结束行号（1-based）", type: "number", placeholder: "10" },
    { key: "clipboard_name", label: "剪贴板名称", type: "text", placeholder: "default" },
  ],
  file_create: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/new_file.js" },
    { key: "content", label: "文件内容", type: "textarea", placeholder: "文件内容..." },
  ],
  text_summarize: [
    { key: "text", label: "文本", type: "textarea", placeholder: "粘贴要总结的文本 "},
    { key: "max_points", label: "要点数", type: "number", placeholder: "5" },
    { key: "keyword_limit", label: "关键词数", type: "number", placeholder: "12" },
  ],
  json_tool: [
    { key: "text", label: "JSON 文本", type: "textarea", placeholder: "{\"name\":\"SLATE\"}" },
    { key: "mode", label: "模式", type: "text", placeholder: "format / minify / path" },
    { key: "path", label: "路径", type: "text", placeholder: "items.0.name" },
    { key: "indent", label: "缩进", type: "number", placeholder: "2" },
  ],
  regex_test: [
    { key: "pattern", label: "正则", type: "text", placeholder: "\\bTODO\\b" },
    { key: "text", label: "测试文本", type: "textarea", placeholder: "输入用于测试的文本 "},
    { key: "flags", label: "标志", type: "text", placeholder: "i / m / s" },
    { key: "limit", label: "最大结果", type: "number", placeholder: "20" },
  ],
  repo_stats: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "max_files", label: "最大文件数", type: "number", placeholder: "5000" },
  ],
  todo_scan: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "markers", label: "标记", type: "text", placeholder: "TODO,FIXME,待办" },
    { key: "limit", label: "最大结果", type: "number", placeholder: "100" },
  ],
  web_search: [
    { key: "query", label: "搜索关键词 / URL", type: "text", placeholder: "FastAPI 最新版本号（fetch 模式填 URL）" },
    { key: "mode", label: "模式", type: "text", placeholder: "search / fetch" },
    { key: "max_results", label: "结果数（≤10）", type: "number", placeholder: "5" },
  ],
  web_fetch: [
    { key: "url", label: "网页 URL", type: "text", placeholder: "https://example.com/article" },
    { key: "mode", label: "模式", type: "text", placeholder: "text / html" },
    { key: "max_chars", label: "截断长度（≤30000）", type: "number", placeholder: "8000" },
  ],
  chart_create: [
    { key: "data", label: "数据（JSON 首标签:值）", type: "textarea", placeholder: "Q1:120, Q2:90, Q3:150" },
    { key: "type", label: "图表类型", type: "text", placeholder: "bar / hbar / line / pie" },
    { key: "title", label: "图表标题", type: "text", placeholder: "季度销售额" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / warm / gray 或逗号分隔色值 "},
  ],
  qrcode_create: [
    { key: "text", label: "二维码内容（文本/URL）", type: "textarea", placeholder: "https://github.com/CaryWang1234/SLATE" },
    { key: "size", label: "模块像素大小", type: "number", placeholder: "8" },
  ],
  python_api_extract: [
    { key: "target", label: "目标（包名或 .py 文件/目录路径）", type: "text", placeholder: "requests 或 C:/path/to/mylib" },
    { key: "depth", label: "递归深度（-1 不限）", type: "number", placeholder: "1" },
    { key: "format", label: "输出格式", type: "text", placeholder: "json / markdown" },
  ],
  html_bundle: [
    { key: "src", label: "HTML 文件路径", type: "text", placeholder: "C:/path/to/page/index.html" },
    { key: "out", label: "输出路径（可选）", type: "text", placeholder: "缺省为源同目录 <原名>.bundled.html" },
  ],
  mcp_factory: [
    { key: "tool_name", label: "工具名称（英文）", type: "text", placeholder: "my_tool" },
    { key: "description", label: "工具描述", type: "text", placeholder: "我的自定义工具功能描述" },
    { key: "params", label: "参数规格（JSON 数组）", type: "textarea", placeholder: '[{"name":"input","type":"str","required":true,"description":"输入内容"}]' },
    { key: "body", label: "核心逻辑代码", type: "textarea", placeholder: 'result = {"message": "Hello"}' },
    { key: "overwrite", label: "覆盖已有（true/false）", type: "text", placeholder: "false" },
  ],
  browser_automation: [
    { key: "action", label: "操作类型", type: "text", placeholder: "launch/navigate/screenshot/click/type/get_text/evaluate/scroll/wait/close" },
    { key: "url", label: "目标 URL", type: "text", placeholder: "https://example.com" },
    { key: "selector", label: "CSS 选择器", type: "text", placeholder: "#id 或 .class" },
    { key: "text", label: "输入文字", type: "text", placeholder: "要输入的内容" },
    { key: "expression", label: "JS 表达式", type: "text", placeholder: "document.title" },
    { key: "headless", label: "无头模式 (true/false)", type: "text", placeholder: "true" },
    { key: "full_page", label: "全页截图 (true/false)", type: "text", placeholder: "false" },
  ],
  computer_use: [
    { key: "action", label: "操作类型", type: "text", placeholder: "screenshot/click/type/press/hotkey/wait/locate/clipboard/window_list/window_focus 等" },
    { key: "x", label: "X 坐标", type: "text", placeholder: "500" },
    { key: "y", label: "Y 坐标", type: "text", placeholder: "300" },
    { key: "text", label: "输入文字", type: "text", placeholder: "Hello World" },
    { key: "keys", label: "按键（hotkey 逗号分隔 / press 单键名）", type: "text", placeholder: "ctrl,c 或 enter" },
    { key: "button", label: "鼠标按键", type: "text", placeholder: "left/right/middle" },
    { key: "region", label: "截图区域 x,y,w,h", type: "text", placeholder: "0,0,800,600" },
    { key: "seconds", label: "等待秒数（wait）", type: "text", placeholder: "1" },
    { key: "repeats", label: "按键次数（press）", type: "text", placeholder: "1" },
    { key: "scroll_amount", label: "滚动格数", type: "text", placeholder: "3" },
    { key: "image_path", label: "参考图片路径", type: "text", placeholder: "C:/path/to/image.png" },
    { key: "confidence", label: "匹配置信度 0-1", type: "text", placeholder: "0.8" },
    { key: "title", label: "窗口标题关键词（window_*）", type: "text", placeholder: "记事本" },
  ],
  excel_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "create / read / convert" },
    { key: "file_path", label: "源文件路径（read/convert）", type: "text", placeholder: "C:/path/to/data.xlsx" },
    { key: "title", label: "表格标题（create 文件名）", type: "text", placeholder: "季度报表" },
    { key: "sheet", label: "工作表名", type: "text", placeholder: "Sheet1" },
    { key: "headers", label: "表头（JSON 数组或逗号分隔）", type: "text", placeholder: "姓名,部门,绩效" },
    { key: "rows", label: "数据行（JSON 二维数组）", type: "textarea", placeholder: '[["张三","研发",95],["李四","设计",88]]' },
    { key: "data", label: "CSV 文本数据（首行表头）", type: "textarea", placeholder: "姓名,部门\n张三,研发" },
    { key: "limit", label: "读取预览行数", type: "number", placeholder: "50" },
    { key: "out", label: "输出路径（convert 可选）", type: "text", placeholder: "缺省为源同目录同名换扩展名" },
  ],
  pdf_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "info / extract / tables" },
    { key: "file_path", label: "PDF 文件路径", type: "text", placeholder: "C:/path/to/doc.pdf" },
    { key: "pages", label: "页码范围", type: "text", placeholder: "1-3,5 或 all" },
    { key: "max_chars", label: "最大提取字符数", type: "number", placeholder: "30000" },
  ],
  git_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "status / log / diff / branches / remotes" },
    { key: "directory", label: "仓库目录路径", type: "text", placeholder: "C:/path/to/repo" },
    { key: "limit", label: "提交记录条数（log）", type: "number", placeholder: "10" },
    { key: "scope", label: "diff 范围", type: "text", placeholder: "unstaged / staged / all" },
  ],
  doc_scan: [
    { key: "directory", label: "扫描目录", type: "text", placeholder: "C:/path/to/docs" },
    { key: "file_path", label: "扫描单个文件（与目录二选一）", type: "text", placeholder: "C:/path/to/file.docx" },
    { key: "severity", label: "最低严重级别", type: "text", placeholder: "critical / high / medium / low" },
    { key: "category", label: "类别过滤", type: "text", placeholder: "身份证号 / 硬编码密码 / 手机号" },
    { key: "max_files", label: "最大扫描文件数", type: "number", placeholder: "50" },
  ],
  screenshot_to_code: [
    { key: "image_path", label: "图片路径", type: "text", placeholder: "C:/path/to/screenshot.png" },
    { key: "style", label: "风格偏好（可选）", type: "text", placeholder: "tailwind / plain css / responsive" },
  ],
};

// ── 列表渲染：工具首+ SKILL.md 技能区 ────────────

function createSectionHeader(text, count) {
  const head = document.createElement("div");
  head.className = "skill-section-header";
  const title = document.createElement("span");
  title.className = "skill-section-title";
  title.textContent = text;
  const badge = document.createElement("span");
  badge.className = "skill-section-count";
  badge.textContent = String(count);
  head.appendChild(title);
  head.appendChild(badge);
  return head;
}

function renderSkillList() {
  skillList.innerHTML = "";

  // 内置工具
  const mcp = state.skills.mcp || {};
  skillList.appendChild(createSectionHeader("工具", Object.keys(mcp).length));
  for (const [name, desc] of Object.entries(mcp)) {
    skillList.appendChild(createSkillItem(name, desc, "工具"));
  }

  // 远程 MCP 工具
  const remote = state.skills.remote || {};
  const remoteCount = Object.keys(remote).length;
  if (remoteCount > 0) {
    skillList.appendChild(createSectionHeader("MCP 远程工具", remoteCount));
    for (const [name, desc] of Object.entries(remote)) {
      skillList.appendChild(createSkillItem(name, desc, "MCP"));
    }
  }

  // SKILL.md 技能
  const skills = state.skills.skills || {};
  skillList.appendChild(createSectionHeader("技能 · SKILL.md", Object.keys(skills).length));
  if (Object.keys(skills).length === 0) {
    const empty = document.createElement("div");
    empty.className = "skill-empty-hint";
    empty.textContent = "暂无技能，可点击下方「导入技能」或「新建技能」";
    skillList.appendChild(empty);
  }
  for (const [name, desc] of Object.entries(skills)) {
    skillList.appendChild(createSkillItem(name, desc, "Skill"));
  }
}

function createSkillItem(name, desc, kind) {
  const item = document.createElement("div");
  item.className = "skill-item";

  const info = document.createElement("div");
  const nameRow = document.createElement("div");
  nameRow.className = "skill-item-name";
  const badge = document.createElement("span");
  badge.className = "skill-kind-badge" + ((kind === "工具" || kind === "MCP") ? " skill-kind-mcp" : " skill-kind-skill");
  badge.textContent = kind;
  nameRow.appendChild(badge);
  nameRow.appendChild(document.createTextNode(" " + name));
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = desc;
  info.appendChild(nameRow);
  info.appendChild(descEl);
  item.appendChild(info);

  // Skill 支持删除；内置工具不可首
  if (kind === "Skill") {

    const delBtn = document.createElement("button");
    delBtn.className = "skill-item-del";
    delBtn.title = "删除技能";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteSkill(name);
    });
    item.appendChild(delBtn);
  }

  item.addEventListener("click", () => {
    if (kind === "工具") openSkillModal(name, false);
    else openSkillViewer(name);
  });
  return item;
}

async function handleDeleteSkill(name) {
  if (!await dlgConfirm(t("确定删除技能 {name}", { name }), { danger: true, okText: "删除" })) return;
  try {
    const res = await del(`/skills/${encodeURIComponent(name)}`);
    showToast(res.code === 0 ? t("已删除技能 {name}", { name }) : t("删除失败: {msg}", { msg: res.message }));
    if (res.code === 0) refreshSkills();
  } catch (e) {
    showToast(t("删除失败: {msg}", { msg: e.message }));
  }
}

// ── 工具执行弹窗 ─────────────────────────────

let currentSkillName = "";

function openSkillModal(name) {
  currentSkillName = name;
  skillModalTitle.textContent = t("执行工具: {name}", { name });
  skillParams.innerHTML = "";
  skillResult.classList.add("hidden");
  skillResult.textContent = "";
  btnRunSkill.classList.remove("hidden");

  const defs = SKILL_PARAM_DEFS[name] || [];
  for (const def of defs) {
    const label = document.createElement("label");
    label.textContent = def.label;

    let input;
    if (def.type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 3;
    } else {
      input = document.createElement("input");
      input.type = def.type;
    }
    input.id = `skill-param-${def.key}`;
    input.placeholder = def.placeholder || "";
    if (def.type === "number") input.value = "30";

    skillParams.appendChild(label);
    skillParams.appendChild(input);
  }

  skillModal.classList.remove("hidden");
}

// ── SKILL.md 技能查看器（只读展示定义内容） ─────────────

async function openSkillViewer(name) {
  skillModalTitle.textContent = t("技术 {name}", { name });
  skillParams.innerHTML = "";
  btnRunSkill.classList.add("hidden");
  skillResult.classList.remove("hidden");
  skillResult.textContent = "读取中…";
  skillModal.classList.remove("hidden");

  try {
    const res = await post("/skills/execute", { skill: name, params: {} });
    if (res.code === 0 && res.data?.content) {
      skillResult.textContent = res.data.content;
    } else {
      skillResult.textContent = t("读取失败: {msg}", { msg: res.message || t("未知错误") });
    }
  } catch (e) {
    skillResult.textContent = t("请求失败: {msg}", { msg: e.message });
  }
}

async function executeSkill() {
  const params = {};

  const defs = SKILL_PARAM_DEFS[currentSkillName] || [];
  for (const def of defs) {
    const el = document.getElementById(`skill-param-${def.key}`);
    if (el) {
      params[def.key] = def.type === "number" ? parseInt(el.value) || 0 : el.value;
    }
  }

  btnRunSkill.disabled = true;
  btnRunSkill.textContent = "执行中…";

  try {
    // 高危命令审批：命中写死规则时弹框请求批准
    if (!(await guardSkillParams(currentSkillName, params))) {
      skillResult.classList.remove("hidden");
      skillResult.textContent = "高危命令已被拒绝执行";
      return;
    }
    const res = await post("/skills/execute", { skill: currentSkillName, params });
    skillResult.classList.remove("hidden");
    if (res.code === 0) {
      skillResult.textContent = JSON.stringify(res.data, null, 2);
      // 多模态输出：图片内联预览，文档附查看链接
      if (res.data?.preview_url) {
        const url = res.data.preview_url;
        const name = (res.data.file_path || url).split(/[\\/]/).pop();
        const isImage = /\.(svg|png|jpe?g|webp|gif)$/i.test(name);
        if (isImage) {
          const img = document.createElement("img");
          img.src = url;
          img.className = "skill-result-image";
          skillResult.appendChild(img);
        } else {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          link.className = "skill-result-doc-link";
          link.textContent = "\n📄 " + t("查看输出文档：{name}", { name });
          skillResult.appendChild(link);
        }
      }
    } else {
      skillResult.textContent = t("错误: {msg}", { msg: res.message });
    }
  } catch (e) {
    skillResult.classList.remove("hidden");
    skillResult.textContent = t("请求失败: {msg}", { msg: e.message });
  }

  btnRunSkill.disabled = false;
  btnRunSkill.textContent = "执行";
}

// ── 上传自定义技术───────────────────────────

async function handleUploadSkill() {
  const name = await dlgPrompt("技能名称（英文，如 my-skill）：", { title: "新建技能", placeholder: "my-skill" });
  if (!name || !name.trim()) return;
  const desc = (await dlgPrompt("技能描述：", { title: "新建技能", value: name.trim(), textarea: true })) || name.trim();

  // 创建文件选择器
  const input = document.createElement("input");

  input.type = "file";
  input.multiple = true;
  input.accept = ".md,.py,.js,.json,.yaml,.yml,.sh,.bat";

  input.addEventListener("change", async () => {
    if (!input.files.length) return;
    const formData = new FormData();
    for (const file of input.files) {
      formData.append("files", file);
    }
    formData.append("skill_name", name.trim());
    formData.append("skill_desc", desc.trim());

    try {
      const res = await upload(`/skills/upload?skill_name=${encodeURIComponent(name.trim())}&skill_desc=${encodeURIComponent(desc.trim())}`, formData);
      if (res.code === 0) {
        showToast(t("技术{name} 上传成功", { name }));
        refreshSkills();
      } else {
        showToast(t("上传失败: {msg}", { msg: res.message }));
      }
    } catch (e) {
      showToast(t("上传失败: {msg}", { msg: e.message }));
    }
  });

  input.click();
}

// ── 导入 SKILL.md 技能（本地路径） ───────────────

async function handleImportSkill() {
  const path = await dlgPrompt("输入本地路径（包含 SKILL.md 的目录，或单个 .md 文件）：", { title: "导入技能", placeholder: "D:\\skills\\my-skill" });
  if (!path || !path.trim()) return;
  const name = (await dlgPrompt("技能名称（留空则自动取目录/文件名）：", { title: "导入技能" })) || "";

  try {
    const res = await post("/skills/import", { path: path.trim(), name });
    if (res.code === 0) {
      showToast(t("技能 {name} 导入成功（{n} 个文件）", { name: res.data.skill, n: res.data.files }));
      refreshSkills();
    } else {
      showToast(t("导入失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    showToast(t("导入失败: {msg}", { msg: e.message }));
  }
}

// ── 发现已安装插件（Codex/Claude 标准路径） ──────

async function handleDiscoverPlugins() {
  showToast("正在扫描标准插件目录...");
  try {
    const res = await get("/skills/sources");
    if (res.code !== 0) {
      showToast(t("扫描失败: {msg}", { msg: res.message }));
      return;
    }
    const data = res.data;
    const localSkills = data.local_skills || [];
    const codexPlugins = data.codex_plugins || [];
    const total = localSkills.length + codexPlugins.length;

    if (total === 0) {
      showToast("未发现已安装的插件");
      return;
    }

    // 显示发现结果
    let msg = `发现 ${total} 个插件：\n\n`;
    if (localSkills.length) {
      msg += `SKILL.md 技能 (${localSkills.length}):\n`;
      localSkills.forEach(s => { msg += `  - ${s.name}: ${s.description}\n`; });
    }
    if (codexPlugins.length) {
      msg += `\nCodex 插件 (${codexPlugins.length}):\n`;
      codexPlugins.forEach(p => { msg += `  - ${p.name}: ${p.description}\n`; });
    }
    msg += "\n是否导入全部？";

    if (await dlgConfirm(msg, { title: "发现插件", okText: "导入全部", cancelText: "取消" })) {
      let imported = 0;
      for (const skill of localSkills) {
        try {
          await post("/skills/import-path", { path: skill.path, name: skill.name });
          imported++;
        } catch (e) {}
      }
      for (const plugin of codexPlugins) {
        try {
          await post("/skills/import-path", { path: plugin.path, name: plugin.name });
          imported++;
        } catch (e) {}
      }
      showToast(`成功导入 ${imported} 个插件`);
      refreshSkills();
    }
  } catch (e) {
    showToast(t("扫描失败: {msg}", { msg: e.message }));
  }
}

// ── 从 GitHub 导入技能 ─────────────────────────

async function handleGithubImport() {
  const url = await dlgPrompt("输入 GitHub 仓库地址：", {
    title: "从 GitHub 导入",
    placeholder: "https://github.com/user/repo 或 user/repo",
  });
  if (!url || !url.trim()) return;

  const subpath = await dlgPrompt("子路径（可选，留空自动查找 SKILL.md）：", {
    title: "从 GitHub 导入",
    placeholder: "path/to/skill",
  });

  showToast("正在下载...");
  try {
    const res = await post("/skills/import-github", { url: url.trim(), subpath: (subpath || "").trim() });
    if (res.code === 0) {
      showToast(t("技能 {name} 导入成功（{n} 个文件）", { name: res.data.name, n: res.data.files }));
      refreshSkills();
    } else {
      showToast(t("导入失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    showToast(t("导入失败: {msg}", { msg: e.message }));
  }
}

// ── 刷新技能列首─────────────────────────────

async function refreshSkills() {
  const res = await get("/skills");
  if (res.code === 0) {
    setSkills(res.data);
  }
}

// ── 初始首───────────────────────────────────

function initSkillPanel() {
  skillList = document.getElementById("skill-list");
  btnUpload = document.getElementById("btn-upload-skill");
  btnImport = document.getElementById("btn-import-skill");
  skillModal = document.getElementById("skill-modal");
  skillModalTitle = document.getElementById("skill-modal-title");
  skillParams = document.getElementById("skill-params");
  skillResult = document.getElementById("skill-result");
  btnRunSkill = document.getElementById("btn-run-skill");
  btnDiscover = document.getElementById("btn-discover-plugins");
  btnGithubImport = document.getElementById("btn-github-import");

  btnUpload.addEventListener("click", handleUploadSkill);
  btnImport.addEventListener("click", handleImportSkill);
  if (btnDiscover) btnDiscover.addEventListener("click", handleDiscoverPlugins);
  if (btnGithubImport) btnGithubImport.addEventListener("click", handleGithubImport);
  btnRunSkill.addEventListener("click", executeSkill);

  // 关闭弹窗
  skillModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => skillModal.classList.add("hidden"));
  });

  subscribe("skills", renderSkillList);

  // 加载技能列首
  refreshSkills();

}

export { initSkillPanel, refreshSkills };
