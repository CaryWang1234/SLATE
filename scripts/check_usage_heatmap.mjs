/**
 * 用量热力图与内嵌 2048 守卫：scripts/check_usage_heatmap.mjs
 *
 * 两块都没有构建期校验，出问题只在人眼里：
 * ①2048 的合并规则写错（一格一次移动被合两回、方向映射串位）肉眼看不出来，
 *   只有断言钉得住；
 * ②热力图的列必须严格「一列一周、周日打头」，错一格整年的日期就都往左移一位，
 *   格子还在但对应的日子全错——比不画更糟；
 * ③热力图是周日打头的固定 53 列，看得见（非 future）的天数只有 365+今天星期数，
 *   够不到后端 371 天的取数窗口——所以汇总行只能报日期区间，报「近 53 周」就是虚的；
 * ④2048 的棋盘必须挂在 .heat 之外。openGame 给 .heat 加 .hidden，CSS 的
 *   .heat.hidden{display:none} 会连带藏掉自己的子节点，棋盘做儿子就永远打不开。
 *
 * 直接 import 真实现（不复制代码），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  emptyBoard, moveLine, move, spawn, isOver, maxTile,
} from "../frontend/js/components/game_2048.js?v=20260913-007";
import {
  WEEKS, buildGrid, monthLabels, levelFor,
} from "../frontend/js/components/usage_heatmap.js?v=20260913-007";
import { EN_DICT } from "../frontend/js/services/i18n_dict.js?v=20260913-007";

const BACKEND_WINDOW_DAYS = 371;  // backend/routers/chat.py: ACTIVITY_WINDOW_DAYS

const b = (...rows) => rows.map(r => [...r]);
const flat = board => board.flat();
const mirrorH = board => board.map(r => [...r].reverse());
const mirrorV = board => [...board].reverse();
const mirrorOf = (board, dir) => (dir === "h" ? mirrorH(board) : mirrorV(board));

// ── 1. 合并语义：向索引 0 侧推挤，同值合成一格，一次移动只合一回 ──
assert.deepEqual(moveLine([2, 2, 2, 2]), { line: [4, 4, 0, 0], gained: 8 }, "[2,2,2,2] 应合成两对");
assert.deepEqual(moveLine([2, 2, 4]), { line: [4, 4, 0], gained: 4 }, "[2,2,4] 不得连环合成 8");
assert.deepEqual(moveLine([4, 2, 2]), { line: [4, 4, 0], gained: 4 }, "先并后留：[4,2,2] 合后面那对");
assert.deepEqual(moveLine([2, 2, 2]), { line: [4, 2, 0], gained: 4 }, "三条同值只合最左一对");
for (const line of [[2, 2, 4], [0, 0, 0, 0], [8, 8, 2, 2]]) {
  assert.equal(moveLine(line).line.length, line.length, "输出长度必须等于输入长度");
}
assert.deepEqual(moveLine([2, 0, 2, 4]), { line: [4, 4, 0, 0], gained: 4 }, "空格不算屏障");
assert.deepEqual(moveLine([8, 8, 8, 8]), { line: [16, 16, 0, 0], gained: 32 });
assert.deepEqual(moveLine([2, 4, 8, 16]), { line: [2, 4, 8, 16], gained: 0 }, "互不相等就原样推齐");
assert.deepEqual(moveLine([0, 0, 0, 0]), { line: [0, 0, 0, 0], gained: 0 });

// ── 2. 四个方向的格子映射 ──
const BOARD = b([2, 0, 0, 2], [0, 4, 0, 0], [0, 0, 8, 0], [2, 0, 0, 4]);
assert.deepEqual(move(BOARD, "left").board, b([4, 0, 0, 0], [4, 0, 0, 0], [8, 0, 0, 0], [2, 4, 0, 0]));
assert.deepEqual(move(BOARD, "right").board, b([0, 0, 0, 4], [0, 0, 0, 4], [0, 0, 0, 8], [0, 0, 2, 4]));
assert.deepEqual(move(BOARD, "up").board, b([4, 4, 8, 2], [0, 0, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0]));
assert.deepEqual(move(BOARD, "down").board, b([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2], [4, 4, 8, 4]));
assert.equal(move(BOARD, "left").gained, 4, "只有第 0 行合成一对 4");
assert.equal(move(BOARD, "up").gained, 4, "只有第 0 列能合");
assert.equal(move(BOARD, "down").gained, 4, "往下同样只合第 0 列");

// 镜像不变量：向右 = 镜像后向左再镜像回来（cellAt 写反时这条最先炸）
for (const [axis, src, dst] of [["h", "right", "left"], ["v", "down", "up"]]) {
  const mirrored = mirrorOf(BOARD, axis);
  const a = move(BOARD, src).board;
  const bb = move(mirrored, dst).board;
  assert.deepEqual(mirrorOf(bb, axis), a, `${src} 与 ${dst} 不互为镜像`);
  assert.equal(move(BOARD, src).gained, move(mirrored, dst).gained, `${src} 与 ${dst} 得分不等`);
}

// 已经推到位的牌面：moved=false，前端据此拒绝补牌
const STUCK = b([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
for (const dir of ["left", "right", "up", "down"]) {
  assert.equal(move(STUCK, dir).moved, false, `满盘无同值相邻时 ${dir} 不该算动`);
  assert.equal(move(STUCK, dir).gained, 0);
}
assert.equal(isOver(STUCK), true, "四向都推不动就是终局");
const PACKED_LEFT = b([2, 4, 0, 0], [8, 16, 0, 0], [2, 8, 0, 0], [4, 16, 0, 0]);
assert.equal(move(PACKED_LEFT, "left").moved, false, "每行已贴左且无可合对 → 往左不算动");
assert.equal(move(PACKED_LEFT, "right").moved, true, "右侧留空时往右应当能推");
assert.equal(move(BOARD, "left").moved, true);

// ── 3. spawn：先抽位置再抽点数，各花一次 rng ──
{
  const seq = [0, 0.95];
  const rng = () => seq.shift();
  const empty = emptyBoard();
  const after = spawn(empty, rng);
  assert.equal(flat(after).filter(v => v).length, 1, "每次只补一格");
  assert.equal(after[0][0], 4, "位置 rng=0 → 首格；点数 rng=0.95 ≥ 0.9 → 出 4");
  assert.equal(flat(empty).filter(v => v).length, 0, "spawn 不得改原棋盘");
}
{
  const seq = [0.5, 0.1];
  const after = spawn(emptyBoard(), () => seq.shift());
  const idx = flat(after).findIndex(v => v);
  assert.ok(idx > 0, "rng=0.5 应落在中间某格");
  assert.equal(after[Math.floor(idx / 4)][idx % 4], 2, "rng=0.1 < 0.9 → 出 2");
}
{
  const full = b([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
  assert.deepEqual(spawn(full, () => 0), full, "满盘时原样返回，不能越界写");
}

// ── 4. isOver / maxTile ──
assert.equal(isOver(b([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2])), true, "满盘且无相邻同值即终局");
assert.equal(isOver(b([2, 2, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0])), false, "空格或可合都还没完");
assert.equal(isOver(emptyBoard()), false);
// 满盘：只有纵向能合 / 只有横向能合，两个方向各钉一次（棋盘格满盘时删掉任一方向的判据都测不出）
const VERT_ONLY = b([2, 4, 2, 4], [2, 8, 4, 8], [4, 2, 8, 4], [8, 4, 2, 8]);
assert.equal(isOver(VERT_ONLY), false, "满盘时纵向同值也算还能走");
assert.equal(move(VERT_ONLY, "up").moved, true, "纵向可合的满盘往上必须能推");
assert.equal(move(VERT_ONLY, "left").moved, false, "横向无可合对，往左推不动");
const HORZ_ONLY = b([2, 2, 4, 8], [4, 8, 2, 4], [2, 4, 8, 2], [8, 2, 4, 8]);
assert.equal(isOver(HORZ_ONLY), false, "满盘时横向同值也算还能走");
assert.equal(move(HORZ_ONLY, "left").moved, true, "横向可合的满盘往左必须能推");
assert.equal(move(HORZ_ONLY, "up").moved, false, "纵向无可合对，往上推不动");
assert.equal(maxTile(BOARD), 8);
assert.equal(maxTile(emptyBoard()), 0);

// ── 5. 热力图排布：53 列 × 7 行、周日打头、日期连续且不越过今天 ──
assert.equal(WEEKS, 53, "热力图周数改了要同步后端的取数窗口");
assert.equal(WEEKS * 7, 371);
const today = new Date(2026, 8, 13);  // 2026-09-13
const grid = buildGrid([], today);

function assertShape(g) {
  assert.equal(g.cells.length, WEEKS * 7);
  assert.equal(g.cells[0].dow, 0, "首格必须是周日");
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const cell = g.cells[w * 7 + d];
      assert.equal(cell.dow, d, `第 ${w} 列第 ${d} 行的 dow 错位`);
      assert.equal(new Date(`${cell.date}T00:00:00`).getDay(), d, `${cell.date} 不在星期 ${d} 这一行`);
    }
  }
  const seen = new Set(g.cells.map(c => c.date));
  assert.equal(seen.size, g.cells.length, "格子日期不能重复");
  for (let i = 1; i < g.cells.length; i++) {
    assert.ok(g.cells[i - 1].date < g.cells[i].date, "日期必须严格递增");
  }
  assert.ok(g.cells.some(c => c.date === g.endDate && c.week === WEEKS - 1), "今天必须落在末列");
  assert.equal(g.cells[g.cells.length - 1].dow, 6, "末列末尾应是本周六");
  assert.ok(g.cells.filter(c => !c.future).every(c => c.date <= g.endDate), "非 future 格不得是未来日期");
  assert.ok(g.cells.filter(c => c.future).every(c => c.week === WEEKS - 1), "future 只允许出现在末列");
  // 看得见的天数 = startDate..endDate = 365 + 今天的星期数（周日 365、周六 371），
  // 永远够不到 53 整周，所以汇总行只能报日期。少一天多一天都是排布错了。
  const ms = new Date(`${g.endDate}T00:00:00`) - new Date(`${g.startDate}T00:00:00`);
  const span = Math.round(ms / 86400000) + 1;
  const dow = new Date(`${g.endDate}T00:00:00`).getDay();
  assert.equal(span, 365 + dow, `可见跨度 ${span} 天 ≠ 365+星期数(${dow})`);
  assert.equal(g.cells.filter(c => !c.future).length, span, "非 future 格数必须等于可见跨度");
  assert.ok(span <= BACKEND_WINDOW_DAYS, `画布跨 ${span} 天，后端只取 ${BACKEND_WINDOW_DAYS} 天`);
}
assertShape(grid);
// 星期几打头的边界：周日 / 周六 / 跨年都要覆盖（主探针恰是周日，漏掉周日对齐的改动在它身上是空操作）
for (const probe of [new Date(2026, 8, 13), new Date(2026, 8, 12), new Date(2026, 0, 1), new Date(2025, 11, 31)]) {
  const g = buildGrid([], probe);
  const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  assert.equal(g.endDate, fmt(probe));
  assertShape(g);
}

// ── 6. 计数与分档 ──
{
  const g = buildGrid([
    { date: grid.endDate, count: 12 },
    { date: grid.cells[10].date, count: 3 },
    { date: "1999-01-01", count: 999 },     // 窗口外，直接不进画布
    { date: "bad-date", count: 5 },          // 脏数据不能污染任何格子
    { date: grid.cells[0].date },            // count 缺失按 0
  ], today);
  assert.equal(g.max, 12);
  assert.equal(g.total, 15);
  assert.equal(g.activeDays, 2);
  assert.equal(g.cells.find(c => c.date === grid.endDate).count, 12, "今天的量要落在今天的格子上");
  assert.equal(g.cells.filter(c => c.count === 999).length, 0, "窗口外的日期不得进画布");
  assert.equal(g.cells.filter(c => c.count === 5).length, 0, "脏日期不得污染任何格子");
  assert.equal(g.cells[0].count, 0);
}
assert.equal(levelFor(0, 12), 0, "零活动必须是 lv0");
assert.equal(levelFor(12, 12), 4);
assert.equal(levelFor(10, 12), 4, ">75% 为最深档");
assert.equal(levelFor(7, 12), 3);
assert.equal(levelFor(5, 12), 2);
assert.equal(levelFor(2, 12), 1);
assert.equal(levelFor(1, 1), 1, "样本极小时按条数直接分档，别全糊成同一色");
assert.equal(levelFor(9, 3), 4, "小样本也要封顶在 lv4");
let prevLevel = -1;
for (let n = 0; n <= 40; n++) {
  const lv = levelFor(n, 40);
  assert.ok(lv >= prevLevel, `色阶在 count=${n} 处回退了`);
  prevLevel = lv;
}

// ── 7. 月份标签：按列递增、不在首列、一个月只标一次 ──
{
  const labels = monthLabels(grid);
  assert.ok(labels.length >= 11 && labels.length <= 12, `一年里的月份标签数异常：${labels.length}`);
  assert.ok(labels.every(l => l.week > 0), "首列不标月份，左边会被星期列挤掉");
  for (let i = 1; i < labels.length; i++) {
    assert.ok(labels[i].week > labels[i - 1].week, "标签列必须递增");
    assert.notEqual(labels[i].label, labels[i - 1].label, "同月不得重复出标签");
  }
  assert.ok(labels.every(l => /^[0-9]{1,2}月$/.test(l.label)), "标签取的是中文月名，英文由渲染处 t() 处理");
}

// ── 8. 双语文案：新界面用到的中文键都要有英文，否则英文装在界面上漏中文 ──
for (const key of [
  "活跃度", "{start} 至 {end}：发送 {n} 条消息 · {d} 天活跃", "{date} · 发送 {n} 条消息", "{date} · 未使用",
  "周一", "周三", "周五", "少", "多",
  "分数", "最高分", "新游戏", "返回热力图",
  "方向键或 WASD 移动方块，合出 2048", "合出 2048 了！可以接着往上刷", "无步可走，点「新游戏」再来一局",
]) {
  assert.ok(EN_DICT[key], `i18n_dict.js 缺英文词条：${key}`);
}
for (const m of ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]) {
  assert.ok(EN_DICT[m], `i18n_dict.js 缺月份词条：${m}`);
}

// ── 9. 结构与文案：Node 侧没 DOM，直接读源码钉住两条走查里真炸过的 ──
{
  const src = readFileSync(new URL("../frontend/js/components/usage_heatmap.js?v=20260913-007", import.meta.url), "utf8");
  assert.match(src, /shell\.append\(gameHost\)/, "棋盘宿主得并进 .heat-shell");
  assert.doesNotMatch(src, /heat\.append\(gameHost\)/, "棋盘宿主挂进 .heat 会被 .heat.hidden 一起藏掉，双击永远打不开");
  assert.match(src, /t\("\{start\} 至 \{end\}：发送/, "汇总行得报日期区间");
  assert.doesNotMatch(src, /近 \{weeks\} 周/, "周数是虚的：周日打头的画布够不满 53 整周");
}

console.log("热力图排布与 2048 合并契约：通过");
