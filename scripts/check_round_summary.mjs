/**
 * 本轮总结守卫：scripts/check_round_summary.mjs
 *
 * 这功能的红线只有一条：卡片说"能撤回"，就必须真的能撤回到本轮开始前，且绝不碰用户
 * 本轮之后自己改的东西。为此三条口径必须同时成立——写之前先取原文、一次任务只留第一份
 * 原文、撤回前逐条比对现场。少任何一条，卡片就从"可撤回"变成"看起来可撤回"。
 *
 * 盯的契约：
 *   ① 三个真落盘的端点里 begin_write 在 write_text_file **之前**，finish_write 只在写成功
 *      之后（记账分两步：写失败时清单上一个字都不该多）；
 *   ② 快照目录在 data/ 下，不在项目里（清单本身不该被撤回/被提交）；run_id 当目录名用，
 *      必须先过白名单正则；
 *   ③ 一轮对同一文件的多次写入只留第一次的原文，行数也按那份原文算；
 *   ④ 撤回逐条比对"当前 == 本轮写入后"，不相等就跳过并回报；
 *   ⑤ 前端 run_id 与写入同源（账本 runId），三个自动应用点 + 手动「接受」+ 移动 sheet 都要带；
 *   ⑥ 收尾挂载走 metadata 整块覆盖的**回填**写法（不回填就把工具结果抹了）；
 *   ⑦ 撤销前必须过 danger 确认框；卡片文案全在 EN_DICT 里；diff 复用既有 .diff-line 配色。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const SNAP = read("backend", "round_snapshots.py");
const PROJECTS = read("backend", "routers", "projects.py");
const TOOLS = read("frontend", "js", "services", "tools.js");
const CHAT = read("frontend", "js", "components", "chat.js");
const CARD = read("frontend", "js", "components", "round_summary.js");
const MCHAT = read("frontend", "js", "mobile", "m-chat.js");
const MAUTH = read("frontend", "js", "mobile", "m-auth.js");
const LEDGER = read("frontend", "js", "services", "agent_ledger.js");
const DICT = read("frontend", "js", "services", "i18n_dict.js");
const CSS = read("frontend", "css", "style.css");

const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

/** 取某个 def 的函数体（缩进法：def 之后连续的同/更深缩进行） */
function pyBody(src, defHead) {
  const at = src.indexOf(defHead);
  if (at === -1) return "";
  const lines = src.slice(at).split("\n");
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** 取 JS 里某个函数/代码块的源码片段：从 open 起按花括号配对 */
function jsBlock(src, openFragment) {
  const at = src.indexOf(openFragment);
  if (at === -1) return "";
  const start = src.indexOf("{", at);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return "";
}

/** 逐笔取出 post("<route>", {...}) 的实参对象。
 *  不能用 split(route).slice(1) + includes：那样每一"段"其实一直读到下一笔调用（最后一读到文件尾），
 *  某一笔丢了 run_id，会从后面那笔借到分数——变异取证实测漏掉两条。 */
function postArgs(src, route) {
  const opener = `post("${route}"`;
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(opener, from);
    if (at === -1) break;
    const brace = src.indexOf("{", at + opener.length);
    let depth = 0, end = -1;
    if (brace !== -1) {
      for (let j = brace; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) { end = j; break; }
      }
    }
    out.push(end === -1 ? "" : src.slice(brace, end + 1));
    from = end === -1 ? at + opener.length : end + 1;
  }
  return out;
}

// ── ① 三个写端点：先快照，写成功才记账 ────────────────────
const ENDPOINTS = [
  ['async def apply_file_edit(req: ApplyEditRequest):', "apply-edit"],
  ['async def create_file(req: CreateFileRequest):', "create-file"],
  ['async def append_file(req: AppendFileRequest):', "append-file"],
];
for (const [head, label] of ENDPOINTS) {
  const body = pyBody(PROJECTS, head);
  const begin = body.indexOf("round_snapshots.begin_write(");
  const write = body.indexOf("write_text_file(");
  const finish = body.indexOf("round_snapshots.finish_write(");
  must(body, `没找到 ${label} 端点`);
  must(begin !== -1 && write !== -1 && begin < write,
    `${label}：begin_write 没排在 write_text_file 之前——原文被覆盖后就再也取不到了`);
  must(finish !== -1 && write < finish,
    `${label}：finish_write 没排在写入之后（或根本没用）——写失败也会记进清单，卡片会报没发生的事`);
  must(body.includes("req.run_id"), `${label}：没把 req.run_id 交给 begin_write，这一轮的写入进不了清单`);
}
must((PROJECTS.match(/run_id: str = ""/g) || []).length >= 3,
  "三个写请求模型都该有可选的 run_id（缺省空串＝老前端不传也照旧写入）");
