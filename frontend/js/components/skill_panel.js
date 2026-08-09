/**
 * SLATE MCP / 技能面板：MCP 内置工具列表 + SKILL.md 技能（上传/导入/删除）
 */

import { state, subscribe, setSkills } from "../store.js?v=20260808-23";
import { get, post, del, upload } from "../services/api.js?v=20260808-23";
import { guardSkillParams } from "../services/riskguard.js?v=20260808-23";

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

// ── 技能参数定义 ─────────────────────────────

const SKILL_PARAM_DEFS = {
  file_tree: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
  ],
  file_peek: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "C:\\path\\to\\file.js" },
    { key: "lines", label: "行数（≤50）", type: "number", placeholder: "30" },
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
    { key: "description", label: "样式描述", type: "text", placeholder: "高对比度代码编辑器风格" },
    { key: "component", label: "组件类型", type: "text", placeholder: "page / card / button / nav / form / code" },
  ],
  doc_write: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目技术文档" },
    { key: "doc_type", label: "文档类型", type: "text", placeholder: "technical / requirement / api / readme / changelog" },
    { key: "sections", label: "章节（逗号分隔）", type: "text", placeholder: "概述,安装,配置,API" },
    { key: "content_hint", label: "内容提示", type: "textarea", placeholder: "关键信息或要点" },
  ],
  file_edit: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/app.js" },
    { key: "edits", label: "编辑操作（JSON 数组）", type: "textarea", placeholder: '[{"old_text": "原内容", "new_text": "新内容"}]' },
  ],
  file_create: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/new_file.js" },
    { key: "content", label: "文件内容", type: "textarea", placeholder: "文件内容..." },
  ],
  text_summarize: [
    { key: "text", label: "文本", type: "textarea", placeholder: "粘贴要总结的文本" },
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
    { key: "text", label: "测试文本", type: "textarea", placeholder: "输入用于测试的文本" },
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
};

// ── 列表渲染：MCP 工具区 + SKILL.md 技能区 ────────────

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

  // Skill 支持删除；MCP 内置工具不可删
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
    if (kind === "MCP") openSkillModal(name, false);
    else openSkillViewer(name);
  });
  return item;
}

async function handleDeleteSkill(name) {
  if (!confirm(`确定删除技能 ${name}？`)) return;
  try {
    const res = await del(`/skills/${encodeURIComponent(name)}`);
    showToast(res.code === 0 ? `已删除技能 ${name}` : `删除失败: ${res.message}`);
    if (res.code === 0) refreshSkills();
  } catch (e) {
    showToast(`删除失败: ${e.message}`);
  }
}

// ── MCP 工具执行弹窗 ─────────────────────────────

let currentSkillName = "";

function openSkillModal(name) {
  currentSkillName = name;
  skillModalTitle.textContent = `执行 MCP 工具: ${name}`;
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
  skillModalTitle.textContent = `技能: ${name}`;
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
      skillResult.textContent = `读取失败: ${res.message || "未知错误"}`;
    }
  } catch (e) {
    skillResult.textContent = `请求失败: ${e.message}`;
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
    } else {
      skillResult.textContent = `错误: ${res.message}`;
    }
  } catch (e) {
    skillResult.classList.remove("hidden");
    skillResult.textContent = `请求失败: ${e.message}`;
  }

  btnRunSkill.disabled = false;
  btnRunSkill.textContent = "执行";
}

// ── 上传自定义技能 ───────────────────────────

function handleUploadSkill() {
  const name = prompt("技能名称（英文，如 my-skill）：");
  if (!name) return;
  const desc = prompt("技能描述：") || name;

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
    formData.append("skill_name", name);
    formData.append("skill_desc", desc);

    try {
      const res = await upload(`/skills/upload?skill_name=${encodeURIComponent(name)}&skill_desc=${encodeURIComponent(desc)}`, formData);
      if (res.code === 0) {
        showToast(`技能 ${name} 上传成功`);
        refreshSkills();
      } else {
        showToast(`上传失败: ${res.message}`);
      }
    } catch (e) {
      showToast(`上传失败: ${e.message}`);
    }
  });

  input.click();
}

// ── 导入 SKILL.md 技能（本地路径） ────────────────

async function handleImportSkill() {
  const path = prompt("输入本地路径（包含 SKILL.md 的目录，或单个 .md 文件）：");
  if (!path || !path.trim()) return;
  const name = prompt("技能名称（留空则自动取目录/文件名）：") || "";

  try {
    const res = await post("/skills/import", { path: path.trim(), name });
    if (res.code === 0) {
      showToast(`技能 ${res.data.skill} 导入成功（${res.data.files} 个文件）`);
      refreshSkills();
    } else {
      showToast(`导入失败: ${res.message}`);
    }
  } catch (e) {
    showToast(`导入失败: ${e.message}`);
  }
}

// ── 刷新技能列表 ─────────────────────────────

async function refreshSkills() {
  const res = await get("/skills");
  if (res.code === 0) {
    setSkills(res.data);
  }
}

// ── 初始化 ───────────────────────────────────

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

  // 加载技能列表
  refreshSkills();
}

export { initSkillPanel, refreshSkills };
