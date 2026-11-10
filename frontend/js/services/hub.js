/**
 * 中枢会话的跨会话/扩展/工作区能力。
 *
 * 中枢是一条普通会话 + 本机指针（state.hubConversationId）。它的"最高控制权"只体现在
 * 工具目录：这 7 个工具只在中枢会话里可见、可执行（tools.js 的 HUB_TOOL_KEYS 与 callCtx.hub）。
 * 指针本身不是权限档——普通会话即使记住了工具名，executeTool 也会拒绝。
 *
 * 派发必须回到 chat.js 的 sendMessage：那一处才有并行槽位、单场互斥、项目归属与消息落库。
 * 本模块只登记一个 dispatcher，避免 tools.js 反向 import chat.js 成环。
 */

import { get, post, put, patch, del } from "./api.js?v=20261108-003";
import { state, permissionModeFor, modeRegistry, addMode, updateMode, removeMode } from "../store.js?v=20261108-003";
import {
  getRegistry, getCurrentProject, setActiveProject, openProject, closeProject,
  createWorkspace, switchProjectRoot, editWorkspaceFolders, patchRegistry, removeRegistry,
} from "./project.js?v=20261108-003";
import { dlgConfirm } from "./dialog.js?v=20261108-003";

export const HUB_TOOL_KEYS = [
  "session_list", "session_read", "session_dispatch",
  "extensions_list", "extension_manage",
  "workspace_list", "workspace_manage",
];

const SESSION_LIST_LIMIT = 80;
const READ_LIMIT_MAX = 80;
const TEXT_CLIP = 4000;

let dispatcher = null;

/** chat.js 在模块加载时登记：内部就是 sendMessage(payload, { convId, projectId })。 */
function registerHubDispatcher(fn) {
  dispatcher = typeof fn === "function" ? fn : null;
}

function err(message) {
  return { error: String(message || "操作失败") };
}

async function confirmAction(what, detail, convId) {
  if (permissionModeFor(convId) !== "ask") return true;
  return await dlgConfirm(`中枢要${what}：\n${detail}\n\n允许执行吗？`, { title: "中枢操作", danger: true });
}

function clip(text, n = TEXT_CLIP) {
  const s = String(text || "");
  return s.length > n ? s.slice(0, n) + `\n…（已截断，原文 ${s.length} 字符）` : s;
}