for (const [route, verb] of [["/round-files", "get"], ["/round-diff", "get"], ["/round-revert", "post"]]) {
  must(PROJECTS.includes(`@router.${verb}("${route}")`), `缺少读/撤路由 ${verb.toUpperCase()} ${route}`);
}

// ── ② 快照落点与 run_id 收口 ──────────────────────────────
must(/SNAPSHOT_DIR = DATA_DIR \/ "round_snapshots"/.test(SNAP),
  "快照目录不在 DATA_DIR 下：清单写进项目目录就会被撤回、被 git 提交");
must(/_RUN_ID_RE = re\.compile\(r"\^\[A-Za-z0-9_.-\]\{1,64\}\$"\)/.test(SNAP),
  "run_id 直接当目录名用，必须先过白名单正则（否则 `../` 能跑出快照根）");
must(/MAX_FILE_BYTES = 2 \* 1024 \* 1024/.test(SNAP),
  "超大文件不该存原文（撤回全靠这份原文，磁盘不能没顶）");

// ── ③ 一轮一份原文，行数按那份原文算 ─────────────────────
const beginBody = pyBody(SNAP, "def begin_write(");
// 「已有条目 → 复用 entry 里的 pre_file」这条分支必须排在「存一份新原文」之前：
// 顺序倒了，同一轮的第二次写入就会把中间态当起点，撤回去到一个哪一步都不是的结果。
const reuseAt = beginBody.indexOf('"pre_file": entry.get("pre_file")');
const storeAt = beginBody.indexOf("_store_pre(rid, raw)");
must(reuseAt !== -1 && storeAt !== -1 && reuseAt < storeAt,
  "begin_write 命中已有条目时没复用第一次的原文（或复用分支排到了存新原文之后）");
must(beginBody.includes("len(files) >= MAX_FILES_PER_RUN"), "begin_write 没有每轮文件数上限");
const finishBody = pyBody(SNAP, "def finish_write(");
must(/_count_diff\(_read_pre\(rid, entry\), post_raw\)/.test(finishBody),
  "行数没按「本轮首次原文 ↔ 当前」算——多轮写入会把同一行重复计进合计");
must(finishBody.includes('"files": {}') && finishBody.includes('atomic_write_json(_manifest_path(rid), doc)'),
  "清单只在 finish_write 里落盘（begin 只存原文）");

