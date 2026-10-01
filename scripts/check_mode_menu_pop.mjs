/**
 * 「＋」模式与功能浮层守卫：scripts/check_mode_menu_pop.mjs
 *
 * 用户要的是手感：按一次出现，再按关闭——和同一条工具栏上的审批胶囊、思考强度弹窗一个形制。
 * 原来它是个带遮罩的模态：第二次点「＋」时先打在遮罩上，按钮根本收不到那一下，
 * "再按关闭"在这类结构里永远不成立，所以这里钉的是"遮罩不许回来"。
 *
 * 盯的契约（三侧都要在）：
 *   ① HTML：菜单 DOM 在 #mode-menu-picker 里（浮层靠它定位），面板带 hidden 初始收起、
 *      按钮带 aria-haspopup/expanded/controls；条目 id 一个不许少（走查与 8 个处理器都按 id 找）；
 *   ② JS：按钮点一下是"取反"而不是"只开"；收起走 classList.toggle("hidden")；
 *      点外侧与 Escape 各有一条关闭路；旧的 #mode-menu-modal / 遮罩监听不许残留；
 *   ③ CSS：.mode-menu-pop 是 absolute 且 bottom 挂在按钮上方，
 *      并自带一条 .hidden → display:none ——桌面端没有全局 .hidden 工具类，
 *      少这一条就是"类在切、像素不动"，菜单从加载起一直摊在输入框上方。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = readFileSync(path.join(ROOT, "frontend", "index.html"), "utf8");
const JS = readFileSync(path.join(ROOT, "frontend", "js", "components", "chat.js"), "utf8");
const CSS = readFileSync(path.join(ROOT, "frontend", "css", "style.css"), "utf8");

const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

/** 从 idAt（某个 id 出现的位置）往回找包住它的那个 <div>，再按标签深度配平 </div>。
 *  往回找是必须的：id 排在 <div 之后，向前搜只会撞到它的第一个子节点。
 *  计数从 <div 之后开始：把开头那个 <div 也算进深度，就会多配一个兄弟节点的 </div>，
 *  于是"面板被搬出 picker"这种毒永远咬不住（变异取证实测过）。 */
function divBlock(src, idAt) {
  const open = src.lastIndexOf("<div", idAt);
  if (open === -1) return "";
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open + 4;
  let depth = 1;
  for (let m; (m = tag.exec(src)); ) {
    if (m[0] === "</div>") {
      if (--depth === 0) return src.slice(open, m.index + 6);
    } else depth++;
  }
  return "";
}

// ── ① HTML ────────────────────────────────────────────────
const PICKER_AT = HTML.indexOf('id="mode-menu-picker"');
must(PICKER_AT !== -1, '找不到 #mode-menu-picker：浮层没有定位锚，absolute 会挂到别的容器上');
const PICKER = divBlock(HTML, PICKER_AT);
must(PICKER.includes('id="btn-mode-menu"'), "「＋」按钮不在 #mode-menu-picker 里（按钮和浮层脱钩）");
must(PICKER.includes('id="mode-menu-pop"'), "菜单面板不在 #mode-menu-picker 里（它就只能靠 JS 算坐标定位了）");
must(/id="mode-menu-pop"[^>]*class="[^"]*\bhidden\b[^"]*"/.test(HTML),
  '#mode-menu-pop 没有初始 hidden：菜单一加载就摊在输入框上方');
must(!/class="[^"]*\bmodal\b[^"]*"[^>]*id="mode-menu-pop"/.test(HTML)
  && !/id="mode-menu-pop"[^>]*class="[^"]*\bmodal\b/.test(HTML),
  "#mode-menu-pop 还挂着 modal 类：模态那套居中与遮罩会把它拽回全屏");
must(!HTML.includes('id="mode-menu-modal"'), "旧的 #mode-menu-modal 还在：两份菜单 DOM 会抢同一批条目 id");
must(/id="btn-mode-menu"[^>]*aria-haspopup="dialog"/.test(HTML)
  && /id="btn-mode-menu"[^>]*aria-controls="mode-menu-pop"/.test(HTML)
  && /id="btn-mode-menu"[^>]*aria-expanded="false"/.test(HTML),
  "「＋」按钮少了 aria-haspopup/controls/expanded：读屏与键盘用户不知道那下是开还是关");

const ROWS = ["row-grind", "row-bs", "row-harness", "row-schedule",
  "row-mention-skill", "row-mention-tool", "row-mention-mcp", "row-mention-file"];
