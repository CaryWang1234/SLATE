/**
 * 多项目管理（P0 在册与切换）守卫。
 *
 * 两类判据混在一起是有意的：
 *   · 纯函数分组 —— 在 Node 里真跑 task_list.js，因为它就是纯函数，模拟比读源码可靠；
 *   · 跨文件接线 —— 只能钉源码文本（后端注册表由 scripts/check_backend_projects.py 真跑，
 *     浏览器里的切换器由 .qoder/walk_multi_project.py 真跑），这里钉"接线还在"。
 *
 * 最要紧的一条是 `_current_project` 的访问收口：多项目之后"当前"只是一个视野，
 * 谁再直接读它，谁就让某个路由悄悄打到用户正在看的那个项目上。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as tl from "../frontend/js/services/task_list.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, p), "utf-8");

const PROJECTS = read("../backend/routers/projects.py");
const REGISTRY = read("../backend/project_registry.py");
const CHAT_PY = read("../backend/routers/chat.py");
const CODE_SEARCH = read("../backend/skills/code_search.py");
const SETTINGS_PY = read("../backend/routers/settings.py");
const STORE = read("../frontend/js/store.js");
const SCENE = read("../frontend/js/services/project_scene.js");
const SVC = read("../frontend/js/services/project.js");
const BAR = read("../frontend/js/components/project_bar.js");
const CHAT = read("../frontend/js/components/chat.js");
const APP = read("../frontend/js/app.js");
const HTML = read("../frontend/index.html");
const CSS = read("../frontend/css/style.css");
const DICT = read("../frontend/js/services/i18n_dict.js");

let passed = 0;
const fails = [];
function ok(name, cond, detail = "") {
  passed += 1;
  if (!cond) fails.push(`${name}${detail ? " :: " + detail : ""}`);
}
function match(name, src, re, detail = "") {
  ok(name, re.test(src), detail || re.source);
}

// ══ 1. 后端：单例访问收口 ═══════════════════════════════════
// 允许出现 _current_project 的位置只有这四个函数体（声明行除外）。
// 做法：把模块按顶级 def 切块，逐块看谁引用了它。
{
  const lines = PROJECTS.split("\n");
  const allowed = new Set(["_set_active", "_active_info", "_is_active"]);
  const owners = [];
  let current = null;
  let sawModuleLevel = [];
  // 必须带前后界定：路由函数名 get_current_project 里就含 "_current_project" 这个子串，
  // 不用边界看就会把它当成"又一处直接读单例"，报一条压根不存在的违规。
  const HITS = /(^|[^\w])_current_project([^\w]|$)/;
  for (const line of lines) {
    const m = /^(?:async )?def ([A-Za-z_][\w]*)/.exec(line);
    if (m) current = m[1];
    if (/^[A-Za-z_]/.test(line) && !m) current = null;   // 回到模块级（路由装饰器之间的注释等）
    if (HITS.test(line) && !line.startsWith("_current_project:")) {
      (current ? owners : sawModuleLevel).push(`${current || "<模块级>"}: ${line.trim()}`);
    }
  }
  const bad = [...sawModuleLevel, ...owners.filter(o => !allowed.has(o.split(":")[0]))];
  ok("单例只在 _set_active/_active_info/_is_active 里被碰", bad.length === 0, bad.join(" | "));
  match("路由不许再直接读缓存：统一走 _resolve_project", PROJECTS, /def _resolve_project\(/);
  ok("_active_info 会按注册表自愈（重启不丢视野）",
    /def _active_info[\s\S]{0,400}?registry\.entry_of\(doc, str\(doc\.get\("active"\)/.test(PROJECTS));
}

// ══ 2. 后端：每个能打别的项目的路由都有 project 参数 ══════════
{
  const need = ["UpdateConfigRequest", "BrowseRequest", "FindRequest", "SwitchRootRequest",
    "WorkspaceFoldersRequest", "ReviewDiffRequest", "ApplyEditRequest", "CreateFileRequest",
    "AppendFileRequest", "ScanRequest"];
  for (const cls of need) {
    const body = new RegExp(`class ${cls}\\(BaseModel\\):[\\s\\S]*?\\n\\n`).exec(PROJECTS)?.[0] || "";
    ok(`${cls} 带 project 字段`, /project: str = ""/.test(body));
  }
  match("GET /git/graph 用查询参数寻址", PROJECTS, /async def git_graph\(project: str = ""\)/);
  // 打别的项目不许顺手把视野抢走。函数体按"下一个装饰器"切，不按空行切——
  // 函数体里本来就有空行，拿空行当边界只会截到前两行，判据就成了摆设。
  const cfg = /async def update_project_config[\s\S]*?(?=\n@router\.)/.exec(PROJECTS)?.[0] || "";
  ok("config 路由体被完整截到（判据前提）", cfg.includes("atomic_write_json(config_path"), cfg.slice(0, 60));
  ok("写别的项目配置不改视野", /if not req\.project or _is_active\(info\)/.test(cfg));
  ok("未打开项目时的报错口径没变", (PROJECTS.match(/未打开项目/g) || []).length >= 6);
}

// ══ 3. 后端：注册表协议 ════════════════════════════════════
{
  match("id 由宿主目录派生（重开同一个文件夹必须落回同一个 id）", REGISTRY, /"p_" \+ hashlib\.sha1\(real\.encode\("utf-8"\)\)\.hexdigest\(\)\[:10\]/);
  match("读坏注册表回空表，绝不因为索引坏了就打不开项目", REGISTRY, /except \(OSError, json\.JSONDecodeError\):\s*\n\s*return _blank\(\)/);
  ok("active 指向脏 id 时按最近打开回落", /newest = sorted\(projects, key=lambda e: float\(e\.get\("last_opened_at"\)/.test(REGISTRY));
  match("写盘先备份坏件再原子覆盖", REGISTRY, /backup_corrupt\(REGISTRY_PATH\)/);
  ok("在册条目封顶且固定项永不淘汰", /MAX_PROJECTS = 200/.test(REGISTRY) && /bool\(e\.get\("pinned"\)\)/.test(REGISTRY));
  ok("草稿按上限截断（prefs 会上共享档，别把 2MB 文本同步出去）", /MAX_DRAFT_CHARS = 2000/.test(REGISTRY));
  // 名字只用于显示：重名时不许按名字命中，否则两个同名项目被归成一个
  match("find_entry 只在名字唯一时才认名字", REGISTRY, /return named\[0\] if len\(named\) == 1 else None/);
  // 移除 ≠ 删数据
  const forget = /async def remove_registry_entry[\s\S]*?(?=\n@router\.)/.exec(PROJECTS)?.[0] || "";
  ok("forget 分支前提：函数体被完整截到", forget.includes("shutil.rmtree"), forget.slice(0, 60));
  ok("只有显式 forget 才删数据，且限定在 data/projects/ 前缀下",
    /if forget:/.test(forget) && /registry\.PROJECT_DATA_DIR\.resolve\(\)/.test(forget)
    && /startswith\(str\(allowed\)\)/.test(forget));
  ok("注册表不进 /settings/state 白名单（真源只有 projects.json 一份）",
    !/"projectsPrefs"/.test(SETTINGS_PY) && !/"projects":/.test(SETTINGS_PY));
}

// ══ 4. 后端：会话归属（延迟迁移，读时回落名称） ═════════════
{
  match("conversations 有 project_id 列", CHAT_PY, /project_id TEXT DEFAULT ''/);
  match("老库靠 ALTER 补列", CHAT_PY, /if "project_id" not in cols:/);
  match("project_id 有索引（切项目就查一次，不能全表扫）", CHAT_PY, /CREATE INDEX IF NOT EXISTS idx_conversations_project_id/);
  // 这一条是整个决策的钉子：回填是一次性改写全部历史，推错没有回头路
  ok("没做回填 UPDATE：历史仍按名称回落", !/UPDATE conversations SET project_id/.test(CHAT_PY));
  match("读时按名称回落", CHAT_PY, /def _name_fallbacks\(/);
  match("已归到别的项目的老会话不会被名字拽回来", CHAT_PY, /\(not c\.get\("project_id"\)\) and str\(c\.get\("project"\)/);
  match("列表接口接受 project_id", CHAT_PY, /async def list_conversations\(project_id: str = ""/);
  match("建新会话同时写名称与 id", CHAT_PY, /INSERT INTO conversations \(id, title, created_at, updated_at, project, project_id\)/);
  match("导入/导出带上 project_id", CHAT_PY, /prompt_tokens, completion_tokens, message_count, context_tokens, project, project_id/);
}

// ══ 5. 技能层：搜索不许打到"用户正在看的那个"项目上 ═══════════
{
  ok("code_search 不再直接读单例", !/_current_project/.test(CODE_SEARCH));
  match("code_search 走 _resolve_project", CODE_SEARCH, /_resolve_project/);
  match("code_search 接受 project 入参", CODE_SEARCH, /def execute\([\s\S]{0,300}?project: str = "",/);
}

// ══ 6. 前端：服务层与现场恢复的接线 ═════════════════════════
{
  for (const fn of ["getRegistry", "setActiveProject", "patchRegistry", "removeRegistry", "addProjectAliases"]) {
    match(`services/project.js 导出 ${fn}`, SVC, new RegExp(`async function ${fn}\\(`));
    ok(`${fn} 出现在导出表里`, new RegExp(`export \\{[\\s\\S]*?${fn}`).test(SVC));
  }
  ok("切换器与清单共用一份刷新", /async function refreshRegistry\(/.test(SCENE) && /setProjects|state\.projects = list/.test(SCENE));
  // 顺序是刻意的：先记旧项目再切，反过来会把旧草稿记到新项目头上
  const sw = /async function switchToProject[\s\S]*?\n\}/.exec(SCENE)?.[0] || "";
  ok("切换前先记旧项目现场", /await saveScene\(\);[\s\S]*?setActiveProject\(target\)/.test(sw), sw.slice(0, 200));
  ok("现场只认白名单字段（草稿由后端截断）", /last_conversation_id: state\.currentConversationId/.test(sw)
    || /last_conversation_id: state\.currentConversationId/.test(SCENE));
  ok("还原会话走动态 import，不静态依赖 chat.js（会成环）",
    /await import\("\.\.\/components\/chat\.js|import\("\.\.\/components\/chat\.js/.test(SCENE)
    && !/^import .* from "\.\.\/components\/chat\.js/m.test(SCENE));
  // 空现场必须清屏：只处理"有现场"那一支，切到没看过的项目就会把上一个项目的
  // 会话和草稿原样留在屏幕上——走查 W2 咬到的就是这个。
  ok("目标项目没有现场时清空会话与草稿（不是直接 return）",
    /if \(!wanted\) \{[\s\S]{0,220}?setDraftValue\(""\)[\s\S]{0,160}?startNewChat/.test(SCENE),
    /if \(!wanted\)[\s\S]{0,240}/.exec(SCENE)?.[0] || "");
  ok("上次没留草稿时也显式清空输入框",
    /setDraftValue\(String\(prefs\.draft \|\| ""\)\)/.test(SCENE));
  match("chat.js 把 startNewChat 提出来并导出（现场还原要复用）", CHAT, /export \{[\s\S]*?startNewChat \}/);
  match("新对话按钮复用同一个入口，不再各写一份", CHAT, /btnNewChat\.addEventListener\("click", startNewChat\)/);

  match("store 有在册清单与 active id", STORE, /projects: \[\],/);
  match("在册清单不落 localStorage（真源在服务端）", STORE, /state\.projects = Array\.isArray\(list\)/);
  match("顶栏项目名是切换器入口", BAR, /project-bar-switch/);
  match("× 的文案改成「收起」", BAR, /收起当前项目/);
  match("弹窗顶部先给在册项目", BAR, /function renderRegistryList\(/);
  match("打开项目弹窗里先刷新清单", BAR, /await refreshRegistry\(\);\s*\n\s*renderRegistryList\(\)/);
  match("打字与切会话都会记现场", BAR, /window\.addEventListener\("slate:conv-active-changed", queueSceneSave\)/);
  match("关浏览器前把待记的现场写下去", BAR, /addEventListener\("beforeunload"/);
  match("建会话同时带 project 与 project_id", CHAT, /project_id: state\.project\?\.project_id \|\| ""/);
  match("开机先问服务端视野，lastProjectPath 退成第二道",
    APP, /const res = await getCurrentProject\(\);\s*\n\s*let project = res\.code === 0 \? res\.data : null;/);
  match("Codex 组头操作按 project_id 走", APP, /const projectId = String\(meta\?\.projectId \|\| ""\)/);
  match("HTML 有在册项目一段", HTML, /id="project-registry-list"/);
  for (const cls of ["project-switcher", "project-registry-item", "conv-group-head", "codex-hist-group-row"]) {
    match(`CSS 有 .${cls}`, CSS, new RegExp(`\\.${cls}[\\s,{:]`));
  }
}

// ══ 7. 前端分组：两壳同一口径，且在 Node 里真跑 ══════════════
{
  const S = 1_700_000_000;
  const c = (id, extra = {}) => ({ id, title: id, updated_at: S, created_at: S, ...extra });
  const dup = [
    { id: "p_a", name: "app", path: "C:/one/app" },
    { id: "p_b", name: "app", path: "D:/two/app" },   // 与 p_a 同名不同目录
  ];
  const convs = [
    c("a1", { project: "app", project_id: "p_a" }),
    c("b1", { project: "app", project_id: "p_b" }),
    c("legacy", { project: "app", project_id: "" }),   // 老会话：只有名字
    c("free", { project: "", project_id: "" }),
  ];
  const show = (gs) => gs.map(([n, l]) => `${n}:${l.map(x => x.id).join(",")}`).join(" | ");

  // ① 重名在册：三组都要分开，且没 id 的老会话谁也不归（诚实，比猜一个强）
  const gs = tl.groupConversationsByProject(convs, "project", { flags: {}, activeConvId: "", registry: dup });
  ok("两个同名项目不会被合成一组", gs.length === 4, show(gs));
  ok("重名时组标签彼此可辨", new Set(gs.map(([n]) => n)).size === 4, show(gs));
  ok("a1 与 b1 各归各的 id 组",
    gs.some(([, l]) => l.length === 1 && l[0].id === "a1")
    && gs.some(([, l]) => l.length === 1 && l[0].id === "b1"), show(gs));
  ok("重名时老会话不硬塞给任何一个",
    gs.some(([, l]) => l.length === 1 && l[0].id === "legacy"), show(gs));
  ok("未分类仍垫底", gs[gs.length - 1][0] === "未分类", show(gs));
  ok("分组第三项带 projectId 给组头操作用",
    gs.every(([, , meta]) => meta && typeof meta.projectId === "string"
      && typeof meta.projectName === "string"), JSON.stringify(gs.map(g => g[2])));

  // ② 名字在册唯一：没 id 的老会话按名称回落，和同一个组（这就是"延迟迁移"读到时的样子）
  const solo = [{ id: "p_a", name: "app", path: "C:/one/app" }];
  const gs2 = tl.groupConversationsByProject(convs, "project", { flags: {}, activeConvId: "", registry: solo });
  ok("名字唯一时老会话按名称并入那个 id 组",
    gs2.some(([, l]) => l.map(x => x.id).join(",") === "a1,legacy"), show(gs2));
  ok("册外 id（p_b 已被移除）仍单独成组，不会被并进同名组",
    gs2.some(([, l]) => l.map(x => x.id).join(",") === "b1"), show(gs2));

  // ③ 清单还没加载（首屏）：按 id 分组照旧，不报错、不把有 id 的降级进名字组
  const gs3 = tl.groupConversationsByProject(convs, "project", { flags: {}, activeConvId: "" });
  ok("清单缺失时不抛异常且仍分四组", gs3.length === 4, show(gs3));

  // ④ projectGroupKey 的取值域：id > 唯一名称 > 名字组 > 未分类
  assert.equal(tl.projectGroupKey(c("x", { project_id: "p_a" }), dup), "id:p_a");
  assert.equal(tl.projectGroupKey(c("x", { project: "app", project_id: "" }), dup), "name:app",
    "两个同名在册项目时，没 id 的老会话只能停在名字组");
  assert.equal(tl.projectGroupKey(c("x", { project: "app", project_id: "" }), solo), "id:p_a",
    "名字在册唯一时按名字归到那个 id（等价于后端读时回落）");
  assert.equal(tl.projectGroupKey(c("x"), []), "none");
  ok("classic 与 Codex 都用带 registry 的 ctx",
    /registry: state\.projects/.test(CHAT) && /registry: state\.projects/.test(APP));
  passed += 1;
}

// ══ 8. 双语词条：切换器文案不许写死在 JS 里 ═══════════════════
{
  const keys = [
    "在册项目", "点击切换在册项目", "打开其他目录…", "从最近移除", "取消固定",
    "切到该项目", "收起当前项目（仍保留，点项目名可切回）",
  ];
  for (const k of keys) ok(`词条「${k}」有英文对照`, DICT.includes(`"${k}"`));
}

// ── 汇总 ────────────────────────────────────────────────
if (fails.length) {
  console.error(`check_multi_project: ${fails.length}/${passed + fails.length} 项失败`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`check_multi_project: 通过（${passed} 项）`);
