/**
 * 首记忆与素材管首 * 长期记忆首CRUD、AI 自动提取、用户资料编辑、素材收藏的归口
 */

import {
  state, subscribe,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  getModelKey,
  savePersistent,
} from "../store.js?v=20260818-75";
import { get, post, del, patch, streamChat } from "../services/api.js?v=20260818-75";
import { dlgConfirm, dlgPrompt } from "../services/dialog.js?v=20260818-75";
import { t } from "../services/i18n.js?v=20260818-75";
import { initVaultPanel, openVaultPanel } from "./vault.js?v=20260818-75";

let memoryModal, snippetModal;
let memoryList, snippetList, knowledgeList, knowledgeSearchInput;
let memoryTabs, memoryTabContents;
let autoRefineRunning = false;
let lastAutoRefineAt = 0;
let memoryReindexDone = false;

const CATEGORY_LABELS = {
  // ── 模块级知识 ─────────────────────────────
  architecture: "架构",
  tech: "技术",
  convention: "规范",
  // ── 仓库级知识 ──────────────────────────────
  build: "构建",
  logging: "日志",
  config: "配置",
  // ── 记忆分类 ──────────────────────────────
  preference: "偏好",
  decision: "决策",
  project: "项目",
  term: "术语",
  fact: "事实",
  general: "通用",
  other: "其他",
};

/** 分类分组（用于下拉选项展示） */
const CATEGORY_GROUPS = [
  { label: "模块级知识", items: [
    { value: "architecture", label: "架构" },
    { value: "tech", label: "技术" },
    { value: "convention", label: "规范" },
  ]},
  { label: "仓库级知识", items: [
    { value: "build", label: "构建" },
    { value: "logging", label: "日志" },
    { value: "config", label: "配置" },
  ]},
  { label: "记忆分类", items: [
    { value: "preference", label: "偏好" },
    { value: "decision", label: "决策" },
    { value: "project", label: "项目" },
    { value: "term", label: "术语" },
    { value: "fact", label: "事实" },
    { value: "general", label: "通用" },
    { value: "other", label: "其他" },
  ]},
];

/** 分类下拉选项（应用内对话框用，替代手敲枚举值） */
const CATEGORY_OPTIONS = CATEGORY_GROUPS.flatMap(g =>
  g.items.map(item => ({ value: item.value, label: `[${g.label}] ${item.label}` }))
);

// ── 记忆列表渲染 ─────────────────────────────────────────────────────────────

