/**
 * 团队讨论的"唤醒 + 拍板"接线守卫：scripts/check_team_wake.mjs
 *
 * 这一层把三样东西接到一起（辩论循环 / bg_tasks 那一条唤醒队列 / 右栏任务中心），
 * 每一处接错都不报错，只会"看着对而这场地基是假的"。所以钉的是接合处，不是行数：
 *  ①唤醒只有一条路：团队不自建轮询或 SSE，只往 bg_tasks 的任务表 + 事件池里写
 *    （subagent_jobs 立的先例）。第二条链路迟早分叉成"手机问得比桌面多"那种病；
 *  ②awaiting 是跨端词：事件种类、徽标种类、面板话术三处都要认识它。
 *    徽标只认 task_list 的闭集 FLAG_KINDS，所以"等你拍板"借 needs 表达——
 *    把它算成 error 就是把等人的事标成失败的事；
 *  ③拍板必须真的等人：dlgChoice 要 await（不 await 等于自动采纳，功能整块退化而界面照旧），
 *    判定只看 value 不看标签（标签会随界面语言翻），取消算"未拍板"而不是"采纳"，
 *    重开要有次数上限（每重开一轮是全员一次真开销）；
 *  ④拍板行不是发言：它挂的是合成成员 id "signoff"，后端按名册取发言时天然排除，
 *    而摘要统计要按 SPEECH_ACTIONS 过滤——否则「发言统计 共 5 条」里有两条是人签的字；
 *  ⑤通知各用各的 tag：系统通知同 tag 会互相顶掉，"等你拍板"被后一条完成通知顶掉就等于没提醒；
 *  ⑥三个新状态的 CSS 规则块要真在，词典要真有键——中文浅色主题下肉眼永远看不见这两类洞。
 *
 * 判据一律从源码现读（不从页面自指）；禁词断言先剥注释，免得自己的告诫把自己钉死。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EN_DICT } from "../frontend/js/services/i18n_dict.js?v=20261003-001";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const TEAM = strip(read("../frontend/js/components/team.js"));
const BG = strip(read("../frontend/js/services/bg_tasks.js"));
const PANEL = strip(read("../frontend/js/components/bg_task_panel.js"));
const NOTIF = strip(read("../frontend/js/services/notify.js"));
const DIALOG = strip(read("../frontend/js/services/dialog.js"));
const LIST = strip(read("../frontend/js/services/task_list.js"));
const PY = read("../backend/routers/events.py");
const CSS = read("../frontend/css/style.css");
const HTML = read("../frontend/index.html");

let checks = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. 只有一条唤醒通道 ───────────────────────────────────
ok("W1 团队侧不许自建第二条唤醒链路（轮询/SSE/WebSocket）",
  !/EventSource|new WebSocket|setInterval\(/.test(TEAM),
  "有动静就走 bg_tasks 那一条队列，两条迟早分叉");
ok("W2 团队用的是 bg_tasks 的三个入口",
  /import \{ upsertLocalTask, pushLocalBgEvent, registerLocalTaskStopper \} from "\.\.\/services\/bg_tasks\.js\?v=\d{8}-\d{3}"/.test(TEAM));
const UPSERT_CALLS = TEAM.match(/syncTeamTask\(/g) || [];
ok("W3 在册两次：开场挂一行、收尾结一行（中间没人管就一直是「在跑」）",
  UPSERT_CALLS.length === 3, `实际 ${UPSERT_CALLS.length} 处（含定义那一处）`);
ok("W4 收尾那行按是否手动停止分状态",
  /syncTeamTask\(teamRemote, \{\s*state: stoppedManually \? "stopped" : "exited",/.test(TEAM));
ok("W5 待拍板事件进的是同一个池子，且带着归属",
  /kind: "awaiting",/.test(TEAM)
  && /pushLocalBgEvent\(\{[\s\S]{0,420}conversation_id: ctx\.conversationId,[\s\S]{0,60}origin: "local",/.test(TEAM));
ok("W6 任务行标了 family，面板与提醒才认得出这是团队讨论",
  /family: "team",/.test(TEAM));

// ── 2. awaiting 是跨端词，四处都得认识它 ──────────────────
ok("W7 bg_tasks 的话术认识 awaiting",
  /kind === "awaiting" \? "等你拍板"/.test(BG));
ok("W8 徽标把 awaiting 算「需要操作」而不是失败",
  /const needs = e\.kind === "stopped" \|\| e\.kind === "awaiting";[\s\S]{0,140}kind: ok \? "done" : needs \? "needs" : "error"/.test(BG));
ok("W9 徽标种类仍是闭集三值（没为团队新造第四种）",
  /export const FLAG_KINDS = \["done", "needs", "error"\];/.test(LIST));
ok("W10 团队任务的系统提醒只由团队自己发（这里只记徽标，否则一次结束响两声）",
  /if \(t\.family !== "team"\) \{[\s\S]{0,300}notifyTaskComplete\(title, body\)/.test(BG)
  && /recordTaskFlag\(convId, \{ kind: ok \? "done" : "error"/.test(BG));
ok("W11 停止器是登记表而不是单点：两家各认各的 id",
  /const localStoppers = \[\];/.test(BG)
  && /for \(const stop of localStoppers\) \{/.test(BG)
  && /if \(!String\(taskId \|\| ""\)\.startsWith\("team:"\)\) return false;/.test(TEAM));
ok("W12 面板点「停止」对团队行走的是 stopDiscussion",
  /registerLocalTaskStopper\(async \(taskId\) => \{[\s\S]{0,200}stopDiscussion\(\);/.test(TEAM));

// ── 3. 拍板真的在等人 ────────────────────────────────────
const SIGNOFF_BLOCK = (() => {
  const at = TEAM.indexOf("async function requestTeamSignoff");
  if (at < 0) return "";
  const after = TEAM.slice(at);
  const end = after.search(/\n\}/);
  return end < 0 ? after : after.slice(0, end + 2);
})();
ok("W13 有 requestTeamSignoff 这段，且真的 await 弹窗（不 await 等于自动采纳）",
  SIGNOFF_BLOCK.length > 0 && /await dlgChoice\(/.test(SIGNOFF_BLOCK), SIGNOFF_BLOCK.slice(0, 80));
ok("W14 夜间模式（全托管）不提问，但那一行照画（自动采纳不许读成用户点过头）",
  /permissionModeFor\(ctx\.conversationId\) === "night"/.test(SIGNOFF_BLOCK)
  && /finalizeEntry\(addDebateEntry\(SIGNOFF_MEMBER, "decided"\), "decided", "", text\);/.test(SIGNOFF_BLOCK)
  && /return signoffRec\("decided", text, round\);/.test(SIGNOFF_BLOCK));
ok("W15 判定只认 value，不许拿翻译后的标签比（英文界面会认不出来）",
  /answer === "approve"/.test(SIGNOFF_BLOCK) && !/answer\.includes\(|answer === t\(/.test(SIGNOFF_BLOCK),
  "按标签比较＝把这条判据挂在会随语言变的字符串上");
ok("W16 取消/Esc 算「未拍板」而不是采纳",
  /const approved = answer === "approve";[\s\S]{0,120}const outcome = approved \? "decided" : "reopened";/.test(SIGNOFF_BLOCK));
ok("W17 拍板行既进上下文也落账（不落账的话重看这场就少一格）",
  /entries\.push\(outcome\);/.test(TEAM) && /recordTeamTurn\(teamRemote, outcome\);/.test(TEAM));
ok("W18 只有签了字才结束讨论",
  /if \(!outcome \|\| outcome\.action === "decided"\) verdict = rec;/.test(TEAM));
ok("W19 重开有次数上限（每重开一轮是全员一次真实开销）",
  /const TEAM_REOPEN_CAP = \d+;/.test(TEAM) && /reopenUsed < TEAM_REOPEN_CAP/.test(TEAM));
ok("W20 强制拍板那份同样等人签字，不签就退回未达成",
  /verdict = await forceVerdict\(topic, boardContext, entries, teamRemote\);[\s\S]{0,320}if \(outcome\.action !== "decided"\) verdict = null;/.test(TEAM));
ok("W21 待拍板时弹窗会真出现（面板在背后也要响一次人）",
  /teamPanel\?\.classList\.contains\("hidden"\)[\s\S]{0,160}notifyTaskComplete\([\s\S]{0,80}"slate-team-signoff"\)/.test(SIGNOFF_BLOCK));

// ── 4. 三种新状态伪造不出来，也不算发言 ──────────────────
const VERBS = (TEAM.match(/function parseDebateAction[\s\S]*?\/\^\s*\\s\*【([^】]*)】/)?.[1] || "")
  .replace(/[()]/g, "").split("|").filter(Boolean);
ok("W22 动作解析仍只那六个词：拍板三态演不出来",
  VERBS.length === 6 && !VERBS.includes("待拍板") && !VERBS.includes("已拍板") && !VERBS.includes("未拍板"),
  `实际：${VERBS.join("|")}`);
const SPEECH = (TEAM.match(/const SPEECH_ACTIONS = \[([\s\S]*?)\];/)?.[1] || "")
  .split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
ok("W23 发言口径与动作表里的六种发言一字不差（多一个少一个都会把摘要算歪）",
  SPEECH.length === 6 && ["propose", "support", "oppose", "rebut", "supplement", "verdict"].every(k => SPEECH.includes(k)),
  `实际：${SPEECH.join(",")}`);
ok("W24 摘要统计读的是过滤后的那几行",
  /const speech = entries\.filter\(e => SPEECH_ACTIONS\.includes\(e\.action\)\);/.test(TEAM)
  && /共 \{n\} 条（\{counts\}）", \{ n: speech\.length/.test(TEAM));
ok("W25 拍板行挂的是合成成员，后端按名册取发言时天然排除它",
  /const SIGNOFF_MEMBER = \{ id: "signoff",/.test(TEAM)
  && PY.includes('if turn["memberId"] in member_ids'));

// ── 5. 通知不互相顶掉 ────────────────────────────────────
ok("W26 系统通知的 tag 已参数化（写死同 tag 会让「等你拍板」被后一条顶掉）",
  /function showSystemNotification\(title, body, tag\)/.test(NOTIF)
  && /tag: tag \|\| "slate-task-complete"/.test(NOTIF));
ok("W27 团队两处通知各带自己的 tag",
  (NOTIF.match(/export function notifyTaskComplete\(title, body, tag\)/) ? 1 : 0) === 1
  && /"slate-team-signoff"/.test(TEAM) && /"slate-team-discussion"/.test(TEAM));
ok("W37 tag 一路传到 Notification：中间那一跳也得带上（只改签名等于没参数化）",
  /showSystemNotification\(title, body, tag\);/.test(NOTIF));
ok("W28 手动停止那里不再单独响一声（终局提醒只有一处出口）",
  /function stopDiscussion[\s\S]{0,700}?notifyTaskComplete/.test(TEAM) === false);

// ── 6. 画得出来、翻得出来 ────────────────────────────────
for (const cls of ["awaiting", "decided", "reopened"]) {
  ok(`W29 .debate-entry.action-${cls} 有规则块（不是被别的选择器借走）`,
    new RegExp(`\\.debate-entry\\.action-${cls}\\s*\\{`).test(CSS));
  ok(`W30 .debate-action-badge.action-${cls} 有规则块`,
    new RegExp(`\\.debate-action-badge\\.action-${cls}\\s*\\{`).test(CSS));
}
for (const key of ["待拍板", "未拍板", "我", "等待你拍板", "采纳拍板", "继续讨论",
  "已采纳这个决策", "未拍板：继续讨论", "夜间模式：决策已自动采纳",
  "团队讨论待拍板", "团队讨论等你拍板", "团队讨论已停止", "团队讨论已完成",
  "决策需我拍板", "这一场的决策要等你签字才结束", "看这场讨论的结论",
  "停止这场讨论", "在团队面板里重看这场讨论"]) {
  ok(`W31 英文词典里有「${key}」`, typeof EN_DICT[key] === "string" && EN_DICT[key].length > 0);
}
ok("W32 拍板开关在页面上存在且默认勾着（默认必须是「要人签字」）",
  /id="team-signoff-toggle" checked/.test(HTML));
ok("W33 选择框只回 value：dlgChoice 存在且 resolve 的是 c.value",
  /export function dlgChoice\(titleText, questionText, choices\)/.test(DIALOG)
  && /btn\.addEventListener\("click", \(\) => finish\(c\.value\)\)/.test(DIALOG));

// ── 7. 面板不新长第二种行 ────────────────────────────────
ok("W34 团队行走的是既有那一种行（panelRows 仍只读 bgTasks + state.runs）",
  /function panelRows\(\) \{\s*\n\s*const tasks = bgTasks\(\);[\s\S]{0,200}state\.runs/.test(PANEL)
  && !/function renderTeamRow/.test(PANEL));
ok("W35 团队行的跳转认得 team: 前缀并回团队面板",
  /const isTeam = task\.family === "team";/.test(PANEL)
  && /String\(task\.task_id\)\.slice\("team:"\.length\)/.test(PANEL)
  && /await import\("\.\.\/app\.js\?v=\d{8}-\d{3}"\)/.test(PANEL));
ok("W36 面板不许静态 import app.js（成环）",
  !PANEL.includes('from "../app.js'), "跳转一律动态 import");

console.log(`check_team_wake: 通过（${checks} 项判据）`);