/** 后端给的是 epoch 秒（老数据也可能是 ISO 串）：两种都认，统一成"YYYY-MM-DD HH:MM"。 */
function fmtWhen(v) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  const d = new Date(Number.isFinite(n) && n > 1e9 ? n * 1000 : String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  const pad = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtConv(c) {
  return `- ${c.id} | ${c.title || "（无标题）"} | 项目 ${c.project || "无"} | ${fmtWhen(c.updated_at)} | ${c.message_count || 0} 条`;
}

async function listConversations() {
  const res = await get("/chat/conversations");
  if (res?.code !== 0) throw new Error(res?.message || "拉取会话列表失败");
  return Array.isArray(res.data) ? res.data : [];
}

async function createConversation(title, project = "") {
  const body = { title: String(title || "中枢派发").slice(0, 120) };
  if (project) body.project = String(project);
  const res = await post("/chat/conversations", body);
  if (res?.code !== 0) throw new Error(res?.message || "新建会话失败");
  return String(res.data?.id || res.data?.conversation_id || "");
}

async function runSessionList(params = {}) {
  const scope = String(params.scope || "all");
  const includeArchived = params.archived === true;
  let list = await listConversations();
  // 自己也在会话表里：列出来只会让中枢把自己当成一个可派发的目标
  list = list.filter(c => String(c.id) !== String(state.hubConversationId || ""));
  if (!includeArchived) list = list.filter(c => !c.archived);
  if (scope === "project") {
    const pid = String(state.project?.project_id || "");
    list = list.filter(c => String(c.project_id || "") === pid);
  }
  list = list.slice(0, Math.min(SESSION_LIST_LIMIT, Math.max(1, Number(params.limit) || SESSION_LIST_LIMIT)));
  if (!list.length) return "没有符合条件的会话。";
  return `共 ${list.length} 条会话（id | 标题 | 项目 | 更新时间 | 条数）：\n${list.map(fmtConv).join("\n")}`;
}

async function runSessionRead(params = {}) {
  const id = String(params.id || "").trim();
  if (!id) return err("缺少会话 id；先用 session_list 查。");
  const limit = Math.min(READ_LIMIT_MAX, Math.max(1, Number(params.limit) || 30));
  const res = await get(`/chat/conversations/${encodeURIComponent(id)}/messages`);
  if (res?.code !== 0) return err(res?.message || `读取会话 ${id} 失败`);
  const all = (Array.isArray(res.data) ? res.data : [])
    .filter(m => (m.role === "user" || m.role === "assistant") && !m.hidden);
  const picked = all.slice(-limit);
  if (!picked.length) return `会话 ${id} 没有可读的对话消息。`;
  const body = picked.map(m => {
    const who = m.role === "user" ? "用户" : "助手";
    return `【${who}】${clip(m.content || "")}`;
  }).join("\n\n");
  const more = all.length > picked.length ? `\n\n（共 ${all.length} 条，这里只给最近 ${picked.length} 条）` : "";
  return `会话 ${id}：\n\n${body}${more}`;
}

async function runSessionDispatch(params = {}, callCtx = {}) {
  if (!dispatcher) return err("派发通道未就绪：chat 模块还没登记 dispatcher。");
  const text = String(params.text || "").trim();
  if (!text) return err("缺少要派发的 text。");
  let convId = String(params.id || "").trim();
  let projectId = String(params.project || "");
  let created = false;
  if (convId) {
    const list = await listConversations();
    const target = list.find(c => String(c.id) === convId);
    if (!target) return err(`会话 ${convId} 不存在；先用 session_list 查或省略 id 新建。`);
    // 目标会话自己的项目：拿中枢屏幕上的项目去跑别场的任务，文件会落到错误目录
    if (!projectId) projectId = String(target.project_id || "");
  } else {
    const title = String(params.title || text.slice(0, 24)).trim();
    convId = await createConversation(title, projectId);
    if (!convId) return err("新建会话成功但没拿到 id。");
    created = true;
  }
  const result = await dispatcher({ convId, text, projectId, fromHub: true });
  if (!result?.ok) {
    return err(`派发未执行：${result?.reason || "目标会话当前不可启动"}${created ? `（已新建会话 ${convId}，可稍后重试）` : ""}`);
  }
  return `${created ? "已新建会话" : "已派发到会话"} ${convId}：${clip(text, 200)}\n${result.note || "目标会话会按它自己的审批档与工具白名单执行。"}`;
}

async function runExtensionsList(params = {}) {
  const kind = String(params.kind || "skills");
  if (kind === "modes") {
    const list = modeRegistry();
    return `模式 ${list.length} 个：\n${list.map(m => `- ${m.id} | ${m.name}${m.builtin ? "（内置）" : ""} | 工具 ${m.tools === null || m.tools === undefined ? "全部" : Array.isArray(m.tools) ? m.tools.length + " 个" : m.tools}`).join("\n")}`;
  }
  const path = { skills: "/skills", mcp: "/mcp/servers", experts: "/experts", actions: "/actions" }[kind];
  if (!path) return err(`未知 kind: ${kind}（可用 skills/mcp/modes/experts/actions）`);
  const res = await get(path);
  if (res?.code !== 0) return err(res?.message || `拉取 ${kind} 失败`);
  const data = res.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.servers) ? data.servers
    : Array.isArray(data?.items) ? data.items : Array.isArray(data?.skills) ? data.skills
      : Array.isArray(data?.actions) ? data.actions : Array.isArray(data?.experts) ? data.experts : [];
  if (!list.length) return `${kind} 下面没有条目。`;
  return `${kind} ${list.length} 条：\n${list.slice(0, 100).map(x => {
    if (typeof x === "string") return `- ${x}`;
    const id = x.id || x.name || x.title || "";
    const name = x.name || x.title || "";
    const status = x.connected === true ? "已连接" : x.connected === false ? "未连接" : (x.enabled === false ? "停用" : "");
    return `- ${id}${name && name !== id ? ` | ${name}` : ""}${status ? ` | ${status}` : ""}`;
  }).join("\n")}`;
}

