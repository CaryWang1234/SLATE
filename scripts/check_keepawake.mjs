/**
 * 夜间模式「跑任务时不让电脑睡眠」守卫：scripts/check_keepawake.mjs
 *
 * 这一改最坏的失败模式不是"开关点不动"（看得见），而是**两种相反的方向都静默**：
 * 说好了不睡却照着睡（用户挂机一整晚白跑），以及说好了放手却一直钉着（笔记本塞进包里发烫）。
 * 后者比前者更糟，因为没人会去检查一个"没发生"的睡眠。所以钉死在下面。
 *
 * 盯的契约：
 * ① Windows 那一侧只有一个实现处（backend/keepawake.py）：标志值、钉住/放手的表达式、
 *    平台门、常驻线程、回读方式、租约——全都逐行认，不认"有这个常量名"。
 * ② 置位、回读、复位必须都在同一条常驻线程里：SetThreadExecutionState 是按线程记的，
 *    写在请求线程上等于写在一条随时会被回收的线程上。
 * ③ 只钉系统不钉屏幕：ES_DISPLAY_REQUIRED 不许进 _hold 那段（挂机跑任务屏该熄就熄）。
 * ④ 租约靠心跳续：心跳间隔必须显著小于租期（一次网络抖动不该断供），到期没人续就必须自动放手。
 * ⑤ 前端只回答"该不该钉"：判据＝有一场真在跑的 run（不是排队等槽位）且这一场生效档是 night；
 *    审批档只认 store 的 permissionModeFor，不许自己读那份 per-conversation 映射。
 * ⑥ 设置页那句状态读的是**后端回答**，不是用户勾没勾：勾了但跑的不是夜间档/连不上后端时，
 *    "正在钉住"这句话就是假的。
 * ⑦ 这颗开关只存本机：不许进 backend 的共享设置 allowlist（同步到手机只会多一个不兑现的开关）。
 * ⑧ 装机包：新 router 与新模块都要在 SLATE.spec 的 hiddenimports 里点名（那份清单没有通配）。
 *
 * 运行：node scripts/check_keepawake.mjs
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

// 前端模块一律带 ?v= 引：不带就与它内部那句 import 成了两份实例（这条以前踩过）
const PIN = (read("frontend/index.html").match(/\?v=(\d{8}-\d{3})/) || [])[0] || "";

const PY = read("backend/keepawake.py");
const ROUTER = read("backend/routers/keep_awake.py");
const MAIN = read("backend/main.py");
const SPEC = read("SLATE.spec");
const SVC = read("frontend/js/services/keepawake.js");
const APPJS = read("frontend/js/app.js");
const CHATJS = read("frontend/js/components/chat.js");
const STORE = read("frontend/js/store.js");
const HTML = read("frontend/index.html");
const DICT = read("frontend/js/services/i18n_dict.js");
const SETTINGS_PY = read("backend/routers/settings.py");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

// 取一个 Python 顶层函数体（缩进行算正文，撞回第 0 列就收口）——不然断言会被后面别的函数借走
function pyFn(src, name) {
  const lines = src.split("\n");
  const start = lines.findIndex(l => l.startsWith(`def ${name}(`));
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i] && !/^[ \t]/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// 取一段 JS 函数：从声明处到第一个顶格 "\n}"（切到文件尾会让断言被同文件别处借走）
function jsFn(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return "";
  const j = src.indexOf("\n}", i);
  return src.slice(i, j < 0 ? src.length : j + 2);
}

const HOLD = pyFn(PY, "_hold");
const APPLY = pyFn(PY, "_apply");
const RENEW = pyFn(PY, "renew");
const STOP = pyFn(PY, "stop");
const STATUS = pyFn(PY, "status");
const AVAILABLE = pyFn(PY, "available");

// ── 1. Windows 那一侧的机制 ────────────────────────────────────
ok("ES_CONTINUOUS / ES_SYSTEM_REQUIRED 的常量值是 Windows 文档里那两个数",
  /^ES_CONTINUOUS = 0x80000000$/m.test(PY) && /^ES_SYSTEM_REQUIRED = 0x00000001$/m.test(PY),
  PY.match(/^ES_(CONTINUOUS|SYSTEM_REQUIRED) = .*/gm));

