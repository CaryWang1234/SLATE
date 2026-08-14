/**
 * SLATE MCP / 技能面板：MCP 内置工具列表 + SKILL.md 技能（上传/导入/删除�? */

import { state, subscribe, setSkills } from "../store.js?v=20260814-48";
import { get, post, del, upload } from "../services/api.js?v=20260814-48";
import { guardSkillParams } from "../services/riskguard.js?v=20260814-48";
import { dlgConfirm, dlgPrompt } from "../services/dialog.js?v=20260814-48";
import { t } from "../services/i18n.js?v=20260814-48";

let skillList, btnUpload, btnImport, skillModal, skillModalTitle, skillParams, skillResult, btnRunSkill;

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

// ── 技能参数定�?─────────────────────────────

const SKILL_PARAM_DEFS = {
  file_tree: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
  ],
  file_peek: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "C:\\path\\to\\file.js" },
    { key: "lines", label: "行数（≤50�?, type: "number", placeholder: "30" },
  ],
  terminal: [
    { key: "command", label: "命令", type: "text", placeholder: "ls -la" },
    { key: "work_dir", label: "工作目录", type: "text", placeholder: "." },
  ],
  html_render: [
    { key: "title", label: "页面标题", type: "text", placeholder: "SLATE 页面" },
    { key: "body", label: "HTML 内容", type: "textarea", placeholder: "<p>Hello</p>" },
  ],
  css_color: [
    { key: "description", label: "样式描述", type: "text", placeholder: "高对比度代码编辑器风�? },
    { key: "component", label: "组件类型", type: "text", placeholder: "page / card / button / nav / form / code" },
  ],
  doc_write: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目技术文�? },
    { key: "doc_type", label: "文档类型", type: "text", placeholder: "technical / requirement / api / readme / changelog" },
    { key: "sections", label: "章节（逗号分隔�?, type: "text", placeholder: "概述,安装,配置,API" },
    { key: "content_hint", label: "内容提示", type: "textarea", placeholder: "关键信息或要�? },
  ],
  ppt_create: [
    { key: "title", label: "演示文稿标题", type: "text", placeholder: "Q3 项目汇报" },
    { key: "subtitle", label: "副标�?, type: "text", placeholder: "进展 · 风险 · 计划" },
    { key: "outline", label: "大纲章节（逗号分隔�?, type: "text", placeholder: "背景,方案,实施计划,总结" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / wine / gray �?6 位色�? },
  ],
  word_create: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目方案�? },
    { key: "author", label: "作�?, type: "text", placeholder: "SLATE" },
    { key: "content", label: "正文（支�?# 标题 / - 列表标记�?, type: "textarea", placeholder: "# 概述\n项目背景说明\n## 目标\n- 目标一" },
  ],
  file_edit: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/app.js" },
    { key: "edits", label: "编辑操作（JSON 数组�?, type: "textarea", placeholder: '[{"old_text": "原内�?, "new_text": "新内�?}]' },
  ],
  file_create: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/new_file.js" },
    { key: "content", label: "文件内容", type: "textarea", placeholder: "文件内容..." },
  ],
  text_summarize: [
    { key: "text", label: "文本", type: "textarea", placeholder: "粘贴要总结的文�? },
    { key: "max_points", label: "要点�?, type: "number", placeholder: "5" },
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
    { key: "text", label: "测试文本", type: "textarea", placeholder: "输入用于测试的文�? },
    { key: "flags", label: "标志", type: "text", placeholder: "i / m / s" },
    { key: "limit", label: "最大结�?, type: "number", placeholder: "20" },
  ],
  repo_stats: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "max_files", label: "最大文件数", type: "number", placeholder: "5000" },
  ],
  todo_scan: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "markers", label: "标记", type: "text", placeholder: "TODO,FIXME,待办" },
    { key: "limit", label: "最大结�?, type: "number", placeholder: "100" },
  ],
  web_search: [
    { key: "query", label: "搜索关键�?/ URL", type: "text", placeholder: "FastAPI 最新版本号（fetch 模式�?URL�? },
    { key: "mode", label: "模式", type: "text", placeholder: "search / fetch" },
    { key: "max_results", label: "结果数（�?0�?, type: "number", placeholder: "5" },
  ],
  web_fetch: [
    { key: "url", label: "网页 URL", type: "text", placeholder: "https://example.com/article" },
    { key: "mode", label: "模式", type: "text", placeholder: "text / html" },
    { key: "max_chars", label: "截断长度（≤30000�?, type: "number", placeholder: "8000" },
  ],
  chart_create: [
    { key: "data", label: "数据（JSON �?标签:值）", type: "textarea", placeholder: "Q1:120, Q2:90, Q3:150" },
    { key: "type", label: "图表类型", type: "text", placeholder: "bar / hbar / line / pie" },
    { key: "title", label: "图表标题", type: "text", placeholder: "季度销售额" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / warm / gray 或逗号分隔色�? },
  ],
  qrcode_create: [
    { key: "text", label: "二维码内容（文本/URL�?, type: "textarea", placeholder: "https://github.com/CaryWang1234/SLATE" },
    { key: "size", label: "模块像素大小", type: "number", placeholder: "8" },
  ],
  python_api_extract: [
    { key: "target", label: "目标（包名或 .py 文件/目录路径�?, type: "text", placeholder: "requests �?C:/path/to/mylib" },
    { key: "depth", label: "递归深度�?1 不限�?, type: "number", placeholder: "1" },
    { key: "format", label: "输出格式", type: "text", placeholder: "json / markdown" },
  ],
  html_bundle: [
    { key: "src", label: "�?html 文件路径", type: "text", placeholder: "C:/path/to/page/index.html" },
    { key: "out", label: "输出路径（可选）", type: "text", placeholder: "缺省为源同目�?<原名>.bundled.html" },
  ],
};

// ── 列表渲染：MCP 工具�?+ SKILL.md 技能区 ────────────

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

  // MCP 内置工具
  const mcp = state.skills.mcp || {};
  skillList.appendChild(createSectionHeader("MCP 工具", Object.keys(mcp).length));
  for (const [name, desc] of Object.entries(mcp)) {
    skillList.appendChild(createSkillItem(name, desc, "MCP"));
  }

  // SKILL.md 技�?  const skills = state.skills.skills || {};
  skillList.appendChild(createSectionHeader("技�?· SKILL.md", Object.keys(skills).length));
  if (Object.keys(skills).length === 0) {
    const empty = document.createElement("div");
    empty.className = "skill-empty-hint";
    empty.textContent = "暂无技能，可点击下方「导入技能」或「新建技能�?;
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
  badge.className = "skill-kind-badge" + (kind === "MCP" ? " skill-kind-mcp" : " skill-kind-skill");
  badge.textContent = kind;
  nameRow.appendChild(badge);
  nameRow.appendChild(document.createTextNode(" " + name));
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = desc;
  info.appendChild(nameRow);
  info.appendChild(descEl);
  item.appendChild(info);

  // Skill 支持删除；MCP 内置工具不可�?  if (kind === "Skill") {
    const delBtn = document.createElement("button");
    delBtn.className = "skill-item-del";
    delBtn.title = "删除技�?;
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteSkill(name);
    });
    item.appendChild(delBtn);
  }

  item.addEventListener("click", () => {
    if (kind === "MCP") openSkillModal(name, false);
    else openSkillViewer(name);
  });
  return item;
}

async function handleDeleteSkill(name) {
  if (!await dlgConfirm(t("确定删除技�?{name}�?, { name }), { danger: true, okText: "删除" })) return;
  try {
    const res = await del(`/skills/${encodeURIComponent(name)}`);
    showToast(res.code === 0 ? t("已删除技�?{name}", { name }) : t("删除失败: {msg}", { msg: res.message }));
    if (res.code === 0) refreshSkills();
  } catch (e) {
    showToast(t("删除失败: {msg}", { msg: e.message }));
  }
}

// ── MCP 工具执行弹窗 ─────────────────────────────

let currentSkillName = "";

function openSkillModal(name) {
  currentSkillName = name;
  skillModalTitle.textContent = t("执行 MCP 工具: {name}", { name });
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
  skillModalTitle.textContent = t("技�? {name}", { name });
  skillParams.innerHTML = "";
  btnRunSkill.classList.add("hidden");
  skillResult.classList.remove("hidden");
  skillResult.textContent = "读取中�?;
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
  btnRunSkill.textContent = "执行中�?;

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

// ── 上传自定义技�?───────────────────────────

async function handleUploadSkill() {
  const name = await dlgPrompt("技能名称（英文，如 my-skill）：", { title: "新建技�?, placeholder: "my-skill" });
  if (!name || !name.trim()) return;
  const desc = (await dlgPrompt("技能描述：", { title: "新建技�?, value: name.trim(), textarea: true })) || name.trim();

  // 创建文件选择�?  const input = document.createElement("input");
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
        showToast(t("技�?{name} 上传成功", { name }));
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

// ── 导入 SKILL.md 技能（本地路径�?────────────────

async function handleImportSkill() {
  const path = await dlgPrompt("输入本地路径（包�?SKILL.md 的目录，或单�?.md 文件）：", { title: "导入技�?, placeholder: "D:\\skills\\my-skill" });
  if (!path || !path.trim()) return;
  const name = (await dlgPrompt("技能名称（留空则自动取目录/文件名）�?, { title: "导入技�? })) || "";

  try {
    const res = await post("/skills/import", { path: path.trim(), name });
    if (res.code === 0) {
      showToast(t("技�?{name} 导入成功（{n} 个文件）", { name: res.data.skill, n: res.data.files }));
      refreshSkills();
    } else {
      showToast(t("导入失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    showToast(t("导入失败: {msg}", { msg: e.message }));
  }
}

// ── 刷新技能列�?─────────────────────────────

async function refreshSkills() {
  const res = await get("/skills");
  if (res.code === 0) {
    setSkills(res.data);
  }
}

// ── 初始�?───────────────────────────────────

function initSkillPanel() {
  skillList = document.getElementById("skill-list");
  btnUpload = document.getElementById("btn-upload-skill");
  btnImport = document.getElementById("btn-import-skill");
  skillModal = document.getElementById("skill-modal");
  skillModalTitle = document.getElementById("skill-modal-title");
  skillParams = document.getElementById("skill-params");
  skillResult = document.getElementById("skill-result");
  btnRunSkill = document.getElementById("btn-run-skill");

  btnUpload.addEventListener("click", handleUploadSkill);
  btnImport.addEventListener("click", handleImportSkill);
  btnRunSkill.addEventListener("click", executeSkill);

  // 关闭弹窗
  skillModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => skillModal.classList.add("hidden"));
  });

  subscribe("skills", renderSkillList);

  // 加载技能列�?  refreshSkills();
}

export { initSkillPanel, refreshSkills };
