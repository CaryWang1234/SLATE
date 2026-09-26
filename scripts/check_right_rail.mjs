/**
 * 右侧栏归拢守卫：scripts/check_right_rail.mjs
 *
 * 症状（2026-09 用户实测）：有时会开出两根右栏——TODOLIST 与任务中心同时可见时，
 * 它们各自是 .chat-area-row 的直接子元素，于是并成两根 280/320px 的列，消息区被挤窄两次。
 * 修法是把右侧那几块收进同一根竖栏（.rail-col）：开合仍各管各的，但永远只占一列。
 *
 * 盯的契约（HTML 与 CSS 两侧都要在）：
 *   ① .chat-area-row 的直接子元素恰好两个：消息区 + 一根竖栏；三块面板都在竖栏里，
 *      谁被搬回去当直系子元素就又成了第二根右栏；
 *   ② 竖栏是纵向 flex 且**不写宽度**——宽度由可见的那几块定，全收起时整栏塌成 0，
 *      写死宽度会留一条空栏把消息区一直挤窄；
 *   ③ 同栏几块面板走同一条规则（平分高度 + 同一宽度），且各自保留 .hidden → display:none，
 *      否则栏塌不下去。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = readFileSync(path.join(ROOT, "frontend", "index.html"), "utf8");
const CSS = readFileSync(path.join(ROOT, "frontend", "css", "style.css"), "utf8");

const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

const ROW_OPEN = '<div class="chat-area-row">';
const PANELS = ["todo-panel", "bg-task-panel", "grind-panel"];

/** 从 src 里 openAt 处那个 <div 开始，按标签深度找到配对的 </div>（嵌套 div 也算准） */
function divBlock(src, openAt) {
  const open = src.indexOf("<div", openAt);
  if (open === -1) return null;
  const bodyStart = src.indexOf(">", open) + 1;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = bodyStart;
  let depth = 1;
  for (let m; (m = tag.exec(src)); ) {
    if (m[0] === "</div>") {
      if (--depth === 0) return { inner: src.slice(bodyStart, m.index), start: open, end: m.index + "</div>".length };
    } else {
      depth++;
    }
  }
  return null;
}

/** 一层里所有直系 div（用配对结果跳过各自的内部，所以只拿到同一深度的） */
function topLevelDivs(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf("<div", i);
    if (at === -1) return out;
    const blk = divBlock(src, at);
    if (!blk) return out;
    out.push(src.slice(blk.start, blk.end));
    i = blk.end;
  }
}

// ── ① 横向容器里只有「消息区 + 一根竖栏」，三块面板都在竖栏内部 ──
const rowAt = HTML.indexOf(ROW_OPEN);
must(rowAt !== -1, `找不到 ${ROW_OPEN}（布局改了名就要同步这条判据）`);
const row = rowAt === -1 ? null : divBlock(HTML, rowAt);
must(!!row, ".chat-area-row 的标签没配对，解析不到内部");
if (row) {
  const kids = topLevelDivs(row.inner);
  must(kids.length === 2,
    `.chat-area-row 的直系子元素应当恰好两个（消息区 + 一根竖栏），现在 ${kids.length} 个：多出来的每一块都是一根额外的右栏`);
  must(kids[0]?.includes('id="chat-messages"'), ".chat-area-row 的第一个直系子元素不是消息区");
  must(kids[1]?.includes('class="rail-col"'), ".chat-area-row 里没有那根右侧竖栏（.rail-col）");
  const railCount = (row.inner.match(/class="rail-col"/g) || []).length;
  must(railCount === 1, `右侧竖栏应当只有一根，现在 ${railCount} 根`);

  const rail = divBlock(row.inner, row.inner.indexOf('<div class="rail-col">'));
  must(!!rail, "找不到 .rail-col 那一层（或它的标签没配对）");
  if (rail) {
    const outside = row.inner.slice(0, rail.start) + row.inner.slice(rail.end);
    for (const id of PANELS) {
      must(rail.inner.includes(`id="${id}"`), `#${id} 不在右侧竖栏里：右栏必须只有一根`);
      must(!outside.includes(`id="${id}"`),
        `#${id} 又挂在 .chat-area-row 下面当直系子元素了：两块同开就又成了两根并列的右栏`);
    }
    must(!rail.inner.includes('id="chat-messages"'), "消息区被圈进右侧竖栏了：它不该跟着面板伸缩");
  }
}

// ── ② 竖栏纵向排列、并且不写宽度（全收起时要塌成 0） ──
const railAt = CSS.indexOf(".rail-col {");
must(railAt !== -1, "style.css 里没有 .rail-col 的规则");
if (railAt !== -1) {
  const railCss = CSS.slice(railAt, CSS.indexOf("}", railAt));
  must(/display:\s*flex/.test(railCss) && /flex-direction:\s*column/.test(railCss),
    "右侧竖栏不是纵向 flex：同栏两块会并成左右两列，等于没合并");
  must(!/(^|[;\s])(width|min-width|max-width|flex-basis)\s*:/.test(railCss),
    "竖栏写了宽度：所有面板都收起时它还占着一条空栏的位置，消息区白窄一截");
  must(/flex-shrink:\s*0/.test(railCss), "竖栏没写 flex-shrink: 0：消息区内容一长就会把右栏压扁");
}

// ── ③ 同栏几块走同一条规则（同宽 + 可收缩），各自保留 .hidden 隐藏 ──
const childAt = CSS.indexOf(".rail-col > .todo-panel");
must(childAt !== -1, "style.css 没给右栏里的面板定布局（.rail-col > .todo-panel …）");
if (childAt !== -1) {
  const sel = CSS.slice(childAt, CSS.indexOf("{", childAt));
  must(sel.includes(".rail-col > .todo-panel") && sel.includes(".rail-col > .grind-panel"),
    "右栏几块面板没走同一条规则：宽度各写各的，栏里早晚参差不齐");
  const body = CSS.slice(childAt, CSS.indexOf("}", childAt));
  must(/flex:\s*1 1 0/.test(body) && /min-height:\s*0/.test(body),
    "同栏两块没有平分高度 / 不能收缩：一块长起来，另一块就被挤没了");
  must(/width:\s*\d+px/.test(body), "同栏面板没有统一宽度");
}
must(/\.todo-panel\.hidden\s*\{[^}]*display:\s*none/.test(CSS),
  "清单/任务中心面板没有 .hidden 隐藏规则：栏收不起来，等于常驻一列");
must(/\.grind-panel\.hidden\s*\{[^}]*display:\s*none/.test(CSS),
  "墨迹面板没有 .hidden 隐藏规则：栏收不起来");
must(/id="bg-task-panel"[^>]*class="[^"]*todo-panel[^"]*"/.test(HTML),
  "#bg-task-panel 没带 todo-panel 类：它不会跟着 .todo-panel.hidden 一起收起来");

if (problems.length) {
  console.error(`right rail check failed with ${problems.length} issue(s):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("right rail check passed (one column, collapses to 0 when empty).");