async function runExtensionManage(params = {}, callCtx = {}) {
  const kind = String(params.kind || "");
  const action = String(params.action || "");
  const data = params.data && typeof params.data === "object" ? params.data : {};

  if (kind === "mcp") {
    const id = String(data.id || "");
    if (action === "add") {
      if (!String(data.name || "").trim()) return err("mcp.add 需要 data.name。");
      if (!(await confirmAction("添加并连接 MCP Server", String(data.name), callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await post("/mcp/servers", {
        name: String(data.name).trim(), url: String(data.url || ""),
        auto_connect: data.auto_connect !== false, transport: String(data.transport || "sse"),
        command: String(data.command || ""), env: data.env && typeof data.env === "object" ? data.env : {},
      });
      return res?.code === 0 ? `已添加 MCP：${res.data?.name || data.name}` : err(res?.message || "添加 MCP 失败");
    }
    if (!id) return err("mcp 操作需要 data.id。");
    if (action === "connect" || action === "disconnect") {
      if (!(await confirmAction(action === "connect" ? "连接 MCP Server" : "断开 MCP Server", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await post(`/mcp/servers/${encodeURIComponent(id)}/${action}`);
      return res?.code === 0 ? `MCP ${id} 已${action === "connect" ? "连接" : "断开"}` : err(res?.message || "操作失败");
    }
    if (action === "remove") {
      if (!(await confirmAction("删除 MCP Server", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await del(`/mcp/servers/${encodeURIComponent(id)}`);
      return res?.code === 0 ? `已删除 MCP ${id}` : err(res?.message || "删除失败");
    }
    return err(`mcp 不支持 action=${action}（可用 add/connect/disconnect/remove）`);
  }

  if (kind === "skill") {
    if (action !== "remove") return err("skill 目前只支持 remove。");
    const name = String(data.name || data.id || "");
    if (!name) return err("skill.remove 需要 data.name。");
    if (!(await confirmAction("删除技能", name, callCtx.convId))) return err("用户拒绝了这次操作。");
    const res = await del(`/skills/${encodeURIComponent(name)}`);
    return res?.code === 0 ? `已删除技能 ${name}` : err(res?.message || "删除技能失败");
  }

  if (kind === "mode") {
    if (action === "save") {
      const spec = data.mode && typeof data.mode === "object" ? data.mode : data;
      if (!spec || !spec.id) return err("mode.save 需要 data.mode（含 id）。");
      const exists = (state.customModes || []).some(m => m.id === spec.id);
      const saved = exists ? updateMode(spec.id, spec) : addMode(spec);
      return saved ? `已${exists ? "更新" : "新建"}模式 ${saved.id}` : err("模式校验失败或与已有 id 冲突。");
    }
    if (action === "remove") {
      const id = String(data.id || "");
      if (!id) return err("mode.remove 需要 data.id。");
      return removeMode(id) ? `已删除模式 ${id}` : err(`没有自定义模式 ${id}（内置模式不能删）。`);
    }
    return err(`mode 不支持 action=${action}（可用 save/remove）`);
  }

  if (kind === "expert") {
    const id = String(data.id || "");
    if (action === "create") {
      if (!(await confirmAction("新建专家包", String(data.name || ""), callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await post("/experts", data);
      return res?.code === 0 ? `已新建专家 ${res.data?.id || ""}` : err(res?.message || "新建专家失败");
    }
    if (!id) return err("expert 操作需要 data.id。");
    if (action === "save") {
      if (!(await confirmAction("保存专家包", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await put(`/experts/${encodeURIComponent(id)}`, data);
      return res?.code === 0 ? `已保存专家 ${id}` : err(res?.message || "保存失败");
    }
    if (action === "delete") {
      if (!(await confirmAction("删除专家包", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const res = await del(`/experts/${encodeURIComponent(id)}`);
      return res?.code === 0 ? `已删除专家 ${id}` : err(res?.message || "删除失败");
    }
    return err(`expert 不支持 action=${action}（可用 create/save/delete）`);
  }

  if (kind === "action") {
    const id = String(data.id || data.actionId || "");
    if (!id) return err("action 操作需要 data.id。");
    const scope = String(data.scope || "");
    const project = String(data.project || "");
    if (action === "save") {
      if (!(await confirmAction("写入工作流 Action", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const qs = project ? `?project=${encodeURIComponent(project)}` : "";
      const res = await put(`/actions/${encodeURIComponent(id)}${qs}`, { content: String(data.content || ""), scope });
      return res?.code === 0 ? `已保存 Action ${id}` : err(res?.message || "保存失败");
    }
    if (action === "delete") {
      if (!(await confirmAction("删除工作流 Action", id, callCtx.convId))) return err("用户拒绝了这次操作。");
      const qs = new URLSearchParams();
      if (project) qs.set("project", project);
      if (scope) qs.set("scope", scope);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await del(`/actions/${encodeURIComponent(id)}${suffix}`);
      return res?.code === 0 ? `已删除 Action ${id}` : err(res?.message || "删除失败");
    }
    return err(`action 不支持 action=${action}（可用 save/delete）`);
  }

  return err(`未知 kind: ${kind}（可用 mcp/skill/mode/expert/action）`);
}

async function runWorkspaceList() {
  const [cur, reg] = await Promise.all([getCurrentProject(), getRegistry()]);
  if (cur?.code !== 0) return err(cur?.message || "读取当前工作区失败");
  const list = Array.isArray(reg?.data?.projects) ? reg.data.projects : [];
  const p = cur.data || {};
  const roots = Array.isArray(p.roots) ? p.roots : [];
  const lines = [
    `当前：${p.name || "（无）"} | 根 ${p.path || "（无）"}${p.kind === "workspace" ? ` | 工作区（宿主 ${p.workspace_dir || "?"}）` : ""}`,
    roots.length ? `包含 ${roots.length} 个文件夹：${roots.join("、")}` : "单目录项目",
    `在册 ${list.length} 个：`,
    ...list.map(x => `- ${x.id} | ${x.name || ""} | ${x.path || ""}${x.active ? " | 当前" : ""}${x.kind === "workspace" ? " | 工作区" : ""}`),
  ];
  return lines.join("\n");
}

async function runWorkspaceManage(params = {}, callCtx = {}) {
  const action = String(params.action || "");
  const project = String(params.project || "");
  const needConfirm = (detail) => confirmAction(`管理工作区（${action}）`, detail, callCtx.convId);
  let res;
  switch (action) {
    case "open":
      if (!params.path) return err("workspace_manage open 需要 path。");
      if (!(await needConfirm(String(params.path)))) return err("用户拒绝了这次操作。");
      res = await openProject(String(params.path));
      break;
    case "close":
      if (!(await needConfirm("关闭当前项目"))) return err("用户拒绝了这次操作。");
      res = await closeProject();
      break;
    case "create":
      if (!String(params.name || "").trim()) return err("workspace_manage create 需要 name。");
      if (!(await needConfirm(`${params.name}（${(params.folders || []).length} 个文件夹）`))) return err("用户拒绝了这次操作。");
      res = await createWorkspace(String(params.name), Array.isArray(params.folders) ? params.folders : []);
      break;
    case "set_active":
      if (!project) return err("workspace_manage set_active 需要 project。");
      res = await setActiveProject(project);
      break;
    case "switch_root":
      if (!params.path) return err("workspace_manage switch_root 需要 path。");
      res = await switchProjectRoot(String(params.path), project);
      break;
    case "add_folder":
    case "remove_folder":
      if (!params.path) return err(`workspace_manage ${action} 需要 path。`);
      if (!(await needConfirm(`${action === "add_folder" ? "添加" : "移除"}文件夹 ${params.path}`))) return err("用户拒绝了这次操作。");
      res = await editWorkspaceFolders(action === "add_folder" ? "add" : "remove", String(params.path), project);
      break;
    case "set_pinned":
      if (!project) return err("workspace_manage set_pinned 需要 project。");
      res = await patchRegistry(project, { pinned: params.pinned !== false });
      break;
    case "remove_registry":
      if (!project) return err("workspace_manage remove_registry 需要 project。");
      if (!(await needConfirm(`从注册表移除 ${project}${params.forget ? "并删除 SLATE 私有数据" : ""}`))) return err("用户拒绝了这次操作。");
      res = await removeRegistry(project, params.forget === true);
      break;
    default:
      return err(`workspace_manage 不支持 action=${action}（open/close/create/set_active/switch_root/add_folder/remove_folder/set_pinned/remove_registry）`);
  }
  if (res?.code !== 0) return err(res?.message || "工作区操作失败");
  // 前端视图跟着后端真源刷新；失败不掩盖已成功的那次写入
  try {
    const scene = await import("./project_scene.js?v=20261108-003");
    await scene.refreshRegistry();
    if (res.data?.project) {
      const { notify } = await import("../store.js?v=20261108-003");
      state.project = res.data.project;
      notify("project", res.data.project);
    }
  } catch (e) { /* 刷新失败不影响操作结果 */ }
  return `工作区操作已执行：${action}${res.data?.project?.name ? ` → ${res.data.project.name}` : ""}`;
}

export {
  registerHubDispatcher,
  runSessionList, runSessionRead, runSessionDispatch,
  runExtensionsList, runExtensionManage,
  runWorkspaceList, runWorkspaceManage,
};
