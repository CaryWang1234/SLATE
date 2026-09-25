/**
 * 分项目作用域守卫：scripts/check_scope_overlay.mjs
 *
 * P4 说的是「全局 + 项目覆盖」这一套要同时成立五件事，缺一条就会拿别人的那份去干活：
 * ①三份生效值各有合并口径：Actions 同 id 顶掉、知识库同 title 顶掉且**不屏蔽**全局其余、
 *   MCP 掩码按服务器 id 记（URL 与密钥绝不进项目目录）；
 * ②写入必须点名落点：要写项目那份而项目不在册 → 拒绝，绝不"退而写进全局"；
 * ③读路径按项目视野取：路由缺 project 参数就等于只看全局那份，前端每个消费点都得带上；
 * ④注入点按**这一场的项目**取覆盖版（并行时屏幕上那个项目的清单不属于后台那场）；
 * ⑤界面写明"现在改的是哪一份"（与分项目宪法同一套文案）。
 * ①②③④里有真跑（起本地后端不现实，就用桩把前端那条按项目取数的链路真跑一遍），
 * 其余是真读源码比对，不靠肉眼。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// 前端模块一律带 ?v= 引：不带就与 project_scope.js 内部那句 import 成了两份实例，
// 守卫写进 state 的东西它读不到，整段真跑会假红（这条以前踩过）。
const PIN = (read("frontend/index.html").match(/\?v=(\d{8}-\d{3})/) || [])[0] || "";
const store = await import(`../frontend/js/store.js${PIN}`);
const scope = await import(`../frontend/js/services/project_scope.js${PIN}`);

const BACKEND_OVERLAY = read("backend/scope_overlay.py");
const ROUTER_ACTIONS = read("backend/routers/actions.py");
const ROUTER_KNOWLEDGE = read("backend/routers/knowledge.py");
const ROUTER_MCP = read("backend/routers/mcp_servers.py");
const ROUTER_SKILLS = read("backend/routers/skills.py");
const MCP_CLIENT = read("backend/mcp_client.py");
const PROJECTS = read("backend/routers/projects.py");
const PS = read("frontend/js/services/project_scope.js");
const TOOLS = read("frontend/js/services/tools.js");
const ADAPTER = read("frontend/js/services/adapter.js");
const CHAT = read("frontend/js/components/chat.js");
const PANEL = read("frontend/js/components/skill_panel.js");
const MEMORY = read("frontend/js/components/memory.js");
const MCPPANEL = read("frontend/js/components/mcp_server_panel.js");
const BOARD = read("frontend/js/components/board_workflow.js");
const HTML = read("frontend/index.html");
const DICT = read("frontend/js/services/i18n_dict.js");

// ── 1. 三份生效值各有合并口径 ──────────────────────────────────
assert.match(BACKEND_OVERLAY, /def effective_action_files\(/, "缺 Actions 的合并函数");
assert.match(BACKEND_OVERLAY, /def mcp_mask_of\(/, "缺 MCP 掩码读取");
assert.match(BACKEND_OVERLAY, /def server_enabled\(/, "缺「这台服务器在这一项目里用不用」的判定");
assert.match(BACKEND_OVERLAY, /def tool_allowed\(/, "缺工具白名单判定");
assert.match(BACKEND_OVERLAY, /def set_server_mask\(/, "缺掩码写入");
// 掩码写入只动 mcp.servers.<id>：同一份 config.json 还住着宪法，整份覆盖会抹掉别人的东西
assert.match(BACKEND_OVERLAY, /servers\.pop\(key, None\)/, "摘掉掩码要删掉那一格，不是清空整份配置");
// 知识库：同名顶掉 + 别的项目不进视野 + 不整体屏蔽全局
assert.match(ROUTER_KNOWLEDGE, /def merge_docs_by_scope\(/, "缺知识库的作用域合并");
assert.match(ROUTER_KNOWLEDGE, /project_id TEXT DEFAULT ''/, "knowledge_docs 没有 project_id 列");
assert.match(ROUTER_KNOWLEDGE, /PRAGMA table_info/, "老库缺列时没有幂等补列（升级会直接报错）");
assert.match(ROUTER_KNOWLEDGE, /_title_key/, "同 title 覆盖的键没抽出来，两处口径会漂");

// ── 2. 写入必须点名落点，绝不偷偷落到全局 ──────────────────────
assert.match(ROUTER_ACTIONS, /if scope == "project" and not project_id:/, "写项目那份时没检查项目视野");
assert.match(ROUTER_ACTIONS, /绝不"退而写进全局"/, "少了『不许退而写进全局』这条口径说明");
assert.match(ROUTER_ACTIONS, /falls_back_to_global/, "删除项目那份后没告诉前端它会回落全局");
assert.match(ROUTER_MCP, /if not req\.project:/, "掩码路由没点名项目（等于允许偷偷改全局）");
assert.match(ROUTER_KNOWLEDGE, /没动它/, "在项目视野里删全局文档要出声拒绝");

// ── 3. 读路径按项目视野取（后端各路由都得收 project） ──────────
for (const [rel, src] of [
  ["actions.py", ROUTER_ACTIONS], ["knowledge.py", ROUTER_KNOWLEDGE], ["mcp_servers.py", ROUTER_MCP],
]) {
  assert.match(src, /project: str = ""/, `${rel} 的读路由没收 project 参数`);
}
assert.match(ROUTER_SKILLS, /async def list_skills\(project: str = ""\)/, "技能清单没按项目收窄远程工具");
assert.match(ROUTER_SKILLS, /req\.project|body\.get\("project"\)|project_id/, "技能执行没把项目视野带到远程调用");
assert.match(MCP_CLIENT, /def list_servers\(project_id: str = ""\)/, "list_servers 没按项目给出生效结论");
assert.match(MCP_CLIENT, /"enableScope"/, "面板读不到「这条结论来自哪一份」");
assert.match(MCP_CLIENT, /def get_all_remote_tools\(project_id: str = ""\)/, "工具清单没按掩码过滤");
// 调用口再验一次：列表过滤过 ≠ 调不动，前端拿旧清单或直接打路由时这条是唯一的门
assert.match(MCP_CLIENT, /async def call_remote_tool\([^)]*project_id/, "call_remote_tool 没有项目参数（少了防御性复核）");
assert.match(PROJECTS, /"mcp": config\.get\("mcp"\)/, "项目信息没带掩码：前端就得为每一场多发一次请求");

// ── 4. 注入点按这一场的项目取覆盖版（真跑） ────────────────────
const GLOBAL_ACTION = { id: "build", name: "打包", description: "全局那份", scope: "global" };
const PROJECT_ACTION = { id: "build", name: "打包", description: "项目那份", scope: "project" };
store.setActions({ actions: [GLOBAL_ACTION], broken: [] });
store.setSkills({ mcp: {}, skills: {}, remote: {}, remoteTools: [{ serverId: "srvG", name: "g", server: "G", description: "" }] });
store.setProject({ project_id: "pA", path: "/tmp/a", name: "alpha", constitution: null });

const asked = [];
globalThis.fetch = async (url) => {
  const s = String(url);
  asked.push(s);
  const data = s.includes("/api/actions")
    ? { actions: [PROJECT_ACTION], broken: [] }
    : { mcp: {}, skills: {}, remote: {}, remoteTools: [{ serverId: "srvB", name: "b", server: "B", description: "只有这个项目能用" }] };
  return { ok: true, json: async () => ({ code: 0, data, message: "ok" }) };
};

// 视野内那场：快照就是它的生效版，不该多发请求
const ownBefore = asked.length;
const own = await scope.ensureScopeCatalog(store.state.project);
assert.equal(asked.length, ownBefore, "屏幕上这个项目已经取过生日，还要再发一次请求");
assert.deepEqual(own.actions, [GLOBAL_ACTION], "视野内没走 store 快照");

// 后台那场（别的项目）：按 ?project= 取自己的覆盖版，取一次就缓存
const other = await scope.ensureScopeCatalog({ project_id: "pB" });
assert.ok(asked.some(u => u.includes("/api/actions?project=pB")), "没按项目取 Action 目录");
assert.ok(asked.some(u => u.includes("/api/skills?project=pB")), "没按项目取远程工具清单");
assert.deepEqual(other.actions, [PROJECT_ACTION], "注入的不是项目那份覆盖版");
assert.equal(other.remoteTools[0].serverId, "srvB", "远程工具没按项目掩码取");
const askedAfter = asked.length;
await scope.ensureScopeCatalog({ project_id: "pB" });
assert.equal(asked.length, askedAfter, "同一项目的生效清单没缓存，每场都要重取");
assert.deepEqual(scope.catalogForScope({ project_id: "pB" }).actions, [PROJECT_ACTION],
  "同步读取点拿不到缓存那份（系统提示是同步拼装的）");
// 摘掉缓存（写了 Action / 换了掩码）后回到"重新取"，而不是继续拿旧的
scope.forgetScopeCatalog("pB");
assert.equal(asked.length, askedAfter, "forgetScopeCatalog 不该自己发请求");
await scope.ensureScopeCatalog({ project_id: "pB" });
assert.ok(asked.length > askedAfter, "丢掉缓存后没有重新去磁盘取（会一直念旧清单）");
// 读不到现场时回落全局快照：宁可多用一次全局默认，也不能拿别的项目的清单去注入
assert.deepEqual(scope.catalogForScope(null).actions, [GLOBAL_ACTION], "没有项目视野时该用全局快照");

// 读不到现场时的回落口径要写在代码里：宁可多用一次全局快照，也不能拿别的项目的清单注入
assert.match(PS, /if \(!next\.actions\.length && !next\.remoteTools\.length\) return activeCatalog\(\)/,
  "两个请求都落空时没有回落全局快照");
assert.match(PS, /for \(const key of \[\.\.\.catalogs\.keys\(\)\]\) if \(key !== activeId\) catalogs\.delete\(key\)/,
  "换视野时没丢掉别的项目的生效清单缓存");

// 系统提示的两个注入点都按这一场的项目取
assert.match(ADAPTER, /function getActionsSystemPrompt\(project = null\)[\s\S]{0,400}catalogForScope\(project\)\.actions/,
  "Action 目录注入没按这一场的项目取");
assert.match(ADAPTER, /getActionsSystemPrompt\(opts\.project\)/, "Action 目录注入没收到这一场的项目");
assert.match(TOOLS, /const remoteTools = catalogForScope\(project\)\.remoteTools;/,
  "远程 MCP 工具注入还在读全局快照");
assert.match(TOOLS, /function projectParam\(ctx = \{\}\)[\s\S]{0,700}function scopeProjectParam\(ctx = \{\}\)/,
  "缺『生效视野』归属参数（不传＝后端只看全局那份）");
assert.match(TOOLS, /project: skill\.startsWith\("mcp__"\) \? scopeProjectParam\(callCtx\) : ""/,
  "远程工具执行没带这一场的项目（掩码在调用口就白设了）");
assert.match(CHAT, /await ensureScopeCatalog\(run\.scope\)/, "开场前没把这一场项目的生效清单取回来");
assert.match(CHAT, /project: pid \}\)/, "知识库检索没带这一场的项目");
assert.match(CHAT, /runOf\(convId\)\?\.scope\?\.project_id \|\| state\.project\?\.project_id/, "知识检索的项目视野没按这一场取");

// ── 5. 面板与界面文案：写明现在改的是哪一份 ────────────────────
assert.match(PANEL, /function activeProjectQuery\(\)/, "技能/Action 清单没有统一的项目视野参数");
assert.match(PANEL, /get\(`\/actions\$\{activeProjectQuery\(\)\}`\)/, "Action 面板没按当前项目取生效目录");
assert.match(PANEL, /subscribe\("project", \(\) => \{ refreshSkills\(\); refreshActions\(\); \}\)/,
  "换项目没重取两份快照（面板会留着上一个项目的清单）");
assert.match(PANEL, /function describeActionScope\(scope\)/, "编辑器缺『现在改的是哪一份』说明");
assert.match(PANEL, /currentActionScope === "project" \? "project" : "global"/, "保存/删除没按这一份的落点点名");
assert.match(PANEL, /btnActionOverride/, "全局那份上面没有『在本项目另存一份』的入口");
assert.match(HTML, /id="action-scope-hint"/, "缺少写明 Action 归属的提示位");
assert.match(HTML, /id="btn-action-override"/, "缺少『在本项目另存一份』按钮");
assert.match(MEMORY, /function knowledgeProjectQuery\(\)/, "知识面板没有按项目取数的统一参数");
assert.match(MEMORY, /item\.scope === "project"/, "知识列表没标出哪一条是项目那份");
assert.match(MEMORY, /subscribe\("project", \(\) => \{ loadKnowledgeDocs/, "换项目没重取知识视野");
assert.match(MCPPANEL, /function projectMaskIntent\(srv\)/, "MCP 面板没有按项目停用语义");
assert.match(MCPPANEL, /\/mask/, "MCP 面板没调掩码路由");
assert.match(MCPPANEL, /srv\.enableScope === "project"/, "MCP 面板没写明这条结论来自哪一份");
assert.match(MCPPANEL, /subscribe\("project", \(\) => loadServers\(\)\)/, "换项目没重取服务器生效状态");
assert.match(BOARD, /let wfActionsProject = ""/, "看板工作流的 Action 缓存没记住它属于哪个项目视野");
assert.match(BOARD, /wfStepsCache\.clear\(\)/, "换项目时步骤缓存没跟着失效（同 id 在别的项目是另一份流程）");

// 双语文案齐备（与分项目宪法同一套说法）
for (const key of [
  "正在编辑项目「{name}」的 Action：存入该项目 .slate/actions/，同名时优先于全局",
  "正在编辑全局 Action：项目内同名 Action 优先于这一份",
  "这条知识存哪里？存进项目「{name}」只在该项目可见（同名时优先于全局）；点「存为全局」则所有项目共用。",
  "只在当前项目停用，其他项目不受影响",
  "摘掉后这台服务器改用全局配置",
  "以下是项目版本的备份。",
]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺词条：${key}`);
}

// ── 6. 用了就得 import：这一族 ReferenceError 只有跑到那条分支才炸 ──────
// 真浏览器走查抓到过一次：adapter.js 直接调 catalogForScope()，静态比对全绿，
// 但整条发送链路在 buildSystemContent 里就断了（请求根本没发出去）。
// 名字挑得足够特殊（不像 get(/t( 那样会撞对象方法），所以这里可以全树扫。
const SCOPE_EXPORTS = ["catalogForScope", "ensureScopeCatalog", "forgetScopeCatalog",
  "projectScopeOf", "constitutionForScope", "invalidateProjectScopes"];
const jsFiles = [];
(function walk(dir, rel) {
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (ent.isDirectory()) walk(join(dir, ent.name), join(rel, ent.name));
    else if (ent.name.endsWith(".js")) jsFiles.push(join(rel, ent.name));
  }
})("frontend/js", "frontend/js");
for (const rel of jsFiles) {
  const src = read(rel);
  for (const name of SCOPE_EXPORTS) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(src)) continue;
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(src)) continue;
    assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*project_scope\\.js`).test(src),
      `${rel} 调用了 ${name}() 却没有从 project_scope.js import（跑到那一行就是 ReferenceError）`);
  }
}

// 快照按**屏幕上这一视野**重取（写的是别的项目那份时也不许把别人的清单盖进全局快照），
// 缓存里存的全是"别的项目"那份生效清单，一次写入谁都可能因此变旧 → 整个丢掉。
// 少任何一半都会静默滞后：前者让面板与下一场注入拿着旧的，后者让后台那场继续念旧清单。
assert.match(TOOLS, /const res = await get\(activePid \? `\/actions\?project=\$\{encodeURIComponent\(activePid\)\}` : "\/actions"\);\n\s*if \(res\.code === 0\) setActions\(res\.data\);\n\s*forgetScopeCatalog\(""\);/,
  "写完 Action 没按当前视野重取快照，或没把别的项目的生效清单缓存丢掉");

console.log("分项目作用域守卫：通过（真跑取数/缓存/回落 8 组，静态比对 60+ 处）");
