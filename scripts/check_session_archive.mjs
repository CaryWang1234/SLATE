/**
 * 会话归档守卫：scripts/check_session_archive.mjs
 *
 * 归档只有一条不许坏的规矩：**它不是删除**。所以这一层的判据分三段：
 * ① 库里那一列（新库有、老库靠 ALTER 补，默认 0——升级不许把谁的历史悄悄藏起来）；
 * ② 两批列表互斥（默认那页不含归档的，?archived=1 只含归档的；同一场两边都出现，
 *    恢复/删除就打在用户以为的另一个对象上）；
 * ③ 动手的地方各管各的（任务栏只写 archived:true，设置里恢复写 false、真删才走 DELETE）。
 * 最容易出事的三处都钉住位置：归档不许删消息、归档前要拦住正在生成的那场、
 * 归档的 flag 只认布尔 True（给了字符串 "false" 不能被判成归档）。
 *
 * 运行：node scripts/check_session_archive.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const CHAT_PY = read("backend/routers/chat.py");
const CHAT = read("frontend/js/components/chat.js");
const ARCHIVE = read("frontend/js/components/session_archive.js");
const APP = read("frontend/js/app.js");
const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const MCONV = read("frontend/js/mobile/m-conversations.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);
function fnBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}
/** Python 版：函数体是缩进行，第一条顶格行就是它的结束 */
function pyFn(src, name) {
  const start = src.indexOf(`def ${name}(`);
  if (start < 0) return "";
  const lines = src.slice(start).split("\n");
  const out = [lines[0]];
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() && !/^[ \t]/.test(lines[k])) break;
    out.push(lines[k]);
  }
  return out.join("\n");
}
/** 从 from 起、到到 next 之前的一小段（用来把判据钉在某个按钮的 handler 里） */
function slice(from, marker, endMarker) {
  const i = from.indexOf(marker);
  if (i < 0) return "";
  const j = endMarker ? from.indexOf(endMarker, i) : -1;
  return j < 0 ? from.slice(i) : from.slice(i, j);
}

// ── 1. 后端：那一列存在，且老库也补得上 ────────────────

const createBlock = slice(CHAT_PY, "CREATE TABLE IF NOT EXISTS conversations", ")\n    \"\"\")");
ok("新库的 conversations 建表就带 archived 列", has(createBlock, "archived INTEGER DEFAULT 0"),
  "只加迁移不加建表：新装与老库两套形状，读代码的人分不清哪个是真");
ok("老库靠 PRAGMA + ALTER 补这一列", /if "archived" not in cols:/.test(CHAT_PY)
  && /ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0/.test(CHAT_PY),
  "少这一步，升级后的用户一点归档就是 OperationalError");
ok("默认值是 0（升级不许把已有历史藏起来）",
  (CHAT_PY.match(/archived INTEGER DEFAULT 0/g) || []).length >= 2);

// ── 2. 后端：两批列表互斥 ─────────────────────────────

const listFn = pyFn(CHAT_PY, "list_conversations");
ok("列表默认只看没归档的那批", has(listFn, "archived: bool = False"));
ok("归档那批由 ?archived=1 单独取", has(listFn, "bool(c.get(\"archived\")) is archived]"),
  "写成 include/not 两种口径，早晚有一批会话两边都出现或两边都没有");
