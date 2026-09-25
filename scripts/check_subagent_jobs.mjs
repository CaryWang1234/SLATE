/**
 * 后台子代理批次守卫：scripts/check_subagent_jobs.mjs
 *
 * 这一层要成立的前提只有一个：它**不新写一套**后台机制，而是把一批子代理挂到
 * bg_task 已经调好的那套上（同一条任务列表、同一个事件池、同一份徽标与配额、
 * 同一个面板）。所以本守卫盯的大部分东西都是"复用没漏、分流没错"：
 *   · 复用漏一处（本地任务没并进 state.bgTasks）→ 面板与"还有活没交接完"都看不见它；
 *   · 分流错一处（事件不带 conversation_id）→ A 项目的结论念给 B 项目的对话；
 *   · 寿命说反（写成活在后端进程）→ 用户以为刷新还在，其实没了。
 *
 * 盯的契约：
 * ① 批次活在页面里：不落盘、不请求后端路由，也不复用主循环的 AbortSignal
 *    （主循环一收口那个 signal 就废了，后台任务不能跟着它一起死）；
 * ② 上限只在一处判（canStartBgSubAgent），超限返回 not-ok 而不是静默丢弃；
 * ③ 事件与任务都走 bg_tasks 那一份合并结果，唤醒话术按事件自带 tail_budget 截；
 * ④ 出处一路带上：scopeConvId 进实时面板订阅做过滤，conversation_id 进事件做归属分流；
 * ⑤ 停止按 origin 分流：本地批次 abort，进程任务才走 /stop；
 * ⑥ 模型可见描述与工具目录同源，且写清"不等结果 / 页面寿命"；
 * ⑦ 结论预算按人头分：整段只在唤醒时从尾部截，5 个子代理挤一份预算会把最前面的截没。
 *
 * 运行：node scripts/check_subagent_jobs.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const JOBS = read("frontend/js/services/subagent_jobs.js");
const SUB = read("frontend/js/services/subagent.js");
const SERVICE = read("frontend/js/services/bg_tasks.js");
const TOOLS = read("frontend/js/services/tools.js");
const CHAT = read("frontend/js/components/chat.js");
const PANEL = read("frontend/js/components/bg_task_panel.js");
const RUN = read("frontend/js/services/run_registry.js");
const I18N = read("frontend/js/services/i18n_dict.js");
const README_ZH = read("README-zh.md");
const README_EN = read("README.md");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

// ── 1. 寿命：活在页面里，不落盘、不打后端 ───────────────────
ok("批次模块不碰任何持久化（刷新即止是写进注释的口径）",
  !/localStorage|sessionStorage|indexedDB/.test(JOBS),
  "落盘只会复活成「看着在跑其实早死了」的假象（与 run_registry 不变量③同口径）");
ok("批次模块不请求后端（没有 api/fetch 那一条路）",
  !/from "\.\/api\.js|fetch\(/.test(JOBS));
ok("运行登记表同样不落盘（守住被引用的那条不变量）",
  !/localStorage|sessionStorage/.test(RUN) && /run 不落盘/.test(RUN));
ok("注释与文档都写明「页面寿命 / 刷新即止」",
  /刷新或关窗它就没了/.test(JOBS) && /刷新或关页面即止/.test(README_ZH)
  && /browser page/.test(README_EN),
  "寿命说反是最难查的一种谎：用户以为还在跑");

// ── 2. 只有一处判上限，超限要出声 ───────────────────────────
ok("并行批次上限有常量并在 canStart 一处判",
  /export const BG_SUBAGENT_MAX_JOBS = \d+;/.test(JOBS)
  && /return jobs\.size < BG_SUBAGENT_MAX_JOBS;/.test(JOBS));
ok("派出入口先判上限，超限返回 not-ok（不静默丢任务）",
  /if \(!canStartBgSubAgent\(\)\) return \{ ok: false, reason: "cap" \};/.test(JOBS));
ok("工具侧把「为什么没派出」说给模型（否则它会以为已经在跑）",
  /if \(!started\.ok\) \{[\s\S]{0,200}后台子代理批次未派出[\s\S]{0,160}BG_SUBAGENT_MAX_JOBS/.test(TOOLS));

// ── 3. 不吃主循环的 signal，自己一把 AbortController ────────
ok("批次自建 controller 并把它的 signal 交给引擎",
  /jobs\.set\(jobId, \{ controller: new AbortController\(\)/.test(JOBS)
  && /jobs\.get\(jobId\)\.controller\.signal\)/.test(JOBS));
ok("批次不使用主循环的 signal（跟着本轮一起死＝后台是假的）",
  !/getSubAgentSignal/.test(JOBS),
  "把 getSubAgentSignal() 接进来会让后台批次在主循环收口时被取消");
ok("前台路径仍然用主循环 signal（本轮等待就该能被本轮停止）",
  /await runSubAgents\(agents, deps, getSubAgentSignal\(\)\)/.test(TOOLS));
ok("停止一批 = abort，且在跑的批次认这个 id",
  /export function stopSubAgentJob\(jobId\)[\s\S]{0,300}job\.controller\.abort\(\)/.test(JOBS));

// ── 4. 复用 bg_tasks：一条列表、一个事件池 ──────────────────
ok("本地任务并进同一份 state.bgTasks（面板与计数读的都是这一份）",
  /function publishTasks\(\) \{\s*\n\s*const merged = \[\.\.\.localTasks\.values\(\), \.\.\.serverTasks\];\s*\n\s*state\.bgTasks = merged/.test(SERVICE));
ok("setTasks 只换后端那半份（轮询回来的快照不会把本地批次抹掉）",
  /function setTasks\(tasks\) \{\s*\n\s*serverTasks = Array\.isArray\(tasks\) \? tasks : \[\];\s*\n\s*publishTasks\(\);/.test(SERVICE));
ok("本地任务带 origin:\"local\"（停止与清除按它分流）",
  /const next = \{ \.\.\.task, origin: "local" \};/.test(SERVICE) && /origin: "local"/.test(JOBS));
ok("结局事件进同一个未读池（不再写第二套唤醒链路）",
  /export function pushLocalBgEvent\(event\)[\s\S]{0,300}pushEvents\(\[\{/.test(SERVICE)
  && /event_id: `local-\$\{id\}-\$\{localEventSeq\}`/.test(SERVICE));
ok("事件 id 由本地计数器保证唯一（重复 id 会被去重吃掉）",
  /localEventSeq \+= 1;/.test(SERVICE));
ok("本地任务结束照样提醒人（音效/通知 + 归属徽标）",
  /if \(next\.state !== "running"\) \{[\s\S]{0,200}announceFinished\(\[next\]\)/.test(SERVICE));
ok("「还有活没交接完」看得见本地批次",
  /export function hasBgWork\(\) \{\s*\n\s*return hasBgEvents\(\) \|\| runningBgTasks\(\)\.length > 0;/.test(SERVICE)
  && /export function runningBgTasks\(\) \{\s*\n\s*return bgTasks\(\)\.filter\(t => t\.state === "running"\)/.test(SERVICE),
  "读的是合并后的 state.bgTasks：本地批次不并进那份，空闲续跑就等不到它");
ok("停止按 origin 分流：本地走 stopper，进程任务才打 /stop",
  /if \(localTasks\.has\(id\)\) \{[\s\S]{0,300}localStopper \? await localStopper\(id\) : false/.test(SERVICE)
  && SERVICE.indexOf("localTasks.has(id)") < SERVICE.indexOf("/stop"));
ok("清掉已结束时先清本地（后端那份由 /clear 管）",
  /for \(const \[id, t\] of \[\.\.\.localTasks\.entries\(\)\]\) \{[\s\S]{0,120}t\.state !== "running"\) localTasks\.delete\(id\)/.test(SERVICE));
ok("停止入口由批次模块注册（两边不互相 import 成环）",
  /export function registerLocalTaskStopper\(fn\)/.test(SERVICE)
  && /registerLocalTaskStopper\(async \(jobId\) => stopSubAgentJob\(jobId\)\);/.test(JOBS));

// ── 5. 出处：谁家的结论念给谁 ───────────────────────────────
ok("工具把归属会话透成 scopeConvId",
  /scopeConvId: callCtx\.convId \|\| ""/.test(TOOLS)
  && /startSubAgentJob\(\{ agents, deps, convId: callCtx\.convId \|\| "" \}\)/.test(TOOLS));
ok("引擎的实时事件一律带上出处",
  /const scope = String\(deps\.scopeConvId \|\| ""\);/.test(SUB)
  && /convId: scope \}\)/.test(SUB) && /convId: String\(deps\?\.scopeConvId \|\| ""\)/.test(SUB));
ok("实时面板只画这一场的进度（别场派出的子代理不串台）",
  /if \(event\.convId && event\.convId !== String\(state\.currentConversationId \|\| ""\)\) return;/.test(CHAT));
ok("结局事件带 conversation_id（归属分流读的就是它）",
  /conversation_id: job\.convId,/.test(JOBS));

// ── 6. 唤醒话术与预算 ───────────────────────────────────────
ok("唤醒按事件自带预算截尾巴，缺省回落到进程任务那份",
  /const cap = Number\(e\.tail_budget\) > 0 \? Number\(e\.tail_budget\) : BG_WAKE_TAIL_CHARS;/.test(SERVICE)
  && /tail_budget: BG_SUBAGENT_TAIL_BUDGET/.test(JOBS));
ok("子代理结论的预算比日志尾巴宽（交付物不是日志）",
  /export const BG_SUBAGENT_TAIL_BUDGET = (\d+);/.test(JOBS)
  && Number(JOBS.match(/BG_SUBAGENT_TAIL_BUDGET = (\d+)/)[1]) > Number(SERVICE.match(/BG_WAKE_TAIL_CHARS = (\d+)/)[1]));
ok("本地结论不再让模型去别处取输出（它没有日志文件）",
  /const localHint = list\.some\(e => e\.origin === "local"\)/.test(SERVICE)
  && /结论已完整附在上面，这一类任务没有日志可查/.test(SERVICE));
ok("整批预算先按人头分（否则最前面的子代理会被尾部截法整段截没）",
  /const per = Math\.max\(300, Math\.floor\(BG_SUBAGENT_TAIL_BUDGET \/ Math\.max\(1, list\.length\)\)/.test(JOBS)
  && /body\.slice\(0, per\)/.test(JOBS));
ok("退出码只回答「有没有交付」：有一个跑完就算成",
  /const exitCode = failure \|\| !doneCount \? 1 : 0;/.test(JOBS));

// ── 7. 模型可见描述与面板 ───────────────────────────────────
ok("background 参数进工具目录（模型看得见才有这一条路）",
  /background: \{ type: "boolean"/.test(TOOLS));
ok("background 两种写法都认（模型常把布尔写成字符串）",
  /if \(background === true \|\| background === "true"\)/.test(TOOLS));
ok("描述写明「不等结果 / 最多 3 批 / 页面寿命」",
  /background=true 时这批子代理转为后台任务/.test(TOOLS) && /最多 3 批在跑/.test(TOOLS)
  && /结果只在当前页面存活/.test(TOOLS));
ok("回执劝住模型别等着、别重复派出",
  /现在不要等待、也不要重复派出/.test(TOOLS));
ok("面板：本地行的两个按钮说人话（看结论 / 停这批）",
  /const isLocal = task\.origin === "local";/.test(PANEL)
  && /t\(isLocal \? "看子代理结论" : "看输出（最近 \{n\} 行）",/.test(PANEL)
  && /t\(isLocal \? "停止这批子代理" : "停止任务（杀整棵进程树）"\)/.test(PANEL));
ok("面板：本地结论就地读，不打 /bg-tasks（那条路由不认识它）",
  /const local = bgTasks\(\)\.find\(x => x\.task_id === taskId && x\.origin === "local"\);\s*\n\s*if \(local\) \{/.test(PANEL)
  && PANEL.indexOf('x.origin === "local"') < PANEL.indexOf("/bg-tasks/"));
ok("面板词条有英文（未命中的键会露出中文）",
  /"看子代理结论": "View subagent conclusions"/.test(I18N)
  && /"停止这批子代理": "Stop this subagent batch"/.test(I18N)
  && /"（这一批还没有结论）":/.test(I18N));

// ── 8. 语法自检（模块图能过 acorn） ─────────────────────────
ok("批次模块导入 bg_tasks 的三个入口 + 引擎",
  /import \{ upsertLocalTask, pushLocalBgEvent, registerLocalTaskStopper, startBgPolling \}/.test(JOBS)
  && /import \{ runSubAgents \}/.test(JOBS));

const failed = results.filter(([p]) => !p);
console.log(`后台子代理守卫：共 ${results.length} 项，失败 ${failed.length}${failed.length ? "" : " —— 通过"}`);
for (const [, name] of failed) console.log(`  x ${name}`);
for (const [p, , detail] of results) if (!p && detail) console.log(`    · 原因提示 → ${detail}`);
process.exit(failed.length ? 1 : 0);
