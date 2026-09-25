/**
 * AI 辅助功能守卫：scripts/check_ai_features.mjs
 *
 * 这一层的契约只有一句话：除了对话、团队对话、提示词工厂，任何自己去找模型要结果的功能
 * 都必须能在设置里关掉、并且能单独选模型。它最容易坏在三个地方：
 * ① 加了新功能却忘了接闸门（表上有个名字，代码里没人问）——表看起来全，实际照发请求；
 * ② 接了闸门但选出来的模型没真进请求（还是用主模型）——"选模型"成了摆设；
 * ③ 持久化链少一环（builder 写了、读盘没写，或后端白名单漏键）——设置重启就丢。
 * 所以这里不查"有没有那个常量"，而是逐个功能查：闸门在不在真正发请求那个函数体内、
 * 解析出来的模型 id 有没有出现在同一段请求参数里。
 *
 * 运行：node scripts/check_ai_features.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const SERVICE = read("frontend/js/services/ai_features.js");
const STORE = read("frontend/js/store.js");
const HTML = read("frontend/index.html");
const APP = read("frontend/js/app.js");
const I18N = read("frontend/js/services/i18n_dict.js");
const CHAT = read("frontend/js/components/chat.js");
const MEMORY = read("frontend/js/components/memory.js");
const REVIEW = read("frontend/js/components/review.js");
const UNDERSTAND = read("frontend/js/components/understand.js");
const BOARD = read("frontend/js/components/whiteboard.js");
const SUBAGENT = read("frontend/js/services/subagent.js");
const RISK = read("frontend/js/services/riskguard.js");
const WORKFLOW = read("frontend/js/services/workflow.js");
const TOOLS = read("frontend/js/services/tools.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const MAUTH = read("frontend/js/mobile/m-auth.js");
const SETTINGS_PY = read("backend/routers/settings.py");
const AIF_PY = read("backend/ai_features.py");
const SCHED_PY = read("backend/routers/scheduler.py");
const IMAGE_PY = read("backend/skills/image_gen.py");
const VIDEO_PY = read("backend/skills/video_gen.py");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);

// 取某个顶层函数的函数体（这些文件里函数都是顶格 `}` 收尾），
// 用来把判据钉在"真正发请求的那个函数里面"，而不是"这个文件里某处有"。
function fnBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

// ── 1. 登记表自身成立 ────────────────────────

const table = SERVICE.slice(SERVICE.indexOf("export const AI_FEATURES"));
const ids = [...table.matchAll(/^\s*id:\s*"([a-z_]+)"/gm)].map(m => m[1]);
const names = [...table.matchAll(/name:\s*"([^"]+)"/g)].map(m => m[1]);
const notes = [...table.matchAll(/note:\s*"([^"]+)"/g)].map(m => m[1]);
const toolsOf = [...table.matchAll(/tool:\s*"([a-z_]+)"/g)].map(m => m[1]);

ok("登记表被解析出来了（不是空表）", ids.length >= 13, `只读到 ${ids.length} 个功能`);
ok("功能 id 不重复", new Set(ids).size === ids.length,
  ids.filter((v, i) => ids.indexOf(v) !== i).join(","));
ok("每个功能都有名字与一句话说明", ids.length === names.length && ids.length === notes.length,
  `id=${ids.length} name=${names.length} note=${notes.length}`);
ok("每个功能都标了触发方式（自动/手动/模型调用）",
  (table.match(/mode:\s*"(自动|手动|模型调用)"/g) || []).length === ids.length);
ok("模型可见的话术没进登记表（表里只放给人看的文案）",
  !/content:\s*"/.test(table) && !/system:\s*"/.test(table));

// 豁免项不许挂号：对话与团队对话是产品本体，自动推进/后台续跑在各自区块里已有开关，
// 同一件事两处开关迟早出现"这里关了那边还在跑"。
for (const banned of ["auto_review", "bg_auto_resume", "continue_autopilot", "team_chat", "prompt_factory"]) {
  ok(`豁免功能没被重复挂号：${banned}`, !ids.includes(banned));
}

// ── 2. 每个 id 真被消费：闸门 + 模型都落在发请求的函数体内 ──

// id → [发请求所在的文件, 函数名] 若干处；一处功能可能桌面/手机各有一处。
// 两个例外：subagent 的闸门在工具目录那一层（关掉＝工具不出现在目录、硬调也被拒），
// resolveBinding 只是解析模型、闸门在 runWorkflow 总入口。
const TOOLS_GATED = new Set(["subagent"]);
const CONSUMERS = {
  context_compress: [[CHAT, "checkAndCompress"], [CHAT, "doManualCompress"], [MCHAT, "mCheckCompress"]],
  memory_distill: [[MEMORY, "autoRefineMemoryAndProfile"]],
  memory_extract: [[MEMORY, "extractMemoriesFromConversation"]],
  conversation_spark: [[MEMORY, "captureConversationSpark"]],
  code_understand: [[UNDERSTAND, "startUnderstanding"]],
  code_review: [[REVIEW, "startReview"]],
  whiteboard_organize: [[BOARD, "aiOrganize"]],
  subagent: [[SUBAGENT, "runOneSubAgent"]],
  command_explain: [[RISK, "explainCommand"], [MAUTH, "mExplainCommand"]],
  workflow_dag: [[WORKFLOW, "runWorkflow"], [WORKFLOW, "resolveBinding"]],
};

for (const id of ids) {
  const sites = CONSUMERS[id];
  if (!sites) {
    // 后端自己发请求的三项没有前端函数，改由本节末尾的后端断言与工具目录兜住；
    // 冒出一个既不在这里、也不在那三项里的 id，就是新功能忘了接线。
    ok(`未挂号的功能必须属于后端三项：${id}`,
      ["scheduled_task", "image_gen", "video_gen"].includes(id),
      "登记表里出现既没有前端消费点、也不在后端三项里的 id");
    continue;
  }
  for (const [src, fn] of sites) {
    const body = fnBody(src, fn);
    const gated = body.includes(`isAiFeatureOn("${id}")`) || body.includes(`aiFeatureBlocked("${id}")`);
    const needsGate = !TOOLS_GATED.has(id) && fn !== "resolveBinding";
    if (needsGate) {
      ok(`${fn} 函数体内有 ${id} 的闸门`, !!body && gated,
        "闸门写在函数外面等于没写：别的入口照样能调到这段请求");
    }
    if (fn === "runWorkflow") continue; // 整条链都要发请求，总闸门在这里就够
    ok(`${fn} 用 ${id} 指定的模型发请求`, body.includes(`aiModelFor("${id}"`),
      "有开关但模型仍写死跟随主模型：设置里的选模型是摆设");
    // 选出来的模型要真流到请求参数里（可能是直接塞进 streamChat，也可能是转手给内部函数）
    ok(`${fn} 把选出来的模型用上了`, /target\.id/.test(body) && /target\.key/.test(body),
      "解析完模型就丢了，选谁都一样");
    ok(`${fn} 没留硬编码兜底模型`, !/gpt-5\.6-terra/.test(body),
      "写死模型 id：换端点后这项功能会静默报未配置或直接 404");
  }
}

// 后端自己发请求的三项：关掉就一次都不发
ok("定时任务在后端查同一份开关", /feature_enabled\("scheduled_task"\)/.test(SCHED_PY));
ok("图片生成在后端查同一份开关", /feature_enabled\("image_gen"\)/.test(IMAGE_PY));
ok("视频生成在后端查同一份开关", /feature_enabled\("video_gen"\)/.test(VIDEO_PY));
// 只查调用那一行会放过"函数里调了但没 import"——视频生成曾就是这么坏的：
// 调用点在，NameError 也在，用户看到的是"技能执行失败"而不是"已关闭"。
for (const [rel, src] of [["backend/routers/scheduler.py", SCHED_PY],
  ["backend/skills/image_gen.py", IMAGE_PY], ["backend/skills/video_gen.py", VIDEO_PY]]) {
  ok(`${rel} 真的 import 了 feature_enabled`,
    /^from backend\.ai_features import /m.test(src), "调用点在但没 import：一关就抛 NameError");
}
ok("后端读取处与前端同一份状态文件", has(AIF_PY, "desktop_state.json"));
// 只 grep "aiHelpers" 是假牙：这个词在文件头的说明里就出现过一次，读错键照样过关。
ok("后端读的就是 aiHelpers 这个键", /shared\.get\("aiHelpers"\)/.test(AIF_PY),
  "改成读别的键：前端写了后端看不见，开关全成摆设");
ok("前端读开关默认全开（没写过的功能不许按关处理）",
  /entryOf\(id\)\.enabled !== false/.test(SERVICE),
  "写成 === true 会让所有从未在设置里点过的功能静默失效");
ok("工作流节点落在默认档时能拿到 Key",
  /getModelKey\(binding\.modelId\) \|\| binding\.key/.test(WORKFLOW),
  "只认 modelKeys 那一份：本地模型与临时输入的 Key 会被判成未配置");
ok("后端读不到状态时默认放行（损坏的偏好不该静默禁功能）",
  /def feature_enabled[\s\S]{0,600}return default/.test(AIF_PY));

// ── 3. 工具类功能：目录里不给、硬调也不执行 ──────────────────

const TOOL_FILES = { subagent_run: "subagent", image_gen: "image_gen", video_gen: "video_gen" };
for (const t of toolsOf) {
  ok(`登记表里的工具名在工具表里真存在：${t}`, new RegExp(`^\\s*${t}:\\s*\\{`, "m").test(TOOLS)
    || new RegExp(`"${t}"`).test(TOOLS), "工具名写错＝关掉的是空气");
}
ok("文本协议工具目录按开关过滤", /toolEntries[\s\S]{0,300}!isAiToolOff\(key\)/.test(TOOLS));
ok("精简目录的核心集也按开关过滤",
  /CORE_AGENT_TOOLS\.filter\(key => TOOLS\[key\]\)[\s\S]{0,200}isAiToolOff/.test(TOOLS));
ok("原生 tools schema 按开关过滤",
  /function buildOpenAITools[\s\S]{0,300}if \(isAiToolOff\(key\)\) continue/.test(TOOLS));
ok("skill_run 的常用清单按开关过滤", /SKILL_RUN_QUICK_LIST\.filter\(n => !isAiToolOff\(n\)\)/.test(TOOLS));
ok("工具选择速查里也不提关掉的功能（配方会把模型引向被摘掉的工具）",
  /offToolNames[\s\S]{0,200}route\.includes\(name\)/.test(TOOLS));
ok("模型凭记忆硬调时给明确停用话术",
  /function executeTool[\s\S]{0,700}isAiToolOff\(name\)/.test(TOOLS)
  && /该功能已由用户在「设置 → AI 辅助功能」中关闭/.test(TOOLS));
ok("工具停用话术没走 t()（模型可见文案不入典）",
  !/t\(`?\[工具 \$\{name\}\] 未执行：该功能/.test(TOOLS));

// ── 4. 持久化链一环不缺 ──────────────────────

ok("state 里声明了 aiHelpers", /aiHelpers:\s*\{\}/.test(STORE));
ok("本机落盘产出 aiHelpers", /aiHelpers: normalizeAiHelpers\(state\.aiHelpers\)/.test(STORE));
ok("共享状态产出 aiHelpers（手机端要读同一份）",
  /aiHelpers: normalizeAiHelpers\(data\.aiHelpers\)/.test(STORE));
ok("本机读回落 aiHelpers",
  (STORE.match(/state\.aiHelpers = normalizeAiHelpers\(data\.aiHelpers\);/g) || []).length >= 2,
  "两条读盘少一条：另一台机器改的开关在这台不生效");
ok("共享读盘按 hasOwnProperty 判定（缺键不许覆盖）",
  /hasOwnProperty\.call\(data, "aiHelpers"\)/.test(STORE));
ok("后端白名单收了 aiHelpers（漏键会被静默丢弃）", /"aiHelpers",/.test(SETTINGS_PY));
ok("归一化函数把 enabled 定型为布尔", /enabled: raw\.enabled !== false/.test(STORE));
ok("唯一写入口：改完就落盘并通知订阅者",
  /export function setAiFeature[\s\S]{0,700}savePersistent\(\)[\s\S]{0,200}notify\("aiHelpers"/.test(SERVICE));

// ── 5. 设置界面 ──────────────────────────────

ok("设置页有独立区块", has(HTML, 'id="settings-ai-features"'));
ok("区块有锚点导航项", has(HTML, 'data-target="settings-ai-features"'));
ok("行由 JS 渲染进容器（一张表一处渲染，不手抄 13 遍 DOM）",
  has(HTML, 'id="ai-feature-list"') && /export function renderAiFeatureSettings/.test(SERVICE));
ok("每行是复选框 + 模型下拉",
  /data-ai-enabled/.test(SERVICE) && /data-ai-model/.test(SERVICE));
ok("下拉第一项是跟随主模型（空串语义与审阅模型一致）",
  /<option value="">\$\{t\("跟随当前主模型"\)\}/.test(SERVICE));
ok("关掉的功能整行变灰且下拉点不动（别让人以为还能选）",
  /\.ai-feature-row\.is-off/.test(read("frontend/css/style.css"))
  && /classList\.toggle\("is-off"/.test(SERVICE));
ok("模型被删后下拉保留那一项（不悄悄改默认值）", /已不在模型列表/.test(SERVICE));
ok("app.js 打开设置时刷新、启动时绑定一次",
  /renderAiFeatureSettings\(\)/.test(APP) && /initAiFeatureSettings/.test(APP));
ok("区块文案说明了两处已有开关不重复设",
  has(HTML, "「自动推进」的审阅模型、「后台任务」的自动续跑在各自区块里"));

// ── 6. 不许留硬编码兜底模型 ──────────────────────

for (const [label, src] of [["memory.js", MEMORY], ["subagent.js", SUBAGENT]]) {
  ok(`${label} 不再写死兜底模型`, !has(src, "gpt-5.6-terra"),
    "写死一个模型 id：换端点后这项功能会静默报未配置或直接 404");
}
ok("压缩两条路径都不再写死兜底模型",
  !has(fnBody(CHAT, "checkAndCompress"), "gpt-5.6-terra")
  && !has(fnBody(CHAT, "doManualCompress"), "gpt-5.6-terra"));

// ── 7. 中英双份：登记表与界面文案都要有词条 ──────────────────────

for (const n of names) ok(`词条：${n}`, has(I18N, `"${n}":`));
for (const n of notes) ok(`词条：${n.slice(0, 12)}…`, has(I18N, `"${n}":`));
for (const extra of ["AI 辅助功能", "（未配置 Key）", "（已不在模型列表）",
  "{name}已关闭，可在「设置 → AI 辅助功能」中打开",
  "共 {n} 项，全部开启（关闭即不再为此发模型请求）",
  "共 {n} 项，已关闭 {off} 项（关闭即不再为此发模型请求）",
  "团队工作流已在「设置 → AI 辅助功能」中关闭",
  "（命令目的说明已关闭，可在设置 → AI 辅助功能打开）",
  "（命令目的说明已关闭，可在桌面端设置 → AI 辅助功能打开）"]) {
  ok(`词条：${extra.slice(0, 18)}`, has(I18N, `"${extra}"`));
}
ok("登记表里每条说明都不许出现英文单引号（会截断 JS 字符串）", !notes.some(n => n.includes("'")));

// ── 8. 解析/语法层面兜底 ──────────────────────

ok("登记表解析用的 id 与源码一致（正则没读漏）", ids.length >= 13 && ids.includes("context_compress"));
ok("前端消费点清单覆盖登记表（新增功能要先在这里挂号）",
  ids.every(id => CONSUMERS[id] || ["scheduled_task", "image_gen", "video_gen"].includes(id)));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_ai_features: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