for (const id of ROWS) {
  must(PICKER.includes(`id="${id}"`), `菜单条目 ${id} 被搬出了 #mode-menu-picker（处理器按 id 找，会静默失灵）`);
}
must(PICKER.includes('id="mode-status-grind"'), "磨墨那行的状态位 #mode-status-grind 没了（syncModeMenu 没地方写）");
must(PICKER.includes('id="sw-harness"') && PICKER.includes('id="sw-bs"'),
  "两个开关的滑块节点没了：目标模式 / 头脑风暴的回显无处可画");

// ── ② JS ──────────────────────────────────────────────────
// 切片只取 setModeMenuPop 这一个函数体：整段文件往下切，会被同栏另一个弹窗
// （思考强度 effort-pop 的 toggle("hidden") / setAttribute("aria-expanded")）把断言借走，
// 那两条毒就跑成了假绿——变异取证就是这么抓出来的。
const FN_AT = JS.indexOf("function setModeMenuPop(");
must(FN_AT !== -1, "找不到 setModeMenuPop：开合没有唯一的落点");
const FN_END = JS.indexOf("\n}", FN_AT);
const TOGGLE = FN_AT === -1 ? "" : JS.slice(FN_AT, FN_END === -1 ? JS.length : FN_END + 2);
must(JS.includes("let modeMenuPopOpen = false;"), "没有 modeMenuPopOpen 这份开合状态：按钮按下无从判断该开还是该关");
must(/pop\.classList\.toggle\("hidden"/.test(TOGGLE), "收起没走 classList.toggle(\"hidden\")");
must(/btn\.setAttribute\("aria-expanded"/.test(TOGGLE), "开合没同步 aria-expanded");
must(/if \(modeMenuPopOpen\) syncModeMenu\(\)/.test(TOGGLE), "只在打开时回显开关状态这条没了（每次开都读到旧状态）");
must(/addEventListener\("click", \(\) => setModeMenuPop\(!modeMenuPopOpen\)\)/.test(JS),
  "「＋」按钮不是取反（再按关不掉，或关掉后开不开）");
must(/if \(modeMenuPopOpen && !e\.target\?\.closest\?\.\("#mode-menu-picker"\)\) closeModeMenu\(\);/.test(JS),
  "点外侧收起那条没了：浮层没有遮罩，不接 pointerdown 就永远挂-screen");
must(/e\.key === "Escape" && modeMenuPopOpen/.test(JS) && /modeBtn\?\.focus\(\)/.test(JS),
  "Escape 没接（或收完不把焦点还给按钮）");
must(!JS.includes('getElementById("mode-menu-modal")') && !JS.includes("openModeMenu"),
  "chat.js 还留着旧模态的取路（#mode-menu-modal / openModeMenu）");
must(!/modeModal\?\.querySelectorAll/.test(JS), "旧遮罩监听还在：它会先吃掉第二次点击");

// ── ③ CSS ─────────────────────────────────────────────────
must(/\.mode-menu-picker\s*\{[^}]*position:\s*relative/.test(CSS),
  ".mode-menu-picker 没有 position:relative：浮层会锚到整页，跑到别处去");
const POP = CSS.slice(CSS.indexOf(".mode-menu-pop {"));
const POP_BODY = POP.slice(0, POP.indexOf("}") + 1);
must(/position:\s*absolute/.test(POP_BODY) && /bottom:\s*calc\(100%\s*\+\s*\d+px\)/.test(POP_BODY),
  ".mode-menu-pop 不是挂在按钮正上方的浮层（输入框在页面底部，往下开会掉出屏幕）");
must(/z-index:/.test(POP_BODY), ".mode-menu-pop 没有 z-index：会被消息区盖住");
must(/\.mode-menu-pop\.hidden\s*\{[^}]*display:\s*none/.test(CSS),
  "桌面端没有全局 .hidden 工具类：.mode-menu-pop 少这条就是类在切、像素不动");
must(/#btn-mode-menu\[aria-expanded="true"\][^{]*\{[^}]*(border-color|color):/.test(CSS),
  "按钮展开态没有高亮：菜单开着而按钮看不出来，用户只会反复按");

if (problems.length) {
  console.error(`mode menu popover check failed with ${problems.length} issue(s):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("mode menu popover check passed (button-anchored, toggles on the button, no backdrop).");
