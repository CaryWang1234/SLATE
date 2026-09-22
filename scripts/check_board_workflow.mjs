/**
 * 黑板工作流视图守卫：scripts/check_board_workflow.mjs
 *
 * 这个视图把三样本来各活各的东西接到一起（Actions 目录 / agent 账本 / 团队会话），
 * 接错一处不会报错，只会"看着对而数据是假的"。所以钉的是接合处：
 *  ①第 5 档视图三处同名：index.html 的 data-view、BOARD_VIEW_LABELS 的键、renderBoardView
 *    的分派。任一处漏了，按钮点了没反应或视图永远空白；
 *  ②分派必须排在"卡片为空就早退"之前——工作流视图不依赖黑板卡片，排后面就是空板即空视图；
 *  ③活层绝不写 boardCards：setBoardCards 的 notify 会连带 renderMermaid + renderBoardView
 *    整树重绘，运行中每秒一跳会把界面抖散（这条是本项目踩过的事件风暴）；
 *  ④spawn 边靠 parentCallId：账本上行少带这一个字段，后端的叶子查询就取不到那一行，
 *    星图照样画得出来，只是每个人的工具全都不见了；
 *  ⑤团队落库的 session 与 run 都得带 conversationId，否则 /team/latest 按对话取数取空；
 *  ⑥图上每个 .bw-/.star- 类都得在 style.css 里有规则，且每个中文键都得进英文词典——
 *    这两类"渲染出来了但没人管"的洞，肉眼在中文浅色主题下永远看不见。
 *
 * 纯静态的部分用正则钉；能跑的（星图布局、类名与词典的反查）真 import 实现来跑。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EN_DICT } from "../frontend/js/services/i18n_dict.js?v=20260922-002";
import { memberHue, roleRank, starPositions } from "../frontend/js/services/star_map.js?v=20260922-002";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const WF = read("../frontend/js/components/board_workflow.js");
const STAR = read("../frontend/js/services/star_map.js");
const BOARD = read("../frontend/js/components/whiteboard.js");
const HTML = read("../frontend/index.html");
const CSS = read("../frontend/css/style.css");
const LEDGER = read("../frontend/js/services/agent_ledger.js");
const LOOP = read("../frontend/js/services/agent_loop.js");
const TOOLS = read("../frontend/js/services/tools.js");
const SUB = read("../frontend/js/services/subagent.js");
const TEAM = read("../frontend/js/components/team.js");
const CHAT = read("../frontend/js/components/chat.js");
const PY = read("../backend/routers/events.py");

// ── 1. 第 5 档视图：三处同名，且分派排在空卡片早退之前 ──────────
assert.match(HTML, /<button class="board-view-btn" data-view="workflow"/, "index.html 缺工作流视图按钮");
assert.match(BOARD, /const BOARD_VIEW_LABELS = \{[\s\S]*?\bworkflow:\s*"工作流"/, "BOARD_VIEW_LABELS 缺 workflow");
assert.match(BOARD, /if \(currentBoardView === "workflow"\) \{\s*renderWorkflowView\(boardViewPanel, meta\);\s*return;\s*\}/,
  "renderBoardView 缺工作流分派");
const dispatch = BOARD.indexOf('if (currentBoardView === "workflow") {');
// 从分派点往后找"卡片为空即早退"：这个早退必须落在分派之后
const emptyReturn = BOARD.indexOf("if (!cards.length) {", dispatch);
assert.ok(dispatch > 0 && emptyReturn > 0 && dispatch < emptyReturn,
  "工作流分派必须排在「卡片为空即早退」之前，否则空黑板上这个视图永远空白");
// 工作流视图不看黑板卡片，也就不该跟着卡片开关一起被隐藏
assert.match(BOARD, /stepToggle\.classList\.toggle\("hidden", currentBoardView === "workflow"\)/,
  "工作流视图下该收起「显示工具步骤」开关");
// 进入即起 tick，离开即停：漏了停就是后台常驻定时器
assert.match(BOARD, /currentBoardView === "workflow" && !boardViewCollapsed\) startWorkflowTick\(\);\s*else stopWorkflowTick\(\);/,
  "视图切换必须成对地起停 tick");
assert.match(BOARD, /import \{ renderWorkflowView, startWorkflowTick, stopWorkflowTick, initBoardWorkflow \} from "\.\/board_workflow\.js\?v=\d{8}-\d{3}"/,
  "whiteboard.js 未按统一的 ?v= 引 board_workflow");

// ── 2. 抗重绘风暴：这个模块不许碰黑板数据 ────────────────────
// 注释里写的是"为什么不能碰"，剥掉注释再查，否则自己的告诫会把自己钉死
const WF_CODE = WF.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
for (const banned of ["setBoardCards(", "renderAllCards(", "drawArrows(", "state.boardCards"]) {
  assert.ok(!WF_CODE.includes(banned), `board_workflow.js 不得调用 ${banned}：写黑板数据会触发整树重绘风暴`);
}
// 状态只能经 setter 写：与聊天框顶部那套控件共用一份真相
// 只读比较（=== true）可以，赋值会把 store 的 notify 绕过
assert.ok(!/state\.(chatMode|reasoningEffort|harness(?:\.\w+)?)\s*=[^=]/.test(WF),
  "不得直接改 state 字段，走 store 的 setter");
assert.match(WF, /setChatMode\(modeSel\.value\)/, "回复方式必须经 setChatMode");
assert.match(WF, /setReasoningEffort\(effortSel\.value\)/, "思考档位必须经 setReasoningEffort");
// 运行现场由 chat.js 注入而不是反向 import：chat.js 已 import whiteboard.js
assert.ok(!WF.includes('from "../components/chat.js"'), "board_workflow 不得 import chat.js（会成环）");
assert.match(WF, /await import\("\.\.\/app\.js\?v=/, "跳转团队面板走动态 import app.js");
assert.match(CHAT, /setWorkflowRunApi\(\{/, "chat.js 未注入运行现场");

// ── 3. 活层只 patch 叶子：整段重建等于把风暴搬进自己家 ─────────
const patchBody = WF.slice(WF.indexOf("function patchWorkflowLive()"), WF.indexOf("function noteLiveStarts("));
assert.ok(patchBody.length > 400, "没抓到 patchWorkflowLive 函数体");
assert.match(patchBody, /refs\?\.phase\?\.isConnected/, "活层先确认节点还挂在文档上");
assert.match(patchBody, /if \(refs\.phase\.textContent !== phase\)/, "文本没变就不写 DOM");
assert.match(patchBody, /liveSig\(steps\) !== refs\.liveSig/, "步骤序列变了才重建那条小 ol");
assert.ok(!/container\.innerHTML|boardViewPanel/.test(patchBody), "活层不碰视图外壳");
// 定时器与 rAF：视图关掉就得停，rAF 合帧避免同一 tick 里重复 patch
assert.match(WF, /wfTimer = setInterval\(schedulePatch, TICK_MS\)/);
assert.match(WF, /if \(wfRafPending\) return;/, "schedulePatch 必须合帧");
// 卡片墙只渲染有界数量，展开的步骤懒加载（列表摘要里没有正文）
assert.match(WF, /list\.slice\(0, MAX_CARDS\)/);
assert.match(WF, /await loadSteps\(action\.id\)/, "步骤清单要懒加载");
assert.match(WF, /res\.data\?\.action\?\.steps/, "Action 详情的步骤在 data.action.steps 下");
// 坏文件的提示必须由 renderGrid 自己挂：置顶/刷新都会重建网格，挂在别处等于提示会自己消失
const gridFn = WF.slice(WF.indexOf("function renderGrid(grid)"), WF.indexOf("export async function renderWorkflowView"));
assert.ok(WF.includes("function appendBroken(grid)"), "解析失败提示要有统一挂载函数");
assert.equal((gridFn.match(/appendBroken\(grid\)/g) || []).length, 2, "空墙与非空墙两条路径都要挂提示");
// 空态必须留一句话：留着上一批步骤不删，会把"这场没跑过"读成"还在跑上一场"
assert.ok(patchBody.includes('className = "bw-live-empty"'), "活层空态要有占位行");
assert.match(CHAT, /const mine = !boardRunConvId \|\| boardRunConvId === \(state\.currentConversationId \|\| ""\);/,
  "运行现场必须按对话作废：跨对话播上一场的步骤是假数据");

// ── 4. spawn 边：账本 → 上行 → 后端口径三处对齐 ───────────────
assert.match(LEDGER, /parentCallId: event\.parentCallId \|\| ""/, "toWire 必须上行 parentCallId");
assert.match(LEDGER, /emit\(type, \{ callId = "", parentCallId = ""/, "emit 要收 parentCallId");
assert.match(LOOP, /callIdFor: \(i\) => \(ledger \? ledger\.callId\(run\.round, i\) : ""\)/,
  "kernel 要把本行 callId 交给执行器");
assert.match(LOOP, /ledger,\s*\n\s*onCallStart/, "kernel 要把 ledger 交给执行器");
assert.match(TOOLS, /ledgerCallId: ctx\.callIdFor\?\.\(i\) \|\| call\.id \|\| ""/, "executeToolCalls 要透传 ledgerCallId");
assert.match(TOOLS, /parentCallId: callCtx\.ledgerCallId \|\| ""/, "subagent_run 要把父调用交给引擎");
assert.match(SUB, /const childId = `\$\{parentCallId\}s\$\{index\}`/, "子代理行 id 由父 callId 派生");
assert.match(SUB, /ledger\.emit\(type, \{ callId: childId, parentCallId, tool: label/, "spawn 行要同时带 childId 与 parentCallId");
assert.match(SUB, /started: \(task\) => emit\("subagent\.started"/, "子代理开始要记一行");
assert.match(SUB, /finished: \(result\) => emit\("subagent\.finished"/, "子代理结束要记一行");
assert.ok(!/ledger\.emit\("call\./.test(SUB), "子代理不得伪装成 call.* —— 那会长成步骤卡");
assert.match(PY, /type = 'subagent\.started' AND parent_call_id <> ''/, "后端叶子查询按 parent 非空认子代理");
assert.match(PY, /type = 'call\.ready' AND parent_call_id = ''/, "顶层工具叶子按 call.ready 且 parent 为空");

// ── 5. 团队落库：会话与账本都得挂在同一场对话上 ────────────────
assert.match(TEAM, /post\("\/events\/team\/append"/, "团队发言要落库");
assert.match(TEAM, /conversationId: state\.currentConversationId \|\| ""/, "团队会话要带 conversationId");
assert.match(TEAM, /openLedgerRun\(\{ conversationId: teamRemote\.conversationId, mode: "team"/,
  "每位成员的发言开一个 mode:team 的账本 run");
assert.match(TEAM, /function recordTeamTurn\(ctx, rec, runId = ""\)/, "发言落库入口要收 runId");
assert.match(TEAM, /runId,\s*\n\s*text: String\(rec\.text \|\| ""\)/, "发言行必须把自己那条 run 带上");
assert.match(TEAM, /hue: memberHue\(m\?\.id\)/, "成员色相按 id 算，纯函数才可复现");
assert.match(TEAM, /remote: teamRemote\.syncState === "ok"/, "本地历史要标出这场是否落库成功");
assert.ok(TEAM.includes("recordTeamTurn(teamRemote, rec, runId)"), "常规发言未接落库");
assert.ok(TEAM.includes("recordTeamTurn(teamRemote, rec, \"\")"), "强制拍板那行没记账");

// ── 6. 星图布局可复现：活数据刷新不该让星体乱跳 ────────────────
const roster = [
  { id: "m1", name: "决策者", role: "decider" },
  { id: "m2", name: "分析师", role: "analyst" },
  { id: "m3", name: "创意者", role: "creative" },
  { id: "m4", name: "路人", role: "member" },
];
const once = starPositions(roster, { cx: 210, cy: 170, radius: 108 });
const twice = starPositions([...roster].reverse(), { cx: 210, cy: 170, radius: 108 });
assert.deepEqual(once.map(p => [p.member.id, p.x.toFixed(1), p.y.toFixed(1)]),
  twice.map(p => [p.member.id, p.x.toFixed(1), p.y.toFixed(1)]), "布局只由成员集合决定，与传入顺序无关");
assert.equal(once[0].member.id, "m1", "决策者排第一位");
assert.ok(once[0].y < 170, "第一个扇区居中朝上");
assert.equal(roleRank("decider") < roleRank("ghost"), true, "未知角色排最后");
assert.equal(memberHue("m1"), memberHue("m1"), "hue 是 id 的纯函数");
assert.ok(Number.isInteger(memberHue("m1")) && memberHue("m1") >= 0 && memberHue("m1") < 360, "hue 落在色环内");
assert.equal(memberHue(undefined), 0, "缺 id 不该 NaN");
assert.match(STAR, /import \{ t \} from "\.\/i18n\.js\?v=/, "星图文字不过 t() 就永远中文（observer 跳过 svg）");

// ── 7. 类名与词典：渲染出来的东西不能没人管 ───────────────────
const usedClasses = new Set();
const addClass = (cls) => {
  if (cls && !/[${}]/.test(cls) && /^(bw|star)-[a-z][a-z0-9-]*$/.test(cls)) usedClasses.add(cls);
};
for (const src of [WF, STAR]) {
  for (const m of src.matchAll(/\b((?:bw|star)-[a-z][a-z0-9-]*)\b/g)) addClass(m[1]);
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    for (const cls of m[1].split(/\s+/)) addClass(cls);
  }
  for (const m of src.matchAll(/classList\.toggle\("([^"]+)"/g)) addClass(m[1]);
}
const missingCss = [...usedClasses].filter(c => !new RegExp(`\\.${c}(?![\\w-])`).test(CSS)).sort();
assert.deepEqual(missingCss, [], `这些类在 style.css 里没有规则: ${missingCss.join(", ")}`);

const usedKeys = new Set();
for (const src of [WF, STAR, TEAM]) {
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) usedKeys.add(m[1]);
}
const unmapped = [...usedKeys].filter(k => /[一-鿿]/.test(k) && !(k in EN_DICT)).sort();
assert.deepEqual(unmapped, [], `这些中文键缺英文词典项: ${unmapped.join(", ")}`);

console.log("check_board_workflow: 黑板工作流视图接线 / 抗风暴 / spawn 边 / 星图 / 词典与样式 通过");
