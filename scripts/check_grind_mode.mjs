/**
 * 磨墨模式守卫：scripts/check_grind_mode.mjs
 *
 * 症状（用户实报）：进了磨墨模式，它不追问，直接开干。
 * 根因是这一轮同时拿到两套互相矛盾的章程：grind.js 注入「磨墨 · 只追问」，而同一条消息里
 * buildAgentRuntimeContext 又塞进 [Agent Runtime · Autopilot]「请自主执行到完成、没做完就
 * 继续发起下一批工具调用」；autopilotOn 对磨墨没有任何豁免（「做一个网站」正好命中 wantsEnv），
 * 内核于是按 Autopilot 多轮推进。两处都得钉：
 *
 * ① 提示词：三个阶段的注入文本都必须带「只研磨不施工」（禁工具/禁改文件/禁跑命令）；
 * ② 模式闸门：磨墨在场的那一轮，harnessOn 与 autopilotOn 都必须被压掉、不给 Autopilot 章程；
 * ③ 请求载荷：这一轮 toolMode=none——目录、tools 参数都不发，系统提示改说 [磨墨模式]；
 *    光压章程不够，目录里的「当前回复必须包含工具调用块」与「不调用任何工具」是同一轮里的两句反话；
 * ④ 执行入口：模型照吐 ◈◈◈ 时循环不跑（重新生成同一路），解析读的是剥掉标记的文本；
 * ⑤ 纠正话术：DSML 与空转警告教给模型的格式必须真能被解析、举的工具名必须是注册过的工具。
 *
 * 判据只认"比较行/赋值行"，不认常量名出现——`has("grindTurnOn")` 这种假牙会在真被改坏时照样绿。
 * 提示词那侧直接 import 真实现跑，不复制字符串。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_ROUNDS, COLLECT_RE, firstRoundPrompt, grindRoundPrompt, collectingPrompt,
} from "../frontend/js/services/grind.js?v=20261003-003";
// 与 chat.js 用同一条 ?v= 说明符，否则 Node 里载入的是第二份实例（纯函数也读不到同一份状态）
const { effectiveToolMode, detectToolCalls, TOOLS } = await import("../frontend/js/services/tools.js?v=20261003-003");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function must(cond, label, extra = "") {
  checks += 1;
  if (!cond) {
    console.error(`✗ ${label}${extra ? " :: " + extra : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`ok  ${label}`);
  }
}

// ── ① 三个阶段的注入文本都要带"只研磨不施工" ──
const phases = {
  接墨: firstRoundPrompt("帮我做一个个人网站"),
  磨墨: grindRoundPrompt({ round: 2, resolved: [], unknown: [] }),
  收墨: collectingPrompt(),
};
for (const [name, text] of Object.entries(phases)) {
  must(/只研磨不施工/.test(text), `${name}阶段：注入文本明写「只研磨不施工」`);
  must(/不调用任何工具|不要调用工具/.test(text), `${name}阶段：明写禁调工具`, text.slice(0, 40));
  must(!/(可以|请)调用工具|直接调用工具/.test(text), `${name}阶段：文本里没有"可以调工具"的反向暗示`);
}
must(/追问纪律/.test(phases.接墨), "接墨阶段带追问纪律（每条回复只问一个缺口）");
must(/只问下一个|只问一个/.test(phases.磨墨), "磨墨中段仍只问一个缺口，不转成施工", phases.磨墨.slice(0, 60));
must(/【墨迹】/.test(phases.接墨) && /【墨迹】/.test(phases.磨墨),
  "追问阶段要求带墨迹状态块（用户靠它读已定/未知）");
must(/```json/.test(phases.收墨) && /open_questions/.test(phases.收墨),
  "收墨阶段给了墨稿 JSON 格式与未知项落点");
must(Number.isInteger(MAX_ROUNDS) && MAX_ROUNDS > 0, "追问上限是个正整数", String(MAX_ROUNDS));
must(/收墨/.test(String(COLLECT_RE)) && COLLECT_RE.test("收墨") && !COLLECT_RE.test("收墨之前先做一版"),
  "收墨触发词只认整句指令，不认正文里顺口一提");

// ── ② 模式闸门：磨墨那一轮不许开自主执行 ──
const chat = readFileSync(join(REPO, "frontend/js/components/chat.js"), "utf8");
must(new RegExp(`function grindGuardOn\\(convId = state\\.currentConversationId\\) \\{\\s*return !!grindSession && grindSession\\.state !== "done"\\s*&& convId === grindSession\\.conversation_id;`).test(chat),
  "磨墨闸门是个现读的谓词：「现读 grindSession 未 done + 同一会话」。它必须现读——"
  + "会话是这一轮才建的，早先算好的 grindActive 首轮还是 null（用它当闸门＝接墨轮照样拿到 Autopilot 章程）");
must(/const grindTurnOn = !chatModeOn && grindGuardOn\(\);/.test(chat),
  "磨墨那一轮的认定走这个谓词（不是自己另写一份比较）");
must(/const harnessOn = !chatModeOn && !grindTurnOn && state\.harness\?\.enabled === true;/.test(chat),
  "目标模式在这一轮被压掉（harnessOn 带 !grindTurnOn）");
must(/const autopilotOn = !chatModeOn && !grindTurnOn && \(harnessOn \|\| agentTask\.wantsEnv\);/.test(chat),
  "Autopilot 在这一轮被压掉（autopilotOn 带 !grindTurnOn）");
must(/const agentRuntimeContext = \(bgResumeTurn \|\| grindTurnOn\) \? "" : buildAgentRuntimeContext\(text, harnessOn\);/.test(chat),
  "不给磨墨这一轮注入 [Agent Runtime · Autopilot] 章程");
const stallGap = "[\\s\\S]{0,80}?";
must(new RegExp(`async function autoAdvanceIfStalled\\([^)]*\\)${stallGap}\\{${stallGap}if \\(grindGuardOn\\(genConvId\\)\\) return msgEl;`).test(chat),
  "停顿合工具（autoAdvance）在磨墨场次里关掉：它会把「系统建议的最小动作」塞回给模型");
must(new RegExp(`async function autoReviewIfStalled\\([^)]*\\)${stallGap}\\{${stallGap}if \\(grindGuardOn\\(genConvId\\)\\) return msgEl;`).test(chat),
  "停顿审查（autoReview）在磨墨场次里关掉：审查模型的提示词就是「如果需要推进，只输出工具调用块」——那等于系统自己催磨墨开工");
must(/runToolLoop\(msgEl, modelId, apiKey, baseUrl, params, signal, toolRounds, \{ autopilot: autopilotOn(?:, mode: sendMode)? \}, run\)/.test(chat),
  "内核拿到的 autopilot 就是上面这个被压过的值（没在别处被写回 true）");
const gate = `grindSession && grindSession\\.state !== "done"\\s*&& state\\.currentConversationId === grindSession\\.conversation_id`;
const near = "[\\s\\S]{0,600}?";
const gatedBlock = `${gate}\\)\\s*\\{${near}`;
must(new RegExp(`${gatedBlock}grindSvc\\.firstRoundPrompt\\(`).test(chat)
  && new RegExp(`${gatedBlock}grindSvc\\.collectingPrompt\\(`).test(chat),
  "注入链仍挂着闸门：同一会话且没 done 才把提示词写进末条 user（接墨/收墨都在这一支里）");
must(new RegExp(`${gatedBlock}handleGrindReply\\(`).test(chat),
  "回复后的墨迹解析也挂同一道闸门——否则改到别场的消息上");
must(/state === "collecting"\)[\s\S]{0,140}?grindSvc\.collectingPrompt\(/.test(chat),
  "收墨阶段（state=collecting）注入的是收墨提示词");
must(/\(\(grindSession\.round \|\| 0\) === 0\)[\s\S]{0,140}?grindSvc\.firstRoundPrompt\(/.test(chat),
  "首轮（round=0）注入的是接墨提示词");
must(/else \{[\s\S]{0,260}?grindSvc\.grindRoundPrompt\(grindSession\)/.test(chat),
  "其余轮次注入的是磨墨提示词（每轮都带「只问一个缺口」）");
must(/grindSvc\.COLLECT_RE\.test\([\s\S]{0,300}?grindSvc\.collectSession\(/.test(chat),
  "用户说「收墨」时先把会话切到 collecting（没切的话下一轮还在磨墨）");
must(!/const grindTurnOn[\s\S]{0,400}?state\.harness\s*=\s*\{[\s\S]{0,80}?enabled:\s*false/.test(chat),
  "压掉的是这一轮的行为，没有去改用户存的目标模式设置");

// ── ③ 请求载荷：磨墨那一轮真的没有工具（目录、tools 参数、执行循环三样都不给） ──
const adapter = readFileSync(join(REPO, "frontend/js/services/adapter.js"), "utf8");
const toolsSrc = readFileSync(join(REPO, "frontend/js/services/tools.js"), "utf8");
must(effectiveToolMode("gpt-5.6-sol", "openai", "agent", true) === "none",
  "第 4 个实参为真时工具模式压成 none（请求不带 tools，目录也不下发）");
must(effectiveToolMode("gpt-5.6-sol", "openai", "agent") !== "none",
  "对照：非磨墨的智能体轮仍拿得到工具（闸门没顺手把正常链路掐了）");
must(effectiveToolMode("gpt-5.6-sol", "openai", "chat", false) === "none", "对话态仍是 none");
must(/return \(chatMode === "chat" \|\| noTools\) \? "none"/.test(toolsSrc),
  "none 的判据是「对话态 或 本轮无工具」，不是把 chatMode 覆写成别的值");

const noToolBranch = /\n  if \(opts\.withTools === false\) \{([\s\S]*?)\n  \} else \{/.exec(adapter)?.[1] || "";
must(noToolBranch.includes("[磨墨模式]") && !noToolBranch.includes("getToolsSystemPrompt"),
  "无工具分支按磨墨/对话分岔声明，两条都不拼工具目录");
must(/不要输出 ◈◈◈/.test(noToolBranch) && /不要改文件、跑命令或开始实现/.test(noToolBranch),
  "磨墨声明既禁调用块也禁施工（只禁调用块会被绕过去改文件）");
must(/送入目标模式/.test(noToolBranch),
  "动工出口写成「用户点按钮」，模型自己不开工");
must(/withTools: toolMode !== "none",\s*grindTurn: opts\.grindTurn === true,/.test(adapter),
  "buildMessages 把磨墨标记交给 buildSystemContent（否则分岔永远走对话那条）");
must(/meta: streamMeta, grindTurn: grindTurnOn/.test(chat)
  && /let toolMode = effectiveToolMode\(model, provider, modeChat, grindTurn\)/.test(chat),
  "首轮请求把这一轮的认定交给统一流式入口，入口据此算 toolMode（对话态由生效模式推出）");
must(/const grindTurn = grindGuardOn\(convId\);/.test(chat)
  && /effectiveToolMode\(modelId, [^,]+, mode\.id === "chat" \? "chat" : "agent", grindTurn\)/.test(chat),
  "长墨稿被截断后的续写请求同样不带工具（续写时把目录发回去，禁令就成了上一轮说过的话）");
must(/meta: regenMeta, grindTurn: grindGuardOn\(regenConvId\)/.test(chat),
  "重新生成那一笔请求现读归属会话是否还在磨墨（不是照屏幕上那场算）");

// ── ④ 执行入口：模型照吐 ◈◈◈ 时不执行，且解析读的是剥干净的文本 ──
must(/if \(!signal\.aborted && !streamFailed && !grindTurnOn\) loopOutcome = await runToolLoop\(/.test(chat),
  "磨墨那一轮不进工具循环（提示词只是劝，这里才是手）");
must(/regenLoop = !signal\.aborted && !streamFailed && !grindGuardOn\(regenConvId\)/.test(chat),
  "磨墨会话里重新生成也不进工具循环");
must(/await handleGrindReply\(hasToolMarkup\(fullContent\) \? stripToolCalls\(fullContent\) : fullContent, msgEl\)/.test(chat),
  "墨迹/墨稿解析读的是剥掉调用块的文本：泄漏的 ◈◈◈ 不污染解析，也不参与墨稿判定");

// ── ⑤ 纠正话术教的格式必须真能被解析（曾经的错：◈◈ 少一个菱形、举了不存在的工具名） ──
function fillsExecutable(tpl, name) {
  const body = String(tpl).replace(/\\n/g, "\n").replace("工具名", name).replace("{JSON 参数}", '{"path": ""}');
  const calls = detectToolCalls(body);
  return calls.length === 1 && calls[0].name === name && TOOLS[name] !== undefined;
}
const dsmlTpl = /请改用 (◈◈◈?工具名\\n\{JSON 参数\}\\n◈◆◆) 的格式/.exec(chat)?.[1] || "";
const stallTpl = /请以 (◈◈◈?工具名\\n\{JSON 参数\}\\n◈◆◆) 的格式/.exec(chat)?.[1] || "";
must(fillsExecutable(dsmlTpl, "project_files"), "DSML 纠正话术教的格式能被系统解析成一次调用");
must(fillsExecutable(stallTpl, "project_files"), "空转强警告教的格式能被系统解析成一次调用");
const stallSentence = /`\[系统警告\][\s\S]*?浪费额度。`/.exec(chat)?.[0] || "";
const namedExamples = [...stallSentence.matchAll(/例如 ([a-z_ /]+)，/g)][0]?.[1].split(/[ /,]+/).filter(Boolean) || [];
must(stallSentence.includes("[可用工具]") && namedExamples.length >= 3
  && namedExamples.every(n => TOOLS[n]),
  `空转强警告举的工具名必须是注册过的工具（点名系统里没有的名字，模型照着吐就只换来"未知工具"）：${namedExamples.join(",") || "没举到"}`);

if (process.exitCode) {
  console.error(`\n磨墨模式守卫：${checks} 项判据里有不通过项`);
} else {
  console.log(`\n磨墨模式守卫：${checks} 项判据全通过`);
}
