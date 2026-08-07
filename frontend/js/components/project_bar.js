/**
 * SLATE 项目栏组件：打开/关闭项目、文件树浏览
 */

import { state, subscribe, setProject, setProjectFileTree } from "../store.js?v=20260807-12";
import { openProject, closeProject, browseFiles, listDrives } from "../services/project.js?v=20260807-12";

let projectBar, projectOpenModal, projectPathInput, projectDrivesList, projectSidebar;
let fileTreeContainer, projectInfoEl, projectCloseBtn;
let currentBrowsePath = "";
let sidebarCollapsed = false;

// ── 项目栏渲染 ────────────────────────────────

function renderProjectBar() {
  if (!projectBar) return;
  const proj = state.project;
  const actions = document.createElement("div");
  actions.className = "project-bar-actions";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "icon-btn";
  toggleBtn.textContent = sidebarCollapsed ? "›" : "‹";
  toggleBtn.title = sidebarCollapsed ? "展开项目栏" : "折叠项目栏";
  toggleBtn.addEventListener("click", toggleProjectSidebar);
  actions.appendChild(toggleBtn);

  if (proj) {
    projectBar.innerHTML = "";

    const info = document.createElement("div");
    info.className = "project-bar-info";

    const icon = document.createElement("span");
    icon.className = "project-bar-icon";
    icon.textContent = "📁";
    info.appendChild(icon);

    const name = document.createElement("span");
    name.className = "project-bar-name";
    name.textContent = proj.name;
    name.title = proj.path;
    info.appendChild(name);

    projectBar.appendChild(info);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "icon-btn";
    refreshBtn.textContent = "↻";
    refreshBtn.title = "刷新项目";
    refreshBtn.addEventListener("click", () => handleRefreshProject(refreshBtn));
    actions.appendChild(refreshBtn);

    const configBtn = document.createElement("button");
    configBtn.className = "icon-btn";
    configBtn.textContent = "⚙";
    configBtn.title = "项目设置";
    configBtn.addEventListener("click", openProjectSettings);
    actions.appendChild(configBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭项目";
    closeBtn.addEventListener("click", handleCloseProject);
    actions.appendChild(closeBtn);

    projectBar.appendChild(actions);

    // 自动浏览根目录
    if (!state.projectFileTree?.entries) {
      refreshFileTree("");
    }
  } else {
    projectBar.innerHTML = "";

    const openBtn = document.createElement("button");
    openBtn.className = "project-bar-open";
    openBtn.textContent = "📂 打开项目…";
    openBtn.addEventListener("click", openProjectModal);
    projectBar.appendChild(openBtn);
    projectBar.appendChild(actions);

    // 清空文件树，显示占位
    if (fileTreeContainer) {
      fileTreeContainer.innerHTML = '<div class="file-tree-empty">打开项目以浏览文件</div>';
    }
  }
}

function toggleProjectSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  projectSidebar?.classList.toggle("collapsed", sidebarCollapsed);
  renderProjectBar();
}

// ── 打开项目弹窗 ──────────────────────────────

async function openProjectModal() {
  projectPathInput.value = state._lastProjectPath || "";
  projectOpenModal.classList.remove("hidden");
  projectPathInput.focus();

  // 加载磁盘列表
  const res = await listDrives();
  if (res.code === 0) {
    renderDrivesList(res.data);
  }
}

function renderDrivesList(drives) {
  if (!projectDrivesList) return;
  projectDrivesList.innerHTML = "";
  for (const d of drives) {
    const btn = document.createElement("button");
    btn.className = "project-drive-btn";
    btn.textContent = d.name;
    btn.title = d.path;
    btn.addEventListener("click", () => {
      projectPathInput.value = d.path;
    });
    projectDrivesList.appendChild(btn);
  }
}

async function handleOpenProject() {
  const path = projectPathInput.value.trim();
  if (!path) return;

  const res = await openProject(path);
  if (res.code === 0) {
    setProject(res.data);
    projectOpenModal.classList.add("hidden");
    // 自动浏览根目录
    currentBrowsePath = "";
    await refreshFileTree("");
  } else {
    alert(res.message || "打开失败");
  }
}

async function handleCloseProject() {
  if (!confirm("关闭当前项目？")) return;
  await closeProject();
  setProject(null);
  setProjectFileTree([]);
}

async function handleRefreshProject(button) {
  if (!state.project) return;
  const path = state.project.path;
  const browsePath = currentBrowsePath || "";
  if (button) button.disabled = true;
  try {
    const opened = await openProject(path);
    if (opened.code === 0) {
      setProject(opened.data);
    }
    const refreshed = await refreshFileTree(browsePath);
    if (!refreshed && browsePath) {
      await refreshFileTree("");
    }
  } finally {
    if (button) button.disabled = false;
  }
}

// ── 文件树 ────────────────────────────────────

async function refreshFileTree(path) {
  const res = await browseFiles(path);
  if (res.code === 0) {
    setProjectFileTree(res.data);
    currentBrowsePath = res.data.path || "";
    renderFileTree();
    return true;
  }
  return false;
}

