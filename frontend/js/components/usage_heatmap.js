/**
 * 设置页「用量统计」里的活跃度热力图：按本地日期看每天发了多少条消息。
 *
 * 数据来自 GET /api/chat/usage/summary 的 data.daily（后端只回有活动的日子，
 * 空档由这里补 0）。老后端不带 daily 时 app.js 直接跳过渲染，这里不再兜底。
 *
 * 格子按 GitHub 口径排：一列一周，周日打头，53 列刚好对上后端的 371 天。
 * 53 列在窄的设置栏里铺不开，所以格子边长由 syncCellSize 量容器宽度回算成
 * --heat-cell（见 CSS 里 .heat-grid 的 repeat(53, var(--heat-cell))），而不是靠
 * 1fr 缩放——1fr 会把格子压成长条，宽度不够时照样撑出横向滚动条。
 *
 * 半隐藏的 2048：双击任一格子，棋盘就地替掉热力图（见 game_2048.js）。
 * 不留可见入口，也不写提示文案——这是彩蛋，不是功能按钮。
 */

import { t } from "../services/i18n.js?v=20260913-007";
import { mount2048 } from "./game_2048.js?v=20260913-007";

const WEEKS = 53;
const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

function fmtDate(dt) {
  const p = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** 0 无活动；其余按占最大值的比例分 4 档（样本极小时直接按条数走） */
export function levelFor(count, max) {
  if (!count) return 0;
  if (max <= 4) return Math.min(4, count);
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** 把稀疏的 daily 摊成 53 列 × 7 行的格子，末尾未到的一周置 future */
export function buildGrid(daily, today = new Date()) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const firstSunday = new Date(
    end.getFullYear(), end.getMonth(),
    end.getDate() - end.getDay() - (WEEKS - 1) * 7
  );
  const counts = new Map();
  for (const item of daily || []) {
    if (!item || !item.date) continue;
    counts.set(String(item.date), Math.max(0, Number(item.count) || 0));
  }
  const cells = [];
  let total = 0, max = 0, activeDays = 0;
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(firstSunday.getFullYear(), firstSunday.getMonth(), firstSunday.getDate() + w * 7 + d);
      const date = fmtDate(dt);
      const future = dt.getTime() > end.getTime();
      const count = future ? 0 : (counts.get(date) || 0);
      if (!future) {
        total += count;
        if (count) activeDays += 1;
        if (count > max) max = count;
      }
      cells.push({ date, count, week: w, dow: d, future });
    }
  }
  return { cells, weeks: WEEKS, total, max, activeDays, startDate: fmtDate(firstSunday), endDate: fmtDate(end) };
}

/** 换月的第一列出月份标签；整列都在未来的列不标 */
export function monthLabels(grid) {
  const out = [];
  let prev = -1;
  for (let w = 0; w < grid.weeks; w++) {
    const column = grid.cells.slice(w * 7, w * 7 + 7).filter(c => !c.future);
    if (!column.length) continue;
    const mid = column[Math.min(3, column.length - 1)];
    const m = Number(mid.date.slice(5, 7)) - 1;
    if (prev === -1) { prev = m; continue; }
    if (m !== prev) {
      out.push({ week: w, label: MONTHS[m] });
      prev = m;
    }
  }
  return out;
}

