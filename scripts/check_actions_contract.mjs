/**
 * Actions 契约守卫：scripts/check_actions_contract.mjs
 *
 * 为什么盯这个契约：Action 是「用户写给模型看的流程说明书」，它一旦能被模型自己写入，
 * 就等于让模型往自己的系统提示里加料。P0 靠「只读」挡掉的风险，P1 开了写入之后只能靠流程挡，
 * 所以钉死的是这三件事：
 * ① 写入要过三道闸——SAY-1 校验通过才落盘（坏文件不许上盘）、覆盖/删除前先留底（每份 ≤5 版可回滚）、
 *    模型侧 actions_write 在「询问」档位必须弹审批且必须自证 author: model；
 * ② 解析只发生在 Python 侧的 SAY-1 子集里，前端永不引入 YAML 解析器；
 * ③ 目录注入有预算、有纪律句，且对话态整段不注入。
 * 这三条都是「改坏了不会立刻报错、只会悄悄退化或悄悄丢数据」的类型，靠人记不住。
 *
 * 运行：node scripts/check_actions_contract.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = p => readFileSync(new URL(p, import.meta.url), "utf8");
const MAIN_SRC = read("../backend/main.py");
const ROUTER_SRC = read("../backend/routers/actions.py");
const SAY_SRC = read("../backend/slate_yaml.py");
const TOOLS_SRC = read("../frontend/js/services/tools.js");
const ADAPTER_SRC = read("../frontend/js/services/adapter.js");
const STORE_SRC = read("../frontend/js/store.js");
const PANEL_SRC = read("../frontend/js/components/skill_panel.js");
const CHAT_SRC = read("../frontend/js/components/chat.js");
const REQUIREMENTS = read("../requirements.txt");

/**
 * 取一个 Python 函数的源码切片。
 * 顺序类断言（校验必须在写入之前）必须限定在函数体内：整文件 [\s\S]* 会跨函数凑出一次「成功」，
 * 于是删掉 _write_action 里的校验也不会红——守卫最怕的就是这种看起来在管事、其实空转的断言。
 */
function pyBody(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker);
  assert.ok(at >= 0, `源码里找不到 ${label}（${startMarker}），断言会变成空转`);
  const rest = src.slice(at + startMarker.length);
  const end = endMarker ? rest.indexOf(endMarker) : -1;
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(body.length > 40, `${label} 函数体切片过短，断言会变成空转`);
  return body;
}

// ── 1. 后端：路由注册、目录定位、越权与体积护栏、永不 500 ──
assert.match(MAIN_SRC, /app\.include_router\(actions\.router, prefix="\/api"\)/,
  "main.py 必须注册 actions 路由，否则 /api/actions 整条链是死的");