const HOLD_LINE = HOLD.match(/flags = \([^)]*\) if active else [A-Z_]+/);
ok("钉住用的是 ES_CONTINUOUS|ES_SYSTEM_REQUIRED，放手只留 ES_CONTINUOUS",
  !!HOLD_LINE && /ES_CONTINUOUS \| ES_SYSTEM_REQUIRED/.test(HOLD_LINE[0])
  && /else ES_CONTINUOUS$/.test(HOLD_LINE[0]), String(HOLD_LINE));

ok("屏幕仍允许熄灭：_hold 那一段里不许出现 ES_DISPLAY_REQUIRED（挂机跑任务不该亮着屏）",
  !/ES_DISPLAY_REQUIRED/.test(HOLD), "ES_DISPLAY_REQUIRED 进了持有线程＝屏幕也被钉住");

ok("平台门只认 Windows（照 desktop_tray.available 的写法，非 Windows 一律短路）",
  /os\.name == "nt" and sys\.platform == "win32"/.test(AVAILABLE), AVAILABLE);

ok("ctypes 显式声明 restype/argtypes（不显式声明就等于把指针宽度交给运气）",
  /SetThreadExecutionState\.restype = ctypes\.c_uint/.test(PY)
  && /SetThreadExecutionState\.argtypes = \[ctypes\.c_uint\]/.test(PY));

ok("这台 Windows 没有 GetThreadExecutionState 这只导出：代码里不许绑它（散文里提一句没事）",
  !/\.GetThreadExecutionState\b/.test(PY), "绑了会当场抛 function not found（实测踩过）");

ok("回读＝同一组标志连调两次取第二次（Set 的返回值是调用**之前**的状态）",
  /first = api\.SetThreadExecutionState\(flags\)/.test(APPLY)
  && /applied = api\.SetThreadExecutionState\(flags\)/.test(APPLY)
  && !/return first/.test(APPLY), APPLY.slice(0, 80));