function renderMemoryList() {
  if (!memoryList) return;
  memoryList.innerHTML = "";

  if (state.memories.length === 0) {
    memoryList.innerHTML = '<div class="memory-empty">暂无记忆项目<br><small>点击"添加记忆"首从对话提示</small></div>';
    return;
  }

  for (const mem of state.memories) {
    const item = document.createElement("div");
    item.className = "memory-item";
    item.dataset.id = mem.id;

    const cat = document.createElement("span");
    cat.className = "memory-item-category";
    cat.textContent = CATEGORY_LABELS[mem.category] || mem.category || "通用";
    item.appendChild(cat);

    const content = document.createElement("div");
    content.className = "memory-item-content";
    content.textContent = mem.content;
    content.addEventListener("dblclick", async () => {
      const newText = await dlgPrompt("编辑记忆内容：, { title: "编辑记忆", value: mem.content, textarea: true });
      if (newText !== null && newText.trim()) {
        updateMemory(mem.id, { content: newText.trim() });
        patch(`/chat/memories/${mem.id}`, { content: newText.trim() }).catch(() => {});
        indexMemoryInKnowledge({ ...mem, content: newText.trim() });
      }
    });
    item.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "memory-item-actions";

    const editBtn = document.createElement("button");
    editBtn.textContent = "首;
    editBtn.title = "编辑分类";
    editBtn.addEventListener("click", async () => {
      const known = CATEGORY_OPTIONS.some(o => o.value === mem.category);
      const options = known ? CATEGORY_OPTIONS : [{ value: mem.category, label: mem.category }, ...CATEGORY_OPTIONS];
      const newCat = await dlgPrompt("编辑分类：, { title: "编辑分类", options, value: mem.category });
      if (newCat !== null && newCat.trim()) {
        updateMemory(mem.id, { category: newCat.trim() });
        patch(`/chat/memories/${mem.id}`, { category: newCat.trim() }).catch(() => {});
        indexMemoryInKnowledge({ ...mem, category: newCat.trim() });
      }
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "首;
    delBtn.title = "删除";
    delBtn.addEventListener("click", async () => {
      removeMemory(mem.id);
      try { await del(`/chat/memories/${mem.id}`); } catch (e) {}
      try { await del(`/knowledge/docs/memory:${mem.id}`); } catch (e) {}
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    memoryList.appendChild(item);
  }
}

// ── 从对话提取记首───────────────────────────────────────────────────────────

async function extractMemoriesFromConversation() {
  if (state.messages.length < 2) {
    const { toast } = await import("../app.js?v=20260818-75");
    toast("对话内容太少，无法提取记忆);
    return;
  }

  const { toast } = await import("../app.js?v=20260818-75");
  toast("正在分析对话内容…);

  // 构建对话文本
  const dialogText = state.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `[${m.role === "user" ? "用户" : "助手"}]: ${m.content}`)
    .join("\n");

  try {
    // 获取提取提示首
    const res = await post("/chat/extract-memories", {

      text: dialogText,
      existing_memories: state.memories.map(m => ({ id: m.id, category: m.category, content: m.content })),
    });

    if (res.code !== 0) {
      toast(t("提取失败: {msg}", { msg: res.message || t("未知错误") }));
      return;
    }

    const modelId = state.currentModel?.id || "gpt-5.6-terra";
    const apiKey = getModelKey(modelId);
    const baseUrl = state.currentModel?.base_url || undefined;

    // 调用 LLM 提取
    let result = "";
    for await (const chunk of streamChat({
      model: modelId,
      messages: [{ role: "user", content: res.data.prompt }],
      api_key: apiKey,
      base_url: baseUrl,
      temperature: 0.3,
      max_tokens: 1024,
      stream: true,
    })) {
      result += chunk;
    }

    // 解析 JSON
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      toast("未能提取有效记忆");
      return;
    }

    const memories = JSON.parse(jsonMatch[0]);
    let addedCount = 0, overwrittenCount = 0, deletedCount = 0;

    for (const mem of memories) {
      const action = mem.action || "add";
      const content = String(mem?.content || "").trim();
      const targetId = String(mem?.target_id || "").trim();

      if (action === "delete" && targetId) {
        const exists = state.memories.find(m => m.id === targetId);
        if (exists) {
          removeMemory(targetId);
          del(`/chat/memories/${targetId}`).catch(() => {});
          del(`/knowledge/docs/memory:${targetId}`).catch(() => {});
          deletedCount++;
        }
        continue;
      }

      if (action === "overwrite" && targetId && content) {
        const exists = state.memories.find(m => m.id === targetId);
        if (exists) {
          updateMemory(targetId, { category: mem.category || exists.category, content });
          patch(`/chat/memories/${targetId}`, { category: mem.category || exists.category, content }).catch(() => {});
          indexMemoryInKnowledge({ id: targetId, category: mem.category || exists.category, content });
          overwrittenCount++;
        }
        continue;
      }

      if (content) {
        const newMem = { category: mem.category || "general", content };
        const saved = addMemory(newMem);
        post("/chat/memories", { id: saved.id, category: saved.category, content: saved.content }).catch(() => {});
        indexMemoryInKnowledge(saved);
        addedCount++;
      }
    }

    let msg = "";
    if (addedCount) msg += t("新增 {n} 条", { n: addedCount });
    if (overwrittenCount) msg += (msg ? "，" : "") + t("覆盖 {n} 条", { n: overwrittenCount });
    if (deletedCount) msg += (msg ? "，" : "") + t("删除 {n} 条", { n: deletedCount });
    toast(msg || t("未提取到有效记忆"));
  } catch (e) {
    console.error("提取记忆失败:", e);
    toast(t("提取失败: {msg}", { msg: e.message }));
  }
}

function buildMemoryProfilePrompt(dialogText) {
  const recentMemories = state.memories
    .slice(-40);
  const existingMemories = recentMemories
    .map((m, i) => `#${i + 1} [${m.category || "general"}] ${m.content || ""} (id:${m.id})`)
    .join("\n");
  const profile = state.userProfile || {};
  return `请分析以下最近对话，自主提炼可以长期保留的信息首
你需要同时更新两类内容：
1. 长期记忆：稳定、可复用、以后会影响协作的信息，例如用户偏好、项目背景、重要决策、常用术语、明确约束首2. 用户画像：用户的角色、工作风格、技术栈、协作习惯、其他长期偏好首
严格规则首- 只保留长期有价值的信息，不要记录一次性任务、临时状态、寒暄、工具结果、纯代码输出首- 不要重复已有记忆首- 不要编造用户没有表达过的信息
- 如果对话中用户明确修正、推翻、或废弃了某条已有记忆，用 overwrite 或 delete 动作处理（用 target_id 指定记忆 id）
- 如果没有新增内容，memories 输出空数组
- profile 只输出需要新增或修正的字段；不确定就省略
- 只输出 JSON，不要 Markdown，不要解释
输出格式：
{
  "memories": [
    {"action":"add","category":"preference|decision|project|term|fact|other","content":"..."},
    {"action":"overwrite","target_id":"记忆id","category":"...","content":"更新后的内容"},
    {"action":"delete","target_id":"记忆id","reason":"简要原因"}
  ],
  "profile": {
    "role": "",
    "style": "",
    "techStack": "",
    "habits": "",
    "custom": ""
  }
}

已有记忆首${existingMemories || "首}

当前用户画像首${JSON.stringify(profile, null, 2)}

最近对话：
${dialogText.slice(-7000)}`;
}

function normalizeProfilePatch(profile) {
  const patch = {};
  for (const key of ["role", "style", "techStack", "habits", "custom"]) {
    const value = String(profile?.[key] || "").trim();
    if (value) patch[key] = value;
  }
  return patch;
}

function isDuplicateMemory(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (!normalized) return true;
  return state.memories.some(mem => String(mem.content || "").trim().toLowerCase() === normalized);
}

async function indexMemoryInKnowledge(memory) {
  const content = String(memory?.content || "").trim();
  if (!content) return;
  try {
    await post("/knowledge/docs", {
      id: `memory:${memory.id}`,
      title: `长期记忆 · ${memory.category || "general"}`,
      source: "long-term-memory",
      kind: "memory",
      content,
      metadata: { memory_id: memory.id, category: memory.category || "general" },
    });
  } catch (e) {}
}

async function autoRefineMemoryAndProfile({ silent = true } = {}) {
  if (autoRefineRunning) return { added: 0, overwritten: 0, deleted: 0, profileUpdated: false };
  if (Date.now() - lastAutoRefineAt < 45000) return { added: 0, overwritten: 0, deleted: 0, profileUpdated: false };
  const visibleMessages = state.messages.filter(m => !m.hidden && (m.role === "user" || m.role === "assistant"));
  if (visibleMessages.length < 4) return { added: 0, overwritten: 0, deleted: 0, profileUpdated: false };

  const modelId = state.currentModel?.id;
  if (!modelId) return { added: 0, overwritten: 0, deleted: 0, profileUpdated: false };
  const apiKey = getModelKey(modelId);
  if (!apiKey && modelId !== "local") return { added: 0, profileUpdated: false };

  const recent = visibleMessages.slice(-8)
    .map(m => `[${m.role === "user" ? "用户" : "助手"}]: ${String(m.content || "").slice(0, 1600)}`)
    .join("\n\n");

  autoRefineRunning = true;
  lastAutoRefineAt = Date.now();
  try {
    const baseUrl = state.currentModel?.base_url || undefined;
    let result = "";
    for await (const chunk of streamChat({
      model: modelId,
      messages: [{ role: "user", content: buildMemoryProfilePrompt(recent) }],
      api_key: apiKey,
      base_url: baseUrl,
      temperature: 0.2,
      max_tokens: 1200,
      stream: true,
    })) {
      result += chunk;
    }

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { added: 0, profileUpdated: false };
    const parsed = JSON.parse(jsonMatch[0]);
    let added = 0, overwritten = 0, deleted = 0;
    for (const mem of Array.isArray(parsed.memories) ? parsed.memories : []) {
      const action = mem.action || "add";
      const content = String(mem?.content || "").trim();
      const targetId = String(mem?.target_id || "").trim();

      if (action === "delete" && targetId) {
        const exists = state.memories.find(m => m.id === targetId);
        if (exists) {
          removeMemory(targetId);
          del(`/chat/memories/${targetId}`).catch(() => {});
          del(`/knowledge/docs/memory:${targetId}`).catch(() => {});
          deleted++;
        }
        continue;
      }

      if (action === "overwrite" && targetId && content) {
        const exists = state.memories.find(m => m.id === targetId);
        if (exists) {
          updateMemory(targetId, { category: mem.category || exists.category, content });
          patch(`/chat/memories/${targetId}`, { category: mem.category || exists.category, content }).catch(() => {});
          indexMemoryInKnowledge({ id: targetId, category: mem.category || exists.category, content });
          overwritten++;
        }
        continue;
      }

      // action === "add" (default)
      if (!content || isDuplicateMemory(content)) continue;
      const saved = addMemory({ category: mem.category || "general", content });
      post("/chat/memories", { id: saved.id, category: saved.category, content: saved.content }).catch(() => {});
      indexMemoryInKnowledge(saved);
      added++;
    }

    const patch = normalizeProfilePatch(parsed.profile);
    const profileUpdated = Object.keys(patch).length > 0;
    if (profileUpdated) setUserProfile(patch);
    if (!silent && (added || overwritten || deleted || profileUpdated)) {
      const { toast } = await import("../app.js?v=20260818-75");
      let msg = "";
      if (added) msg += t("新增 {n} 条", { n: added });
      if (overwritten) msg += (msg ? "，" : "") + t("覆盖 {n} 条", { n: overwritten });
      if (deleted) msg += (msg ? "，" : "") + t("删除 {n} 条", { n: deleted });
      if (profileUpdated) msg += (msg ? "，" : "") + t("更新画像");
      toast(msg || t("记忆已更新"));
    }
    return { added, overwritten, deleted, profileUpdated };
  } catch (e) {
    console.warn("自动提炼记忆失败:", e);
    return { added: 0, overwritten: 0, deleted: 0, profileUpdated: false, error: e.message };
  } finally {
    autoRefineRunning = false;
  }
}

// ── 手动添加记忆 ─────────────────────────────────────────────────────────────

async function showAddMemoryDialog() {
  const content = await dlgPrompt("请输入记忆内容：", { title: "添加记忆", textarea: true });
  if (!content || !content.trim()) return;

  const category = (await dlgPrompt("选择分类：, { title: "添加记忆", options: CATEGORY_OPTIONS, value: "general" })) || "general";

  const mem = { category: category.trim(), content: content.trim() };
  const saved = addMemory(mem);
  post("/chat/memories", { id: saved.id, category: saved.category, content: saved.content })
    .then(() => indexMemoryInKnowledge(saved))
    .catch(() => indexMemoryInKnowledge(saved));
}

function renderKnowledgeList(items = []) {
  if (!knowledgeList) return;
  knowledgeList.innerHTML = "";
  if (!items.length) {
    knowledgeList.innerHTML = '<div class="memory-empty">暂无知识条目<br><small>可以添加笔记、项目背景、资料摘录等长期可复用内容/small></div>';
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "knowledge-item";

    const head = document.createElement("div");
    head.className = "knowledge-item-head";
    const title = document.createElement("span");
    title.className = "knowledge-item-title";
    title.textContent = item.title || "未命名知识;
    const meta = document.createElement("span");
    meta.className = "knowledge-item-meta";
    meta.textContent = (item.kind || "note") + (item.chunk_count ? t(" · {n} 片段", { n: item.chunk_count }) : "") + (item.score ? ` · ${(item.score * 100).toFixed(0)}%` : "");
    head.appendChild(title);
    head.appendChild(meta);

    const body = document.createElement("div");
    body.className = "knowledge-item-content";
    body.textContent = (item.content || item.source || "").slice(0, 520);

    const actions = document.createElement("div");
    actions.className = "knowledge-item-actions";
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "×";
    delBtn.title = "删除";
    delBtn.addEventListener("click", async () => {
      if (!await dlgConfirm(t("删除知识「{title}」？", { title: item.title || item.id }), { danger: true, okText: "删除" })) return;
      await del(`/knowledge/docs/${item.doc_id || item.id}`);
      await loadKnowledgeDocs();
    });
    actions.appendChild(delBtn);

    row.appendChild(head);
    row.appendChild(body);
    row.appendChild(actions);
    knowledgeList.appendChild(row);
  }
}

async function loadKnowledgeDocs() {
  if (!knowledgeList) return;
  try {
    if (!memoryReindexDone) {
      memoryReindexDone = true;
      await post("/knowledge/reindex-memories", {});
    }
    const res = await get("/knowledge/docs");
    renderKnowledgeList(res.code === 0 ? (res.data || []) : []);
  } catch (e) {
    renderKnowledgeList([]);
  }
}

async function searchKnowledge() {
  const query = knowledgeSearchInput?.value.trim() || "";
  if (!query) {
    await loadKnowledgeDocs();
    return;
  }
  const res = await post("/knowledge/search", { query, limit: 12 });
  renderKnowledgeList(res.code === 0 ? (res.data || []) : []);
}

async function addKnowledgeDialog() {
  const title = await dlgPrompt("知识标题：, { title: "添加知识" });
  if (title === null) return;
  const content = await dlgPrompt("知识内容：, { title: "添加知识", textarea: true, rows: 8 });
  if (!content || !content.trim()) return;
  const res = await post("/knowledge/docs", {
    title: title.trim() || "未命名知识,
    source: "manual",
    kind: "note",
    content: content.trim(),
  });
  if (res.code === 0) {
    const { toast } = await import("../app.js?v=20260818-75");
    toast("知识已添加);
    await loadKnowledgeDocs();
  }
}

function loadKnowledgeSettingsToForm() {
  const enabled = document.getElementById("knowledge-enabled");
  const topK = document.getElementById("knowledge-topk");
  if (enabled) enabled.checked = state.knowledgeSettings?.enabled !== false;
  if (topK) topK.value = state.knowledgeSettings?.topK || 5;
}

function saveKnowledgeSettingsFromForm() {
  const enabled = document.getElementById("knowledge-enabled");
  const topK = document.getElementById("knowledge-topk");
  state.knowledgeSettings = {
    enabled: enabled ? enabled.checked : true,
    topK: Math.max(1, Math.min(12, parseInt(topK?.value) || 5)),
  };
  savePersistent();
}

// ── 用户资料 ─────────────────────────────────────────────────────────────────

function loadProfileToForm() {
  const p = state.userProfile;
  const el = (id) => document.getElementById(id);
  if (el("profile-role")) el("profile-role").value = p.role || "";
  if (el("profile-style")) el("profile-style").value = p.style || "";
  if (el("profile-tech")) el("profile-tech").value = p.techStack || "";
  if (el("profile-habits")) el("profile-habits").value = p.habits || "";
  if (el("profile-custom")) el("profile-custom").value = p.custom || "";
}

function saveProfileFromForm() {
  const el = (id) => document.getElementById(id);
  setUserProfile({
    role: el("profile-role")?.value.trim() || "",
    style: el("profile-style")?.value.trim() || "",
    techStack: el("profile-tech")?.value.trim() || "",
    habits: el("profile-habits")?.value.trim() || "",
    custom: el("profile-custom")?.value.trim() || "",
  });
}

// ── 素材列表渲染 ─────────────────────────────────────────────────────────────

function renderSnippetList() {
  if (!snippetList) return;
  snippetList.innerHTML = "";

  if (state.promptSnippets.length === 0) {
    snippetList.innerHTML = '<div class="snippet-empty">暂无素材<br><small>在对话中的消息上点击 首按钮收藏素材</small></div>';
    return;
  }

  for (const snip of state.promptSnippets) {
    const item = document.createElement("div");
    item.className = "snippet-item";

    const text = document.createElement("div");
    text.className = "snippet-item-text";
    text.textContent = snip.text;
    item.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "snippet-item-meta";

    const source = document.createElement("span");
    source.textContent = snip.source ? t("来源: {src}", { src: snip.source }) : new Date(snip.createdAt).toLocaleDateString();
    meta.appendChild(source);

    const actions = document.createElement("div");
    actions.className = "snippet-item-actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "首;
    copyBtn.title = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(snip.text);
        copyBtn.textContent = "首;
        setTimeout(() => { copyBtn.textContent = "首; }, 1200);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "首;
    delBtn.title = "删除";
    delBtn.addEventListener("click", async () => {
      removePromptSnippet(snip.id);
      try { await del(`/chat/snippets/${snip.id}`); } catch (e) {}
    });
    actions.appendChild(delBtn);

    meta.appendChild(actions);
    item.appendChild(meta);
    snippetList.appendChild(item);
  }
}

// ── 标签页切首───────────────────────────────────────────────────────────────

function initMemoryTabs() {
  memoryTabs = memoryModal.querySelectorAll(".memory-tab");
  memoryTabContents = memoryModal.querySelectorAll(".memory-tab-content");

  memoryTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      memoryTabs.forEach(t => t.classList.toggle("active", t === tab));
      memoryTabContents.forEach(c => {
        c.classList.toggle("active", c.id === `memory-tab-${target}`);
      });
      if (target === "vault") openVaultPanel();
    });
  });
}

// ── 初始首───────────────────────────────────────────────────────────────────

function initMemoryPanel() {
  memoryModal = document.getElementById("memory-modal");
  snippetModal = document.getElementById("snippet-modal");
  memoryList = document.getElementById("memory-list");
  snippetList = document.getElementById("snippet-list");
  knowledgeList = document.getElementById("knowledge-list");
  knowledgeSearchInput = document.getElementById("knowledge-search-input");

  if (!memoryModal || !snippetModal) return;

  initMemoryTabs();
  initVaultPanel();
  memoryModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => memoryModal.classList.add("hidden"));
  });
  snippetModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => snippetModal.classList.add("hidden"));
  });

  // 绑定按钮事件
  const btnAddMemory = document.getElementById("btn-add-memory");
  const btnExtractMemory = document.getElementById("btn-extract-memory");
  const btnAutoRefineMemory = document.getElementById("btn-auto-refine-memory");
  const btnSaveProfile = document.getElementById("btn-save-profile");
  const btnResetProfile = document.getElementById("btn-reset-profile");
  const btnSearchKnowledge = document.getElementById("btn-search-knowledge");
  const btnAddKnowledge = document.getElementById("btn-add-knowledge");

  if (btnAddMemory) btnAddMemory.addEventListener("click", showAddMemoryDialog);
  if (btnExtractMemory) btnExtractMemory.addEventListener("click", extractMemoriesFromConversation);
  if (btnAutoRefineMemory) btnAutoRefineMemory.addEventListener("click", () => autoRefineMemoryAndProfile({ silent: false }));
  if (btnSaveProfile) btnSaveProfile.addEventListener("click", () => {
    saveProfileFromForm();
    import("../app.js?v=20260818-75").then(({ toast }) => toast("资料已保存));
  });
  if (btnResetProfile) btnResetProfile.addEventListener("click", async () => {
    if (await dlgConfirm("确定要重置用户资料吗？, { danger: true, okText: "重置" })) {
      resetUserProfile();
      loadProfileToForm();
    }
  });
  if (btnSearchKnowledge) btnSearchKnowledge.addEventListener("click", searchKnowledge);
  if (knowledgeSearchInput) knowledgeSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchKnowledge();
  });
  if (btnAddKnowledge) btnAddKnowledge.addEventListener("click", addKnowledgeDialog);
  document.getElementById("knowledge-enabled")?.addEventListener("change", saveKnowledgeSettingsFromForm);
  document.getElementById("knowledge-topk")?.addEventListener("change", saveKnowledgeSettingsFromForm);

  // 素材的添加按首
  const btnAddSnippet = document.getElementById("btn-add-snippet");

  if (btnAddSnippet) btnAddSnippet.addEventListener("click", async () => {
    const text = await dlgPrompt("粘贴或输入提示词素材：, { title: "添加素材", textarea: true, rows: 6 });
    if (text && text.trim()) {
      const snip = { text: text.trim(), source: "手动添加" };
      addPromptSnippet(snip);
      post("/chat/snippets", snip).catch(() => {});
    }
  });

  // 监听状态变首
  subscribe("memories", renderMemoryList);

  subscribe("userProfile", loadProfileToForm);
  subscribe("promptSnippets", renderSnippetList);

  // 初始渲染
  renderMemoryList();
  renderSnippetList();
  loadKnowledgeSettingsToForm();
  loadKnowledgeDocs();
}

// ── 打开弹窗 ─────────────────────────────────────────────────────────────────

function openMemoryModal() {
  if (!memoryModal) memoryModal = document.getElementById("memory-modal");
  loadProfileToForm();
  renderMemoryList();
  loadKnowledgeSettingsToForm();
  loadKnowledgeDocs();
  memoryModal.classList.remove("hidden");
}

function openSnippetModal() {
  if (!snippetModal) snippetModal = document.getElementById("snippet-modal");
  renderSnippetList();
  snippetModal.classList.remove("hidden");
}


// ── 灵光（Spark）：对话结束时自动捕获技术洞察 ─────────────────

let sparkRunning = false;
let lastSparkAt = 0;

function buildSparkPrompt(recent) {
  return `分析以下对话，判断是否产生了值得长期保留的技术洞察。
只捕获真正有跨对话复用价值的内容：
- 重要的技术决策（选择了什么方案、为什么、权衡了什么）
- 问题的关键解决方案（尤其是非显而易见的修复方法）
- 可复用的代码模式或架构模式
- 关键配置或环境设置的发现
- 值得记住的工程经验教训

如果没有值得保留的洞察，输出空数组。不要捕获普通问答、闲聊、工具输出或临时调试。

输出 JSON 数组：
[{"title":"简明标题","content":"关键洞察内容（200字以内）","tags":["标签"],"category":"decision|solution|pattern|config|experience"}]

对话内容：
${recent}`;
}

async function captureConversationSpark() {
  if (sparkRunning) return;
  if (Date.now() - lastSparkAt < 120000) return;
  const visible = state.messages.filter(m =>
    !m.hidden && (m.role === "user" || m.role === "assistant")
  );
  if (visible.length < 6) return;

  const modelId = state.currentModel?.id;
  if (!modelId) return;
  const apiKey = getModelKey(modelId);
  if (!apiKey && modelId !== "local") return;

  sparkRunning = true;
  lastSparkAt = Date.now();

  try {
    const recent = visible.slice(-16)
      .map(m => `[${m.role === "user" ? "用户" : "助手"}]: ${String(m.content || "").slice(0, 1200)}`)
      .join("\n\n");

    const baseUrl = state.currentModel?.base_url || undefined;
    let result = "";
    for await (const chunk of streamChat({
      model: modelId,
      messages: [{ role: "user", content: buildSparkPrompt(recent) }],
      api_key: apiKey,
      base_url: baseUrl,
      temperature: 0.3,
      max_tokens: 1024,
      stream: true,
    })) {
      result += chunk;
    }

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    const insights = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(insights) || !insights.length) return;

    let count = 0;
    for (const insight of insights) {
      const title = String(insight.title || "").trim();
      const content = String(insight.content || "").trim();
      if (!title || !content) continue;

      const docId = `spark:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await post("/knowledge/docs", {
        title: `灵光 · ${title}`,
        source: "spark",
        kind: "spark",
        content,
        metadata: {
          tags: Array.isArray(insight.tags) ? insight.tags : [],
          category: insight.category || "decision",
        },
      }).catch(() => {});
      count++;
    }

    if (count > 0) {
      const { toast } = await import("../app.js?v=20260818-75");
      toast(t("已捕获 {n} 条灵光", { n: count }));
    }
  } catch (e) {
    console.warn("灵光捕获失败:", e);
  } finally {
    sparkRunning = false;
  }
}

export {
  initMemoryPanel,
  openMemoryModal,
  openSnippetModal,
  renderMemoryList,
  renderSnippetList,
  autoRefineMemoryAndProfile,
  captureConversationSpark,
};