assert.match(ROUTER_SRC, /router = APIRouter\(prefix="\/actions"/, "路由前缀要是 /actions");
assert.match(ROUTER_SRC, /os\.environ\.get\("SLATE_DATA_DIR"/,
  "Action 目录要跟随 SLATE_DATA_DIR，打包与隔离测试才不会读到开发数据");
assert.match(ROUTER_SRC, /ACTIONS_DIR = DATA_DIR \/ "actions"/, "Action 落在 data/actions 下");
assert.match(ROUTER_SRC, /def _clean_id[\s\S]*ACTION_ID_RE\.match/,
  "id 必须先消毒再拼路径（白名单正则），不能靠事后过滤");
assert.match(ROUTER_SRC, /return target if target\.parent == base else None/,
  "解析后的路径必须仍落在 data/actions 内，挡住 ../ 与符号链接外逃");
assert.match(ROUTER_SRC, /st_size > MAX_FILE_BYTES/, "读取前要卡文件体积，不能把任意大的文件灌进内存");
assert.doesNotMatch(ROUTER_SRC, /HTTPException|status_code=5/,
  "失败要回 {code:-1, message}，抛 500 前端只会看到一个没有上下文的请求错误");
assert.match(ROUTER_SRC, /@router\.post\("\/validate"\)/, "试校验入口要在（编辑器实时报错靠它）");

// ── 1b. P1 写入面：写路径只有一条，且顺序是「体积 → 校验 → 留底 → 落盘」 ──
assert.match(ROUTER_SRC, /@router\.put\("\/\{action_id\}"\)/, "面板保存与 actions_write 都打 PUT，路由没了整条写入是死的");
assert.match(ROUTER_SRC, /@router\.delete\("\/\{action_id\}"\)/, "面板要能删，DELETE 路由要在");
assert.match(ROUTER_SRC, /@router\.post\("\/\{action_id\}\/history\/restore"\)/, "留底只能靠 restore 回滚，否则历史是只读摆设");
assert.match(ROUTER_SRC, /HISTORY_DIR = ACTIONS_DIR \/ "\.history"/, "留底要与 Action 同目录（打包后一起走 SLATE_DATA_DIR）");
assert.match(ROUTER_SRC, /HISTORY_KEEP\s*=\s*5(?!\d)/, "留底要有份数上限：无限留底等于让一次误操作灌满磁盘");
assert.match(ROUTER_SRC, /HISTORY_TS_RE = re\.compile\(r"\^\\d\{8\}T\\d\{6\}/,
  "历史文件名里的 ts 要先进白名单正则再拼路径，否则 ../ 能从 /history/{ts} 外逃");
const WRITE_BODY = pyBody(ROUTER_SRC, "def _write_action(", "\ndef _describe", "_write_action");
// P4 起留底目录按落点算（项目那份的历史留在项目自己的 .slate/actions/.history，
// 不与全局那份混在同一堆时间戳里）：锚点因此多钉一个参数，比原来更严，不是放宽。
assert.match(WRITE_BODY, /size > MAX_FILE_BYTES[\s\S]*?load_action\(text[\s\S]*?_backup\(clean_id, path, _history_dir_of\(path\)\)[\s\S]*?atomic_write_text\(path, text\)/,
  "顺序必须是 体积→校验→留底→原子写：先写后校会把坏文件留在盘上，不先留底就没有回滚的余地（留底还得落在这一份自己的目录）");
assert.equal((ROUTER_SRC.match(/atomic_write_text\(path, text\)/g) || []).length, 1,
  "全文件只能有一处直接落盘：多一处就多一条绕过校验与留底的后门");
assert.equal((ROUTER_SRC.match(/return _write_action\(clean_id/g) || []).length, 2,
  "PUT 与回滚要共用 _write_action，写成两遍早晚会有一遍偷偷少做一次校验");
const DELETE_BODY = pyBody(ROUTER_SRC, "async def delete_action(", "@router.get(\"/{action_id}/history\")", "delete_action");
// 同上：删除前的留底也必须落在这一份自己的目录里（P4 起 _backup 收三个参数）
assert.match(DELETE_BODY, /backed_up = _backup\(clean_id, path, history\)[\s\S]*?path\.unlink/,
  "删除要先留底再 unlink：误删一份手写流程是不可逆的");
const RESTORE_BODY = pyBody(ROUTER_SRC, "async def restore_history(", null, "restore_history");
assert.match(RESTORE_BODY, /load_action\(source, action_id=clean_id\)[\s\S]*?return _write_action\(clean_id, source/,
  "回滚也是写：一份早已不合法的旧版本不许绕过校验直接盖回磁盘");

// ── 2. SAY-1 留在纯 stdlib：不引入 PyYAML，前端不解析 YAML ──
assert.doesNotMatch(SAY_SRC, /^\s*import yaml|^\s*from yaml/m, "解析器不得依赖 PyYAML");
assert.doesNotMatch(REQUIREMENTS, /^\s*pyyaml/mi, "PyYAML 不能进依赖清单：只为一个功能加移动件不划算");
assert.match(SAY_SRC, /MAX_STEPS\s*=\s*24/, "步骤数要有上限，否则一份 yml 就能吃掉整轮上下文");
assert.match(SAY_SRC, /class SayError/, "错误要带行号，用户才改得动自己写的文件");

function listJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) listJs(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}
const FRONTEND_DIR = fileURLToPath(new URL("../frontend/js", import.meta.url));
const FRONTEND_JS = listJs(FRONTEND_DIR);
const YAML_HARNESS = FRONTEND_JS
  .filter(file => /from ["']js-yaml|require\(["']yaml|yaml\.load\(/.test(readFileSync(file, "utf8")));
assert.ok(FRONTEND_JS.length > 40, `前端模块扫描失效（只见 ${FRONTEND_JS.length} 个 .js），YAML 断言会是空转`);
assert.deepEqual(YAML_HARNESS, [], "前端不许出现 YAML 解析器：解析只在后端做一次，两处解析必然漂移");

// ── 3. 前端工具：三个工具都在核心目录里，id 先本地拦 ──
for (const name of ["actions_list", "actions_read", "actions_write"]) {
  assert.ok(TOOLS_SRC.includes(`  ${name}: {`), `TOOLS 缺 ${name}`);
  assert.ok(TOOLS_SRC.includes(`"${name}"`), `${name} 要进 CORE_AGENT_TOOLS，否则精简提示里模型看不到`);
}
/** 取一段 JS 对象/函数体的源码切片（同 pyBody，为了把顺序断言关在一个块里） */
function jsBlock(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker);
  assert.ok(at >= 0, `源码里找不到 ${label}（${startMarker}），断言会变成空转`);
  const rest = src.slice(at + startMarker.length);
  const end = endMarker ? rest.indexOf(endMarker) : -1;
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(body.length > 100, `${label} 代码块切片过短，断言会变成空转`);
  return body;
}
const WRITE_TOOL = jsBlock(TOOLS_SRC, "  actions_write: {", "\n  subagent_run: {", "actions_write");
assert.match(WRITE_TOOL, /await post\("\/actions\/validate", \{ content: text \}\)[\s\S]*?dlgConfirm\(/,
  "模型侧要先过同一次 SAY-1 校验再弹审批框：先问后写，校验失败的草稿不该拿去打扰用户");
assert.match(WRITE_TOOL, /if \(!draft\.ok\)[\s\S]*?未写入[\s\S]*?return/,
  "校验不过要直接返回错误给模型去改，不能把坏内容写进目录");
assert.match(WRITE_TOOL, /draft\.action\?\.author !== "model"[\s\S]*?return/,
  "模型代写必须自证 author: model，面板才分得清哪份是用户手写、哪份是模型加的");
// 审批档从"全局那一个值"改成"这一场生效的那一档"（P5 输入框可逐场改）；判据没变松：
// 仍是"只有手动档弹原文确认"，也仍钉确认排在 put 落盘之前。
assert.match(WRITE_TOOL, /if \(permissionModeFor\(callCtx\.convId\) === "ask"\)[\s\S]*?dlgConfirm\([\s\S]*?\n *const res = await put\(/,
  "「手动审批」那一档必须先让用户看过原文再落盘；顺序反了就变成先写后问，审批形同虚设");
assert.match(WRITE_TOOL, /if \(!approved\)[\s\S]*?不要重复调用[\s\S]*?return/,
  "用户拒绝后要劝退模型重试，否则它会换个说法再弹一次同样的框");
// P4 起快照按"屏幕上这一视野"重取、生效清单缓存整个丢（写全局会影响所有项目）；
// 判据没变松：仍钉"刷新排在拼成功文案之前"，少这一步同一轮里 actions_list 还是旧的。
assert.match(WRITE_TOOL, /await refreshActionSnapshot\(\)[\s\S]*?const lines = \[/,
  "写完要刷内存快照与生效清单缓存，否则同一轮里后续 actions_list 仍看不到这份新流程");
assert.doesNotMatch(TOOLS_SRC, /FILE_RAW_TOOLS = new Set\([^)]*actions_write/,
  "actions_write 不进裸文围栏：流式半份 YAML 直接落盘，等于让坏文件常驻目录");
assert.match(TOOLS_SRC, /\[a-z0-9\]\[a-z0-9_-\]\{0,47\}/,
  "前端要复刻同一条 id 规则，../ 之类的垃圾不必打到后端");
assert.match(TOOLS_SRC, /actions_list keyword=关键词 -> actions_read/, "工具速查里要有 Action 路线，否则模型不知道先查再读");
assert.match(TOOLS_SRC, /读到流程不等于做过流程|不是已完成的证据/,
  "必须写明「读到流程 ≠ 执行过流程」，否则模型会复述步骤冒充做完");

// ── 4. 系统提示注入：预算 + 纪律句 + 位置 + 对话态不注入 ──
// 目录注入的函数与调用点从 P4 起带 project 入参（并行时按"这一场的项目"取覆盖版），
// needle 跟到括号前为止。判据没变松：仍是"独立成函数"与"整条链路只注入一次"。
assert.match(ADAPTER_SRC, /function getActionsSystemPrompt\(/, "目录注入要独立成函数，便于估算口径复用");
assert.match(ADAPTER_SRC, /const ACTIONS_CATALOG_LIMIT = 20/, "目录要有条数上限");
assert.match(ADAPTER_SRC, /\.slice\(0, 60\)/, "description 要截断，目录只负责说「有没有、叫什么」");
assert.match(ADAPTER_SRC, /与用户当前要求不符时不要套用/, "抬头要带纪律句：不符的 Action 不许硬套");
const injectAt = ADAPTER_SRC.indexOf("systemContent += getActionsSystemPrompt(");
// P2 起这一句多了 project 入参（并行时工具目录要按"这一场的项目"写），needle 跟到括号前为止；
// 判据没变松：还是"目录注入必须排在工具说明之前"，位置比较照旧。
const toolsAt = ADAPTER_SRC.indexOf("systemContent += getToolsSystemPrompt({ compact: true,");
assert.ok(injectAt > 0 && toolsAt > 0 && injectAt < toolsAt, "Action 目录要在工具说明之前注入");
// 只看 buildSystemContent 自己的函数体：整文件切片会把别处的 getActionsSystemPrompt 定义也算进去
const buildBody = ADAPTER_SRC.slice(
  ADAPTER_SRC.indexOf("function buildSystemContent("),
  ADAPTER_SRC.indexOf("function buildMessages("),
);
const elseAt = buildBody.indexOf("} else {");
const chatPart = buildBody.slice(buildBody.indexOf("if (opts.withTools === false)"), elseAt);
assert.ok(chatPart.length > 50 && !chatPart.includes("getActionsSystemPrompt"),
  "对话态没有 actions_read，注入目录只会诱导模型声称「已按流程执行」");
assert.ok(buildBody.slice(elseAt).includes("getActionsSystemPrompt"), "智能体分支才注入 Action 目录");
// 同上：入参从 P4 起是 opts.project（按这一场的项目取覆盖版），needle 跟到括号前为止。
// 判据没变松：仍然只数"注入这一句"出现一次。
assert.equal(buildBody.split("systemContent += getActionsSystemPrompt(").length - 1, 1,
  "目录只能注入一次，重复注入等于翻倍吃上下文");

// ── 5. store：内存快照，不落 localStorage ──
assert.match(STORE_SRC, /actions: \[\]/, "state 要有 actions 快照");
assert.match(STORE_SRC, /actionsBroken: \[\]/, "解析失败的文件也要进状态，面板才有的可显示");
assert.match(STORE_SRC, /function setActions\(data\)[\s\S]*?notify\("actions"/, "setActions 要 notify，面板订阅才生效");
assert.ok(/export \{[^}]*\bsetActions\b[^}]*\}/.test(STORE_SRC), "setActions 要导出");
const persistentBody = STORE_SRC.slice(
  STORE_SRC.indexOf("function buildPersistentData()"),
  STORE_SRC.indexOf("function savePersistent()"),
);
assert.ok(persistentBody.length > 100 && !/actions/.test(persistentBody),
  "Action 不落 localStorage：磁盘上的 .yml 才是真源，缓存副本只会与磁盘不一致");

// ── 6. 面板：可编辑 + 删除 + 历史回滚，坏文件显式露出 ──
assert.match(PANEL_SRC, /async function refreshActions\(\)/, "面板要能刷新 Action 目录");
// P4 起面板这三个调用都要点名"哪一份"（读带 ?project=、写带 targetScope、删带 ?project=&scope=）。
// 判据没变松：仍是"读的是 /api/actions""保存先校验再 put""删除走 DELETE /api/actions/{id}"，
// 只是又多钉一层——不许不问视野就动全局那一份。
assert.match(PANEL_SRC, /await get\(`\/actions\$\{activeProjectQuery\(\)\}`\)/, "面板读的是 /api/actions（且点名当前项目视野）");
assert.match(PANEL_SRC, /renderActionsSection\(\);/, "renderSkillList 要带 Actions 段");
assert.match(PANEL_SRC, /skill-item-broken/, "解析失败的文件要显示出来，不能凭空消失");
assert.match(PANEL_SRC, /export \{ initSkillPanel, refreshSkills, refreshActions \}/, "refreshActions 要导出");
const PANEL_SAVE = jsBlock(PANEL_SRC, "async function saveAction(targetScope = \"\") {", "\nasync function saveActionAsProjectOverride()", "saveAction");
assert.match(PANEL_SAVE, /const draft = await validateActionDraft\(\);\n[\s\S]{0,80}?if \(!draft\?\.ok\)[\s\S]*?return;[\s\S]*?await put\(/,
  "面板这一路也要「先校验、不过就 return」：后端虽然兜底，但少了这一步用户只会收到一句没头没尾的失败");
assert.match(PANEL_SAVE, /refreshActions\(\);/, "保存成功要刷目录，否则左侧列表还挂着旧的步数");
assert.match(PANEL_SRC, /await del\(`\/actions\/\$\{encodeURIComponent\(id\)\}\?\$\{qs\.toString\(\)\}`\)/,
  "面板删除走 DELETE /api/actions/{id}（带 project/scope 查询串）");
const PANEL_DEL = jsBlock(PANEL_SRC, "async function deleteAction() {", "\nfunction formatHistoryTs", "deleteAction");
assert.match(PANEL_DEL, /await dlgConfirm\([\s\S]*?await del\(/,
  "删除要点一次确认：误删的手写流程只能靠留底救回来");
assert.match(PANEL_DEL, /refreshActions\(\);/, "删完要刷目录，否则列表里还留着一行点不开的条目");
// 回滚调用现在在 URL 后面拼了视野查询串（?project=），needle 收到 restore 为止：
// 判据没变松，仍是"必须显式打 restore 路由"。
assert.match(PANEL_SRC, /await post\(`\/actions\/\$\{encodeURIComponent\(currentActionId\)\}\/history\/restore/,
  "回滚要显式调 restore，而不是把旧文本塞进编辑器让用户再点一次保存");
assert.match(PANEL_SRC, /setTimeout\(validateActionDraft, \d+\)/, "边写边校验要节流，不然每个字符打一次后端");
assert.match(PANEL_SRC, /if \(seq !== actionDraftSeq\) return null/,
  "校验响应要认序号：打字快时旧请求后回来，会把新草稿的错误提示盖掉");

// ── 7. @mention：把一份流程塞进消息，必须有上限、且复用同一个渲染器 ──
assert.match(CHAT_SRC, /const ACTION_MENTION_LIMIT = \d+/,
  "提及注入要有字符上限，不设限等于让一份 64 KB 的 yml 常驻整段对话");
assert.match(CHAT_SRC, /kind: "action"/, "@ 候选里要有 Action，否则用户得记住 id 才能提及");
assert.match(CHAT_SRC, /state\.actions\?\.some\(a => a\.id === name\)[\s\S]*?await resolveMentionedAction\(name\)/,
  "解析链要认 Action id；放在内置工具之后，避免用户起个 file_read 之类的 id 顶掉内建工具");
assert.match(CHAT_SRC, /renderAction\(res\.data\)/,
  "提及注入必须复用 actions_read 的渲染器，两处各写一份格式化迟早漂移");
assert.match(CHAT_SRC, /renderAction \} from "\.\.\/services\/tools\.js\?v=/, "chat.js 要从 tools.js 引 renderAction");

console.log("Actions 契约：写入三道闸（校验/留底/审批） / SAY-1 单点解析 / 目录注入预算 / @mention 上限 —— 通过");
