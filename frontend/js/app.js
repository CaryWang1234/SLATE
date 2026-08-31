/**
 * SLATE 主控 v4：AI 团队、文件上传、上下文压缩
 */

import { state, subscribe, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel, setModelRegistry, loadPersistent, loadSharedPersistent, savePersistent, toggleTheme, resetUsage } from "./store.js?v=20260830-003";
import { initI18n, t } from "./services/i18n.js?v=20260830-003";
import { iconSvgEl } from "./services/icons.js?v=20260830-003";
import { get, post, put } from "./services/api.js?v=20260830-003";
import { dlgConfirm } from "./services/dialog.js?v=20260830-003";
import { fmtTokens, tokenEquivalence } from "./services/usage.js?v=20260830-003";
import { initChat, refreshConversationList } from "./components/chat.js?v=20260830-003";
import { initWhiteboard, refreshWhiteboard } from "./components/whiteboard.js?v=20260830-003";
import { initPromptFactory } from "./components/prompt_factory.js?v=20260830-003";
import { initSkillPanel } from "./components/skill_panel.js?v=20260830-003";
import { initMcpServerPanel } from "./components/mcp_server_panel.js?v=20260830-003";
import { initTeamPanel } from "./components/team.js?v=20260830-003";
import { initProjectBar } from "./components/project_bar.js?v=20260830-003";
import { initMemoryPanel } from "./components/memory.js?v=20260830-003";
import { initExpertsPanel } from "./components/experts.js?v=20260830-003";
import { initSchedule } from "./components/schedule.js?v=20260830-003";
import { initRiskGuard } from "./services/riskguard.js?v=20260830-003";
import { initUnderstandPanel } from "./components/understand.js?v=20260830-003";
import { getCurrentProject, browseFiles } from "./services/project.js?v=20260830-003";
import { setProject, setProjectFileTree } from "./store.js?v=20260830-003";

// ── Toast 通知 ──────────────────────────────

let activePanelName = "chat";

function toast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}

function switchPanel(panelName) {
  activePanelName = panelName || "chat";
  document.querySelectorAll(".tab-btn").forEach(t => {
    t.classList.toggle("active", t.dataset.panel === activePanelName);
  });
  document.querySelectorAll(".panel").forEach(el => {
    el.classList.toggle("active", el.id === `panel-${activePanelName}`);
  });
  if (activePanelName === "whiteboard") {
    requestAnimationFrame(() => refreshWhiteboard());
  }
}

function safeInit(name, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    console.error(`[SLATE] ${name} 初始化失败`, e);
    toast(t("{name} 初始化失败，请查看控制台", { name }));
    return false;
  }
}

// ── 模型选择 ──────────────────────────────

const MODEL_GROUP_LABELS = {
  international: "国际模型",
  domestic: "国产模型",
  local: "本地模型",
};

const MODEL_ICON_MAP = {
  openai: "./images/gpt.svg",
  anthropic: "./images/claude.svg",
  google: "./images/gemini.svg",
  deepseek: "./images/deepseek.svg",
  moonshot: "./images/kimi.svg",
  qwen: "./images/qwen.svg",
  zhipu: "./images/glm.svg",
  doubao: "./images/doubao.svg",
  ernie: "./images/ernie.svg",
  minimax: "./images/minimax.svg",
};

function getModelIconUrl(model) {
  if (!model) return "";
  const id = (model.id || "").toLowerCase();
  const baseUrl = (model.base_url || "").toLowerCase();

  if (id.includes("gpt") || baseUrl.includes("openai.com")) return MODEL_ICON_MAP.openai;
  if (id.includes("claude") || baseUrl.includes("anthropic")) return MODEL_ICON_MAP.anthropic;
  if (id.includes("gemini") || baseUrl.includes("googleapis")) return MODEL_ICON_MAP.google;
  if (id.includes("deepseek") || baseUrl.includes("deepseek")) return MODEL_ICON_MAP.deepseek;
  if (id.includes("kimi") || baseUrl.includes("moonshot")) return MODEL_ICON_MAP.moonshot;
  if (id.includes("qwen") || baseUrl.includes("dashscope")) return MODEL_ICON_MAP.qwen;
  if (id.includes("glm") || baseUrl.includes("bigmodel")) return MODEL_ICON_MAP.zhipu;
  if (id.includes("doubao") || baseUrl.includes("volces")) return MODEL_ICON_MAP.doubao;
  if (id.includes("ernie") || baseUrl.includes("baidubce")) return MODEL_ICON_MAP.ernie;
  if (id.includes("minimax") || baseUrl.includes("minimax")) return MODEL_ICON_MAP.minimax;
  return "";
}

function updateModelIcon(model) {
  const iconEl = document.getElementById("model-icon");
  if (!iconEl) return;
  const url = getModelIconUrl(model);
  if (url) {
    iconEl.src = url;
    iconEl.style.display = "";
  } else {
    iconEl.style.display = "none";
  }
}

function modelNeedsKey(model) {
  return model?.id !== "local";
}

function formatModelOption(model) {
  const hasKey = !modelNeedsKey(model) || hasModelKey(model.id);
  const status = hasKey ? "●" : "○";
  return `${status} ${model.name || model.id}`;
}

