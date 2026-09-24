/**
 * 后台终端任务面板（右栏，与 TODOLIST 并列）。
 *
 * 这一栏存在的理由：模型被明确要求"起了任务就别轮询"——那模型不看的时候，人得看得见。
 * 面板读的是 services/bg_tasks.js 的快照（它按 3 秒轮询，没任务时退到 20 秒慢探），
 * 自己不发起任何请求，除了"展开某条任务的输出"这一下按需拉取。
 *
 * 三件事刻意做对：
 *   ① 没有任务时整栏隐藏（不留空壳占位），工具栏按钮同步置灰；
 *   ② 停止按钮只在 running 时出现——停一个早就结束的任务是空动作，按钮不该在；
 *   ③ 输出是"按需拉、只拉展开的那一条"，不然面板一显示就把所有任务的日志拉一遍。
 */

import { state, notify } from "../store.js?v=20260922-006";
import { t } from "../services/i18n.js?v=20260922-006";
import { iconSvgEl } from "../services/icons.js?v=20260922-006";
import { get } from "../services/api.js?v=20260922-006";
import { bgTasks, stopBgTask, clearFinishedBgTasks, peekBgEvents, startBgPolling, refreshBgTasks } from "../services/bg_tasks.js?v=20260922-006";

/** 展开的输出最多往回看多少行：面板是瞄一眼用的，不是完整日志阅读器 */
const TAIL_LINES = 200;

let panelEl = null;
/** 当前展开输出的任务 id（同时只有一个，避免一次拉一堆日志） */
let expandedId = "";
/** 展开的输出缓存：{ taskId: text }，轮询刷新时按展开项重拉 */
let outputCache = {};

function stateIcon(task) {
  if (task.state === "running") return "activity";
  if (task.state === "stopped") return "ban";
  if (task.state === "exited" && task.exit_code === 0) return "check";
  return "alert-triangle";
}

function stateText(task) {
  if (task.state === "running") return t("进行中");
  if (task.state === "stopped") return t("已停止");
  if (task.state === "exited") return task.exit_code === 0 ? t("已完成") : t("退出码 {n}", { n: task.exit_code });
  // 后端把非 0 退出单独记成 failed：跟"异常结束"分开报，否则"退出码 3"和"压根没跑起来"
  // 在面板上长得一模一样，想知道到底怎么了只能去翻日志
  if (task.state === "failed" && task.exit_code !== null && task.exit_code !== undefined) {
    return t("退出码 {n}", { n: task.exit_code });
  }
  return t("异常结束");
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function mountBgTaskPanel(el) {
  panelEl = el;
  if (!panelEl) return;
  startBgPolling();
  refreshBgTasks();
  renderBgTaskPanel();
}

export function renderBgTaskPanel() {
  if (!panelEl) return;
  syncBgRailButton();
  const tasks = bgTasks();
  // 没有在册任务就整栏收起来：这一栏是"有事才出现"，不是常驻家具
  if (!tasks.length || state.bgPanelOpen === false) {
    panelEl.classList.add("hidden");
    panelEl.innerHTML = "";
    return;
  }
  const running = tasks.filter(x => x.state === "running").length;
  const unread = peekBgEvents().length;
  panelEl.classList.remove("hidden");
  panelEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "todo-panel-header";
  const title = document.createElement("span");
  title.className = "todo-panel-title";
  title.textContent = t("后台任务 {n}", { n: tasks.length })
    + (running ? t(" · 跑着 {n}", { n: running }) : "")
    + (unread ? t(" · 未读 {n}", { n: unread }) : "");
  const spacer = document.createElement("span");
  spacer.className = "bg-panel-spacer";
  const clearBtn = document.createElement("button");
  clearBtn.className = "bg-icon-btn";
  clearBtn.title = t("清掉已结束的记录（日志文件保留）");
  clearBtn.appendChild(iconSvgEl("x"));
  clearBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    expandedId = "";
    outputCache = {};
    await clearFinishedBgTasks();
    renderBgTaskPanel();
  });
  const toggle = document.createElement("span");
  toggle.className = "todo-toggle";
  toggle.textContent = "▾";
  header.append(title, spacer, clearBtn, toggle);
  header.addEventListener("click", () => {
    state.bgPanelOpen = false;
    notify("bgPanelOpen", false);
    renderBgTaskPanel();
  });
  panelEl.appendChild(header);

  const body = document.createElement("div");
  body.className = "todo-panel-body bg-task-body";
  for (const task of tasks) body.appendChild(renderRow(task));
  panelEl.appendChild(body);
}

