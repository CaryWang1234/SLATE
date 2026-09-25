/**
 * 审批模式守卫：scripts/check_permission_mode.mjs
 *
 * 这一改最坏的失败模式不是"弹窗没出来"（当场就能看见），而是**问错了档还没人知道**：
 * 输入框写着"完全访问"却每一条都问、切到另一场对话还留着上一场的档、
 * auto 档把联网也拦下来（用户要的就是"只拦高危"）、手机那侧自己再算一遍档位
 * 于是桌面放行手机弹窗。这些都属"看不出来的那类"，所以钉死在下面。
 *
 * 盯的契约：
 * ① 档位口径：设置页那一个是"默认档"，每场可被 permissionModeByConversation 覆盖；
 *    覆盖是"搬走"不是"复制"；脏值回落到默认档（认不出的档位必须等于最严的那档）。
 * ② 三档语义只有一处实现：ask=命令+联网都问，auto=只问高危，full=都不问；
 *    命令类＝terminal / bg_task(start)，联网类＝web_search / web_fetch / browser_automation。
 * ③ 判定与"问人的脸"分开：手机只换 UI（window.__slateGuardUi），不许自带第二份档位判断。
 * ④ 输入框那颗胶囊：跟着屏幕上这一场重画；完全访问图标与文字都标红；弹窗自带 hidden 声明。
 * ⑤ 新会话创建那一刻，"还没建起来的这一场"选的档要搬到它名下；删会话要清掉那一份。
 *
 * 运行：node scripts/check_permission_mode.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

// 前端模块一律带 ?v= 引：不带就与它内部那句 import 成了两份实例（这条以前踩过）
const PIN = (read("frontend/index.html").match(/\?v=(\d{8}-\d{3})/) || [])[0] || "";

const STORE = read("frontend/js/store.js");
const RISK = read("frontend/js/services/riskguard.js");
const TOOLS = read("frontend/js/services/tools.js");
const CHAT = read("frontend/js/components/chat.js");
const PICKER = read("frontend/js/components/approval_picker.js");
const PANEL = read("frontend/js/components/skill_panel.js");
const WORKFLOW = read("frontend/js/services/workflow.js");
const APPJS = read("frontend/js/app.js");
const MAUTH = read("frontend/js/mobile/m-auth.js");
const MINIT = read("frontend/js/mobile/m-init.js");
const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const DICT = read("frontend/js/services/i18n_dict.js");
const SETTINGS_PY = read("backend/routers/settings.py");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

// ── 1. 真跑：默认档 + 每场覆盖 + 搬运 + 脏值 ───────────────────
globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: {} }) });
const store = await import(`../frontend/js/store.js${PIN}`);
const { state, permissionModeFor, setPermissionModeFor, setDefaultPermissionMode,
  adoptConversationPermissionMode, forgetConversationPermissionMode } = store;

state.permissionMode = "ask";
state.permissionModeByConversation = {};
state.currentConversationId = "c1";

ok("没单独选过的场跟着默认档", permissionModeFor("c1") === "ask" && permissionModeFor("c2") === "ask",
  `实际 ${permissionModeFor("c1")}/${permissionModeFor("c2")}`);

setPermissionModeFor("c1", "full");
ok("改过的那一场有自己的档，别的场不受牵连",
  permissionModeFor("c1") === "full" && permissionModeFor("c2") === "ask");

setDefaultPermissionMode("auto");
ok("默认档变了，单独选过的那一场不跟着变",
  permissionModeFor("c1") === "full" && permissionModeFor("c2") === "auto");

setPermissionModeFor("", "full");
ok("还没建起来的这一场（键 \"\"）先记着自己的选择",
  permissionModeFor("") === "full" && permissionModeFor("c9") === "auto");

adoptConversationPermissionMode("new1");
ok("会话一建起来，那一档搬给它本人",
  permissionModeFor("new1") === "full", "不搬就等于把用户发送前挑的档悄悄丢回默认");
ok("搬走而不是复制：下一场新对话回到默认档",
  permissionModeFor("") === "auto" && permissionModeFor("new2") === "auto",
  "留在 \"\" 里会让往后每一场新对话都继承这次的完全访问");

forgetConversationPermissionMode("new1");
ok("删掉会话时那份审批档跟着清", permissionModeFor("new1") === "auto");

state.permissionModeByConversation = { dirty: "yolo", c1: "auto" };
ok("脏档位不认：回落到默认档，而不是当成最松的那一档",
  permissionModeFor("dirty") === "auto" && permissionModeFor("c1") === "auto");

// ── 2. 持久化口径 ────────────────────────────────────────────
ok("默认档与每场覆盖都落本机状态",
  /permissionMode: normalizePermissionMode\(state\.permissionMode\)/.test(STORE)
  && /permissionModeByConversation: normalizePermissionModeMap\(state\.permissionModeByConversation\)/.test(STORE)
  && /state\.permissionModeByConversation = normalizePermissionModeMap\(data\.permissionModeByConversation\)/.test(STORE));
ok("每场覆盖不跨设备同步（审批档是这台屏幕上的事）",
  !/permissionModeByConversation/.test(STORE.slice(STORE.indexOf("function getSharedPersistentData"), STORE.indexOf("function saveSharedPersistent"))),
  "同步到手机会把桌面的信任档盖到一块根本不长那样的屏上");
ok("默认档仍在后端白名单里（老键不能丢，丢了重启就回到 ask）",
  /"permissionMode"/.test(SETTINGS_PY));

// ── 3. 三档语义：只有一处判定 ─────────────────────────────────
ok("三档各自的行为写在同一处纯判定里",
  /function approvalNeededFor\(skill, params, opts = \{\}\)/.test(RISK)
  && /if \(mode === "full"\) return null;/.test(RISK)
  && /if \(!risk\.risk && \(mode === "auto" \|\| opts\.manual\)\) return null;/.test(RISK),
  "ask 落到最后一行＝命令与联网都问；auto/manual 只放过不高危的");
ok("命令类：terminal 与 bg_task 的 start",
  /if \(skill === "terminal" && params\?\.command\)/.test(RISK)
  && /skill === "bg_task" && params\?\.command && \(params\.action \|\| "start"\) === "start"/.test(RISK));
ok("联网类：搜索、抓网页、开浏览器",
  /skill === "web_search"/.test(RISK) && /skill === "web_fetch"/.test(RISK)
  && /skill === "browser_automation"/.test(RISK));
ok("生效后注入 approved（后端只认这个字段放行高危）",
  /if \(need\.subject\.kind === "command"\) params\.approved = true;/.test(RISK));
ok("审批是一张一张排队问的，不是撞车就替用户说不",
  /let approvalChain = Promise\.resolve\(\);/.test(RISK)
  && /approvalChain = asked\.then\(\(\) => \{\}, \(\) => \{\}\);/.test(RISK)
  && !/if \(pendingResolve\) \{\s*\n?\s*resolve\(false\)/.test(RISK),
  "并行子代理一次挤进多笔时，老的「直接拒绝后来的」等于用户没见过面就被代拒");
ok("判定返回 {ok,message}，调用方原样回传",
  /return \{ ok: false, message: denialMessage\(need\.subject, need\.risk\) \}/.test(RISK));

// ── 4. 接线：每一笔工具调用都过这道门，且按"这一场"判 ──────────
ok("skill_run 每一笔都过门，且带上这一场的会话 id",
  /const verdict = await guardSkillCall\(skill, p, \{ convId: callCtx\.convId \}\);\n\s*if \(!verdict\.ok\) return verdict\.message;/.test(TOOLS));
ok("工作流那一路也走同一个判口",
  /const verdict = await guardSkillCall\(node\.skill, params\)/.test(WORKFLOW));
ok("面板里用户亲手点的执行只拦高危（manual）",
  /guardSkillCall\(currentSkillName, params, \{ manual: true \}\)/.test(PANEL));
ok("Action 写入按这一场的档位决定要不要弹原文",
  /if \(permissionModeFor\(callCtx\.convId\) === "ask"\)/.test(TOOLS));
ok("模型侧描述里写清了「哪一档问什么」",
  /是否每条命令都先征求用户批准，看这一场对话的审批模式/.test(TOOLS)
  && /联网与开浏览器都算「访问网络」/.test(TOOLS));

// ── 5. 手机：只换脸，不换判口 ─────────────────────────────────
ok("移动端挂的是审批 UI，不是第二份档位判断",
  /window\.__slateGuardUi = mApprovalSheet;/.test(MINIT)
  && !/__slateGuardOverride/.test(MINIT) && !/__slateGuardOverride/.test(TOOLS),
  "两套判断迟早分叉：手机问得比桌面多（或反过来）");
ok("手机那侧不再自己读 permissionMode（判口只有 riskguard 一处）",
  !/permissionMode/.test(MAUTH));

// ── 6. 输入框那颗胶囊与红色那档 ───────────────────────────────
ok("输入框里有审批选择器（三个控件都在）",
  has_id("approval-picker") && has_id("btn-approval") && has_id("approval-pop"));
function has_id(id) {
  return HTML.includes(`id="${id}"`);
}
ok("胶囊跟着屏幕上这一场重画：切会话/新会话都会经过 updateSendState",
  /function updateSendState\(\) \{[\s\S]{0,300}syncApprovalPicker\(\)/.test(CHAT));
ok("选择器只认 store 的档位读写，不自己存一份",
  /import \{ state, subscribe, permissionModeFor, setPermissionModeFor \} from "\.\.\/store\.js/.test(PICKER)
  && !/localStorage/.test(PICKER));
ok("完全访问：胶囊上的图标与文字都标红",
  /\.approval-pill\.is-full \{\s*\n\s*color: var\(--danger\)/.test(CSS)
  && /\.approval-pill\.is-full \.approval-pill-icon \{\s*\n\s*color: var\(--danger\)/.test(CSS)
  && /btn\.classList\.toggle\("is-full", mode\.id === "full"\)/.test(PICKER));
ok("弹窗里那一行也整行标红，用的还是同一个 --danger",
  /\.approval-opt\.is-full,[\s\S]{0,80}color: var\(--danger\)/.test(CSS));
ok("设置页的「完全访问」按钮同样标红（两处红同源）",
  /data-mode="full"[^>]*class="review-mode-btn is-danger"|class="review-mode-btn is-danger"[^>]*data-mode="full"/.test(HTML)
  && /\.permission-mode-row \.review-mode-btn\.is-danger \.svg-icon \{[\s\S]{0,60}color: var\(--danger\)/.test(CSS));
ok("自带 hidden 的弹窗在桌面 CSS 里声明过（桌面没有全局 .hidden）",
  /\.approval-pop\.hidden \{ display: none; \}/.test(CSS));
ok("审批弹窗字段名跟着这一笔变（命令 / 访问目标），联网时收起模型说明",
  /subjectLabelEl\.textContent = t\(isCommand \? "命令" : "访问目标"\)/.test(RISK)
  && /explainLabelEl\.classList\.toggle\("hidden", !isCommand\)/.test(RISK)
  && /#risk-explain-label\.hidden,[\s\S]{0,60}display: none;/.test(CSS));

// ── 7. 设置页降级为默认档 + 词条 ──────────────────────────────
ok("设置页那一族按钮改的是默认档（走 store setter，会通知胶囊重画）",
  /function applyPermissionMode\(mode\) \{\s*\n\s*\/\/[\s\S]{0,120}setDefaultPermissionMode\(mode\)/.test(APPJS)
  && !/function applyPermissionMode\(mode\) \{\s*\n\s*state\.permissionMode = mode;/.test(APPJS));
ok("设置页文案说明白「这是新对话的默认档，单场可改」",
  /新对话的默认审批模式/.test(HTML));
for (const key of ["审批模式", "手动审批", "完全访问", "命令执行审批", "联网访问审批", "只改这一场"]) {
  ok(`词条：${key}`, new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":`).test(DICT));
}

// ── 汇总 ─────────────────────────────────────────────────────
const failed = results.filter(([p]) => !p);
for (const [passed, name, detail] of results) {
  console.log(`${passed ? "ok" : " x"} ${name}${!passed && detail ? ` → ${detail}` : ""}`);
}
console.log(`\n审批模式守卫：共 ${results.length} 项，失败 ${failed.length}`);
if (failed.length) process.exit(1);