function renderFileTree() {
  if (!fileTreeContainer) return;
  fileTreeContainer.innerHTML = "";

  const data = state.projectFileTree;
  if (!data || !data.entries) {
    fileTreeContainer.innerHTML = '<div class="file-tree-empty">未浏览目录</div>';
    return;
  }

  // 面包屑导航
  if (currentBrowsePath && currentBrowsePath !== ".") {
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "file-tree-breadcrumb";
    const rootLink = document.createElement("span");
    rootLink.textContent = state.project?.name || "/";
    rootLink.className = "file-tree-link";
    rootLink.addEventListener("click", () => refreshFileTree(""));
    breadcrumb.appendChild(rootLink);

    const parts = currentBrowsePath.split(/[/\\]/).filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated += (accumulated ? "/" : "") + part;
      const sep = document.createElement("span");
      sep.textContent = " / ";
      sep.className = "file-tree-sep";
      breadcrumb.appendChild(sep);

      const link = document.createElement("span");
      link.textContent = part;
      link.className = "file-tree-link";
      const targetPath = accumulated;
      link.addEventListener("click", () => refreshFileTree(targetPath));
      breadcrumb.appendChild(link);
    }

    fileTreeContainer.appendChild(breadcrumb);
  }

  // 返回上级
  if (currentBrowsePath && currentBrowsePath !== ".") {
    const parentBtn = document.createElement("div");
    parentBtn.className = "file-tree-item file-tree-dir";
    parentBtn.textContent = "⬆ ..";
    parentBtn.addEventListener("click", () => {
      const parts = currentBrowsePath.split(/[/\\]/).filter(Boolean);
      parts.pop();
      refreshFileTree(parts.join("/"));
    });
    fileTreeContainer.appendChild(parentBtn);
  }

  // 文件和目录
  for (const entry of data.entries) {
    const item = document.createElement("div");
    item.className = `file-tree-item ${entry.type === "dir" ? "file-tree-dir" : "file-tree-file"}`;

    const icon = entry.type === "dir" ? "📁 " : "📄 ";
    item.textContent = icon + entry.name;

    if (entry.type === "dir") {
      item.addEventListener("click", () => refreshFileTree(entry.path));
    } else {
      item.addEventListener("click", () => openFile(entry.path));
      if (entry.size != null) {
        const size = document.createElement("span");
        size.className = "file-tree-size";
        size.textContent = entry.size < 1024 ? `${entry.size}B`
          : entry.size < 1048576 ? `${(entry.size / 1024).toFixed(1)}K`
          : `${(entry.size / 1048576).toFixed(1)}M`;
        item.appendChild(size);
      }
    }

    fileTreeContainer.appendChild(item);
  }
}

let filePreviewEl;

async function openFile(path) {
  if (!filePreviewEl) filePreviewEl = document.getElementById("file-preview");
  const res = await browseFiles(path);
  if (res.code !== 0 || res.data.type !== "file") return;

  const { name, content, size } = res.data;
  filePreviewEl.innerHTML = "";
  filePreviewEl.classList.remove("hidden");

  // 标题栏
  const header = document.createElement("div");
  header.className = "file-preview-header";

  const title = document.createElement("span");
  title.className = "file-preview-title";
  title.textContent = name;
  title.title = path;
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "file-preview-actions";

  const insertBtn = document.createElement("button");
  insertBtn.className = "icon-btn";
  insertBtn.textContent = "↗";
  insertBtn.title = "插入到聊天";
  insertBtn.addEventListener("click", () => {
    const chatInput = document.getElementById("chat-input");
    if (chatInput) {
      const snippet = `\n[文件: ${name}]\n\`\`\`\n${(content || "").slice(0, 5000)}\n\`\`\``;
      chatInput.value += snippet;
      chatInput.focus();
    }
  });
  actions.appendChild(insertBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.textContent = "×";
  closeBtn.title = "关闭预览";
  closeBtn.addEventListener("click", () => {
    filePreviewEl.classList.add("hidden");
    filePreviewEl.innerHTML = "";
  });
  actions.appendChild(closeBtn);

  header.appendChild(actions);
  filePreviewEl.appendChild(header);

  // 文件内容
  const pre = document.createElement("pre");
  pre.className = "file-preview-content";
  pre.textContent = (content || "(空文件)").slice(0, 10000);
  filePreviewEl.appendChild(pre);
}

// ── 项目设置 ──────────────────────────────────

function openProjectSettings() {
  window.dispatchEvent(new CustomEvent("slate:open-settings", { detail: { focusConstitution: true } }));
}

// ── 初始化 ────────────────────────────────────

function initProjectBar() {
  projectBar = document.getElementById("project-bar");
  projectSidebar = document.getElementById("project-sidebar");
  fileTreeContainer = document.getElementById("project-file-tree");
  projectOpenModal = document.getElementById("project-open-modal");
  projectPathInput = document.getElementById("project-path-input");
  projectDrivesList = document.getElementById("project-drives-list");

  // 打开项目按钮
  const btnConfirmOpen = document.getElementById("btn-confirm-open-project");
  if (btnConfirmOpen) {
    btnConfirmOpen.addEventListener("click", handleOpenProject);
  }

  // 路径输入回车
  if (projectPathInput) {
    projectPathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleOpenProject();
    });
  }

  // 关闭弹窗
  if (projectOpenModal) {
    projectOpenModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
      el.addEventListener("click", () => projectOpenModal.classList.add("hidden"));
    });
  }

  // 订阅项目状态变化
  subscribe("project", renderProjectBar);
  subscribe("projectFileTree", renderFileTree);

  // 初始渲染
  renderProjectBar();
}

export { initProjectBar };