function renderRow(task) {
  const row = document.createElement("div");
  row.className = "bg-task-item" + (task.state === "running" ? " bg-task-running" : "");
  row.dataset.taskId = task.task_id;

  const head = document.createElement("div");
  head.className = "bg-task-head";
  const icon = document.createElement("span");
  icon.className = "bg-task-icon";
  icon.appendChild(iconSvgEl(stateIcon(task)));
  const label = document.createElement("span");
  label.className = "bg-task-label";
  label.textContent = task.label || task.task_id;
  label.title = `${task.task_id}\n${task.command || ""}\n${task.log_path || ""}`;
  const meta = document.createElement("span");
  meta.className = "bg-task-meta";
  meta.textContent = `${stateText(task)} · ${fmtDuration(task.duration)}`;
  head.append(icon, label, meta);

  const cmd = document.createElement("div");
  cmd.className = "bg-task-cmd";
  cmd.textContent = task.command || "";
  cmd.title = task.command || "";

  const actions = document.createElement("div");
  actions.className = "bg-task-actions";
  const logBtn = document.createElement("button");
  logBtn.className = "bg-icon-btn";
  logBtn.title = t("看输出（最近 {n} 行）", { n: TAIL_LINES });
  logBtn.appendChild(iconSvgEl("eye"));
  logBtn.addEventListener("click", () => toggleOutput(task.task_id));
  actions.appendChild(logBtn);
  if (task.state === "running") {
    const stopBtn = document.createElement("button");
    stopBtn.className = "bg-icon-btn bg-icon-danger";
    stopBtn.title = t("停止任务（杀整棵进程树）");
    stopBtn.appendChild(iconSvgEl("ban"));
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      await stopBgTask(task.task_id);
      renderBgTaskPanel();
    });
    actions.appendChild(stopBtn);
  }
  head.appendChild(actions);
  row.append(head, cmd);

  if (expandedId === task.task_id) {
    const pre = document.createElement("pre");
    pre.className = "bg-task-output";
    pre.textContent = outputCache[task.task_id] ?? t("读取中…");
    row.appendChild(pre);
  }
  return row;
}

async function toggleOutput(taskId) {
  if (expandedId === taskId) {
    expandedId = "";
    renderBgTaskPanel();
    return;
  }
  expandedId = taskId;
  renderBgTaskPanel();
  await fetchOutput(taskId);
  renderBgTaskPanel();
}

async function fetchOutput(taskId) {
  try {
    const res = await get(`/bg-tasks/${encodeURIComponent(taskId)}?tail_lines=${TAIL_LINES}`);
    const body = res?.code === 0 ? (res.data?.task?.output || "") : (res?.message || "");
    outputCache[taskId] = body.trim() || t("（暂无输出）");
  } catch (e) {
    outputCache[taskId] = t("读取失败：{msg}", { msg: e.message });
  }
}

/** 工具栏按钮与面板状态同步（描金=展开、置灰=没事可看） */
function syncBgRailButton() {
  const btn = document.getElementById("btn-bg-tasks");
  if (!btn) return;
  const count = bgTasks().length;
  const running = bgTasks().filter(x => x.state === "running").length;
  btn.disabled = !count;
  btn.classList.toggle("is-na", !count);
  btn.classList.toggle("rail-toggle-on", count > 0 && state.bgPanelOpen !== false);
  btn.setAttribute("aria-pressed", state.bgPanelOpen !== false ? "true" : "false");
  btn.title = !count ? t("当前没有后台任务")
    : running ? t("后台任务 {n} 个（{m} 个在跑）", { n: count, m: running })
      : t("后台任务 {n} 个（都结束了）", { n: count });
  const label = btn.querySelector(".bg-rail-count");
  if (label) label.textContent = count ? String(count) : "";
}

/** 轮询把新快照推进来后重绘；展开中的那条顺手刷一次输出 */
export async function onBgTasksChanged() {
  if (expandedId) {
    const still = bgTasks().some(x => x.task_id === expandedId);
    if (!still) {
      expandedId = "";
      outputCache = {};
    } else {
      await fetchOutput(expandedId);
    }
  }
  renderBgTaskPanel();
}
