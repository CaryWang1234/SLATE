/**
 * 回复模式守卫：scripts/check_mode_registry.mjs
 *
 * 「回复模式」横跨四层，任何一层漏接都是静默的：注册表少一个字段 → 浮层少一行说明；
 * 白名单没进请求 → 用户选了「经济」照样能写文件；工具执行口没设闸 → 模型凭记忆硬调就绕过去了；
 * 每场的键写错 → 改这一场变成了改全局。所以这里既 import 真实现核对注册表的值，
 * 又逐层钉住"这一层真在用 mode"的接线，并特意钉住"后台旁路不许继承模式"（团队/子代理/
 * 工作流/记忆按自己的提示词跑，不该被前面那一场选的模式掐掉工具）。
 *
 * 运行：node scripts/check_mode_registry.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const STORE = read("frontend/js/store.js");
const TOOLS = read("frontend/js/services/tools.js");
const ADAPTER = read("frontend/js/services/adapter.js");
const CHAT = read("frontend/js/components/chat.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const METER = read("frontend/js/services/context_meter.js");
const PICKER = read("frontend/js/components/mode_picker.js");
const PANEL = read("frontend/js/components/mode_panel.js");
const EXT = read("frontend/js/components/extensions.js");
const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const DICT = read("frontend/js/services/i18n_dict.js");
const SETTINGS_PY = read("backend/routers/settings.py");

const TEAM = read("frontend/js/components/team.js");
const SUBAGENT = read("frontend/js/services/subagent.js");
const WORKFLOW = read("frontend/js/services/workflow.js");
const MEMORY = read("frontend/js/components/memory.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

// ── 1. 注册表本体（import 真实现，不重抄一份常量）──────────────

const store = await import("../frontend/js/store.js");
const { BUILTIN_MODES, MODE_POPOVER_MAX, MODE_READONLY_TOOLS, MODE_TOOLS_NONE, modeRegistry, modeById } = store;

const ids = BUILTIN_MODES.map(m => m.id);
ok("内置四档就是智能/对话/经济/狂暴，别的一律算自定义",
  JSON.stringify(ids) === JSON.stringify(["smart", "chat", "eco", "turbo"]), ids.join("/"));
const want = {
  smart: { label: "智能", icon: "tool", color: "var(--text)" },
  chat: { label: "对话", icon: "message-circle", color: "#2fd4c4" },
  eco: { label: "经济", icon: "leaf", color: "#3fb950" },
  turbo: { label: "狂暴", icon: "flame", color: "#ff7a45" },
};
for (const [id, exp] of Object.entries(want)) {
  const m = modeById(id);
  ok(`「${exp.label}」的名称/图标/颜色是用户指定的那一套（${id}）`,
    m.label === exp.label && m.icon === exp.icon && m.color.toLowerCase() === exp.color.toLowerCase(),
    JSON.stringify({ label: m.label, icon: m.icon, color: m.color }));
}
ok("智能档不追加提示词、不动工具与旋钮（它是默认基线）",
  modeById("smart").prompt === "" && modeById("smart").tools === null
  && !modeById("smart").effort && !modeById("smart").rounds);
ok("对话档 = 不调用工具 + 单轮（tools 是 none、rounds 1）",
  modeById("chat").tools === MODE_TOOLS_NONE && modeById("chat").rounds === 1);
ok("经济档 = 只读工具白名单 + 低推理 + 收窄轮数",
  Array.isArray(modeById("eco").tools) && modeById("eco").tools.length === MODE_READONLY_TOOLS.length
  && modeById("eco").effort === "low" && modeById("eco").rounds === 12 && modeById("eco").prompt.trim() !== "");
ok("狂暴档 = 全工具 + 高推理 + 放宽轮数",
  modeById("turbo").tools === null && modeById("turbo").effort === "high" && modeById("turbo").rounds === 40);
ok("浮层最多同时摆 7 个模式（用户指定的上限）", MODE_POPOVER_MAX === 7, String(MODE_POPOVER_MAX));
ok("没有自定义模式时注册表就是那四档", modeRegistry().length === 4);

// ── 2. 每场一份选择：搬走不复制，删模式回落默认 ───────────────

ok("每场的模式选择单独存一份（切场不会互相带过去）",
  /modeByConversation/.test(STORE) && /function setModeFor\(convId, id\)/.test(STORE)
  && /state\.modeByConversation = \{ \.\.\.state\.modeByConversation, \[key\]: next \};/.test(STORE));
ok("发送途中才建会话时把「还没建起来」那一场的选择搬给它（搬走不复制）",
  /function adoptConversationMode\(convId\)[\s\S]{0,400}delete rest\[""\]/.test(STORE));
ok("删掉模式时把指向它的选择一并清掉并回落默认（不留悬空 id）",
  /function removeMode\(id\)[\s\S]{0,700}state\.activeModeId = "smart"/.test(STORE));

// ── 3. 持久化链：本机落盘 + 共享给手机 + 后端白名单 ─────────────

ok("本机落盘产出 customModes / activeModeId / modeByConversation",
  /customModes: normalizeCustomModes\(state\.customModes\)/.test(STORE)
  && /activeModeId: normalizeModeId\(state\.activeModeId\)/.test(STORE)
  && /modeByConversation: normalizeModeMap\(state\.modeByConversation\)/.test(STORE));
ok("共享块只带模式本体与全局默认（每场的选择是本机的，不上云）",
  /getSharedPersistentData|sharedState/.test(STORE)
  && !/shared[\s\S]{0,400}modeByConversation: normalizeModeMap/.test(STORE));
ok("后端设置白名单收录 customModes 与 activeModeId",
  /"customModes"/.test(SETTINGS_PY) && /"activeModeId"/.test(SETTINGS_PY));
ok("旧的 chatMode 键留着当二值投影（老存档零迁移）",
  /function legacyChatModeOf\(modeId\)/.test(STORE) && /state\.chatMode = legacyChatModeOf\(/.test(STORE));

// ── 4. 提示词追加：追加在智能体/对话分岔之后、且只在这一处 ───────

ok("模式提示词由 adapter 一处拼装并追加在系统提示里",
  /function getModeSystemPrompt\(mode = null\)/.test(ADAPTER)
  && /systemContent \+= getModeSystemPrompt\(opts\.mode\);/.test(ADAPTER));
ok("buildMessages 把模式透传给提示词组装",
  /mode: opts\.mode \|\| userMessages\._mode \|\| null/.test(ADAPTER));
ok("模式下发的工具目录只为这个模式开放的工具出现",
  /getToolsSystemPrompt\(\{ compact: true, project: opts\.project \|\| null, mode: opts\.mode \|\| null \}\)/.test(ADAPTER));

// ── 5. 工具白名单：判定只看显式传进来的 mode ──────────────────

const maf = (TOOLS.match(/function modeAllowsTool\([\s\S]*?\n\}/) || [""])[0];
ok("modeAllowsTool 只读显式传入的 mode，不偷看全局状态",
  maf.includes("function modeAllowsTool(mode, key)") && !/\bstate\./.test(maf),
  maf.replace(/\s+/g, " ").slice(0, 120));
ok("没给 mode 一律放行（旁路调用不该被前面那一场的选择掐掉工具）",
  /if \(!mode\) return true;/.test(maf));
ok("tools=null 放行、tools=none 全禁、数组走白名单",
  /if \(allow === null \|\| allow === undefined\) return true;/.test(maf)
  && /if \(allow === MODE_TOOLS_NONE\) return false;/.test(maf)
  && /if \(!Array\.isArray\(allow\)\) return true;/.test(maf)
  && /return allow\.includes\(key\);/.test(maf));
ok("收口工具（exit_*）不受白名单影响（否则某些模式下永远退不出循环）",
  /key === "exit_target_mode" \|\| key === "exit_autopilot"\) return true;/.test(maf));
ok("原生 tools schema 按模式过滤", /if \(isAiToolOff\(key\) \|\| !modeAllowsTool\(mode, key\)\) continue/.test(TOOLS));
ok("文本目录按模式过滤", /\.filter\(\(\[key\]\) => !isAiToolOff\(key\) && modeAllowsTool\(mode, key\)\)/.test(TOOLS));
ok("模式没开放的工具连速查配方都跳过",
  /hiddenToolNames = Object\.keys\(TOOLS\)\.filter\(name => isAiToolOff\(name\) \|\| !modeAllowsTool\(mode, name\)\)/.test(TOOLS));
ok("执行口也拦一道：模型凭记忆硬调时给明确话术、且话术不走 t()",
  /当前回复模式没有开放这个工具/.test(TOOLS) && !/t\(`?\[工具 \$\{name\}\] 未执行：当前回复模式/.test(TOOLS));
ok("工具执行 ctx 带上这一场的模式",
  /const ctx = \{[\s\S]{0,400}mode: ctx\.mode \|\| null/.test(TOOLS) || /mode: ctx\.mode \|\| null/.test(TOOLS));

// ── 6. 桌面链路：模式 → 模型/强度/轮数/工具 ───────────────────

ok("桌面发送按这一场的模式取模型与强度",
  /const sendMode = activeModeFor\(genConvId\);/.test(CHAT)
  && /reasoning_effort: mode\?\.effort \|\| state\.reasoningEffort \|\| "auto"/.test(CHAT));
ok("桌面把模式交给工具循环与提示词组装",
  /runToolLoop\(msgEl, modelId, apiKey, baseUrl, params, signal, toolRounds, \{ autopilot: autopilotOn, mode: sendMode \}, run\)/.test(CHAT)
  && /buildOpenAITools\(mode\)/.test(CHAT)
  && /buildMessages\(history, history\._constitution \|\| effectiveConstitution\(\), toolMode, \{ project: history\._project \|\| null, grindTurn(?:, mode)? \}\)/.test(CHAT));
ok("对话档的判定读生效模式，不再读只写不读的全局二元位",
  /activeModeFor\(genConvId\)\.id === "chat"/.test(CHAT));
ok("模式轮数只改默认预算那一档，不压目标模式的轮数上限",
  /modeRoundCap/.test(CHAT) && /Number\(sendMode\.rounds\) > 0/.test(CHAT));

// ── 7. 手机链路与上下文估算口径一致 ──────────────────────────

ok("手机端发送按生效模式取模型/强度/工具模式",
  /const mobileMode = activeModeFor\(\);/.test(MCHAT)
  && /reasoning_effort: mode\.effort \|\| state\.reasoningEffort \|\| "auto"/.test(MCHAT)
  && /buildMessages\(history, effectiveConstitution\(\), toolMode, \{ mode \}\)/.test(MCHAT));
ok("手机端工具循环按模式的轮数与白名单跑",
  /const mode = activeModeFor\(\);/.test(MCHAT) && /Number\(mode\.rounds\) > 0 \? Number\(mode\.rounds\) : MAX_TOOL_ROUNDS/.test(MCHAT));
ok("上下文估算用同一个模式算目录（估算值要等于真发出去的）",
  /const mode = activeModeFor\(\);/.test(METER) && /getToolsSystemPrompt\(\{ compact: true, mode \}\)/.test(METER)
  && /noTools = mode\.id === "chat"/.test(METER));

// ── 8. 后台旁路不许继承模式 ──────────────────────────────────

for (const [rel, src] of [["team.js", TEAM], ["subagent.js", SUBAGENT], ["workflow.js", WORKFLOW], ["memory.js", MEMORY]]) {
  ok(`${rel} 不参与回复模式（按自己的提示词跑，不该被某一场的模式掐掉工具）`,
    !/activeModeFor|modeAllowsTool|activeModeIdFor/.test(src));
}

// ── 9. 模型自建模式：mode_write 与面板同走 store 的 setter ─────

const mw = (TOOLS.match(/mode_write: \{[\s\S]*?\n  \},\n/) || [""])[0];
ok("mode_write 已注册，且 action 只认 create/update/delete",
  mw.includes("mode_write") && /\['create', 'update', 'delete'\]|\["create", "update", "delete"\]/.test(mw));
ok("mode_write 不许碰内置四档", /BUILTIN_MODES\.some\(m => m\.id === clean\)/.test(mw));
ok("mode_write 手动审批档下弹确认框给用户看改动",
  /permissionModeFor\(convId\) === "ask"[\s\S]{0,400}dlgConfirm/.test(mw));
ok("mode_write 与扩展页面板共用 store 的 setter（一处语义两处生效）",
  /addMode\(spec\)/.test(mw) && /updateMode\(clean, spec\)/.test(mw) && /removeMode\(clean\)/.test(mw));
ok("不传 tools 时不偷改已有的工具限制（update 保留原值）",
  /if \(tools !== undefined && tools !== null\) spec\.tools = parseModeToolsParam\(tools\)/.test(mw));

// ── 10. 扩展页「模式」栏 ─────────────────────────────────────

ok("分栏轨里有「模式」这一栏", /\{\s*key:\s*"modes",\s*label:\s*"模式"\s*\}/.test(EXT));
ok("栏体带 data-ext=modes 与计数位", HTML.includes('data-ext="modes"') && HTML.includes('id="ext-modes-count"'));
ok("列表容器与编辑器控件都在 HTML 里",
  HTML.includes('id="ext-mode-list"') && HTML.includes('id="mode-modal"')
  && HTML.includes('id="mode-f-prompt"') && HTML.includes('id="mode-f-tools-scope"')
  && HTML.includes('id="btn-mode-save"') && HTML.includes('id="btn-ext-mode-new"'));
ok("面板从容器取用并报计数（没人报就永远显示 0）",
  PANEL.includes('getElementById("ext-mode-list")') && /setExtCount\("modes", modes\.length\)/.test(PANEL));
ok("面板增改删都走 store 的 setter，并且订阅 modes 重画（模型建的模式也要出现）",
  /addMode\(spec\)/.test(PANEL) && /updateMode\(editingId, spec\)/.test(PANEL) && /removeMode\(editingId\)/.test(PANEL)
  && /subscribe\("modes", renderList\)/.test(PANEL));
ok("内置档在面板里只读：不给保存/删除，整张表单锁住",
  /btnSave\.classList\.toggle\("hidden", editingBuiltin\)/.test(PANEL)
  && /btnDelete\.classList\.toggle\("hidden", editingBuiltin \|\| isNew\)/.test(PANEL)
  && /function setFormDisabled\(disabled\)/.test(PANEL));
// 反面也钉住：整表锁不能把 id 一起带走——新建填不了 id，save() 又要求 id，等于手建不出模式
ok("id 只在新建时可填：整表锁不把它一起锁死",
  /fId\.disabled = !isNew;/.test(PANEL) && !/el === fId/.test(PANEL));
ok("「模式」栏的列表项显示内置/自定义徽标", /skill-kind-builtin/.test(PANEL) && /内置/.test(PANEL));

// ── 11. 视觉：颜色随模式走、隐藏有规则（桌面无全局 .hidden）─────

ok("列表行与浮层条目都由 --mode-color 决定颜色",
  /\.mode-opt-icon \{[^}]*color: var\(--mode-color, currentColor\)/.test(CSS)
  && /\.mode-item-icon \{[^}]*color: var\(--mode-color, currentColor\)/.test(CSS));
ok("浮层与工具白名单网格的隐藏各配一条规则",
  /\.mode-pop\.hidden \{ display: none; \}/.test(CSS) && /\.mode-tools-grid\.hidden \{ display: none; \}/.test(CSS));
ok("编辑器弹窗有自己的宽度规则（不被通用 460px 按回去）", /\.mode-modal-content \{[^}]*width: min\(560px/.test(CSS));

// ── 12. 词条：模型可见文案不入典，界面文案齐 ─────────────────

for (const key of ["回复模式", "智能", "对话", "经济", "狂暴", "模式", "内置", "全部工具", "不调用工具，单轮直答"]) {
  ok(`词条：${key}`, DICT.includes(`"${key}"`));
}

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_mode_registry: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
