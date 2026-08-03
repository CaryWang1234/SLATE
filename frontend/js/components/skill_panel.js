/**
 * SLATE 技能面板：内置技能列表 + 自定义 Skill 上传
 */

import { state, subscribe, setSkills } from "../store.js?v=20260802-02";
import { get, post, upload } from "../services/api.js?v=20260802-02";

let skillList, btnUpload, skillModal, skillModalTitle, skillParams, skillResult, btnRunSkill;

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
};

// ── 技能列表渲染 ────────────────────────────

function renderSkillList() {
  skillList.innerHTML = "";

  // 内置技能
  const builtin = state.skills.builtin || {};
  for (const [name, desc] of Object.entries(builtin)) {
    skillList.appendChild(createSkillItem(name, desc, false));
  }

  // 自定义技能
  const custom = state.skills.custom || {};
  for (const [name, desc] of Object.entries(custom)) {
    skillList.appendChild(createSkillItem(name, desc, true));
  }
}

function createSkillItem(name, desc, isCustom) {
  const item = document.createElement("div");
  item.className = "skill-item";

  const info = document.createElement("div");
  const nameEl = document.createElement("div");
  nameEl.className = "skill-item-name";
  nameEl.textContent = name + (isCustom ? " ✦" : "");
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = desc;
  info.appendChild(nameEl);
  info.appendChild(descEl);
  item.appendChild(info);

  item.addEventListener("click", () => openSkillModal(name, isCustom));
  return item;
}

// ── 技能执行弹窗 ─────────────────────────────

let currentSkillName = "";

function openSkillModal(name, isCustom) {
  currentSkillName = name;
  skillModalTitle.textContent = `执行: ${name}`;
  skillParams.innerHTML = "";
  skillResult.classList.add("hidden");
  skillResult.textContent = "";

  if (isCustom) {
    // 自定义技能没有预定义参数
    const label = document.createElement("label");
    label.textContent = "参数（JSON 格式）";
    const input = document.createElement("textarea");
    input.id = "skill-param-custom";
    input.rows = 4;
    input.placeholder = '{"key": "value"}';
    skillParams.appendChild(label);
    skillParams.appendChild(input);
  } else {
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
  }

  skillModal.classList.remove("hidden");
}

async function executeSkill() {
  const params = {};

  if (SKILL_PARAM_DEFS[currentSkillName]) {
    for (const def of SKILL_PARAM_DEFS[currentSkillName]) {
      const el = document.getElementById(`skill-param-${def.key}`);
      if (el) {
        params[def.key] = def.type === "number" ? parseInt(el.value) || 0 : el.value;
      }
    }
  } else {
    // 自定义技能
    const el = document.getElementById("skill-param-custom");
    if (el && el.value.trim()) {
      try {
        Object.assign(params, JSON.parse(el.value));
      } catch (e) {
        showToast("参数格式错误，请输入有效的 JSON");
        return;
      }
    }
  }

  btnRunSkill.disabled = true;
  btnRunSkill.textContent = "执行中…";

  try {
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
  skillModal = document.getElementById("skill-modal");
  skillModalTitle = document.getElementById("skill-modal-title");
  skillParams = document.getElementById("skill-params");
  skillResult = document.getElementById("skill-result");
  btnRunSkill = document.getElementById("btn-run-skill");

  btnUpload.addEventListener("click", handleUploadSkill);
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
