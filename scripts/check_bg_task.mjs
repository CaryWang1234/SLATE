/**
 * 后台终端任务守卫：scripts/check_bg_task.mjs
 *
 * 这一层（bg_task）的核心契约是"起了就走，别轮询"，而它的正确性一半在别人的文件里：
 * 后端要复用终端那套一次性 shell（不然两边语义又分叉），前端要三层唤醒都接上、
 * 事件要"先入内存再 ack"，停止要真杀整棵进程树（不然停止按钮是句谎话）。
 * 这些点一旦被"顺手简化"，症状只会在几个小时后、在真跑长任务时才显形。
 *
 * 盯的契约：
 * ① 后端复用 terminal 的内部件（高危判定 / 杀树 / PowerShell 包装），不另起一套；
 * ② 停止 = 杀整棵进程树：Windows 走 taskkill /T，POSIX 走进程组（start_new_session + killpg）；
 * ③ 输出有界：环形缓冲 + 落盘 data/bg_tasks/，log 的 since_offset 只回新增；
 * ④ notify 门：notify=false 的任务绝不进事件队列（进队列＝会叫醒模型）；
 * ⑤ start 也要过高危门与并发上限；
 * ⑥ 前端：只在有任务时快轮询、事件先入内存再 ack、三条唤醒通道齐、配额有界、
 *    系统自开的续跑场不进气泡也不入库；
 * ⑦ 面板：没任务时整栏隐藏、停止按钮只在 running 出现、输出按需拉；
 * ⑧ 模型可见描述与工具目录同源（模型靠它选工具），并明确"不要轮询"。
 *
 * 运行：node scripts/check_bg_task.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const BG = read("backend/skills/bg_task.py");
const REG = read("backend/project_registry.py");
const BG_ROUTER = read("backend/routers/bg_tasks.py");
const MAIN = read("backend/main.py");
const SKILLS = read("backend/routers/skills.py");
const TERM = read("backend/skills/terminal.py");
const STORE = read("frontend/js/store.js");
const SERVICE = read("frontend/js/services/bg_tasks.js");
const TOOLS = read("frontend/js/services/tools.js");
const RISKGUARD = read("frontend/js/services/riskguard.js");
const CHAT = read("frontend/js/components/chat.js");
const APPJS = read("frontend/js/app.js");
const LOOP = read("frontend/js/services/agent_loop.js");
const PANEL = read("frontend/js/components/bg_task_panel.js");
const HTML = read("frontend/index.html");
const I18N = read("frontend/js/services/i18n_dict.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);
// 注释里也会出现 setInterval 这类词（"用 setTimeout 串行而不是 setInterval"），
// 判"有没有真调用"前先剥注释，免得把解释性文字当成代码。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/([^:"'])\/\/.*$/gm, "$1");

// ── 1. 后端：复用终端内部件，不另起一套 ─────────────────────
ok("bg_task 从 terminal 导入高危判定/杀树/PowerShell 包装",
  /from backend\.skills\.terminal import[\s\S]{0,400}check_high_risk/.test(BG)
  && /from backend\.skills\.terminal import[\s\S]{0,400}_kill_process_tree/.test(BG)
  && /from backend\.skills\.terminal import[\s\S]{0,400}powershell_wrapper_script/.test(BG),
  "三件里至少一件是直接抄的一遍");
ok("bg_task 没有自己再写一套 PowerShell 外壳",
  !has(BG, "[ScriptBlock]::Create") && !has(BG, "-EncodedCommand"));
ok("bg_task 没有自己再写一套高危词表",
  !/BLOCKED_PREFIXES\s*=\s*\(/.test(BG) && !/def check_high_risk/.test(BG));

// ── 2. 停止 = 真杀整棵进程树 ────────────────────────────────
ok("Windows 侧杀树走 terminal 的 taskkill /T",
  /if sys\.platform == "win32":[\s\S]{0,200}_kill_process_tree\(proc\)/.test(BG));
ok("POSIX 侧按进程组杀（killpg），不是只杀壳",
  has(BG, "os.getpgid") && has(BG, "os.killpg") && has(BG, "signal.SIGTERM") && has(BG, "signal.SIGKILL"),
  "没有进程组一说，bash -c 'make -j8' 的子进程会活下来");
ok("POSIX 起进程时自建会话（否则拿不到进程组）",
  has(BG, "start_new_session=True") || has(BG, "start_new_session=(sys.platform"),
  "缺 start_new_session 时 killpg 会打到自己的组");
ok("stop 会把状态先置为 stopped 再杀，避免被 _finalize 覆盖成 exited",
  /was_running[\s\S]{0,300}self\.state = "stopped"[\s\S]{0,300}_kill_task_group/.test(BG));

// ── 3. 输出有界 + 落盘 ──────────────────────────────────────
ok("输出走环形缓冲（RETAIN_CHARS 上限）", /RETAIN_CHARS\s*=\s*[\d_]+/.test(BG) && has(BG, "RETAIN_CHARS"));
ok("日志落在 DATA_DIR/bg_tasks 下", /LOG_DIR\s*=\s*DATA_DIR \/ "bg_tasks"/.test(BG));
ok("日志目录跟随 SLATE_DATA_DIR（隔离数据目录时不会写进仓库）",
  /DATA_DIR\s*=\s*Path\(os\.environ\.get\("SLATE_DATA_DIR"/.test(BG));
ok("since_offset 只回新增（切成 trimmed 之后的坐标）",
  /start = max\(0, int\(since_offset\) - trimmed\)/.test(BG));
ok("status/log 会剥掉状态回报行，不把它当可见输出",
  /if STATE_TRAILER_PREFIX in line:[\s\S]{0,400}continue/.test(BG)
  && /_take_state_trailer\(line\)/.test(BG) && /splitlines\(\)/.test(BG));

// ── 4. notify 门：不通知就不进事件队列 ──────────────────────
ok("_fire 先判 notify，false 直接返回",
  /def _fire\(self, kind: str, text: str\)[\s\S]{0,200}if not self\.notify:\s*\n\s*return/.test(BG),
  "notify=false 还挂事件＝模型会被无故叫醒");
ok("事件带输出尾巴（模型不用再读一遍日志）", /"tail": self\._tail_locked\(/.test(BG));

// ── 5. start 的安全门与并发上限 ─────────────────────────────
ok("start 过 check_high_risk + approved 才放行",
  /risk = check_high_risk\(command\)[\s\S]{0,200}if risk and not bool\(approved\)/.test(BG));
ok("灾难级前缀单独拦（不信 approved）",
  /for prefix in BLOCKED_PREFIXES:[\s\S]{0,160}禁止执行的危险命令/.test(BG));
ok("命令长度与工作目录都校验",
  /len\(command\) > MAX_COMMAND_LENGTH/.test(BG) && has(BG, "工作目录不存在"));
ok("并发在册任务有上限", /MAX_RUNNING\s*=\s*\d+/.test(BG) && has(BG, "_running_count() >= MAX_RUNNING"));
ok("已结束任务留档有上限并会剪枝",
  /MAX_KEPT_FINISHED\s*=\s*\d+/.test(BG) && has(BG, "def _prune()")
  && /while len\(finished\) > MAX_KEPT_FINISHED:/.test(BG),
  "只留常量不剪枝＝面板越用越脏");
ok("start 立刻返回，并带一段开头输出（起没起来一眼看得出）",
  /HEAD_WINDOW_SECONDS\s*=/.test(BG) && has(BG, 'info["output"] = payload["output"][:HEAD_MAX_CHARS]'));
ok("返回值带 hint，明说不要轮询",
  /_HINT = \(/.test(BG) && has(BG, "不要轮询") && /return \{"task": info, "hint": _HINT\}/.test(BG));

// ── 6. HTTP 面 ─────────────────────────────────────────────
ok("路由文件提供列表/单任务/停止/ack 四个口",
  has(BG_ROUTER, '@router.get("")') && has(BG_ROUTER, '@router.get("/{task_id}")')
  && has(BG_ROUTER, '@router.post("/{task_id}/stop")') && has(BG_ROUTER, '@router.post("/events/ack")'));
ok("events/ack 声明在 /{task_id} 之前（否则 events 被当成任务 id）",
  BG_ROUTER.indexOf('"/events/ack"') < BG_ROUTER.indexOf('"/{task_id}"'));
ok("/clear 只清已结束的（默认 keepRunning）",
  /keepRunning/.test(BG_ROUTER) && /def clear_finished\(keep_running: bool = True\)/.test(BG));
ok("main.py 注册了 bg_tasks 路由",
  /from backend\.routers import[^\n]*\bbg_tasks\b/.test(MAIN) && /app\.include_router\(bg_tasks\.router, prefix="\/api"\)/.test(MAIN));
ok("宿主退出时收尾在册任务（进程树不该活过宿主）",
  /_shutdown_bg_tasks[\s\S]{0,200}bg_task_skill\.shutdown\(\)/.test(MAIN));

// ── 7. 模型可见描述 ─────────────────────────────────────────
ok("BUILTIN_SKILLS 里有 bg_task 且点了 trigger/notify",
  /"bg_task":/.test(SKILLS) && /后台终端任务/.test(SKILLS) && /notify/.test(SKILLS));
ok("工具描述里点名「别轮询」与 trigger+notify",
  has(TOOLS, "bg_task(后台终端任务") && has(TOOLS, "此后不要轮询")
  && has(TOOLS, "trigger") && has(TOOLS, "notify默认false"),
  "模型靠这段字选工具、也靠它决定不要轮询");
ok("速查表里给了后台任务这条线", /跑长耗时命令[\s\S]{0,120}bg_task action=start/.test(TOOLS));
ok("工具描述里不含裸 ASCII 双引号带来的转义风险",
  !/bg_task\(后台终端任务[^)"]*"/.test(TOOLS),
  "中文描述里塞裸 \" 会截断 JS 字符串（acorn 报 unexpected token）");

// ── 8. 前端服务层：轮询纪律与事件投递 ───────────────────────
ok("有任务才快轮询，空态退到慢探",
  /POLL_MS = 3000/.test(SERVICE) && /IDLE_PROBE_MS = 20000/.test(SERVICE)
  && /schedule\(count > 0 \? POLL_MS : IDLE_PROBE_MS\)/.test(SERVICE));
ok("串行 setTimeout（不会上一次没回来就再发）",
  has(SERVICE, "if (inflight) return") && !has(stripComments(SERVICE), "setInterval("),
  "setInterval 会在上一次请求还没回来时再发一次");
ok("起完任务立刻重排轮询（否则要等最多 20 秒的空闲慢探）",
  /export function startBgPolling\(\) \{\s*\n\s*if \(timer !== null\) \{\s*\n\s*clearTimeout\(timer\);/.test(SERVICE),
  "「已在跑就直接返回」会把刚起任务的那次提醒吞掉：面板停在进行中、事件也不来");
ok("事件先入内存再 ack（中途崩了还能再来一次）",
  SERVICE.indexOf("pushEvents(data.events)") < SERVICE.indexOf('post("/bg-tasks/events/ack"'),
  "顺序反了就是丢事件的经典写法");
ok("未读事件池有上限", /BG_EVENTS_KEEP\s*=\s*\d+/.test(SERVICE) && has(SERVICE, "slice(-BG_EVENTS_KEEP)"));
ok("takeBgEvents 取走即清（消费者即处理者）",
  // P1 起 takeBgEvents 带上了归属会话：它清空的是整个池子（留下的那些当场转进信箱），
  // "取走即清"这条判据没变，只是从"全念"变成"只念这一场的"。
  /export function takeBgEvents\(convId = state\.currentConversationId\)[\s\S]{0,400}state\.bgTaskEvents = \[\]/.test(SERVICE));
ok("续跑配额有界，且开关能一票否决",
  /BG_RESUME_MAX = \d+/.test(SERVICE)
  && /bgResumeUsedOf\(key\) >= BG_RESUME_MAX/.test(SERVICE)
  && /state\.bgAutoResume === false \|\| !key\) return false/.test(SERVICE),
  "配额比较被摘掉＝任务一直跑就一直续，等于没有上限");
ok("唤醒话术点名「这不是用户发来的」",
  /系统 · 后台任务消息/.test(SERVICE) && /这不是用户发来的话/.test(SERVICE),
  "不说清的话模型会把注入当成用户新要求");
ok("任务结束会提醒人（音效/系统通知 + 归属会话徽标）",
  has(SERVICE, "notifyTaskComplete(title, body)") && has(SERVICE, "recordTaskFlag(convId"),
  "模型不看的时候，人得看得见");

// ── 9. 前端接线：三层唤醒 ───────────────────────────────────
// P1 起每一层都只认"归属是这一场"的事件（takeBgEvents / peekBgEventsFor 都带 convId）。
// 判据从"有事件就念"收紧成"有归属本场的事件才念"，方向是变严不是变松：
// 别的项目的结局念给当前对话，等于拿 A 的编译结果回答 B 的问题。
ok("空手停笔时注入事件（第一层，只念归属本场的）",
  /const bgEvents = takeBgEvents\(state\.currentConversationId\);\s*\n\s*if \(bgEvents\.length\) \{/.test(CHAT)
  && /bgWakeText\(bgEvents\)/.test(CHAT));
ok("末轮触顶时按未读事件放宽轮数（第二层，先看归属再花配额）",
  /if \(peekBgEventsFor\(run\.genConvId \|\| state\.currentConversationId\)\.length\s*\n?\s*&& takeBgResumeGrant\(/.test(CHAT),
  "先 takeBgResumeGrant 再取事件＝配额会被一条都不该念的消息吃掉");
ok("空闲时自己接一句（第三层）",
  /function maybeDriveBgEvents\(convId, signal\)/.test(CHAT) && /maybeDriveBgEvents\(genConvId, signal\)/.test(CHAT)
  // P2 起这一句先把 conv 取进局部量再用（同一处还要按这一场查队列），传的值仍是当前会话
  && /const conv = state\.currentConversationId;[\s\S]{0,160}maybeDriveBgEvents\(conv, null\)/.test(CHAT),
  "事件只有轮询这一条来路：不订阅它，第三层就等不到触发，事件只能干等用户开口");
// 闸门换了一条、没少一条：P2 之前"切走了就别接话"（state.currentConversationId !== convId）
// 是因为切走即停，那场已经死了；现在后台那场还在跑，接话正是它该有的行为，
// 换成"这一场自己在跑 / 自己还有排队的消息"——不插自己的队。用户主动停过、开关关掉、
// 配额用完这三条原样保留。判据没有变松，只是把失效的那条换成了等价的现行为。
ok("空闲续跑的三道闸门都在",
  /if \(!convId \|\| signal\?\.aborted\) return/.test(CHAT)
  && /if \(isGenerating\(convId\) \|\| visibleQueueFor\(convId\)\.length > 0\) return/.test(CHAT)
  && /if \(!peekBgEventsFor\(convId\)\.length\) return/.test(CHAT)
  && /if \(!takeBgResumeGrant\(convId\)\) return/.test(CHAT));
ok("系统自开的场：不进气泡也不入库",
  /hidden: bgResumeTurn \|\| undefined/.test(CHAT) && /if \(genConvId && !bgResumeTurn\)/.test(CHAT));
ok("系统自开的场不跑「这条像不像任务」的关键词分类",
  /bgResumeTurn = queuedPayload\?\.kind === "bg_resume"/.test(CHAT)
  && /bgResumeTurn \? "" : buildAgentRuntimeContext/.test(CHAT),
  "事件尾巴里蹦出「命令/项目」就会让系统自己给自己开自主推进");
ok("移动端只注入事件、不自己开新场",
  /const events = takeBgEvents\(\);\s*\n\s*if \(events\.length\) \{/.test(MCHAT) && !/maybeDriveBgEvents/.test(MCHAT),
  "先判池子非空再取会念到别场会话的消息：取完判长度才是对的顺序");
ok("移动端启动时也起轮询（否则事件没人领）", /startBgPolling\(\)/.test(MCHAT));
ok("kernel 把归属会话透给工具执行器（徽标才知道记谁头上）",
  /convId: genConvId \|\| state\.currentConversationId/.test(LOOP) && /convId: ctx\.convId \|\| ""/.test(TOOLS));

// ── 10. 工具接线 ───────────────────────────────────────────
// 默认工作目录取自"这一场的项目"（callProject(callCtx)），不是屏幕上那个：
// 并行时后台那场属于别的项目，拿 state.project 兜底等于把它的命令开在别人的目录里
ok("bg_task 注入项目 work_dir",
  /if \(!p\.work_dir && skill === "bg_task"\) p\.work_dir = proj\.path/.test(TOOLS)
  && /const proj = callProject\(callCtx\) \|\| state\.project;/.test(TOOLS));
ok("bg_task 的 start 也要过审批门（与 terminal 同一道）",
  // 判口挪进 riskguard.approvalSubjectOf 了（三档语义要一处算），判据没变松：
  // 仍钉"tools.js 每笔 skill_run 都走 guardSkillCall"＋"bg_task 只有 start 算一笔命令"。
  /const verdict = await guardSkillCall\(skill, p, \{ convId: callCtx\.convId \}\);\n\s*if \(!verdict\.ok\) return verdict\.message;/.test(TOOLS)
  && /skill === "bg_task" && params\?\.command && \(params\.action \|\| "start"\) === "start"/.test(RISKGUARD),
  "后台 ≠ 免审批");
ok("结果回填面板快照（起完就看得见）", has(TOOLS, "noteBgTaskStarted(data, callCtx.convId"));
ok("SKILL_PARAM_DEFS 有 bg_task 的参数表",
  /bg_task: \[/.test(read("frontend/js/components/skill_panel.js")));

// ── 11. 面板 ───────────────────────────────────────────────
ok("没任务时整栏隐藏（不留空壳）",
  // 并行之后的"事"有两类：后台进程与模型生成，两类都没有才收栏（少判一类会让在跑的那场没人看得见）
  /if \(!tasks\.length && !runs\.length \|\| state\.bgPanelOpen === false\)[\s\S]{0,120}classList\.add\("hidden"\)/.test(PANEL));
ok("停止按钮只在 running 出现",
  /if \(task\.state === "running"\)[\s\S]{0,400}stopBgTask\(task\.task_id\)/.test(PANEL));
ok("非 0 退出按「退出码 N」显示（不跟「没跑起来」混成一个词）",
  /task\.state === "failed"[\s\S]{0,200}退出码 \{n\}/.test(PANEL));
ok("输出按需拉，只拉展开的那一条",
  has(PANEL, "async function fetchOutput(taskId)") && has(PANEL, "?tail_lines=")
  && /if \(expandedId === task\.task_id\)/.test(PANEL));
ok("页面里挂了面板容器与工具栏入口",
  /id="bg-task-panel"/.test(HTML) && /id="btn-bg-tasks"/.test(HTML));
ok("工具栏按钮跟着置灰与计数（没任务时不该像能点）",
  /btn\.disabled = !count/.test(PANEL) && /classList\.toggle\("is-na", !count\)/.test(PANEL)
  && /\.bg-rail-count/.test(PANEL));
ok("面板在 chat.js 里装配并订阅",
  has(CHAT, 'mountBgTaskPanel(document.getElementById("bg-task-panel"))') && /subscribe\("bgTasks"/.test(CHAT));
ok("设置里有空闲续跑的开关，且走 store setter",
  /id="setting-bg-auto-resume"/.test(HTML) && /setBgAutoResume\(e\.target\.checked\)/.test(read("frontend/js/app.js")));
ok("store 有快照/事件/开关/配额四件状态",
  /bgTasks: \[\]/.test(STORE) && /bgTaskEvents: \[\]/.test(STORE)
  && /bgAutoResume: true/.test(STORE) && /bgResumeUsed: \{\}/.test(STORE));
ok("配额计数是脏值安全的（负数/NaN 不许进）", /function normalizeCountMap\(/.test(STORE));

// ── 12. 词条 ───────────────────────────────────────────────
ok("面板词条有英文（未命中的键会露出中文）",
  /"后台任务 \{n\}":/.test(I18N) && /"停止任务（杀整棵进程树）":/.test(I18N)
  && /"看输出（最近 \{n\} 行）":/.test(I18N));
ok("唤醒话术不走 i18n（模型可见文本）",
  !/"系统 · 后台任务消息":/.test(I18N), "模型提示词不该收进用户可见词表");

// ── 13. P1 出处与归属：事件要念给"起它的那场会话"，不是"当时正好开着的那一场" ──
ok("后端任务记着出处（project_id / conversation_id 一路带到事件与快照）",
  /self\.project_id = str\(project_id or ""\)/.test(BG) && /self\.conversation_id = str\(conversation_id or ""\)/.test(BG)
  && /"project_id": self\.project_id,/.test(BG) && /"conversation_id": self\.conversation_id,/.test(BG),
  "只存不发的出处等于没有出处：面板分组与回投都读的是 snapshot/事件里这两份");
ok("start 收 project/conversation_id，认不出时按工作目录反查",
  /project: str = ""/.test(BG) && /conversation_id: str = ""/.test(BG)
  && /def _provenance\(project: Any, work_dir: str\)/.test(BG)
  && /registry\.project_id_for_path\(registry\.load_registry\(\), work_dir\)/.test(BG),
  "curl / 移动端起的任务没人告诉它归属，按目录反查是唯一的兜底");
ok("归属反查按最长前缀（工作区宿主与成员目录同时在册时不抢）",
  /def project_id_for_path\(doc: dict\[str, Any\], path: Any\)/.test(REG)
  && /if text == norm or text\.startswith\(norm \+ "\/"\):/.test(REG)
  && /len\(norm\) > best_len/.test(REG),
  "第一个匹配就返回：宿主目录会把子项目的路径抢走");
ok("按项目过滤：给了 project 认不出要报错，不许回一堆别人的任务",
  /return \{"error": f"项目不在册，无法按项目过滤: \{project\}"/.test(BG)
  && /def list_tasks\(peek: bool = False, project_id: str \| None = None\)/.test(BG)
  && /async def list_bg_tasks\(peek: bool = True, project_id: str \| None = None\)/.test(BG_ROUTER));
ok("前端分池：归属当前会话的进唤醒池，别处的进信箱",
  /bgInbox: \[\]/.test(STORE) && /function addToInbox\(events\)/.test(SERVICE)
  && /if \(away\.length\) addToInbox\(away\)/.test(SERVICE));
ok("归属为空的老事件照样念（扣住真结局比念错地方更糟）",
  /const owner = bgEventOwner\(e\);\s*\n\s*\(owner \&\& owner !== current \? away : here\)\.push\(e\)/.test(SERVICE),
  "写成 owner === current 才留下的话，没带 conversation_id 的事件会永远躺在信箱里没人读");
ok("回到那场会话才把消息搬回池子",
  /export function drainInboxFor\(convId\)/.test(SERVICE) && /if \(drainInboxFor\(convId\)\) maybeDriveBgEvents\(convId, null\)/.test(CHAT));
ok("信箱只重绘未读，不在这里叫醒当前这场",
  /subscribe\("bgInbox", \(\) => renderBgTaskPanel\(\)\)/.test(CHAT)
  && !/subscribe\("bgInbox"[\s\S]{0,120}maybeDriveBgEvents/.test(CHAT),
  "A 的编译结束把 B 的对话叫醒，就是「消息念错人」的现场");
ok("工具侧把出处随 start 一起发出去（模型不该负责记这些）",
  /if \(!p\.project && proj\?\.project_id\) p\.project = proj\.project_id/.test(TOOLS)
  && /if \(!p\.conversation_id && callCtx\.convId\) p\.conversation_id = callCtx\.convId/.test(TOOLS));
ok("任务中心按项目分组，别的项目给「切过去」与「回到那场会话」",
  /function groupByProject\(tasks\)/.test(PANEL) && /switchToProject\(group\.projectId\)/.test(PANEL)
  && /dataset\.conversationId = owner/.test(PANEL));
ok("未读徽标记在归属会话头上（不是当前会话）",
  /const convId = String\(t\.conversation_id \|\| owners\.get\(t\.task_id\) \|\| ""\)/.test(SERVICE)
  && /recordTaskFlag\(convId, \{ kind: ok \? "done" : "error", seen: false \}\)/.test(SERVICE));
ok("换视野会重画任务中心（分组头与跳转入口读的是当前视野）",
  /subscribe\("project", \(\) => renderBgTaskPanel\(\)\)/.test(CHAT),
  "走查踩过：切到 A 之后 B 那一组仍按「自己项目」画，跳转入口一个都不出");
ok("用量区给热力图单独的宿主（它清空 host，共用会把总量卡片抹掉）",
  /renderActivityHeatmap\(heatHost/.test(APPJS) && !/renderActivityHeatmap\(box/.test(APPJS),
  "renderActivityHeatmap 第一行就是 host.innerHTML=''——递 #usage-summary 进去等于删掉上面的卡片");

const failed = results.filter(([p]) => !p);
console.log(`后台任务守卫：共 ${results.length} 项，失败 ${failed.length}${failed.length ? "" : " —— 通过"}`);
for (const [, name] of failed) console.log(`  x ${name}`);
for (const [p, name, detail] of results) if (!p && detail) console.log(`    · ${name} → ${detail}`);
process.exit(failed.length ? 1 : 0);
