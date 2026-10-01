/**
 * 自进化工具守卫：scripts/check_evolved_tools.mjs
 *
 * 「工具工厂」让 SLATE 自己写代码给自己用。这类功能一旦接线断了，坏法全是静默的：
 * ① 产物写回源码树（backend/skills/）——一次升级就把用户攒的东西冲干净，还让程序改自己；
 * ② 装载不看启用/停用——面板上明明"已停用"，模型下一轮照样调得动；
 * ③ 覆盖/删除不留底——生成错的代码被覆盖后就再也找不回来，"随时撤销"成了空话；
 * ④ 与新版内置同名时不判优先——两份同名实现谁跑谁不跑没人说得清；
 * ⑤ 清单与源码分两次写、或写盘与注册不同源——刷新一次就各说各话；
 * ⑥ 前端只把 id 拼进 URL 而不消毒——路径穿越到 data/ 外面。
 * 所以这里逐条钉"约定"，而不是只查文件里出现过某个名字。
 *
 * 运行：node scripts/check_evolved_tools.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const EVO = read("backend/evolution.py");
const FACTORY = read("backend/skills/mcp_factory.py");
const SKILLS_PY = read("backend/routers/skills.py");
const EVOLVED_PY = read("backend/routers/evolved.py");
const MAIN_PY = read("backend/main.py");
const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const EXT = read("frontend/js/components/extensions.js");
const PANEL = read("frontend/js/components/skill_panel.js");
const TOOLS = read("frontend/js/services/tools.js");
const STORE = read("frontend/js/store.js");
const CHAT = read("frontend/js/components/chat.js");
const DICT = read("frontend/js/services/i18n_dict.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

/** Python 里某个 `def NAME(` 的函数体（到下一个顶格 def/class 或文件尾为止） */
function pyFn(src, name) {
  const start = src.search(new RegExp(`^def ${name}\\(`, "m"));
  if (start < 0) return "";
  const rest = src.slice(start);
  const next = rest.slice(1).search(/^def |^class /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// ── 1. 产物落点：用户数据区，不是源码树 ────────────────────

ok("evolution 把产物锚在 DATA_DIR/evolved（DATA_DIR 仍吃 SLATE_DATA_DIR，测试才隔离得开）",
  /DATA_DIR = Path\(os\.environ\.get\("SLATE_DATA_DIR"/.test(EVO)
  && /EVOLVED_DIR = DATA_DIR \/ "evolved"/.test(EVO));
ok("evolution 不以任何形式往 backend/skills 写盘（只有迁移那一条读它的旧产物）",
  !/SKILLS_DIR\s*=\s*Path\(__file__\)/.test(EVO)
  && !/write_text|write_bytes|atomic_write/.test(pyFn(EVO, "migrate_legacy")),
  "迁移只做「读旧的 → 走 save_tool 写新址」，绝不回写源码树");
ok("工具工厂不再自己拼源码目录，落盘全交给 evolution.save_tool",
  !/SKILLS_DIR/.test(FACTORY) && /evolution\.save_tool\(/.test(FACTORY));
ok("工具工厂不再改内存里的 BUILTIN_SKILLS 来「注册」",
  !/BUILTIN_SKILLS\[[^\]]*\]\s*=/.test(FACTORY));
ok("工具工厂拒绝与内置工具同名（同名会被内置顶掉，攒着只会有一个死文件）",
  /if name in evolution\.builtin_names\(\):/.test(FACTORY));
ok("工厂名消毒的上限与 evolution 那条正则同为 48（截 64 会在落盘时被判名字不合法）",
  /return cleaned\[:48\]/.test(FACTORY) && /\^\[a-z\]\[a-z0-9_\]\{0,47\}\$/.test(EVO));

// ── 2. 路径围栏：id 先消毒再 join，解析后必须仍在目录内 ──────

const PATHFN = pyFn(EVO, "_tool_path");
ok("_tool_path 解析后仍要求留在目录内（挡住 ../ 与符号链接外逃）",
  /return target if target\.parent == root else None/.test(PATHFN));
const HPFN = pyFn(EVO, "_history_path");
ok("_history_path 先过时间戳正则再拼路径", /HISTORY_TS_RE\.match\(ts\)/.test(HPFN)
  && /return target if target\.parent == root else None/.test(HPFN));
ok("路由层每个入口都先 evolution.clean_name，不拿原始路径参数去拼文件",
  /evolution\.clean_name\(tool_name\)/.test(EVOLVED_PY));
ok("清单与源码两条路都过同一个 _tool_path（少一条就是只围栏了一半）",
  (PATHFN.match(/_tool_path\(/g) || []).length > 0
  && /_tool_path\(EVOLVED_DIR, clean, "\.json"\)/.test(EVO));

// ── 3. 装载语义：停用/坏掉/被顶掉都不许跑 ──────────────────

const LOAD = pyFn(EVO, "load_module");
for (const [label, re] of [
  ["停用", /if not item\["enabled"\]/],
  ["代码本身有问题", /if item\["error"\]/],
  ["被内置同名顶掉", /if item\["shadowed"\]/],
]) {
  ok(`load_module 对「${label}」这一类直接拒绝执行（面板说了停用就必须真停）`, re.test(LOAD));
}
ok("装载缓存按源码摘要失效（回滚/覆盖之后不会还在跑旧逻辑）",
  /_LOADED\[clean\] = \{"digest": item\["digest"\]/.test(LOAD)
  && /cached\.get\("digest"\) == item\["digest"\]/.test(LOAD));
ok("写盘三处（保存/停用/删除）都把缓存摘掉",
  (EVO.match(/_LOADED\.pop\(clean, None\)/g) || []).length >= 3);
ok("列清单时不执行生成的代码（只 compile 自检，跑一遍等于替用户按了一次）",
  /compile\(source, "evolved\.py", "exec"\)/.test(pyFn(EVO, "check_source")));

// ── 4. 目录合并：启用/坏掉/顶掉都不能进模型目录 ────────────

const USABLE = pyFn(EVO, "usable");
ok("usable 同时看 enabled、error 与 shadowed（只看一条的话另两条会偷偷进目录）",
  /item\.get\("enabled"\)/.test(USABLE) && /item\.get\("error"\)/.test(USABLE)
  && /item\.get\("shadowed"\)/.test(USABLE));
ok("shadowed 在 _item_for 里判一次（清单与装载共用同一个结论）",
  /entry\["shadowed"\] = clean in set\(builtin_names\(\)\)/.test(pyFn(EVO, "_item_for")));
ok("builtin_names 走惰性导入（模块级互相引用会把 skills 路由与 evolution 锁成环）",
  /from backend\.routers\.skills import BUILTIN_SKILLS/.test(pyFn(EVO, "builtin_names"))
  && !/^from backend\.routers/s.test(EVO));

// ── 5. 留底与回滚 ─────────────────────────────────────

ok("覆盖前留底：save_tool 先 _snapshot 再写两份文件",
  /backed_up = _snapshot\(clean\)/.test(pyFn(EVO, "save_tool")));
ok("撤销也留底：delete_tool 先 _snapshot 再 unlink",
  /backed_up = _snapshot\(clean\)/.test(pyFn(EVO, "delete_tool")));
ok("留底成对（源码 + 清单），只回滚代码时也不会丢描述",
  /atomic_write_text\(HISTORY_DIR \/ f"\{clean\}\.\{ts\}\.py", source\)/.test(EVO)
  && /atomic_write_text\(HISTORY_DIR \/ f"\{clean\}\.\{ts\}\.json"/.test(EVO));
ok("留底数量有上限（HISTORY_KEEP）并按时间戳裁剪",
  /for entry in history_versions\(clean\)\[HISTORY_KEEP:\]/.test(pyFn(EVO, "_prune_history")));
ok("回滚走的仍是 save_tool 这一条写入口（另开一条就会少做语法自检）",
  /= save_tool\(/.test(pyFn(EVO, "restore_history")));
ok("编译不过的历史版本不许盖回去",
  /if check_source\(source\):/.test(pyFn(EVO, "restore_history")));
ok("语法不过的生成代码根本不落盘（工厂与 save_tool 同一道门）",
  /syntax_error = check_source\(source\)/.test(pyFn(EVO, "save_tool")));

ok("留底时间戳的序号补零（同一秒连存 10 次以上时，-10 会在字典序里排到 -2 前面）",
  /ts = f"\{stamp\}-\{seq:02d\}"/.test(pyFn(EVO, "_snapshot")));
ok("留底时间戳必须比现存的最大值更靠后（被裁掉的名字会腾出来复用，按字典序会把最新那份当最旧的剪掉）",
  /newest = max\(\(v\["ts"\] for v in history_versions\(clean\)\), default=""\)/.test(pyFn(EVO, "_snapshot"))
  && /while \(HISTORY_DIR \/ f"\{clean\}\.\{ts\}\.py"\)\.exists\(\) or ts <= newest:/.test(pyFn(EVO, "_snapshot")));
ok("迁移不碰语法不过的旧产物，也不回写源码树",
  /if check_source\(source\):\n            continue/.test(pyFn(EVO, "migrate_legacy")));
ok("migrate_legacy 可指名源目录（自检才能拿临时目录跑，不往仓库 skills 里种文件）",
  /def migrate_legacy\(skills_dir: Path \| None = None\)/.test(EVO));

// ── 6. 路由注册与运行期分流 ────────────────────────────

ok("evolved 路由挂进 app", /app\.include_router\(evolved\.router, prefix="\/api"\)/.test(MAIN_PY));
ok("启动时迁移旧产物（失败只记日志，不该拖垮后端）",
  /evolution\.migrate_legacy\(\)/.test(MAIN_PY) && /logging\.warning/.test(MAIN_PY));
ok("能力清单单独给 evolved 一份，不并进内置那份 mcp（两类要能分开管）",
  /"evolved": evolution\.catalog\(\)/.test(SKILLS_PY));
ok("执行与流式两条入口都能解析自进化工具",
  /evolution\.load_module\(clean_evolved\)/.test(SKILLS_PY)
  && (SKILLS_PY.match(/evolution\.load_module\(clean_evolved\)/g) || []).length === 2);
const RESOLVE = pyFn(SKILLS_PY, "_resolve_stream_target");
ok("内置那一条先判：同名时内置赢，自进化那份让路",
  RESOLVE.indexOf('if skill_name in BUILTIN_SKILLS:') < RESOLVE.indexOf("clean_evolved = evolution.clean_name("));

// ── 7. 前端接线 ─────────────────────────────────────

ok("分栏轨有「新功能」这一项", /\{ key: "evolved", label: "新功能" \}/.test(EXT));
ok("栏体与计数位都在 HTML 里", HTML.includes('data-ext="evolved"')
  && HTML.includes('id="ext-evolved-list"') && HTML.includes('id="ext-evolved-count"'));
ok("弹窗外壳在 HTML 里（JS 只取 id，不自己造 modal）",
  ["evolved-modal", "evolved-modal-title", "evolved-modal-meta", "evolved-source",
    "evolved-history", "btn-evolved-history", "btn-evolved-toggle", "btn-evolved-delete"]
    .every((id) => HTML.includes(`id="${id}"`)));
ok("面板算了「evolved」这一栏的条数（没人报就永远显示 0）",
  /setExtCount\("evolved", evolvedCache\.length\)/.test(PANEL));
ok("进扩展页会重取自进化清单（挂在 refreshSkills 这条唯一的刷新入口上）",
  /refreshEvolved\(\);/.test(pyBlock(PANEL, "async function refreshSkills()"))
  && /document\.getElementById\("btn-ext-evolved-refresh"\)\?\.addEventListener\("click", refreshEvolved\)/.test(PANEL));
const URL_CALLS = [...PANEL.matchAll(/(?:get|post|del)\(`\/evolved\/\$\{([^}]+)\}/g)].map(m => m[1]);
ok("每条 /evolved/<id> 请求都先 encodeURIComponent（面板里的名字来自盘上文件，不能直接拼 URL）",
  URL_CALLS.length >= 5 && URL_CALLS.every(x => /encodeURIComponent\(/.test(x)),
  `共 ${URL_CALLS.length} 处：${URL_CALLS.filter(x => !/encodeURIComponent\(/.test(x)).join(" | ") || "全部已消毒"}`);
ok("迟到的旧响应不许盖掉当前这条（取源码那一步）",
  /if \(currentEvolvedName !== name\) return;/.test(pyBlock(PANEL, "async function openEvolvedModal(name)")));
ok("历史「查看」迟到时也不许把上一条的留底留在这一条正文上",
  /if \(currentEvolvedName !== name\) return;/.test(pyBlock(PANEL, "function createEvolvedHistoryRow(version)")));
ok("store 初值带 evolved 一份（缺了这个，首屏读 state.skills.evolved 就是 undefined）",
  /skills: \{ mcp: \{\}, evolved: \{\}, skills: \{\}, remote: \{\} \}/.test(STORE));
ok("提及候选与提及解析用同一份合并口径（候选里有的名字必须解析得动）",
  (CHAT.match(/\{ \.\.\.\(state\.skills\?\.mcp \|\| \{\}\), \.\.\.\(state\.skills\?\.evolved \|\| \{\}\) \}/g) || []).length === 2);
ok("skill_search 会列出「自进化工具」这一类", /type: "自进化工具"/.test(TOOLS));
ok("工具目录里点名当前启用的自产工具（不列出来模型根本不知道它们存在）",
  /const evolvedNames = Object\.keys\(state\.skills\?\.evolved \|\| \{\}\)\.slice\(0, 8\)/.test(TOOLS)
  && /evolvedNames\.length \? `自产工具/.test(TOOLS));

// ── 8. CSS：桌面样式没有全局 .hidden，靠自己的规则撑显示 ────────
// 只看"CSS 里出现过这个点号串"是不够的：把规则改名成 .evolved-source-x 照样被算中，
// 于是"class 在切、像素不动"这条最常见的错法就漏了。按选择器整词配规则块。
const SELECTORS = [...CSS.matchAll(/([^{}]+)\{/g)].map(m => m[1]).join("\n");
for (const cls of ["skill-kind-evolved", "evolved-item", "evolved-off", "evolved-state",
  "evolved-state-bad", "evolved-state-warn", "evolved-state-muted", "evolved-toggle-btn",
  "evolved-modal-meta", "evolved-source", "evolved-history", "evolved-history-tip",
  "evolved-history-empty", "evolved-modal-footer"]) {
  ok(`style.css 里有 .${cls} 规则块`, new RegExp(`\\.${cls}(?![\\w-])`).test(SELECTORS));
}
ok("停用/顶掉的那一条有可见差异（evolved-off 真的改变像素，不是只挂个 class）",
  /\.evolved-item\.evolved-off(?![\w-])[^{]*\{[^}]*opacity/.test(CSS));
ok(".evolved-history.hidden 收得起来（桌面 CSS 没有全局 .hidden 兜底）",
  /\.evolved-history\.hidden(?![\w-])[^{]*\{[^}]*display:\s*none/.test(CSS));
ok(".evolved-source 保留缩进与换行（Python 源码丢了缩进就等于换了份文件）",
  /\.evolved-source(?![\w-])[^{]*\{[^}]*white-space:\s*pre(?![\w-])/.test(CSS));

// ── 9. 词条齐全 ──────────────────────────────────────

for (const key of ["新功能", "自产", "停用", "启用", "已停用", "撤销工具", "自进化工具",
  "不可用：{msg}", "与内置工具同名，已由内置接管", "已停用 {name}，模型目录里已摘掉",
  "只回滚代码", "留底 {n} 版", "还没有自产工具。让模型用「工具工厂」生成一个，产物会出现在这里，可随时停用或撤销"]) {
  ok(`词条：${key}`, DICT.includes(`"${key}"`));
}

/** 取某个 JS 函数体的小工具（与 pyFn 同思路，但按花括号配平收口） */
function pyBlock(src, header) {
  const start = src.lastIndexOf(header);
  if (start < 0) return "";
  let depth = 0, seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_evolved_tools: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
