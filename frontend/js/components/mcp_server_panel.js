/**
 * SLATE MCP Server 管理组件
 * 在设置页中展示已配置的外部 MCP Server，支持添加/删除/连接/断开。
 */

import { get, post, del } from "../services/api.js?v=20260826-113";
import { dlgPrompt, dlgConfirm } from "../services/dialog.js?v=20260826-113";
import { refreshSkills } from "./skill_panel.js?v=20260826-113";

let serverListEl, btnAdd, btnRefresh;

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

const STATUS_LABEL = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  error: "错误",
};

function renderServerList(servers) {
  if (!serverListEl) return;
  serverListEl.innerHTML = "";

  if (!servers || !servers.length) {
    const empty = document.createElement("div");
    empty.className = "mcp-server-empty";
    empty.textContent = "暂未配置外部 MCP Server，点击「+ 添加 MCP Server」开始连接";
    serverListEl.appendChild(empty);
    return;
  }

  for (const srv of servers) {
    const item = document.createElement("div");
    item.className = "mcp-server-item";

    // 状态指示灯
    const statusDot = document.createElement("span");
    statusDot.className = `mcp-server-status ${srv.status || "disconnected"}`;
    statusDot.title = STATUS_LABEL[srv.status] || srv.status;

    // 信息区
    const info = document.createElement("div");
    info.className = "mcp-server-info";

    const nameRow = document.createElement("div");
    nameRow.className = "mcp-server-name";
    nameRow.appendChild(statusDot);
    nameRow.appendChild(document.createTextNode(srv.name || srv.id));

    const urlRow = document.createElement("div");
    urlRow.className = "mcp-server-url";
    urlRow.textContent = srv.url;
    urlRow.title = srv.url;

    info.appendChild(nameRow);
    info.appendChild(urlRow);

    // 工具数量
    if (srv.toolCount > 0) {
      const toolsRow = document.createElement("div");
      toolsRow.className = "mcp-server-tools";
      const toolNames = (srv.tools || []).map(t => t.name).join(", ");
      toolsRow.textContent = `${srv.toolCount} 个工具: ${toolNames}`;
      toolsRow.title = toolNames;
      info.appendChild(toolsRow);
    }

    // 错误信息
    if (srv.error) {
      const errRow = document.createElement("div");
      errRow.className = "mcp-server-tools";
      errRow.style.color = "#ef4444";
      errRow.textContent = srv.error;
      info.appendChild(errRow);
    }

    // 操作按钮
    const actions = document.createElement("div");
    actions.className = "mcp-server-actions";

    if (srv.status === "connected") {
      const btnDisconnect = document.createElement("button");
      btnDisconnect.textContent = "断开";
      btnDisconnect.addEventListener("click", () => handleDisconnect(srv.id));
      actions.appendChild(btnDisconnect);
    } else {
      const btnConnect = document.createElement("button");
      btnConnect.textContent = "连接";
      btnConnect.addEventListener("click", () => handleConnect(srv.id));
      actions.appendChild(btnConnect);
    }

    const btnDelete = document.createElement("button");
    btnDelete.className = "danger";
    btnDelete.textContent = "删除";
    btnDelete.addEventListener("click", () => handleRemove(srv.id, srv.name));
    actions.appendChild(btnDelete);

    item.appendChild(statusDot);
    item.appendChild(info);
    item.appendChild(actions);
    serverListEl.appendChild(item);
  }
}

async function loadServers() {
  try {
    const res = await get("/mcp-servers");
    if (res.code === 0) {
      renderServerList(res.data);
    }
  } catch (e) {
    showToast("加载 MCP Server 列表失败" + e.message);
  }
}

async function handleAddServer() {
  const name = await dlgPrompt("MCP Server 名称：", { title: "添加 MCP Server", placeholder: "例如：filesystem" });
  if (!name || !name.trim()) return;

  const url = await dlgPrompt("MCP Server SSE 地址：", {
    title: "添加 MCP Server",
    placeholder: "http://localhost:3000",
  });
  if (!url || !url.trim()) return;

  showToast("正在连接 MCP Server…");
  try {
    const res = await post("/mcp-servers", { name: name.trim(), url: url.trim(), auto_connect: true });
    if (res.code === 0) {
      const data = res.data;
      if (data.status === "connected") {
        showToast(`已连接 ${data.name}，发现 ${data.toolCount} 个工具`);
      } else if (data.status === "error") {
        showToast(`连接失败: ${data.error || "未知错误"}（已保存配置，可稍后重试）`);
      } else {
        showToast(`已添加 ${data.name}`);
      }
      loadServers();
      refreshSkills();
    } else {
      showToast(`添加失败: ${res.message}`);
    }
  } catch (e) {
    showToast(`添加失败: ${e.message}`);
  }
}

async function handleConnect(serverId) {
  showToast("正在连接…");
  try {
    const res = await post(`/mcp-servers/${serverId}/connect`);
    if (res.code === 0) {
      const data = res.data;
      if (data.status === "connected") {
        showToast(`已连接，发现 ${data.toolCount} 个工具`);
      } else {
        showToast(`连接失败: ${data.error || "未知错误"}`);
      }
      loadServers();
      refreshSkills();
    } else {
      showToast(`连接失败: ${res.message}`);
    }
  } catch (e) {
    showToast(`连接失败: ${e.message}`);
  }
}

async function handleDisconnect(serverId) {
  try {
    const res = await post(`/mcp-servers/${serverId}/disconnect`);
    if (res.code === 0) {
      showToast("已断开");
      loadServers();
      refreshSkills();
    }
  } catch (e) {
    showToast(`断开失败: ${e.message}`);
  }
}

async function handleRemove(serverId, name) {
  if (!await dlgConfirm(`确定删除 MCP Server「${name}」？`, { danger: true, okText: "删除" })) return;
  try {
    const res = await del(`/mcp-servers/${serverId}`);
    if (res.code === 0) {
      showToast(`已删除 ${name}`);
      loadServers();
      refreshSkills();
    }
  } catch (e) {
    showToast(`删除失败: ${e.message}`);
  }
}

function initMcpServerPanel() {
  serverListEl = document.getElementById("mcp-server-list");
  btnAdd = document.getElementById("btn-add-mcp-server");
  btnRefresh = document.getElementById("btn-refresh-mcp-servers");

  if (btnAdd) btnAdd.addEventListener("click", handleAddServer);
  if (btnRefresh) btnRefresh.addEventListener("click", () => { loadServers(); refreshSkills(); });

  loadServers();
}

export { initMcpServerPanel, loadServers };
