/**
 * 砚 记忆与素材管理
 * 长期记忆的 CRUD、AI 自动提取、用户资料编辑、素材收藏的归口
 */

import {
  state, subscribe,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  getModelKey,
} from "../store.js?v=20260730-22";
import { get, post, del, patch, streamChat } from "../services/api.js?v=20260730-22";

let memoryModal, snippetModal;
let memoryList, snippetList;
let memoryTabs, memoryTabContents;

const CATEGORY_LABELS = {
  preference: "偏好",
  decision: "决策",
  project: "项目",
  term: "术语",
  fact: "事实",
  general: "通用",
  other: "其他",
};

// ── 记忆列表渲染 ─────────────────────────────────────────────────────────────

function renderMemoryList() {
  if (!memoryList) return;
  memoryList.innerHTML = "";

  if (state.memories.length === 0) {
    memoryList.innerHTML = '<div class="memory-empty">暂无记忆项目<br><small>点击"添加记忆"或"从对话提取"</small></div>';
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
    content.addEventListener("dblclick", () => {
      const newText = prompt("编辑记忆内容：", mem.content);
      if (newText !== null && newText.trim()) {
        updateMemory(mem.id, { content: newText.trim() });
      }
    });
    item.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "memory-item-actions";

    const editBtn = document.createElement("button");
    editBtn.textContent = "✎";
    editBtn.title = "编辑分类";
    editBtn.addEventListener("click", () => {
      const cats = Object.keys(CATEGORY_LABELS).join(", ");
      const newCat = prompt(`编辑分类（可选: ${cats}）：`, mem.category);
      if (newCat !== null && newCat.trim()) {
        updateMemory(mem.id, { category: newCat.trim() });
      }
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.title = "删除";
    delBtn.addEventListener("click", async () => {
      removeMemory(mem.id);
      try { await del(`/chat/memories/${mem.id}`); } catch (e) {}
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    memoryList.appendChild(item);
  }
}

// ── 从对话提取记忆 ───────────────────────────────────────────────────────────

async function extractMemoriesFromConversation() {
  if (state.messages.length < 2) {
    const { toast } = await import("../app.js?v=20260730-22");
    toast("对话内容太少，无法提取记忆");
    return;
  }

  const { toast } = await import("../app.js?v=20260730-22");
  toast("正在分析对话内容…");

  // 构建对话文本
  const dialogText = state.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `[${m.role === "user" ? "用户" : "助手"}]: ${m.content}`)
    .join("\n");

  try {
    // 获取提取提示词
    const res = await post("/chat/extract-memories", {
      text: dialogText,
      existing_memories: state.memories.map(m => ({ category: m.category, content: m.content })),
    });

    if (res.code !== 0) {
      toast("提取失败: " + (res.message || "未知错误"));
      return;
    }

    const modelId = state.currentModel?.id || "gpt-4o";
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
    let addedCount = 0;

    for (const mem of memories) {
      if (mem.content && mem.content.trim()) {
        const newMem = {
          category: mem.category || "general",
          content: mem.content.trim(),
        };
        addMemory(newMem);
        // 同步到后端
        post("/chat/memories", newMem).catch(() => {});
        addedCount++;
      }
    }

    toast(`成功提取 ${addedCount} 条记忆`);
  } catch (e) {
    console.error("提取记忆失败:", e);
    toast("提取失败: " + e.message);
  }
}

// ── 手动添加记忆 ─────────────────────────────────────────────────────────────

function showAddMemoryDialog() {
  const content = prompt("请输入记忆内容：");
  if (!content || !content.trim()) return;

  const cats = Object.keys(CATEGORY_LABELS).join(", ");
  const category = prompt(`选择分类（可选: ${cats}）：`, "general") || "general";

  const mem = { category: category.trim(), content: content.trim() };
  addMemory(mem);
  post("/chat/memories", mem).catch(() => {});
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
    snippetList.innerHTML = '<div class="snippet-empty">暂无素材<br><small>在对话中的消息上点击 ⧉ 按钮收藏素材</small></div>';
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
    source.textContent = snip.source ? `来源: ${snip.source}` : new Date(snip.createdAt).toLocaleDateString();
    meta.appendChild(source);

    const actions = document.createElement("div");
    actions.className = "snippet-item-actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "⧉";
    copyBtn.title = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(snip.text);
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
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

// ── 标签页切换 ───────────────────────────────────────────────────────────────

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
    });
  });
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

function initMemoryPanel() {
  memoryModal = document.getElementById("memory-modal");
  snippetModal = document.getElementById("snippet-modal");
  memoryList = document.getElementById("memory-list");
  snippetList = document.getElementById("snippet-list");

  if (!memoryModal || !snippetModal) return;

  initMemoryTabs();
  memoryModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => memoryModal.classList.add("hidden"));
  });
  snippetModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => snippetModal.classList.add("hidden"));
  });

  // 绑定按钮事件
  const btnAddMemory = document.getElementById("btn-add-memory");
  const btnExtractMemory = document.getElementById("btn-extract-memory");
  const btnSaveProfile = document.getElementById("btn-save-profile");
  const btnResetProfile = document.getElementById("btn-reset-profile");

  if (btnAddMemory) btnAddMemory.addEventListener("click", showAddMemoryDialog);
  if (btnExtractMemory) btnExtractMemory.addEventListener("click", extractMemoriesFromConversation);
  if (btnSaveProfile) btnSaveProfile.addEventListener("click", () => {
    saveProfileFromForm();
    import("../app.js?v=20260730-22").then(({ toast }) => toast("资料已保存"));
  });
  if (btnResetProfile) btnResetProfile.addEventListener("click", () => {
    if (confirm("确定要重置用户资料吗？")) {
      resetUserProfile();
      loadProfileToForm();
    }
  });

  // 素材的添加按钮
  const btnAddSnippet = document.getElementById("btn-add-snippet");
  if (btnAddSnippet) btnAddSnippet.addEventListener("click", () => {
    const text = prompt("粘贴或输入提示词素材：");
    if (text && text.trim()) {
      const snip = { text: text.trim(), source: "手动添加" };
      addPromptSnippet(snip);
      post("/chat/snippets", snip).catch(() => {});
    }
  });

  // 监听状态变化
  subscribe("memories", renderMemoryList);
  subscribe("userProfile", loadProfileToForm);
  subscribe("promptSnippets", renderSnippetList);

  // 初始渲染
  renderMemoryList();
  renderSnippetList();
}

// ── 打开弹窗 ─────────────────────────────────────────────────────────────────

function openMemoryModal() {
  if (!memoryModal) memoryModal = document.getElementById("memory-modal");
  loadProfileToForm();
  renderMemoryList();
  memoryModal.classList.remove("hidden");
}

function openSnippetModal() {
  if (!snippetModal) snippetModal = document.getElementById("snippet-modal");
  renderSnippetList();
  snippetModal.classList.remove("hidden");
}

export { initMemoryPanel, openMemoryModal, openSnippetModal, renderMemoryList, renderSnippetList };