function populateModelSelect() {
  const select = document.getElementById("model-select");
  select.innerHTML = '<option value="">选择模型…</option>';

  for (const [cat, label] of Object.entries(MODEL_GROUP_LABELS)) {
    const models = state.modelRegistry[cat];
    if (!models || models.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = `${t(label)} (${models.length})`;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = formatModelOption(m);
      opt.title = [
        m.name || m.id,
        m.id,
        m.base_url,
        m.supports_responses === true ? "可在设置中启用 Responses API" : "",
        modelNeedsKey(m) ? (hasModelKey(m.id) ? "API Key 已配置" : "API Key 未配置") : "本地模型",
      ].filter(Boolean).join(" · ");
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // 自定义模型
  if (state.customModels.length > 0) {

    const optgroup = document.createElement("optgroup");
    optgroup.label = t("自定义");
    for (const m of state.customModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = formatModelOption({ ...m, provider: m.provider || "custom" });
      opt.title = [
        m.name || m.id,
        m.id,
        m.base_url,
        hasModelKey(m.id) ? "API Key 已配置" : "API Key 未配置",
      ].filter(Boolean).join(" · ");
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "+ 自定义模型…";
  select.appendChild(customOpt);

  if (state.currentModel) select.value = state.currentModel.id;
  updateModelIcon(state.currentModel);
}

function getAllModels() {
  const allModels = [];
  for (const models of Object.values(state.modelRegistry)) {
    allModels.push(...models);
  }
  allModels.push(...state.customModels);
  return allModels;
}

function populateAutoReviewModelSelect() {
  const select = document.getElementById("setting-auto-review-model");
  if (!select) return;
  const currentValue = state.autoReview?.modelId || "";
  select.innerHTML = '<option value="">跟随当前主模型</option>';
  for (const m of getAllModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    select.appendChild(opt);
  }
  select.value = currentValue;
}

function handleModelSelect(e) {
  const value = e.target.value;
  if (!value) return;
  if (value === "__custom__") {
    openCustomModelModal();
    e.target.value = state.currentModel?.id || "";
    return;
  }

  // 在所有分类中查找
  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === value);
    if (found) {
      updateModelIcon(found);
      if (!hasModelKey(found.id) && found.id !== "local") {
        // 没有 API key，弹出输入
        openKeyInputModal(found);

      } else {
        setCurrentModel(found);
        resetUsage();
        toast(t("已切换: {name}", { name: found.name }));
      }
      return;
    }
  }

  // 查找自定义模型
  const custom = state.customModels.find(m => m.id === value);

  if (custom) {
    updateModelIcon(custom);
    if (!hasModelKey(custom.id)) {
      openKeyInputModal(custom);
    } else {
      setCurrentModel(custom);
      resetUsage();
      toast(t("已切换: {name}", { name: custom.name }));
    }
  }
}

// ── 密钥输入弹窗 ────────────────────────────

let pendingKeyModel = null;

function openKeyInputModal(model) {
  pendingKeyModel = model;
  openSettings({ focusModelId: model.id });
  toast(t("请先配置 API Key: {name}", { name: model.name }));
}

// ── 自定义模型编辑──────────────────────────

let editingCustomModelId = null;

function openCustomModelModal(model = null) {
  openSettings();
  renderCustomModelManagement();
  renderKeyManagement();
  editingCustomModelId = model?.id || null;
  const editor = document.getElementById("custom-model-editor");
  document.getElementById("custom-model-editor-title").textContent = model
    ? `编辑自定义模型: ${model.name || model.id}`
    : "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = model ? "保存" : "添加";
  document.getElementById("custom-model-name").value = model?.id || "";
  document.getElementById("custom-model-url").value = model?.base_url || "";
  document.getElementById("custom-model-key").value = model ? (getModelKey(model.id) || "") : "";
  document.getElementById("custom-model-ctx").value = model?.context_window || 32768;
  document.getElementById("custom-model-mode").value = ["openai", "anthropic", "curl"].includes(model?.provider) ? model.provider : "openai";
  editor?.classList.remove("hidden");
  document.getElementById("custom-model-name").focus();
}

function closeCustomModelModal() {
  document.getElementById("custom-model-editor")?.classList.add("hidden");
  editingCustomModelId = null;
  document.getElementById("custom-model-name").value = "";
  document.getElementById("custom-model-url").value = "";
  document.getElementById("custom-model-key").value = "";
  document.getElementById("custom-model-ctx").value = "32768";
  document.getElementById("custom-model-mode").value = "openai";
  document.getElementById("custom-model-editor-title").textContent = "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = "添加";
}

function saveCustomModel() {
  const name = document.getElementById("custom-model-name").value.trim();
  const baseUrl = document.getElementById("custom-model-url").value.trim();
  const key = document.getElementById("custom-model-key").value.trim();
  const ctx = parseInt(document.getElementById("custom-model-ctx").value) || 32768;

  if (!name || !baseUrl) {
    toast("请填写模型名称和 Base URL");
    return;
  }

  const model = {
    id: name,
    name,
    provider: document.getElementById("custom-model-mode").value || "openai",
    base_url: baseUrl,
    context_window: ctx,
  };
  const duplicate = state.customModels.some(m => m.id === name && m.id !== editingCustomModelId);
  if (duplicate) {
    toast("模型名称已存在");
    return;
  }

  if (editingCustomModelId) {
    updateCustomModel(editingCustomModelId, model);
  } else {
    addCustomModel(model);
  }
  setModelKey(name, key);
  const wasEditing = !!editingCustomModelId;
  setCurrentModel(model);
  resetUsage();
  populateModelSelect();
  populateAutoReviewModelSelect();
  renderCustomModelManagement();
  renderKeyManagement();
  closeCustomModelModal();
  toast(t(wasEditing ? "已更新自定义模型: {name}" : "已添加自定义模型: {name}", { name }));
}

// ── 密钥管理面板（设置弹窗内）──────────────

function renderCustomModelManagement() {
  const container = document.getElementById("custom-model-list");
  if (!container) return;
  container.innerHTML = "";

  if (!state.customModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无自定义模型";
    container.appendChild(empty);
    return;
  }

  for (const model of state.customModels) {
    const row = document.createElement("div");
    row.className = "custom-model-row";

    const info = document.createElement("div");
    info.className = "custom-model-info";
    const name = document.createElement("div");
    name.className = "custom-model-name";
    name.textContent = model.name;
    const meta = document.createElement("div");
    meta.className = "custom-model-meta";
    meta.textContent = `${model.base_url} · ${model.context_window || 32768} ctx`;
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "custom-model-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.appendChild(iconSvgEl("edit-2"));
    editBtn.title = "编辑";
    editBtn.addEventListener("click", () => openCustomModelModal(model));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn custom-model-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "删除";
    deleteBtn.addEventListener("click", async () => {
      if (!await dlgConfirm(t("删除自定义模型「{name}」？", { name: model.name }), { danger: true, okText: "删除" })) return;
      removeCustomModel(model.id);
      if (state.autoReview?.modelId === model.id) {
        state.autoReview.modelId = "";
        savePersistent();
      }
      populateModelSelect();
      populateAutoReviewModelSelect();
      renderCustomModelManagement();
      renderKeyManagement();
      toast(t("已删除自定义模型: {name}", { name: model.name }));
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

function renderKeyManagement() {
  const container = document.getElementById("key-management-list");
  if (!container) return;
  container.innerHTML = "";

  const allModels = getAllModels().filter(m => !state.customModels.some(custom => custom.id === m.id));

  for (const m of allModels) {
    const row = document.createElement("div");
    row.className = "key-mgmt-row";

    const info = document.createElement("div");
    info.className = "key-mgmt-info";
    const nameSpan = document.createElement("span");
    nameSpan.className = "key-mgmt-name";
    nameSpan.textContent = m.name;
    const urlSpan = document.createElement("span");
    urlSpan.className = "key-mgmt-url";
    urlSpan.textContent = m.base_url;
    info.appendChild(nameSpan);
    info.appendChild(urlSpan);

    const inputWrap = document.createElement("div");
    inputWrap.className = "key-mgmt-input-wrap";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "setting-input key-mgmt-input";
    input.dataset.modelKey = m.id;
    input.value = getModelKey(m.id) || "";
    input.placeholder = hasModelKey(m.id) ? "已配置（留空删除）" : "未配置";

    const saveBtn = document.createElement("button");
    saveBtn.className = "icon-btn key-mgmt-save";
    saveBtn.appendChild(iconSvgEl("check"));
    saveBtn.title = "保存";
    saveBtn.addEventListener("click", () => {
      const val = input.value.trim();
      setModelKey(m.id, val);
      populateModelSelect();
      if (val && pendingKeyModel?.id === m.id) {
        setCurrentModel(m);
        resetUsage();
        pendingKeyModel = null;
        populateModelSelect();
      }
      toast(t(val ? "已保存 {name}" : "已删除 {name}", { name: m.name }));
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(saveBtn);

    row.appendChild(info);
    row.appendChild(inputWrap);
    container.appendChild(row);
  }
  if (!allModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无内置模型";
    container.appendChild(empty);
  }
}

// ── 设置弹窗 ────────────────────────────────

let settingsModal;

function openSettings(options = {}) {
  settingsModal = document.getElementById("panel-settings");
  document.getElementById("setting-max-tokens").value = state.maxTokens || 64000;
  document.getElementById("setting-output-max-tokens").value = state.outputSettings?.maxTokens || 16384;
  document.getElementById("setting-output-unlimited").checked = state.outputSettings?.unlimitedFileOutput !== false;
  document.getElementById("setting-file-auto-apply").checked = state.fileOutput?.autoApply !== false;
  document.getElementById("setting-auto-review-enabled").checked = state.autoReview?.enabled !== false;
  document.getElementById("setting-auto-review-long-stall").checked = state.autoReview?.reviewLongStall === true;
  document.getElementById("setting-auto-review-min-chars").value = state.autoReview?.minChars || 120;
  populateAutoReviewModelSelect();
  // 通知设置
  document.getElementById("setting-notif-sound").checked = state.notifications?.soundEnabled !== false;
  document.getElementById("setting-notif-system").checked = state.notifications?.systemNotifEnabled === true;
  updateNotifPermissionHint();
  renderPermissionModeSettings();
  renderWebSearchSettings();
  if (state.constitution) {
    document.getElementById("setting-constitution").value = JSON.stringify(state.constitution, null, 2);
  }
  renderCustomModelManagement();
  renderKeyManagement();
  renderUsageSummary();
  renderAbout();
  renderLanInfo();
  renderResponsesApiHint();
  switchPanel("settings");
  if (options.focusModelId) {
    requestAnimationFrame(() => {
      const input = [...document.querySelectorAll("[data-model-key]")]
        .find(el => el.dataset.modelKey === options.focusModelId);
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  } else if (options.focusConstitution) {
    requestAnimationFrame(() => {
      const input = document.getElementById("setting-constitution");
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  } else if (options.focusLan) {
    requestAnimationFrame(() => {
      document.getElementById("settings-lan")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function closeSettings() { switchPanel("chat"); }

// ── 设置页：左侧锚点导航（点击滚动 + 滚动高亮）──────────────

function initSettingsNav() {
  const page = document.querySelector(".settings-page");
  const nav = document.getElementById("settings-nav");
  if (!page || !nav) return;
  const items = [...nav.querySelectorAll(".settings-nav-item")];
  if (!items.length) return;

  items.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(item.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // 高亮规则：取顶边已越过容器顶部 24px 线的最后一个区块
  const onScroll = () => {

    const top = page.getBoundingClientRect().top;
    let activeId = items[0].dataset.target;
    for (const item of items) {
      const block = document.getElementById(item.dataset.target);
      if (block && block.getBoundingClientRect().top - top <= 24) activeId = item.dataset.target;
    }
    items.forEach(item => item.classList.toggle("active", item.dataset.target === activeId));
  };
  page.addEventListener("scroll", onScroll, { passive: true });
}

// ── 设置页：Responses API 提示 ──────────────

function renderResponsesApiHint() {
  const checkbox = document.getElementById("setting-use-responses");
  const hint = document.getElementById("responses-models-hint");
  if (!checkbox || !hint) return;

  checkbox.checked = state.useResponses === true;

  // 收集支持 Responses API 的模型名称
  const supportedModels = [];

  for (const models of Object.values(state.modelRegistry)) {
    for (const m of models) {
      if (m.supports_responses === true) {
        supportedModels.push(m.name);
      }
    }
  }

  if (supportedModels.length > 0) {
    hint.textContent = t("支持 Responses API 的模型：{models}", { models: supportedModels.join("、") });
  } else {
    hint.textContent = t("当前无模型支持 Responses API");
  }

  checkbox.onchange = () => {
    state.useResponses = checkbox.checked;
    savePersistent();
  };
}

// ── 设置页：关于与更新检查 ──────────────

let aboutVersionShown = false;

/** 展示当前版本号（首次打开设置页时拉取，失败保留占位符） */
async function renderAbout() {
  const verEl = document.getElementById("about-version");
  if (!verEl || aboutVersionShown) return;
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    if (d?.current) {
      verEl.textContent = `v${d.current}`;
      aboutVersionShown = true;
    }
  } catch {}
}

// ── 设置页：局域网遥控（地址获取 + 复制 + 二维码） ──────────────

/** 拉取局域网遥控地址并渲染醒目展示（每次打开设置页刷新，IP 变化可及时反映） */
async function renderLanInfo() {
  const box = document.getElementById("lan-info");
  if (!box) return;
  box.innerHTML = '<div class="lan-info-loading">正在获取遥控地址…</div>';
  let data = null;
  try {
    const res = await get("/lan/info");
    if (res?.code === 0) data = res.data;
  } catch {}
  if (!data || !data.enabled) {
    box.innerHTML = "";
    const err = document.createElement("div");
    err.className = "lan-info-error";
    err.textContent = t("遥控服务未启动") + (data?.error ? ": " + data.error : t("，请重启应用"));
    box.appendChild(err);
    return;
  }
  const url = data.urls[0];
  box.innerHTML = `
    <div class="lan-url-row">
      <code class="lan-url" id="lan-url-text">${url}</code>
      <button id="btn-lan-copy" class="send-btn send-btn-sm" type="button">复制地址</button>
    </div>
    <div class="lan-qr-row">
      <img class="lan-qr" src="/api/lan/qrcode?t=${Date.now()}" alt="遥控地址二维码">
      <div class="lan-qr-tip">手机扫码直接打开<br>（需连入同一局域网）</div>
    </div>
    <p class="lan-tip">已启用授权链接：只有使用上方地址或二维码进入的设备才能访问。请勿把链接分享给不受信任的人。</p>
  `;
  document.getElementById("btn-lan-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("遥控地址已复制");
    } catch {
      const el = document.getElementById("lan-url-text");
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast("自动复制失败，已为你选中地址");
    }
  });
}

// ── 首次启动引导 ──────────────────────

function initOnboarding() {
  const modal = document.getElementById("onboarding-modal");
  if (!modal) return;
  const legacySeen = localStorage.getItem("slate_onboarded") === "1";
  if (legacySeen && state.onboardingSeen !== true) {
    state.onboardingSeen = true;
    savePersistent();
  }
  const close = () => {
    modal.classList.add("hidden");
    state.onboardingSeen = true;
    localStorage.setItem("slate_onboarded", "1");
    savePersistent();
  };
  document.getElementById("btn-onboarding-done")?.addEventListener("click", close);
  modal.querySelector(".modal-close")?.addEventListener("click", close);
  modal.querySelector(".modal-backdrop")?.addEventListener("click", close);
  // 设置·关于里可重新查看
  document.getElementById("btn-view-onboarding")?.addEventListener("click", () => {
    modal.classList.remove("hidden");
  });
  if (state.onboardingSeen !== true && !legacySeen) modal.classList.remove("hidden");
}

// ── 数据备份与恢复────────────────────

function initBackupRestore() {
  const statusEl = document.getElementById("backup-status");

  document.getElementById("btn-backup-export")?.addEventListener("click", async () => {
    try {
      const res = await get("/chat/export");
      if (res.code !== 0) throw new Error(res.message || "导出失败");
      let local = null;
      try { local = JSON.parse(localStorage.getItem("slate_state") || "null"); } catch {}
      const payload = {
        app: "SLATE",
        kind: "full-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        backend: res.data,
        local,
      };
      let savedPath = "";
      try {
        const saveRes = await post("/chat/backup-file", { payload });
        if (saveRes.code === 0) savedPath = saveRes.data?.path || "";
      } catch (e) {
        console.warn("备份落盘失败:", e);
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `SLATE-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const d = res.data || {};
      if (statusEl) {
        const base = t("已导出：{a} 会话 / {b} 条消息 / {c} 条记忆 / {d} 条素材", { a: d.conversations?.length || 0, b: d.messages?.length || 0, c: d.memories?.length || 0, d: d.snippets?.length || 0 });
        statusEl.textContent = savedPath ? `${base}；本地备份：${savedPath}` : base;
      }
      toast(savedPath ? "备份已下载，并已保存到本地 backups 目录" : "备份已下载");
    } catch (e) {
      toast(t("导出备份失败: {msg}", { msg: e.message }));
    }
  });

  const fileInput = document.getElementById("backup-file-input");
  document.getElementById("btn-backup-import")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const backend = payload.backend || payload;
      if (!Array.isArray(backend.conversations) && !Array.isArray(backend.messages)) {
        throw new Error("无法识别的备份文件");
      }
      if (!await dlgConfirm("导入备份？已存在的数据会跳过，不会覆盖现有内容。导入后页面将重载。", { okText: "导入" })) return;
      const res = await post("/chat/import", { backend });
      if (res.code !== 0) throw new Error(res.message || "导入失败");
      if (payload.local && typeof payload.local === "object") {
        try { localStorage.setItem("slate_state", JSON.stringify(payload.local)); } catch {}
      }
      const s = res.data || {};
      if (statusEl) {
        statusEl.textContent = t("已导入：{a} 会话 / {b} 条消息 / {c} 条记忆 / {d} 条素材（已存在的跳过）", { a: s.conversations || 0, b: s.messages || 0, c: s.memories || 0, d: s.snippets || 0 });
      }
      toast("恢复完成，正在重载以应用本地设置…");
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(t("恢复失败: {msg}", { msg: e.message }));
    }
  });
}

// ── 关于区项目链接────────────────────

const WEBSITE_URL = "https://carywang1234.github.io/SLATE/";
const GITHUB_URL = "https://github.com/CaryWang1234/SLATE";

async function openProjectLink(url) {
  try {
    const res = await post("/update/open-url", { url });
    if (res.code !== 0) toast(res.message || "打开链接失败");
  } catch (e) {
    toast("打开链接失败");
  }
}

function initAboutLinks() {
  document.getElementById("btn-open-website")?.addEventListener("click", () => openProjectLink(WEBSITE_URL));
  document.getElementById("btn-open-github")?.addEventListener("click", () => openProjectLink(GITHUB_URL));
}

// ── 存储空间管理 ──────────────────────

function fmtBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

async function runStorageCleanup(target, btn) {
  const statusEl = document.getElementById("storage-status");
  btn.disabled = true;
  try {
    const res = await post("/settings/storage/cleanup", { target });
    if (res.code !== 0) { toast(res.message || "清理失败"); return; }
    const freed = res.data?.freed || 0;
    if (statusEl) statusEl.textContent = freed > 0 ? t("已释放 {size}", { size: fmtBytes(freed) }) : "无可释放空间（文件可能正被占用，关闭应用后重试）";
    toast(freed > 0 ? t("已释放 {size}", { size: fmtBytes(freed) }) : "清理完成");
    if (target === "history") {
      // 清空历史后同步侧栏列表
      try { await refreshConversationList(); } catch (e) {}

    }
    await renderStorageUsage();
  } catch (e) {
    toast(t("清理失败: {msg}", { msg: e.message }));
  } finally {
    btn.disabled = false;
  }
}

async function renderStorageUsage() {
  const box = document.getElementById("storage-usage");
  if (!box) return;
  try {
    const res = await get("/settings/storage");
    if (res.code !== 0) throw new Error(res.message || "获取失败");
    const { total, items } = res.data;
    box.innerHTML = "";

    const totalRow = document.createElement("div");
    totalRow.className = "storage-total";
    totalRow.textContent = t("总占用 {size}", { size: fmtBytes(total) });
    box.appendChild(totalRow);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "storage-row";
      const label = document.createElement("span");
      label.className = "storage-label";
      label.textContent = it.label;
      const size = document.createElement("span");
      size.className = "storage-size";
      size.textContent = fmtBytes(it.size);
      row.append(label, size);

      if (it.key === "chat") {
        const vacuumBtn = document.createElement("button");
        vacuumBtn.className = "send-btn send-btn-sm";
        vacuumBtn.textContent = "压缩";
        vacuumBtn.title = "压缩数据库文件，释放已删除数据占用的空间";
        vacuumBtn.addEventListener("click", () => runStorageCleanup("vacuum", vacuumBtn));
        row.appendChild(vacuumBtn);

        const clearBtn = document.createElement("button");
        clearBtn.className = "send-btn send-btn-sm btn-danger";
        clearBtn.textContent = "清空对话";
        clearBtn.title = "删除全部历史会话与消息";
        clearBtn.addEventListener("click", async () => {
          if (!await dlgConfirm("清空全部对话历史？此操作不可恢复，建议先在「数据备份」里导出备份。", { danger: true, okText: "清空" })) return;
          await runStorageCleanup("history", clearBtn);
        });
        row.appendChild(clearBtn);
      } else if (it.key === "webview") {
        const cleanBtn = document.createElement("button");
        cleanBtn.className = "send-btn send-btn-sm";
        cleanBtn.textContent = "清理缓存";
        cleanBtn.title = "清理内置浏览器缓存；运行中被占用的文件将在重启后彻底释放";
        cleanBtn.addEventListener("click", () => runStorageCleanup("webview", cleanBtn));
        row.appendChild(cleanBtn);
      }
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = "";
    const hint = document.createElement("span");
    hint.className = "setting-hint";
    hint.textContent = t("获取存储信息失败：{msg}", { msg: e.message });
    box.appendChild(hint);
  }
}

function initStorageManage() {
  renderStorageUsage();
  // 打开设置页时刷新一次用量
  document.getElementById("btn-settings")?.addEventListener("click", () => setTimeout(renderStorageUsage, 300));

}

/** 手动检查更新：结果内嵌展示，下载说明走后端白名单打开系统浏览器 */
async function checkUpdateNow(btn) {
  const info = document.getElementById("about-update-info");
  if (!info) return;
  btn.disabled = true;
  btn.textContent = "检查中…";
  info.classList.remove("hidden");
  info.textContent = "正在查询最新 Release…";
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    info.innerHTML = "";
    if (!d?.checked) {
      info.textContent = "检查更新失败：网络不可用，请稍后重试。";
      return;
    }
    if (d.current) document.getElementById("about-version").textContent = `v${d.current}`;
    if (!d.hasUpdate) {
      info.textContent = t("已是最新版本（v{v}）。", { v: d.current });
      return;
    }
    const line = document.createElement("div");
    line.textContent = t("发现新版 v{latest}（当前 v{current}）", { latest: d.latest, current: d.current });
    info.appendChild(line);
    if (d.notes) {
      const notes = document.createElement("div");
      notes.style.color = "var(--text-muted)";
      notes.textContent = d.notes.slice(0, 200);
      info.appendChild(notes);
    }
    const actions = document.createElement("div");
    actions.className = "about-update-actions";
    const dlBtn = document.createElement("button");
    dlBtn.className = "send-btn send-btn-sm";
    dlBtn.textContent = "下载更新";
    dlBtn.addEventListener("click", () => post("/update/open-url", { url: d.downloadUrl }).catch(() => {}));
    const relBtn = document.createElement("button");
    relBtn.className = "icon-btn";
    relBtn.textContent = "更新说明";
    relBtn.addEventListener("click", () => post("/update/open-url", { url: d.releaseUrl }).catch(() => {}));
    actions.appendChild(dlBtn);
    actions.appendChild(relBtn);
    info.appendChild(actions);
  } catch (e) {
    info.textContent = t("检查更新失败：{msg}", { msg: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "检查更新";
  }
}

// ── 设置页：用量统计（全部对话累计） ──────────────

async function renderUsageSummary() {
  const box = document.getElementById("usage-summary");
  if (!box) return;
    box.innerHTML = '<div class="usage-summary-loading">加载中…</div>';
  try {
    const res = await get("/chat/usage/summary");
    if (res.code !== 0) throw new Error(res.message || "加载失败");
    const d = res.data || {};
    box.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "usage-summary-grid";
    const equiv = tokenEquivalence(d.total_tokens);
    grid.innerHTML = `
      <div class="usage-summary-card usage-summary-main">
        <div class="usage-summary-num">${fmtTokens(d.total_tokens)}</div>
        <div class="usage-summary-label">总 Tokens</div>
        ${equiv ? `<div class="usage-summary-equiv">${equiv}</div>` : ""}
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${fmtTokens(d.prompt_tokens)}</div>
        <div class="usage-summary-label">总输入</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${fmtTokens(d.completion_tokens)}</div>
        <div class="usage-summary-label">总输出</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${(d.message_count || 0).toLocaleString()}</div>
        <div class="usage-summary-label">总消息数</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${d.conversation_count || 0}</div>
        <div class="usage-summary-label">对话数</div>
      </div>
    `;
    box.appendChild(grid);

    const top = d.top || [];
    if (top.length) {
      const list = document.createElement("div");
      list.className = "usage-summary-top";
      const head = document.createElement("div");
      head.className = "usage-summary-top-head";
      head.textContent = "用量最高的对话";
      list.appendChild(head);
      for (const item of top) {
        const row = document.createElement("div");
        row.className = "usage-summary-top-row";
        const title = document.createElement("span");
        title.className = "usage-summary-top-title";
        title.textContent = item.title || t("对话 {id}", { id: String(item.id || "").slice(0, 6) });
        const tok = document.createElement("span");
        tok.className = "usage-summary-top-tokens";
        tok.textContent = t("{tokens} tokens · {n} 条消息", { tokens: fmtTokens(item.total_tokens), n: item.message_count || 0 });
        row.append(title, tok);
        list.appendChild(row);
      }
      box.appendChild(list);
    }
  } catch (e) {
    box.innerHTML = "";
    const err = document.createElement("div");
    err.className = "usage-summary-loading";
    err.textContent = t("用量加载失败：{msg}", { msg: e.message });
    box.appendChild(err);
  }
}

// 自动推进设置：变更后立即持久化，无需点保存按钮
function applyAutoReviewSettings() {
  state.autoReview = {
    enabled: document.getElementById("setting-auto-review-enabled").checked,
    modelId: document.getElementById("setting-auto-review-model").value || "",
    minChars: Math.max(20, Math.min(800, parseInt(document.getElementById("setting-auto-review-min-chars").value) || 120)),
    reviewLongStall: document.getElementById("setting-auto-review-long-stall")?.checked === true,
  };
  savePersistent();
}

function initAutoReviewPersistence() {
  document.getElementById("setting-auto-review-enabled")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-model")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-min-chars")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-long-stall")?.addEventListener("change", applyAutoReviewSettings);
}

// 通知设置：变更后立即持久化
function updateNotifPermissionHint() {
  const hint = document.getElementById("notif-permission-hint");
  if (!hint) return;
  if (!("Notification" in window)) {
    hint.textContent = t("当前环境不支持系统通知");
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted") hint.textContent = t("已授权系统通知");
  else if (perm === "denied") hint.textContent = t("系统通知权限已被拒绝，请在浏览器设置中手动开启");
  else hint.textContent = t("开启系统通知后将请求浏览器授权");
}

function applyNotificationSettings() {
  state.notifications = {
    soundEnabled: document.getElementById("setting-notif-sound").checked,
    systemNotifEnabled: document.getElementById("setting-notif-system").checked,
  };
  savePersistent();
  // 开启系统通知时自动请求权限
  if (state.notifications.systemNotifEnabled && "Notification" in window && Notification.permission === "default") {
    import("./services/notify.js?v=20260830-003").then(({ requestNotificationPermission }) => {
      return requestNotificationPermission();
    }).then((perm) => {
      updateNotifPermissionHint();
      if (perm === "denied") {
        state.notifications.systemNotifEnabled = false;
        document.getElementById("setting-notif-system").checked = false;
        savePersistent();
      }
    }).catch(() => {});
  } else {
    updateNotifPermissionHint();
  }
}

function initNotificationPersistence() {
  document.getElementById("setting-notif-sound")?.addEventListener("change", applyNotificationSettings);
  document.getElementById("setting-notif-system")?.addEventListener("change", applyNotificationSettings);
}

// 命令权限模式：变更后立即持久化
const PERMISSION_MODE_HINTS = {
  ask: "高危命令（删除、提权、强制推送等）执行前弹窗询问，由你决定是否放行",
  auto: "高危命令自动放行执行，不再弹窗；灾难级命令（rm -rf /、format 等）仍强制拦截",
  full: "跳过高危判定，所有命令直接执行；灾难级命令（rm -rf /、format 等）仍强制拦截",
};

function renderPermissionModeSettings() {
  const mode = state.permissionMode || "ask";
  document.querySelectorAll(".permission-mode-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  const hint = document.getElementById("permission-mode-hint");
  if (hint) hint.textContent = PERMISSION_MODE_HINTS[mode] || "";
}

function applyPermissionMode(mode) {
  state.permissionMode = mode;
  savePersistent();
  renderPermissionModeSettings();
}

function initPermissionModePersistence() {
  document.querySelectorAll(".permission-mode-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyPermissionMode(btn.dataset.mode));
  });
}

// 联网搜索配置：默认引擎 + JS 渲染策略，变更后立即持久化
const WEB_SEARCH_ENGINE_HINTS = {
  auto: "同时搜索 Bing 与 DuckDuckGo，合并去重，结果更全更准（推荐）",
  bing: "仅用 Bing 搜索，中文结果质量好",
  ddg: "仅用 DuckDuckGo 搜索",
};
const WEB_SEARCH_RENDER_HINTS = {
  auto: "网页正文过短或直连失败时，自动用无头浏览器渲染后再提取（推荐）",
  on: "所有网页都先用无头浏览器渲染再提取，速度较慢",
  off: "不做 JS 渲染，只抓静态内容，动态页面可能为空",
};

function renderWebSearchSettings() {
  const cfg = state.webSearch || { engine: "auto", renderJs: "auto" };
  document.querySelectorAll("#web-search-engine-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.value === cfg.engine);
  });
  document.querySelectorAll("#web-search-render-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.value === cfg.renderJs);
  });
  const engineHint = document.getElementById("web-search-engine-hint");
  if (engineHint) engineHint.textContent = WEB_SEARCH_ENGINE_HINTS[cfg.engine] || "";
  const renderHint = document.getElementById("web-search-render-hint");
  if (renderHint) renderHint.textContent = WEB_SEARCH_RENDER_HINTS[cfg.renderJs] || "";
}

function applyWebSearchSetting(key, value) {
  state.webSearch = { ...(state.webSearch || {}), [key]: value };
  savePersistent();
  renderWebSearchSettings();
}

function initWebSearchPersistence() {
  document.querySelectorAll("#web-search-engine-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyWebSearchSetting("engine", btn.dataset.value));
  });
  document.querySelectorAll("#web-search-render-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyWebSearchSetting("renderJs", btn.dataset.value));
  });
}

async function saveSettings() {
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;
  state.maxTokens = maxTokens;
  state.outputSettings = {
    maxTokens: Math.max(1024, Math.min(65536, parseInt(document.getElementById("setting-output-max-tokens").value) || 16384)),
    unlimitedFileOutput: document.getElementById("setting-output-unlimited").checked,
  };
  state.fileOutput = {
    autoApply: document.getElementById("setting-file-auto-apply").checked,
  };
  state.autoReview = {
    enabled: document.getElementById("setting-auto-review-enabled").checked,
    modelId: document.getElementById("setting-auto-review-model").value || "",
    minChars: Math.max(20, Math.min(800, parseInt(document.getElementById("setting-auto-review-min-chars").value) || 120)),
    reviewLongStall: document.getElementById("setting-auto-review-long-stall")?.checked === true,
  };
  state.notifications = {
    soundEnabled: document.getElementById("setting-notif-sound").checked,
    systemNotifEnabled: document.getElementById("setting-notif-system").checked,
  };
  
  const constText = document.getElementById("setting-constitution").value.trim();
  if (constText) {
    try {
      const constData = JSON.parse(constText);
      if (state.project) {
        const { updateProjectConfig } = await import("./services/project.js?v=20260830-003");
        const config = { ...(state.project.config || {}), constitution: constData };
        const res = await updateProjectConfig(config);
        if (res.code === 0) setProject(res.data);
      } else {
        await put("/constitution", constData);
      }
      state.constitution = constData;
    } catch (e) { /* ignore */ }
  }

  savePersistent();
  toast("设置已保存");
}

// ── 标签页切换 ─────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(tab => tab.addEventListener("click", () => {
    // 设置页需通过 openSettings 渲染模型列表/用量等内容，否则直接切入为空
    if (tab.dataset.panel === "settings") openSettings();
    else switchPanel(tab.dataset.panel);
  }));
}

// ── 键盘快捷键──────────────────────────────

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && copySelectedText()) {
      e.preventDefault();
      return;
    }
    // Ctrl+N: 新建对话
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      document.getElementById("btn-new-chat")?.click();
    }
    // Ctrl+D: 切换主题
    if (e.ctrlKey && e.key === "d") {
      e.preventDefault();
      toggleTheme();
      toast(state.theme === "dark" ? "深色模式" : "浅色模式");
    }
    // Escape: 关闭弹窗
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not(.hidden)").forEach(m => m.classList.add("hidden"));
    }
  });
}

function getSelectedPageText() {
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return "";
  const selection = window.getSelection();
  const text = selection ? selection.toString() : "";
  return text.trim() ? text : "";
}

function copySelectedText() {
  const text = getSelectedPageText();
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      try { document.execCommand("copy"); } catch (e) {}
    });
  } else {
    try { document.execCommand("copy"); } catch (e) {}
  }
  return true;
}

function initSelectionCopySupport() {
  document.addEventListener("copy", (e) => {
    const text = getSelectedPageText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
}

// ── 加载模型 ────────────────────────────────

async function loadModels() {
  try {
    const res = await get("/proxy/models");
    console.log("Model API response:", res);
    if (res.code === 0) {
      console.log("Model registry data:", res.data);
      setModelRegistry(res.data);
      populateModelSelect();
      populateAutoReviewModelSelect();
    } else {
      console.warn("Model API returned non-zero code:", res);
    }
  } catch (e) {
    console.error("加载模型列表失败:", e);
  }
}

// ── 启动时自动检查更新────────────────

/** 查询 GitHub 最新 Release，有新版本时展示金色横幅；失败静默，不打扰用户 */
async function checkAppUpdate() {
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    if (!d?.hasUpdate) return;
    let dismissed = "";
    try { dismissed = localStorage.getItem("slate-update-dismissed") || ""; } catch {}
    if (dismissed === d.latest) return; // 用户已选择忽略该版本
    const banner = document.getElementById("update-banner");
    if (!banner) return;
    banner.innerHTML = "";

    const txt = document.createElement("span");
    txt.className = "update-banner-text";
    txt.textContent = t("发现新版 v{latest}（当前 v{current}）", { latest: d.latest, current: d.current });

    const openLink = (url) => async () => {
      const r = await post("/update/open-url", { url });
      if (r.code !== 0) toast(r.message || "打开链接失败", 3000);
    };

    const dl = document.createElement("button");
    dl.className = "update-banner-btn";
    dl.textContent = "下载更新";
    dl.addEventListener("click", openLink(d.downloadUrl));

    const rel = document.createElement("button");
    rel.className = "update-banner-btn update-banner-ghost";
    rel.textContent = "更新说明";
    rel.addEventListener("click", openLink(d.releaseUrl));

    const close = document.createElement("button");
    close.className = "update-banner-close";
    close.appendChild(iconSvgEl("x"));
    close.title = "忽略该版本";
    close.addEventListener("click", () => {
      banner.classList.add("hidden");
      try { localStorage.setItem("slate-update-dismissed", d.latest); } catch {}
    });

    banner.append(txt, dl, rel, close);
    banner.classList.remove("hidden");
  } catch (e) {
    console.warn("检查更新失败", e);
  }
}

// ── 初始化 ─────────────────────────────────

async function init() {
  // i18n 必须最先完成：英文模式要在任何界面渲染前挂好翻译监听
  await initI18n();


  loadPersistent();
  await loadSharedPersistent();

  // 应用保存的主题
  document.documentElement.setAttribute("data-theme", state.theme);


  safeInit("标签页", initTabs);
  safeInit("对话", initChat);
  safeInit("黑板", initWhiteboard);
  safeInit("提示词工厂", initPromptFactory);
  safeInit("技能面板", initSkillPanel);
  safeInit("MCP Server", initMcpServerPanel);
  safeInit("AI 团队", initTeamPanel);
  safeInit("项目栏", initProjectBar);
  safeInit("记忆面板", initMemoryPanel);
  safeInit("专家包", initExpertsPanel);
  safeInit("定时任务", initSchedule);
  safeInit("高危命令守卫", initRiskGuard);
  safeInit("项目理解", initUnderstandPanel);
  safeInit("快捷键", initKeyboardShortcuts);
  safeInit("文本复制", initSelectionCopySupport);

  // 模型选择
  document.getElementById("model-select").addEventListener("change", handleModelSelect);

  // 密钥管理按钮
  document.getElementById("btn-manage-keys").addEventListener("click", openSettings);

  // 自定义模型编辑器
  document.getElementById("btn-save-custom-model").addEventListener("click", saveCustomModel);
  document.getElementById("btn-add-custom-model-settings")?.addEventListener("click", () => openCustomModelModal());
  document.getElementById("btn-cancel-custom-model")?.addEventListener("click", closeCustomModelModal);

  // 主题切换
  document.getElementById("btn-theme").addEventListener("click", () => {
    toggleTheme();
    toast(state.theme === "dark" ? "深色模式" : "浅色模式");
  });

  // 设置弹窗
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  // 顶栏局域网入口：直达设置页“局域网遥控”区块（明显的网址获取入口）
  document.getElementById("btn-lan")?.addEventListener("click", () => openSettings({ focusLan: true }));

  document.getElementById("btn-lan-refresh")?.addEventListener("click", renderLanInfo);
  initAutoReviewPersistence();
  initNotificationPersistence();
  initPermissionModePersistence();
  initWebSearchPersistence();
  window.addEventListener("slate:open-settings", (event) => openSettings(event.detail || {}));

  // 设置页导航与关于
  safeInit("设置导航", initSettingsNav);

  document.getElementById("btn-check-update")?.addEventListener("click", (e) => checkUpdateNow(e.currentTarget));
  safeInit("首次启动引导", initOnboarding);
  safeInit("数据备份恢复", initBackupRestore);
  safeInit("关于区链接", initAboutLinks);
  safeInit("存储空间管理", initStorageManage);

  await loadModels();

  // 自动恢复上次打开的项目（失败不中断启动）
  if (state._lastProjectPath) {
    try {
      const res = await getCurrentProject();
      if (res.code === 0 && res.data) {
        setProject(res.data);
      } else {
        const { openProject } = await import("./services/project.js?v=20260830-003");
        const openRes = await openProject(state._lastProjectPath);
        if (openRes.code === 0) setProject(openRes.data);
      }
      // 确保文件树加载
      const browseRes = await browseFiles("");
      if (browseRes.code === 0) setProjectFileTree(browseRes.data);
    } catch (e) {
      console.warn("[SLATE] 恢复项目失败:", e);
    }
  }

  // 启动时自动检查更新（不阻塞初始化，失败静默）
  checkAppUpdate();

}

document.addEventListener("DOMContentLoaded", init);

export { toast };