ok("SELECT 里带上了 archived（否则前端读不到状态）",
  /project, project_id, archived "/.test(CHAT_PY) || /project, project_id, archived\b/.test(listFn));
ok("互斥过滤排在项目过滤之前（先分两批，再按项目筛）",
  listFn.indexOf("bool(c.get(\"archived\")) is archived]") > listFn.indexOf("conversations = [dict(r) for r in rows]")
  && listFn.indexOf("bool(c.get(\"archived\")) is archived]") < listFn.indexOf("if project_id:"));
ok("清空全部仍然连归档的一起删（归档不是删除的对称面）",
  /if body\.get\("clear_all"\):[\s\S]{0,220}DELETE FROM conversations"/.test(CHAT_PY)
  && !/DELETE FROM conversations WHERE archived/.test(CHAT_PY));

// ── 3. 后端：PATCH 允许只改归档，且 flag 只认真布尔 ────────

const patchFn = pyFn(CHAT_PY, "rename_conversation");
ok("两个字段各给各的（只给 archived 也算一次合法更新）",
  has(patchFn, 'has_title = "title" in body') && has(patchFn, 'has_archived = "archived" in body'));
ok("空标题只在给了 title 时才拒", /if has_title and not title:/.test(patchFn),
  "沿用老的 if not title 会让只改归档那一次被当成空标题拒绝");
ok("什么都没给要说清楚", has(patchFn, '"没有要改的字段"'));
ok("归档标记只认 True：字符串 false 不许被当成真值",
  has(patchFn, "archived = 1 if body.get(\"archived\") is True else 0"));
ok("三条写库分支都在（只标题 / 只归档 / 两个一起）",
  /SET title = \?, archived = \?/.test(patchFn) && /SET archived = \? WHERE id = \?/.test(patchFn)
  && /SET title = \? WHERE id = \?/.test(patchFn));

// ── 4. 任务栏：归档按钮只做归档这一件事 ────────────────

const archiveHandler = slice(CHAT, 'archiveBtn.className = "conv-item-del conv-item-archive"',
  "const delBtn = document.createElement");
ok("归档按钮挂在每行的 actions 里", has(archiveHandler, 'conv-item-archive'));
ok("走查点的是这颗按钮，不是别处", has(archiveHandler, "actionsWrap.appendChild(archiveBtn);"));
ok("正在生成的那场先拦住（位置在写库之前）",
  archiveHandler.indexOf("if (isGenerating(conv.id))") >= 0
  && archiveHandler.indexOf("if (isGenerating(conv.id))") < archiveHandler.indexOf("patch(`/chat/conversations/"));
ok("拦下来给的是看得懂的话，不是静默不响应",
  has(archiveHandler, 'dlgToast(t("这一场还在生成，先停下来再归档"))'));
ok("写的是 archived: true", has(archiveHandler, "{ archived: true }"));
ok("归档这一路不许删数据（DELETE 只能出现在设置页那侧）", !has(archiveHandler, "del(`"),
  "把归档写成删除就是丢用户历史，而且是点一下就没了的那种");
ok("归档完刷新列表（行要真的从任务栏消失）",
  has(archiveHandler, "await refreshConversationList();"));
ok("归档的正是屏幕上这场时要离场", has(archiveHandler, "if (state.currentConversationId === conv.id) startNewChat();"),
  "主区还显示着一场列表里已经没有的对话，下一步点哪儿都不对");
ok("提示写明去哪儿恢复", has(archiveHandler, 't("已归档 · 可在「设置 → 会话归档」恢复")'));

// ── 5. 设置页：读、恢复、真删各是一条通道 ────────────────

ok("读的是归档那一批", has(ARCHIVE, 'get("/chat/conversations?archived=1")'));
const ARCH_BODY = ARCHIVE;
ok("恢复写的是 archived: false", has(ARCH_BODY, "{ archived: false }"));
ok("恢复之后要回主列表（不然任务栏里没有它，设置里却没了）",
  has(ARCH_BODY, 'await import("./chat.js') && has(ARCH_BODY, "refreshConversationList"));
ok("真删才走 DELETE，且删前先确认",
  has(ARCH_BODY, "dlgConfirm(") && has(ARCH_BODY, "danger: true") && has(ARCH_BODY, "del(`/chat/conversations/"));
ok("确认框文案说清连消息一起清掉", has(ARCH_BODY, "确定删除归档会话「{title}」？消息会一起清掉，找不回来。"));
ok("会话标题过了转义再进 innerHTML", has(ARCH_BODY, "esc(conv.title ||"));
// 两条失败通道（fetch 抛错 / 后端回了非 0）都要说人话。只查"字符串在不在"是假牙：
// 这一句在文件里本来就有两处，抹掉任意一处仍然读得到，于是一半的毒咬不住——改成数条数。
ok("读失败与「没有归档」是两句话（catch 与 code!==0 各说一句）",
  (ARCH_BODY.match(/归档会话读不出来/g) || []).length === 2
  && has(ARCH_BODY, 'res?.code !== 0') && has(ARCH_BODY, 't("没有已归档的会话")'),
  "读失败与没有归档是两回事，混成一句用户就以为自己的历史没了");
ok("每次打开都重新读后端（不靠本地缓存的现场）",
  has(ARCH_BODY, "export async function renderArchivedSessions")
  && !has(ARCH_BODY, "state.conversations"));
// 判的是"绑之前先认这颗绑过没有"那一步，不是 dataset.bound 这个字符串——
// 只查字符串的话，把守卫条件删了、赋值行还留着，判据照样绿。
ok("刷新按钮重复绑定要幂等",
  has(ARCH_BODY, "if (btn && !btn.dataset.bound) {") && has(ARCH_BODY, 'btn.dataset.bound = "1"'));

// ── 6. 接线：区块、渲染与样式都得在 ────────────────

ok("设置页有独立区块", has(HTML, '<section class="settings-block" id="settings-session-archive">'));
ok("容器与刷新按钮的 id 在（组件按这两个名找）",
  has(HTML, 'id="archived-session-list"') && has(HTML, 'id="btn-archived-refresh"'));
ok("区块文案说明了恢复与删除的差别",
  has(HTML, "恢复后重新出现在任务栏；删除会连同消息一起清掉，找不回来"));
ok("打开设置时重读归档列表", /renderThemeSettings\(\);\s*\n\s*renderArchivedSessions\(\);/.test(APP));
ok("启动时绑定刷新按钮", has(APP, 'safeInit("会话归档设置", initSessionArchiveSettings)'));
ok("app.js 引的是同一个组件", has(APP, 'from "./components/session_archive.js?v='));
for (const cls of ["archived-list", "archived-item", "archived-title", "archived-meta", "archived-actions"]) {
  ok(`style.css 里有 .${cls} 的规则`, new RegExp(`\\.${cls}\\s*\\{`).test(CSS),
    "class 在 CSS 里 0 条规则＝控件裸奔（这一族踩过两次）");
}
ok("手机端没跟着做半套归档入口（列表口径由后端统一）", !has(MCONV, "archived:"));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_session_archive: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