function div(cls, text) {
  const node = document.createElement("div");
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function cellTitle(cell) {
  return cell.count
    ? t("{date} · 发送 {n} 条消息", { date: cell.date, n: cell.count })
    : t("{date} · 未使用", { date: cell.date });
}

/** 画热力图；game 视图与热力图视图共用同一块地盘，切换靠 data-view */
export function renderActivityHeatmap(host, daily) {
  const grid = buildGrid(daily);
  host.innerHTML = "";

  const shell = div("heat-shell");
  const heat = div("heat");

  const head = div("heat-head");
  head.append(div("heat-title", t("活跃度")));
  // 格子周日打头，末列今天之后还有几个空格（周六才刚好填满），所以看得见的天数
  // 是 365+星期数，够不到后端的 371 天窗口。报日期区间而不是周数，
  // 数字才和屏幕上这些格子一一对得上。
  head.append(div("heat-total", t("{start} 至 {end}：发送 {n} 条消息 · {d} 天活跃", {
    start: grid.startDate, end: grid.endDate, n: grid.total, d: grid.activeDays,
  })));
  heat.append(head);

  const scroll = div("heat-scroll");

  const monthsRow = div("heat-row");
  monthsRow.append(div("heat-daypad"));
  const months = div("heat-months");
  for (const label of monthLabels(grid)) {
    const cell = div("heat-month", t(label.label));
    cell.style.gridColumn = String(label.week + 1);
    months.append(cell);
  }
  monthsRow.append(months);
  scroll.append(monthsRow);

  const bodyRow = div("heat-row");
  const days = div("heat-days");
  const dayNames = { 1: t("周一"), 3: t("周三"), 5: t("周五") };
  for (let d = 0; d < 7; d++) days.append(div("heat-day", dayNames[d] || ""));
  bodyRow.append(days);

  const gridEl = div("heat-grid");
  for (const cell of grid.cells) {
    const node = div(`heat-cell lv${cell.future ? 0 : levelFor(cell.count, grid.max)}`);
    if (cell.future) node.classList.add("future");
    node.dataset.date = cell.date;
    node.title = cellTitle(cell);
    gridEl.append(node);
  }
  gridEl.addEventListener("dblclick", () => openGame(shell));
  bodyRow.append(gridEl);
  scroll.append(bodyRow);
  heat.append(scroll);

  const foot = div("heat-foot");
  foot.append(div("heat-legend-key", t("少")));
  for (let lv = 0; lv <= 4; lv++) foot.append(div(`heat-swatch lv${lv}`));
  foot.append(div("heat-legend-key", t("多")));
  heat.append(foot);

  // 必须是 .heat 的兄弟：openGame 给 .heat 加 .hidden，挂在里面会被一起藏掉
  const gameHost = div("heat-game hidden");

  shell.append(heat);
  shell.append(gameHost);
  host.append(shell);

  syncCellSize(heat, scroll, days);
  return grid;
}

// .heat-daypad/.heat-days 宽 22px、.heat-row 列间距 6px，改样式时改这里
const LABEL_W = 22;
const ROW_GAP = 6;
const CELL_GAP = 3;

let resizeObs = null;

/** 53 列固定尺寸放不下就白瞎出滚动条：按可用宽度回算格子边长 */
function syncCellSize(heat, scroll, days) {
  const apply = () => {
    const avail = scroll.clientWidth - (days.clientWidth || LABEL_W) - ROW_GAP;
    if (avail <= 0) return;
    const cell = Math.max(5, Math.min(13, Math.floor((avail - CELL_GAP * (WEEKS - 1)) / WEEKS)));
    heat.style.setProperty("--heat-cell", `${cell}px`);
  };
  apply();
  if (typeof ResizeObserver !== "function") return;
  if (resizeObs) resizeObs.disconnect();
  resizeObs = new ResizeObserver(apply);
  resizeObs.observe(scroll);
}

let current = null;

function openGame(shell) {
  if (shell.dataset.view === "game") return;
  const heat = shell.querySelector(".heat");
  const host = shell.querySelector(".heat-game");
  if (!heat || !host) return;
  shell.dataset.view = "game";
  heat.classList.add("hidden");
  host.classList.remove("hidden");
  current = mount2048(host, { onClose: () => closeGame(shell) });
}

function closeGame(shell) {
  if (current) { current.destroy(); current = null; }
  const heat = shell.querySelector(".heat");
  const host = shell.querySelector(".heat-game");
  if (heat) heat.classList.remove("hidden");
  if (host) host.classList.add("hidden");
  delete shell.dataset.view;
}

export { WEEKS };
