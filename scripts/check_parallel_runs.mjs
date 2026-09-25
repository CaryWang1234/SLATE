/**
 * 跨项目并行运行守卫：scripts/check_parallel_runs.mjs
 *
 * P2 把"有没有在生成"从一个布尔改成一张表。这一步最坏的失败模式不是跑不起来
 * （跑不起来当场就能看见），而是**串台**：后台那一场拿屏幕上那个项目的目录写文件、
 * 把消息追加进屏幕上那场的数组、按别的项目的宪法回答。串台的症状要到用户切走
 * 会话才发现，而且发现时产物已经落错地方了。
 *
 * 所以这里钉的四组契约，全部是"看不出来的那类"：
 * ① 生成权登记表：一会话至多一个 run；上限只在 canStart 一处判；超限进队列不静默丢；
 *    run 不落盘；endRun 必泵队列（否则等待项永远停在排队中）。
 * ② 会话现场：每场一份消息数组，后台那场的写入只能 notify thread，不能整表重渲染；
 *    token 按会话归账；请求载荷带自己的项目/宪法/知识，不回读全局。
 * ③ 项目视野：工具调用按 run 的项目落文件，拿不到现场就停下报错，绝不回落 state.project；
 *    后端按 id 现读现场的接口不许顺手改视野。
 * ④ 屏幕归属：切会话不再 abort（backgroundRuns 关掉时才回到旧语义）；
 *    进度条/计时器/自动滚动/停止按钮只认屏幕上这一场；设置页三个控件真的接到 store。
 *
 * 运行：node scripts/check_parallel_runs.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const REG = read("frontend/js/services/run_registry.js");
const SCOPE = read("frontend/js/services/project_scope.js");
const STORE = read("frontend/js/store.js");
const CHAT = read("frontend/js/components/chat.js");
const LOOP = read("frontend/js/services/agent_loop.js");
const TOOLS = read("frontend/js/services/tools.js");
const ADAPTER = read("frontend/js/services/adapter.js");
const PANEL = read("frontend/js/components/bg_task_panel.js");
const TASKLIST = read("frontend/js/services/task_list.js");
const APPJS = read("frontend/js/app.js");
const HTML = read("frontend/index.html");
const I18N = read("frontend/js/services/i18n_dict.js");
const PROJ_API = read("backend/routers/projects.py");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);

// ── 1. 登记表：生成权的唯一真源 ─────────────────────────────
ok("登记表存在且导出全套接口（布尔单例已不再是真源）",
  /export function startRun\(/.test(REG) && /export function endRun\(/.test(REG)
  && /export function canStart\(/.test(REG) && /export function abortRun\(/.test(REG)
  && /export function enqueue\(/.test(REG) && /export function pump\(/.test(REG));
ok("一个会话至多一个 run（同会话第二次 startRun 返回 null）",
  /export function startRun\([\s\S]{0,200}if \(id && runOf\(id\)\) return null;/.test(REG)
  && /if \(convId && runOf\(convId\)\) return \{ ok: false, reason: "same_conversation" \}/.test(REG),
  "同一场对话开两个 run：两条流抢同一个 assistant 气泡，落库顺序会乱");
ok("上限只在 canStart 一处判（跨项目 + 同项目两档）",
  /if \(runs\.size >= maxParallelRuns\(\)\) return \{ ok: false, reason: "global_cap" \}/.test(REG)
  && /runsOfProject\(projectId\)\.length >= maxRunsPerProject\(\)/.test(REG)
  // 调用方不许自己再数一遍：两处判上限必然分叉（一处放行一处拒绝）
  && !/runs\.size >=|runningCount\(\) >=/.test(CHAT),
  "chat.js 里另算了一次并行上限");
ok("超限不静默丢：canStart 拒绝后走 enqueue 并给用户回执",
  /const gate = canStart\(\{ convId: targetConvId, projectId \}\);[\s\S]{0,200}enqueue\(\{ convId: targetConvId, projectId, payload \}\)/.test(CHAT)
  && /已达并行上限，已排队/.test(CHAT));
ok("重新生成的入口同样过闸门（否则它绕过上限挤进第三场）",
  /const regenGate = canStart\(/.test(CHAT) && /if \(!regenGate\.ok\)/.test(CHAT));
ok("run 不落盘（刷新后复活成假在跑）",
  !/run[s]?["']?\s*[:,][\s\S]{0,40}savePersistent/.test(STORE)
  && !/runs: state\.runs/.test(STORE)
  && has(STORE, "runs: []"),
  "state.runs 一旦进持久化快照，重启就会留着几条早就死透的在跑");
ok("endRun 释放槽位后必泵队列", /runs\.delete\(key\);[\s\S]{0,120}pump\(\);/.test(REG));
ok("跑完/被停/抛异常都释放槽位（finally 里 endRun）",
  /finally \{[\s\S]{0,400}endRun\(run\.run_id\)/.test(CHAT)
  && /endRun\(regenRun\.run_id\)/.test(CHAT));
ok("队列项交回时先确认那场没在跑（不重复开）",
  /registerRunStarter\(\(item\) => \{[\s\S]{0,240}item\.conv_id && !runOf\(item\.conv_id\)/.test(CHAT));
ok("泵队列取不到槽位时把等待项放回原位（不许丢掉）",
  /if \(!started\) \{[\s\S]{0,120}pending\.splice\(i, 0, taken\)/.test(REG));
ok("登记表快照随 state.runs 通知出去（面板/徽标读的是这一份）",
  /state\.runs = snapshot\(\);[\s\S]{0,60}notify\("runs", state\.runs\)/.test(REG));

// ── 2. 会话现场：一份数组一场，token 各记各的 ────────────────
ok("store 持有每场一份消息数组（threads），state.messages 只是可见那一份的引用",
  /const threads = new Map\(\)/.test(STORE) && /function messagesOf\(convId\)/.test(STORE)
  && /function bindVisibleThread\(convId\)/.test(STORE) && /state\.messages = threads\.get\(key\)/.test(STORE));
ok("后台那场的写入只 notify thread，不触发整表重渲染",
  (() => {
    const i = STORE.indexOf("function addMessage(msg, convId");
    const body = STORE.slice(i, STORE.indexOf("function updateLastAssistantMessage", i));
    // 可见分支写 state.messages 并发 messages；后台分支只写它自己那份数组、只发 thread。
    // 全函数只允许一次 messages 通知——多发一次就会把屏幕重画成后台那场。
    return /if \(visible\) \{[\s\S]{0,160}state\.messages\.push\(msg\);[\s\S]{0,120}notify\("messages"/.test(body)
      && /threads\.get\(key\)\.push\(msg\);\s*\n\s*notify\("thread"/.test(body)
      && (body.match(/notify\("messages"/g) || []).length === 1;
  })(),
  "对后台数组也发 messages 的话，订阅者会把屏幕重画成后台那场的样子");
ok("updateLastAssistantMessage 按会话落点，可见性决定要不要重绘屏幕",
  /function updateLastAssistantMessage\(content, convId = state\.currentConversationId\)[\s\S]{0,200}const list = visible \? state\.messages : messagesOf\(convId\)/.test(STORE));
ok("kernel 读写消息数组走 opts.messages（不是硬读 state.messages）",
  /const thread = \(\) => \(typeof opts\.messages === "function" \? opts\.messages\(\) : state\.messages\)/.test(LOOP)
  && /messages: \(\) => \(genConvId \? messagesOf\(genConvId\) : state\.messages\)/.test(CHAT));
ok("token 用量按会话归账（后台那场不能刷到屏幕上那场的计数器）",
  /state\.conversationUsage\[key\] = saved;/.test(STORE) && /function addUsage\(usage, convId = state\.currentConversationId\)/.test(STORE));
ok("历史数组自带它那一场的现场（项目/宪法/知识）",
  /list\._project = scope \|\| null;/.test(CHAT) && /list\._constitution = r \? constitutionForScope\(scope\)/.test(CHAT)
  && /list\._knowledge = threadKnowledge\.get/.test(CHAT));
ok("组装请求读的是历史数组自带的现场，不回读全局",
  /buildMessages\(history, history\._constitution \|\| effectiveConstitution\(\), toolMode, \{ project: history\._project \|\| null \}\)/.test(CHAT)
  && !/buildMessages\(history, state\.constitution/.test(CHAT));
ok("知识段按场次取（全局那份会被后台那场覆盖）",
  /knowledge: opts\.knowledge \?\? \(Array\.isArray\(userMessages\._knowledge\) \? userMessages\._knowledge : null\)/.test(ADAPTER));
ok("切回还在跑的那场不去后端重取消息（会把生成中的半条读没）",
  /const liveThread = handoffThread\(convId\);[\s\S]{0,700}if \(!liveThread\) \{[\s\S]{0,200}chat\/conversations\/\$\{convId\}\/messages/.test(CHAT));
ok("后台那场的 DOM 搬进游离树，可见树不动它",
  /function stashRunThread\(run\)[\s\S]{0,200}off\.appendChild\(chatScroll\.firstChild\)/.test(CHAT)
  && /function adoptRunThread\(run\)[\s\S]{0,220}chatScroll\.appendChild\(run\.off\.firstChild\)/.test(CHAT));
ok("只有挂在文档里的那棵树才允许滚动屏幕",
  /function autoScrollIn\(host, force = false\)[\s\S]{0,120}if \(!host\?\.isConnected\) return;/.test(CHAT),
  "后台那场一滚动就把用户正在看的列表拽到底");

// ── 3. 项目视野：这一场在自己的项目里干活 ───────────────────
ok("工具侧的项目视野取自调用上下文，不是硬读 state.project",
  /function callProject\(ctx = \{\}\)[\s\S]{0,300}ctx\?\.project_id \? \(projectScopeOf\(ctx\.project_id\)/.test(TOOLS)
  && /project: opts\.project \|\| null/.test(LOOP));
ok("/projects/* 的归属参数只在确属别的项目时才带（视野内请求体一字不变）",
  /function projectParam\(ctx = \{\}\)[\s\S]{0,300}=== activeId\) return "";\s*\n\s*return String\(proj\.project_id\)/.test(TOOLS));
ok("读写文件与终端类工具全部按 run 的项目落地",
  /normalizeProjectRelativePath\(rawPath, project = state\.project\)/.test(TOOLS)
  && (TOOLS.match(/project: projectParam\(callCtx\)/g) || []).length >= 6,
  "只要有一个工具漏带 project，那一个就会写到屏幕上那个项目里");
ok("拿不到项目现场时停下来报错，不退回 state.project",
  /const scope = await ensureProjectScope\(projectId\);[\s\S]{0,260}项目目录已经不在了/.test(CHAT)
  && /if \(!id\) return state\.project \|\| null;/.test(SCOPE)
  && !/function ensureProjectScope[\s\S]{0,600}return state\.project;/.test(SCOPE),
  "退回视野等于把这条任务的产物写进另一个人的仓库");
ok("后端按 id 现读现场的接口不改视野",
  /@router\.get\("\/registry\/\{project_id\}\/info"\)/.test(PROJ_API)
  && (() => {
    // 只在函数体内找：下一条路由就叫 set_active_project，按全文窗口判会一直误报
    const i = PROJ_API.indexOf("async def get_registry_project_info");
    const body = PROJ_API.slice(i, PROJ_API.indexOf("\n@router", i + 1));
    return /return \{"code": 0, "data": info\}/.test(body) && !/set_active|switch_project/.test(body);
  })(),
  "读一个项目顺带切换视野，是并行最隐蔽的一种打断");
ok("宪法按场次的项目算（后台那场不领屏幕上那个项目的规则）",
  /export function constitutionForScope\(project\)[\s\S]{0,400}return own && typeof own === "object" \? own : state\.constitution/.test(SCOPE));
ok("换视野会失效项目现场缓存（磁盘上的宪法可能刚被改过）",
  /export function invalidateProjectScopes\(\)/.test(SCOPE)
  && /subscribe\("project", \(\) => invalidateProjectScopes\(\)\)/.test(CHAT),
  "只导出没人调用：切过项目之后后台那场仍拿旧路径与旧宪法干活");
ok("删会话时清掉本机那三样（在跑的、排队中的、那份消息数组）",
  /function forgetConversationLocal\(convIds\)[\s\S]{0,260}abortRunFor\(id\)[\s\S]{0,60}dropPendingFor\(id\)[\s\S]{0,60}dropThread\(id\)/.test(CHAT)
  && (CHAT.match(/forgetConversationLocal\(/g) || []).length >= 4
  && /const res = await del\(`\/chat\/conversations\/\$\{conv\.id\}\`\);\s*\n\s*if \(res\?\.code !== 0\)/.test(CHAT),
  "后端删了但本地还在：等待项会在槽位空出来时把一条已不存在的会话重新开起来");

// ── 4. 屏幕归属与设置 ──────────────────────────────────────
ok("切会话不再等于停止（只有 backgroundRuns 关掉时才 abort）",
  /if \(!backgroundRunsOn\(\) && isGenerating\(\) && convId !== state\.currentConversationId\)/.test(CHAT)
  && /const leaving = runOf\(state\.currentConversationId\);[\s\S]{0,80}if \(leaving\) abortRun\(leaving\.run_id\)/.test(CHAT),
  "这一条是 P2 的正面判据：把无条件 abort 写回来（原语义）就该红");
ok("kernel 的中途切会话退出同样受 stopOnSwitch 控制",
  /const stopOnSwitch = opts\.stopOnSwitch !== false;[\s\S]{0,160}const switched = \(\) => stopOnSwitch &&/.test(LOOP)
  && /stopOnSwitch: !backgroundRunsOn\(\)/.test(CHAT));
ok("停止只有一个口，且只停屏幕上这一场",
  /function stopGeneration\(\)[\s\S]{0,240}const r = runOf\(state\.currentConversationId\);[\s\S]{0,120}abortRun\(r\.run_id\)/.test(CHAT)
  && !/abort\(\)\s*;/.test(CHAT.replace(/try \{ r\.controller\.abort\(\); \} catch \(e\) \{\}/g, "")),
  "残留的直接 controller.abort() 会绕过登记表，用户就停不下这一场了");
ok("发言按钮的两态按屏幕上这一场判（后台在跑时按发言就该发出去）",
  /btnSend\.addEventListener\("click", \(\) => \{[\s\S]{0,240}if \(isGenerating\(state\.currentConversationId\)\) stopGeneration\(\);[\s\S]{0,80}else sendMessage\(\);/.test(CHAT),
  "写成 isGenerating()（任一场）的话：别的项目在跑时这里点发言会被当成停止，消息无声丢掉");
ok("计时器/输入框焦点只归可见那场",
  /const wasVisible = run\.visible;[\s\S]{0,120}endRun\(run\.run_id\)/.test(CHAT)
  && /if \(wasVisible\) stopTaskTimer\(\)/.test(CHAT) && /if \(wasVisible\) chatInput\.focus\(\)/.test(CHAT));
ok("子代理中止信号只挂屏幕上这一场（两场互相顶掉是并行硬伤）",
  /if \(run\.visible\) setSubAgentSignal\(signal\)/.test(CHAT));
ok("看门狗逐场算静默时长（共用一个时间戳会谁都不掐）",
  /for \(const r of allRuns\(\)\) \{[\s\S]{0,300}r\.conv_id === state\.currentConversationId \? lastActivityAt : r\.last_event_at/.test(CHAT));
ok("markActivity 收 run 对象（切走后按会话 id 查不到，好端端的生成会被掐）",
  /function markActivity\(runOrConv = null\)[\s\S]{0,400}if \(r\) touchRun\(r\)/.test(CHAT));
ok("任务中心的进行中跟着登记表走（不只看屏幕上这一场）",
  /runningConvIds\?\.has\(id\)/.test(TASKLIST)
  && /runningConvIds: new Set\(\(state\.runs \|\|\ \[\]\)\.map\(r => r\.conv_id\)\.filter\(Boolean\)\)/.test(APPJS));
ok("任务中心画出在跑与排队的行，并提供跳转与单独停止",
  /function renderRunRow\(run\)/.test(PANEL) && /abortRun\(run\.run_id\)/.test(PANEL)
  && /去看这一场/.test(PANEL) && /phase === "queued"/.test(PANEL));
ok("并行设置三个控件接线到位（HTML id 与 store setter 一一对应）",
  has(HTML, "id=\"setting-background-runs\"") && has(HTML, "id=\"setting-max-parallel-runs\"")
  && has(HTML, "id=\"setting-max-runs-per-project\"")
  && /function renderParallelSettings\(\)/.test(APPJS)
  && /export \{[\s\S]{0,900}setMaxParallelRuns, setMaxConcurrentRunsPerProject, setBackgroundRuns/.test(STORE));
ok("三个取值持久化且越界回落（脏值不该让并行整体失灵）",
  /maxParallelRuns: normalizeCountInt\(state\.maxParallelRuns, 1, 4, 2\)/.test(STORE)
  && /maxConcurrentRunsPerProject: normalizeCountInt\(state\.maxConcurrentRunsPerProject, 1, 3, 1\)/.test(STORE)
  && /backgroundRuns: state\.backgroundRuns !== false/.test(STORE)
  && /function normalizeCount\(value, min, max, fallback\)/.test(REG));
ok("新文案双语齐全", has(I18N, '"排队中"') && has(I18N, '"去看这一场"')
  && has(I18N, '"已达并行上限，已排队') && has(I18N, '"切走会话时让它继续跑'));
ok("旧的布尔单例没被留在别处当第二真源",
  !/state\.generating/.test(CHAT) && !/state\.generating/.test(STORE));

const failed = results.filter(([p]) => !p);
console.log(`并行运行守卫：共 ${results.length} 项，失败 ${failed.length}${failed.length ? "" : " —— 通过"}`);
for (const [, name] of failed) console.log(`  x ${name}`);
for (const [p, name, detail] of results) if (!p && detail) console.log(`    · ${name} → ${detail}`);
process.exit(failed.length ? 1 : 0);