// ── ④ 撤回：现场对不上就跳过 ──────────────────────────────
const revertBody = pyBody(SNAP, "def revert(");
must(/_entry_state\(project_dir, entry\)/.test(revertBody), "revert 没做现场体检（还存在吗、被改过吗）");
must(/state\["drifted"\][\s\S]{0,200}?skipped\.append\([\s\S]{0,80}?"drifted"/.test(revertBody),
  "revert 没把漂移项跳过并回报——撤回会把用户本轮之后的修改一起抹掉");
must(/if entry\.get\("created"\):[\s\S]{0,300}?target\.unlink\(\)/.test(revertBody),
  "本轮新建的文件在撤回时没删除");
must(/backup_dir \/ f"\{int\(entry\.get\('seq'\) or 0\):04d\}\.cur"/.test(revertBody),
  "还原前没留一份撤回时的现场（撤回自己出错时无从捞回）");
must(/key=lambda e: -int\(e\.get\("seq"\) or 0\)/.test(revertBody),
  "撤回没按写入顺序倒着来");

// ── ⑤ 前端 run_id 与写入同源 ──────────────────────────────
must(/ledger\.runId = `run_\$\{Date\.now\(\)\.toString\(36\)\}_\$\{rand\}`/.test(LEDGER),
  "账本 runId 退回短随机数：7 天窗口里撞车就会把两轮并进一条清单，撤销连不相干那轮一起撤");
must(TOOLS.includes("function roundIdParam(ctx = {})") && /ctx\.ledger\?\.runId/.test(TOOLS),
  "run_id 没从账本取（本轮标识只能有一个出处）");
for (const route of ["/projects/apply-edit", "/projects/create-file", "/projects/append-file"]) {
  const hits = postArgs(TOOLS, route);
  must(hits.length > 0 && hits.every(h => h.includes("run_id: roundIdParam(callCtx)")),
    `tools.js 里 ${route} 的自动应用没带 run_id`);
}
must(/result\._structured\._runId = roundIdParam\(ctx\)/.test(TOOLS),
  "没把本轮 id 捎到 structured 上——手动「接受」的写入进不了这一轮的清单");
must(/data\._runId \|\| ""/.test(CHAT), "chat.js 手动「接受」没带本轮 id");
for (const route of ["/projects/apply-edit", "/projects/create-file"]) {
  const hits = postArgs(CHAT, route);
  must(hits.length > 0 && hits.every(h => h.includes('run_id: data._runId || ""')),
    `chat.js 里 ${route} 的手动「接受」没带 run_id`);
}
for (const route of ["/projects/apply-edit", "/projects/create-file", "/projects/append-file"]) {
  const hits = postArgs(MAUTH, route);
  must(hits.length > 0 && hits.every(h => h.includes("run_id: runId")),
    `移动 sheet 的 ${route} 接受写入没带本轮 id`);
}
must(/const runId = structured\._runId \|\| "";/.test(MAUTH), "移动侧本轮 id 取值处变了");

// ── ⑥ 收尾挂载：只挂一次、回填 metadata ───────────────────
must(/attachRoundSummary\(run\);/.test(CHAT), "桌面 policy.finish 没挂载本轮总结");
// kernel 不 await finish：回过来时这一场已从 run 登记表退了。按登记项判可见 = 永远不重排，
// 卡片要等下一次刷新才出现（走查实测踩过）。
must(/run\.genConvId === state\.currentConversationId/.test(CHAT),
  "桌面挂载后要按「当前会话」判是否重排，不能读 run 登记表");
must(/mountRoundSummary\(run, \(\) => mRenderAllMessages\(\)\)/.test(MCHAT),
  "移动侧没挂载本轮总结（或挂了没重排：kernel 不 await finish）");
must(/renderRoundSummary\(msg\.roundSummary, \{ readOnly: true \}\)/.test(MCHAT),
  "移动侧要只读呈现（不出现「撤销」）");
const mountBody = jsBlock(CARD, "export async function mountRoundSummary(");
must(mountBody.includes('if (res.code !== 0 || !res.data?.files?.length) return;'),
  "这一轮没改文件时也必须不出卡片（空壳会让人以为撤的是别的东西）");
must(/const metadata = \{ roundSummary: msg\.roundSummary \};/.test(mountBody),
  "卡片要嵌在 metadata.roundSummary 键下（摊平写就成了 runId/project，刷新后认不出来）");
must(/metadata\.toolResults = msg\.toolResults/.test(mountBody),
  "PATCH 的 metadata 是整块覆盖：不回填 toolResults 就会把工具结果抹掉");
must(/roundSummary/.test(CHAT) && /msg\.role === "assistant" && msg\.roundSummary\?\.runId/.test(CHAT),
  "renderMessage 没渲染本轮总结卡片");

// ── ⑦ 交互：确认框先行、文案有翻译、diff 复用配色 ─────────
const revertFn = jsBlock(CARD, "async function onRevert(");
must(/dlgConfirm\([\s\S]{0,400}danger: true[\s\S]{0,200}?post\("\/projects\/round-revert"/.test(revertFn),
  "撤销没先过 danger 确认框就发撤回请求");
const keys = [...CARD.matchAll(/t\("([^"]+?)"/g)].map(m => m[1]).filter(k => /[一-鿿]/.test(k));
const missing = keys.filter(k => !DICT.includes(`"${k}":`));
must(missing.length === 0, `EN_DICT 缺词条：${missing.join(" | ")}`);
must(/class(Name)? = "file-edit-diff-pre"/.test(CARD) || /\.file-edit-diff-pre/.test(CARD),
  "审阅差异要复用既有 .file-edit-diff-pre/.diff-line 配色，别另立一份 diff 样式");
must(/reviewBtn\.setAttribute\("aria-expanded"/.test(CARD) && /more\.setAttribute\("aria-expanded"/.test(CARD),
  "展开/审阅按钮缺 aria-expanded（读屏与走查都判不出状态）");
for (const cls of [".round-summary", ".round-file-name", ".round-btn-revert", ".round-more"]) {
  must(CSS.includes(cls), `style.css 缺 ${cls} 样式`);
}

if (problems.length) {
  console.error("本轮总结守卫失败:");
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("本轮总结守卫通过。");