ok("置位/回读/复位全在一条常驻线程里，请求路径不许直接碰 SetThreadExecutionState",
  /threading\.Thread\(target=_hold/.test(RENEW) && !/SetThreadExecutionState/.test(RENEW),
  "写在请求线程上＝写在 anyio 线程池那条随时被回收的线程上");

ok("租约到期会自己放手：renew 把 deadline 推到 LEASE 之后，_hold 醒来发现过期就清标志退出",
  /_deadline = time\.monotonic\(\) \+ LEASE_SECONDS/.test(RENEW)
  && /_deadline = 0\.0/.test(pyFn(PY, "stop"))
  && /active = bool\(_want\) and time\.monotonic\(\) < _deadline/.test(HOLD)
  && /if not active:[\s\S]*return/.test(HOLD));

const RECHECK_M = PY.match(/^RECHECK_SECONDS = ([\d.]+)/m);
const STEP_LINE = HOLD.match(/step = min\(RECHECK_SECONDS, max\(([\d.]+), remaining\)\)/);
ok("放手不许等满一个复查周期：等待步长按剩余租约收紧",
  !!STEP_LINE && !!RECHECK_M && Number(RECHECK_M[1]) >= 1 && Number(STEP_LINE[1]) > 0,
  String(STEP_LINE));

// 界面那句状态读的是这次 HTTP 回答。要是置位/复位还没落进系统就把状态发回去，
// 页面会挂着一句反话等到下一次心跳（20 秒）才纠正——而那 20 秒正是用户会不会合盖走人的窗口。
const WAIT_FN = pyFn(PY, "_wait_for");
ok("want=false 走的是当场放手（renew 直接叫 stop，不是只撤租约等线程下次醒）",
  /if not want:\s*\n\s*stop\(\)/.test(RENEW), RENEW.slice(0, 200));

ok("答案要等标志真落进系统再回：置位与放手两条路各有一次有界等待",
  /def _wait_for\(flag_bit: int, want_bit: bool/.test(WAIT_FN)
  && /_wait_for\(ES_SYSTEM_REQUIRED, True\)/.test(RENEW)
  && /_wait_for\(ES_SYSTEM_REQUIRED, False/.test(pyFn(PY, "stop")), String(WAIT_FN.slice(0, 90)));

ok("持有线程已经不在了就不许再报「钉着」（那位标志按线程记，线程没了系统也不认）",
  /_applied &= ~ES_SYSTEM_REQUIRED/.test(pyFn(PY, "stop")));

ok("唤醒事件用完要 clear，否则 stop() 之后那条线程会空转",
  /if _stop\.wait\(step\):\s*\n\s*_stop\.clear\(\)/.test(HOLD), HOLD.slice(-260));

ok("status 把后端真正读回来的标志位交给上层（applied / system_required / supported）",
  /"applied": int\(_applied\)/.test(STATUS) && /"system_required": bool\(_applied & ES_SYSTEM_REQUIRED\)/.test(STATUS)
  && /"supported": available\(\)/.test(STATUS));

ok("stop() 先撤期望再叫醒线程并 join（退出时释放要看得见，不是只等系统回收）",
  /_want = False/.test(STOP) && /_stop\.set\(\)/.test(STOP) && /keeper\.join\(/.test(STOP));

// ── 2. 路由、注册与装机包 ──────────────────────────────────────
ok("路由挂在 /system 前缀下，读写两个口子都在 keep-awake 这一条路径上",
  /prefix="\/system"/.test(ROUTER)
  && /@router\.get\("\/keep-awake"\)/.test(ROUTER)
  && /@router\.post\("\/keep-awake"\)/.test(ROUTER)
  && /@router\.post\("\/keep-awake\/release"\)/.test(ROUTER));

ok("信封照旧：code/data/message 三件套（前端读的就是 res.data）",
  /return \{"code": 0, "data": data, "message": "ok"\}/.test(ROUTER));

ok("main.py 注册了这个 router 且前缀是 /api",
  /app\.include_router\(keep_awake\.router, prefix="\/api"\)/.test(MAIN));

ok("后端退出时显式松手（shutdown 事件里调 keepawake.stop）",
  /@app\.on_event\("shutdown"\)[\s\S]{0,220}keepawake\.stop\(\)/.test(MAIN));

ok("装机包点名了新模块：backend.routers.keep_awake 与 backend.keepawake 都要在 hiddenimports 里",
  /'backend\.routers\.keep_awake'/.test(SPEC) && /'backend\.keepawake'/.test(SPEC),
  "漏了＝装机包 import 不到，接口直接 404");

// ── 3. 前端的"该不该钉"判定 ────────────────────────────────────
const EP = (SVC.match(/const ENDPOINT = "([^"]+)"/) || [])[1] || "";
ok("前端打的路径与路由声明逐字对得上（拼错＝404，接口活着却谁都问不到，静默到租约到期）",
  EP === "/system/keep-awake", EP);

const NIGHT_FN = jsFn(SVC, "function nightRunActive(");
ok("判据＝有真在跑的 run 且这一场生效档是 night（排队等槽位的不算）",
  /phase !== "queued"/.test(NIGHT_FN) && /permissionModeFor\(r\.conv_id\) === "night"/.test(NIGHT_FN),
  NIGHT_FN);

// 新会话是发送途中才建出来的：那时 run 的 conv_id 被就地改挂到新 id，快照不会重发。
// 读快照就会拿着 "" 去问档——而 "" 那份档已经搬走了，于是把正在跑的夜间活儿判成"不用钉"。
ok("读的是登记表的活对象（activeRuns），不是 state.runs 那份快照",
  /activeRuns\(\)/.test(NIGHT_FN) && !/state\.runs/.test(NIGHT_FN), NIGHT_FN);

ok("改挂会话 id 排在搬审批档之前（adopt 会当场 notify，顺序反了就被读成「这一场不是夜间」）",
  (() => {
    const a = CHATJS.indexOf("run.conv_id = genConvId;");
    const b = CHATJS.indexOf("adoptConversationPermissionMode(res.data.id);");
    return a > 0 && b > 0 && a < b;
  })(), "两处相邻，顺序读源码现判");

ok("审批档只认 store 的 permissionModeFor，不许自己读 per-conversation 映射",
  !/permissionModeByConversation/.test(SVC) && /permissionModeFor/.test(SVC));

const HB_M = SVC.match(/const HEARTBEAT_MS = (\d+)/);
const LEASE_M = PY.match(/^LEASE_SECONDS = ([\d.]+)/m);
ok("心跳与租约留了余量：两次心跳之内必须赶在租约到期前续上",
  !!HB_M && !!LEASE_M && Number(HB_M[1]) * 2 <= Number(LEASE_M[1]) * 1000,
  { hb: HB_M && HB_M[1], lease: LEASE_M && LEASE_M[1] });

const EVAL_FN = jsFn(SVC, "async function evaluate(");
ok("只在期望翻转时才发请求（run 表每次 publish 都重发会把日志刷满）",
  /if \(next === lastSent\) return;/.test(EVAL_FN));

ok("松手那一下真的发出去了：want=false 要 POST 一次，不是只停心跳表",
  /stopHeartbeat\(\)/.test(EVAL_FN) && /await send\(false/.test(EVAL_FN), EVAL_FN.slice(-300));

ok("心跳只在该钉着时续租，不该钉着时立刻停表（免得空转把已放手的机器报成钉着）",
  /timer = setInterval\(\(\) => \{\s*\n\s*if \(wantActive\(\)\) send\(true, "heartbeat"\)/.test(SVC));

const INIT_FN = jsFn(SVC, "export function initKeepAwake(");
ok("三个来源都要重算：run 在跑/静止、这一场的审批档、设置页那颗开关",
  /subscribe\("runs", evaluate\)/.test(INIT_FN)
  && /subscribe\("permissionMode", evaluate\)/.test(INIT_FN)
  && /subscribe\("keepAwakeOnNightRun", evaluate\)/.test(INIT_FN));

// ── 4. 设置页与状态文案 ────────────────────────────────────────
const PERM_BLOCK = (() => {
  const i = HTML.indexOf('id="settings-permission"');
  const j = HTML.indexOf("</section>", i);
  return i < 0 ? "" : HTML.slice(HTML.lastIndexOf("<section", i), j);
})();
ok("开关落在「审批模式」那一块里（夜间模式的附属项就该在那儿），并带一条状态提示容器",
  /id="setting-keep-awake-night"/.test(PERM_BLOCK) && /id="keep-awake-hint"/.test(PERM_BLOCK),
  PERM_BLOCK.slice(0, 120));

const RENDER_FN = jsFn(APPJS, "function renderKeepAwakeSettings(");
ok("状态文案读后端回答（keepAwakeStatus / isHoldingAwake），不是读用户勾没勾",
  /keepAwakeStatus\(\)/.test(RENDER_FN) && /isHoldingAwake\(\)/.test(RENDER_FN)
  && !/正在钉住/.test(RENDER_FN.replace(/t\("[^"]*"\)/g, "")), RENDER_FN.slice(0, 160));

// 只认 system_required 会把"上一拍还钉着"的残值读成"正在钉着"（实测红过一次）；
// 只认 active 又等于拿我们自己按下去的勾当证据。两个都要。
ok("「正在钉住」这句话两个条件都要：租约还在（active）且系统里真记着（system_required）",
  /status\.active && status\.system_required/.test(jsFn(SVC, "export function isHoldingAwake(")));

ok("后端说不支持就把开关置灰：留一颗永远不兑现的勾比没有这颗更糟",
  /box\.disabled = Boolean\(st && st\.supported === false\)/.test(RENDER_FN));

ok("勾选走 store 的 setter（要落盘并通知订阅者），不直接改 state",
  /setKeepAwakeOnNightRun\(e\.target\.checked\)/.test(APPJS));

// 三句文案各判各的：只判"整个 app.js 里有没有这几个字"会两支互相借分——毒掉一句，另一句还替它答绿。
const HOLD_SENT = (RENDER_FN.match(/t\("(正在替[^"]*)"\)/) || [])[1] || "";
const IDLE_SENT = (RENDER_FN.match(/t\("(夜间模式的任务在跑[^"]*)"\)/) || [])[1] || "";
const UNSUP_SENT = (RENDER_FN.match(/t\("(这一版只在[^"]*)"\)/) || [])[1] || "";
ok("钉住那句自己就带边界（屏仍可熄、合盖与手动睡眠管不着）",
  /屏幕仍可正常熄灭/.test(HOLD_SENT) && /合盖/.test(HOLD_SENT), HOLD_SENT);

ok("没钉着那句也带同一套边界（只在一句里留着＝毒掉另一句没人红）",
  /屏幕仍可正常熄灭/.test(IDLE_SENT) && /合盖/.test(IDLE_SENT), IDLE_SENT);

ok("不支持那句照实说清是哪一版做的（不许退成一句含糊的默认文案）",
  /Windows/.test(UNSUP_SENT), UNSUP_SENT);

ok("后端每拍带回状态时设置页要跟着重画（不等用户重开设置页）",
  /onKeepAwakeStatus\(\(\) => renderKeepAwakeSettings\(\)\)/.test(APPJS));

// ── 5. 存储口径：只存本机 ──────────────────────────────────────
ok("store 里有这颗开关，且读老档时回落到默认（开启）",
  /keepAwakeOnNightRun: true/.test(STORE)
  && /state\.keepAwakeOnNightRun = data\.keepAwakeOnNightRun !== false/.test(STORE));

ok("getPersistentData 收它，setter 落盘并 notify 出这个通道名",
  /keepAwakeOnNightRun: state\.keepAwakeOnNightRun !== false/.test(STORE)
  && /notify\("keepAwakeOnNightRun", next\)/.test(STORE));

ok("值没变就不写盘不通知（改一次默认档不该刷一份存档）",
  /if \(\(state\.keepAwakeOnNightRun !== false\) === next\) return;/.test(STORE));

ok("不进后端共享设置：它管的是这台机器该不该醒着，同步到手机只会多个不兑现的开关",
  !/keepAwakeOnNightRun/.test(SETTINGS_PY));

// ── 6. 文案覆盖 ───────────────────────────────────────────────
for (const key of [
  "夜间模式跑任务时不让电脑睡眠",
  "这一版只在 Windows 上生效，当前系统不会阻止睡眠",
  "正在替夜间模式的任务钉住系统：电脑不会睡（屏幕仍可正常熄灭；合盖、手动睡眠、已经睡着的机器都叫不醒）",
  "夜间模式的任务在跑时才会钉住系统，任务停了就交还电源策略（屏幕仍可正常熄灭；合盖、手动睡眠、已经睡着的机器都叫不醒）",
]) {
  ok(`词典里有这句：${key.slice(0, 18)}…`, new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":`).test(DICT));
}

// ── 汇总 ─────────────────────────────────────────────────────
const failed = results.filter(([p]) => !p);
for (const [passed, name, detail] of results) {
  console.log(`${passed ? "ok" : " x"} ${name}${!passed && detail ? ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
console.log(`\n保持清醒守卫：共 ${results.length} 项，失败 ${failed.length}`);
if (failed.length) process.exit(1);
