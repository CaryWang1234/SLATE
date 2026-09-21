/**
 * 侧栏任务列表的排序与状态判定 —— classic 的 #conv-list 与 Codex 的历史分组共用这一份纯函数。
 *
 * 状态刻意分两层：
 *   进行中 —— 只有持有生成权的那一侧知道（切会话即中断）。落库就会在重启后留下
 *             永远转不完的僵尸态，所以它只来自实时参数 activeConvId，绝不进 taskFlags。
 *   其余三态 —— 记的是"上一场怎么结束的"，用户可能明天才回来处理，必须跨重启仍在，
 *             所以由 store 持久化，并带 seen 位来支撑"已完成未查看"。
 *
 * 徽标只在"这条记录确实是该会话的最新一句"时才亮：flag.at 早于会话 updated_at，
 * 说明后来又在别处（手机遥控/另一台机器）继续过，旧结局不该继续压在列表上。
 *
 * 本模块不 import 任何依赖（守卫可在 Node 里直接真跑这些函数），
 * 标签文本在这里只是中文键，渲染处一律过 t() 再上 DOM。
 */

export const STATUS = { RUNNING: "running", NEEDS: "needs", ERROR: "error", UNREAD: "unread", IDLE: "idle" };

/** rank = 按状态排序时的轻重（0 最该先看到）；icon 取自 icons.js 的现有图标名 */
export const STATUS_MARKS = {
  running: { icon: "activity", label: "进行中", rank: 2 },
  needs: { icon: "bell", label: "需要操作", rank: 0 },
  error: { icon: "alert-triangle", label: "出错", rank: 1 },
  unread: { icon: "check", label: "已完成未查看", rank: 3 },
  idle: { icon: "", label: "", rank: 4 },
};

/** 落库的结局只有三种：进行中由实时层负责，未查看只是 done 的一个位 */
export const FLAG_KINDS = ["done", "needs", "error"];

export const SORT_MODES = [
  { key: "recent", label: "最近更新" },
  { key: "project", label: "按项目" },
  { key: "status", label: "按状态" },
  { key: "created", label: "创建时间" },
  { key: "usage", label: "按用量" },
];

export const UNGROUPED = "未分类";

// 会话 updated_at 是服务端 epoch 秒，flag.at 是本地毫秒：跨口径比较留 2s 容差
const STALE_TOLERANCE_S = 2;

export function normalizeTaskListSort(value) {
  return SORT_MODES.some(m => m.key === value) ? value : "recent";
}

export function normalizeTaskFlag(flag) {
  if (!flag || typeof flag !== "object") return null;
  if (!FLAG_KINDS.includes(flag.kind)) return null;
  const at = Number(flag.at) || 0;
  if (!at) return null;
  return { kind: flag.kind, at, seen: flag.seen === true };
}

/** 清洗并裁剪持久化映射：只留最近 TASK_FLAG_MAX 条，会话被删后这些残项也靠裁剪自然消化 */
export function normalizeTaskFlags(flags, max = 300) {
  const out = {};
  if (!flags || typeof flags !== "object") return out;
  const clean = Object.entries(flags)
    .map(([id, flag]) => [id, normalizeTaskFlag(flag)])
    .filter(([, flag]) => flag)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.max(1, max));
  for (const [id, flag] of clean) out[id] = flag;
  return out;
}

export function projectLabel(conv) {
  const name = typeof conv?.project === "string" ? conv.project.trim() : "";
  return name || UNGROUPED;
}

/** 会话 → 四态之一；activeConvId 是"此刻正在生成"的会话（没有就传空） */
export function taskStatusOf(conv, { flags = {}, activeConvId = "" } = {}) {
  const id = conv?.id;
  if (!id) return STATUS.IDLE;
  if (activeConvId && activeConvId === id) return STATUS.RUNNING;
  const flag = normalizeTaskFlag(flags[id]);
  if (!flag) return STATUS.IDLE;
  const updatedS = Number(conv.updated_at) || 0;
  if (updatedS && flag.at / 1000 < updatedS - STALE_TOLERANCE_S) return STATUS.IDLE;
  if (flag.kind === "error") return STATUS.ERROR;
  if (flag.kind === "needs") return STATUS.NEEDS;
  return flag.seen ? STATUS.IDLE : STATUS.UNREAD;
}

export function statusMark(status) {
  return STATUS_MARKS[status] || STATUS_MARKS[STATUS.IDLE];
}

/**
 * 徽标的单一定义：classic 的 .conv-item-status 与 Codex 的同一枚标识都从这里取，
 * 两处渲染只差外层容器类名，图标/文案/色调（data-status 驱动 CSS）不会再各写一份。
 * idle 返回 null —— 没有状态就是没有徽标，不画一个"正常"占位。
 */
export function statusBadge(status) {
  const mark = statusMark(status);
  if (!mark.icon) return null;
  return { className: "conv-item-status", status, icon: mark.icon, label: mark.label };
}

function recencyOf(conv) {
  return Number(conv?.updated_at) || 0;
}

function compareByMode(a, b, mode, ctx) {
  switch (mode) {
    case "project": {
      const pa = projectLabel(a), pb = projectLabel(b);
      if (pa !== pb) {
        // 未分类永远垫底，其余按名称：项目多的时候"没有项目"混在中间最难找
        if (pa === UNGROUPED) return 1;
        if (pb === UNGROUPED) return -1;
        return pa.localeCompare(pb, "zh-Hans-CN");
      }
      return 0;
    }
    case "status":
      return statusMark(taskStatusOf(a, ctx)).rank - statusMark(taskStatusOf(b, ctx)).rank;
    case "created":
      return (Number(b?.created_at) || 0) - (Number(a?.created_at) || 0);
    case "usage":
      return (Number(b?.total_tokens) || 0) - (Number(a?.total_tokens) || 0);
    default:
      return recencyOf(b) - recencyOf(a);
  }
}

/** 返回新数组：主键按 mode，一律以"最近更新"兜底，保证同键次序稳定 */
export function sortConversations(convs, mode, ctx = {}) {
  const key = normalizeTaskListSort(mode);
  return [...(Array.isArray(convs) ? convs : [])].sort((a, b) => {
    const primary = compareByMode(a, b, key, ctx);
    if (primary) return primary;
    return recencyOf(b) - recencyOf(a);
  });
}

/** 项目分组：分组顺序跟随同一排序偏好（组序取组内最佳条目），组内条目同样按偏好排 */
export function groupConversationsByProject(convs, mode, ctx = {}) {
  const key = normalizeTaskListSort(mode);
  const groups = new Map();
  for (const conv of Array.isArray(convs) ? convs : []) {
    const name = projectLabel(conv);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(conv);
  }
  for (const list of groups.values()) list.sort((a, b) => compareByMode(a, b, key, ctx) || (recencyOf(b) - recencyOf(a)));
  // 按项目排时组名即主键；其余模式下组序按"组内最好的那条"跟随偏好
  const ordered = [...groups.entries()];
  if (key === "project") {
    ordered.sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0] === UNGROUPED) return 1;
      if (b[0] === UNGROUPED) return -1;
      return a[0].localeCompare(b[0], "zh-Hans-CN");
    });
  } else {
    ordered.sort((a, b) => {
      const best = (list) => list[0];
      const head = compareByMode(best(a[1]), best(b[1]), key, ctx);
      return head || recencyOf(best(b[1])) - recencyOf(best(a[1]));
    });
  }
  return ordered;
}
