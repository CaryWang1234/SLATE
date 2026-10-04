/**
 * 团队对话"留痕"守卫：scripts/check_team_trace.mjs
 *
 * 钉的是四件容易悄悄回退的事，全部跨端：
 *  ①上游失败不许变成发言。失败文案一旦被写进 fullText，就会跟着 entries 进下一位的提示词，
 *    模型会把"请求失败"当成某人的主张接着反驳——这条链的判据是"失败块里没有 entries.push"。
 *  ②缺席与失败都要落账，但不能被算成发言。DEBATE_ACTIONS 多出 error/skipped 两格，
 *    而 parseDebateAction 的正则与给成员的发言格式都只认原来六个词，模型伪造不出这两种行。
 *  ③全文落库是两端契约：前端发 fullText、后端有列、ALTER 迁移让老库补上列、查询把全文读回来、
 *    前端在本地历史缺正文时真去读它。少一环就是一列没人读的死数据。
 *  ④手动停止的那场也是发生过的事：本地历史要留，界面上要标"已中断"。
 *
 * 判据从源码现读（不从页面自指），禁词断言先把注释剥掉再看。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EN_DICT } from "../frontend/js/services/i18n_dict.js?v=20261003-002";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TEAM = read("../frontend/js/components/team.js");
const PY = read("../backend/routers/events.py");
const CSS = read("../frontend/css/style.css");

// 剥注释：自己的告诫里就写着禁词，不剥会把守卫判成红
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const TEAM_CODE = strip(TEAM);
const PY_CODE = strip(PY);

let checks = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. 失败不入上下文（成员发言与强制拍板两处，同一个缺陷的两个形状）────
// 按缩进取块：`if (failure) {` 后面直到"同缩进的一个 } 单独成行"。
// 不用非贪婪正则跨两处——那会让第二处借走第一处的判据。
function blockAt(src, ifIdx) {
  const lineStart = src.lastIndexOf("\n", ifIdx) + 1;
  const indent = src.slice(lineStart, ifIdx).match(/^\s*/)[0];
  const close = new RegExp(`\\n${indent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`).exec(src.slice(ifIdx));
  return close ? src.slice(ifIdx, ifIdx + close.index) : null;
}
const FAILURE_BLOCKS = [...TEAM_CODE.matchAll(/if \(failure\) \{/g)]
  .map(m => blockAt(TEAM_CODE, m.index))
  .filter(Boolean);

// 旧缺陷的形状：把失败文案赋给 fullText，之后照走"解析动作 → push entries"
ok("A1 全文任何一处都不把失败文案赋给 fullText（两处形状一起钉）",
  !/fullText = t\("请求失败/.test(TEAM_CODE));
ok("A2 失败块有两处（成员发言 + 强制拍板），漏改一处就是留一个洞",
  FAILURE_BLOCKS.length === 2, `实际 ${FAILURE_BLOCKS.length} 处`);
for (const [i, block] of FAILURE_BLOCKS.entries()) {
  ok(`A3-${i + 1} 失败块里落一条 action="error" 的账`,
    block.includes("recordTeamTurn") && /action:\s*"error"/.test(block), block.slice(0, 160));
  ok(`A4-${i + 1} 失败块绝不 push entries——push 就是把它喂给下一位`,
    !block.includes("entries.push"), block.slice(0, 160));
  ok(`A5-${i + 1} 失败块不调用 addTeamUsage（没说的话不计用量）`, !block.includes("addTeamUsage"));
}
ok("A6 正常路径仍有两处 push（成员发言 + 强制拍板），一处没少",
  (TEAM_CODE.match(/entries\.push\(rec\)/g) || []).length === 2);
ok("A7 两条正常 rec 都带全文字段 full",
  /text:\s*parsed\.content \|\| fullText,\s*full:\s*fullText,/.test(TEAM_CODE)
  && (TEAM_CODE.match(/full:\s*fullText,/g) || []).length >= 2);

// ── 2. 缺席留痕，且两种新状态伪造不出来 ────────────────────
const SKIP_BLOCK = TEAM_CODE.match(/if \(!apiKey\) \{\n([\s\S]*?)\n      \}/)?.[1] || "";
ok("B1 没配 Key 的成员也落一行账（action 为 skipped）",
  SKIP_BLOCK.includes("recordTeamTurn") && /action:\s*"skipped"/.test(SKIP_BLOCK), SKIP_BLOCK.slice(0, 160));
ok("B2 缺席那格标的是「未参与」而不是「提案」",
  /addDebateEntry\(member, "skipped"\)/.test(SKIP_BLOCK) && /finalizeEntry\(skipEntry, "skipped"/.test(SKIP_BLOCK));
ok("B3 DEBATE_ACTIONS 多出这五格（失败/缺席/拍板三态）",
  /const DEBATE_ACTIONS = \{[\s\S]*?error:\s*"失败",\s*skipped:\s*"未参与",[\s\S]*?awaiting:\s*"待拍板",\s*decided:\s*"已拍板",\s*reopened:\s*"未拍板",\s*\};/.test(TEAM_CODE));
const VERBS = (TEAM_CODE.match(/function parseDebateAction[\s\S]*?\/\^\s*\\s\*【([^】]*)】/)?.[1] || "")
  .replace(/[()]/g, "").split("|").filter(Boolean);
ok("B4 动作解析仍只认那六个词（模型演不出「失败」「未参与」）",
  VERBS.length === 6 && !VERBS.includes("失败") && !VERBS.includes("未参与"), `实际：${VERBS.join("|")}`);
const FORMAT_LINE = TEAM_CODE.match(/发言格式：[^\n]*/)?.[0] || "";
ok("B5 给成员的发言格式里没有那两种新状态",
  FORMAT_LINE.length > 0 && !FORMAT_LINE.includes("失败") && !FORMAT_LINE.includes("未参与"), FORMAT_LINE);
ok("B6 星图把这两种行排除在发言计数外",
  PY_CODE.includes('not in ("error", "skipped")'));

// ── 3. 全文落库：前端发 → 后端有列 → 老库补列 → 读回来 → 真去读 ────
ok("C1 前端把全文发出去", TEAM_CODE.includes('fullText: String(rec.full || rec.text || "")'));
ok("C2 后端有全文上限常量", /MAX_TURN_FULL = \d+/.test(PY_CODE));
ok("C3 建表语句里有 text_full 列", /team_turns[\s\S]*?text_full TEXT/.test(PY_CODE));
ok("C4 老库靠 PRAGMA + ALTER 补列（CREATE IF NOT EXISTS 对已存在的表不加列）",
  /PRAGMA table_info\(team_turns\)/.test(PY_CODE) && /ALTER TABLE team_turns ADD COLUMN text_full/.test(PY_CODE));
// INSERT 的列名串与 VALUES 的占位符串在 Python 里是相邻的两条字面量。
// 必须把这一句整块切出来再数：`text_digest, text_full, ts` 这一串在下面的查询里一字不差地又出现一次，
// 全文正则查它＝把写入那行删掉也照样绿（变异取证实测漏过的那条）。
const INSERT_CHUNK = (() => {
  const from = PY_CODE.indexOf('"INSERT OR IGNORE INTO team_turns');
  if (from < 0) return "";
  const to = PY_CODE.indexOf("\",", from);
  return PY_CODE.slice(from, to < 0 ? PY_CODE.length : to).replace(/"\s*,?\s*\n\s*"/g, "").replace(/"/g, "");
})();
const IN_TUPLE = /team_turns \(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/.exec(INSERT_CHUNK);
const IN_COLS = (IN_TUPLE?.[1] || "").split(",").map(s => s.trim()).filter(Boolean);
const IN_PARAMS = (IN_TUPLE?.[2] || "").split(",").map(s => s.trim()).filter(Boolean);
ok("C5 写入列表里有 text_full（少一个列名就是静默丢数据）",
  IN_COLS.includes("text_full") && PY_CODE.includes('turn.get("fullText")'),
  `实际列：${IN_COLS.join(",") || "（没切到 INSERT 语句）"}`);
ok("C5b 列数与占位符数相等（不等时 SQLite 抛绑定数不符，整批发言落不进库）",
  IN_COLS.length > 0 && IN_COLS.length === IN_PARAMS.length,
  `列 ${IN_COLS.length} 个 / 占位符 ${IN_PARAMS.length} 个`);
ok("C6 查询把全文读回来", /SELECT seq,[\s\S]*?text_digest, text_full, ts[\s\S]*?FROM team_turns/.test(PY_CODE)
  && PY_CODE.includes('"fullText": r["text_full"]'));
ok("C7 收尾把总结也带回来（否则重建出来的那场没有结论）",
  PY_CODE.includes('"summaryMarkdown": session_row["summary_markdown"]'));
ok("C8 前端本地缺正文时真去读库", /get\(`\/events\/team\/\$\{encodeURIComponent\(sessionId\)\}`\)/.test(TEAM_CODE));
ok("C9 重建的正文优先取全文、退回摘要", TEAM_CODE.includes("turn.fullText || turn.digest"));
ok("C10 本地已有正文就不重画（避免点一下跳一次）",
  /if \(local && Array\.isArray\(local\.entries\) && local\.entries\.length > 0\) return;/.test(TEAM_CODE));

// ── 4. 手动停止的那场也是发生过的事 ────────────────────────
ok("D1 「停止就不写历史」这个旧门不许回来",
  !/if \(!stoppedManually\) \{\s*persistTeamSession/.test(TEAM_CODE));
ok("D2 历史里带 stopped 标记", /stopped:\s*stoppedManually,/.test(TEAM_CODE));
ok("D3 历史行画出「已中断」徽标",
  /if \(session\.stopped\) \{[\s\S]*?team-history-badge[\s\S]*?t\("已中断"\)/.test(TEAM_CODE));
ok("D4 停止的那场仍然不编造总结", /const summaryMarkdown = stoppedManually \? "" :/.test(TEAM_CODE));

// ── 5. 画得出来 / 翻得出来 ─────────────────────────────────
for (const sel of [".debate-entry.action-error", ".debate-entry.action-skipped",
  ".debate-action-badge.action-error", ".debate-action-badge.action-skipped"]) {
  // 按"整条选择器 + 左花括号"配，别只配类名片段：那样会被别的规则借走分
  ok(`E CSS 里有 ${sel} 这条规则（类名在册而 0 条规则＝裸奔）`,
    new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{").test(CSS));
}
for (const key of ["未参与", "发言 {n} 条", "这场讨论被手动停止，没有走完轮次"]) {
  ok(`F 词典收了「${key}」`, Object.prototype.hasOwnProperty.call(EN_DICT, key));
}
ok("G 用量栏不再把发言数说成轮次",
  TEAM_CODE.includes('t("发言 {n} 条"') && !TEAM_CODE.includes('t("轮次 {n}"'));

// ── H 每一趟上游请求都要给代理留路标 ────────────────────────
// 自定义/本地模型的端点只存在于前端注册表：载荷里少 base_url，后端 _find_model 就认不出
// 这个 model id，回「未知模型」——这位成员整场都只会画出一格「失败」。
const STREAM_CALLS = [...TEAM_CODE.matchAll(/streamChat\(\{/g)];
ok("H1 发言与强制拍板两处都发请求（数量对得上才谈漏没漏）", STREAM_CALLS.length === 2,
  `${STREAM_CALLS.length} 处`);
for (const [i, m] of STREAM_CALLS.entries()) {
  const head = TEAM_CODE.slice(m.index, m.index + 420);
  ok(`H2-${i + 1} 第 ${i + 1} 处载荷带了 base_url（少一发就是这位成员永远失败）`,
    head.includes("base_url:"), head.slice(0, 120).replace(/\s+/g, " "));
}
// 光带 base_url 不够：取模型那一步本身必须看得见用户自己添加的模型，
// 否则 base_url 永远是 undefined，上面那条断言照样绿。
ok("H3 取模型走 store 的统一查法（自定义/本地模型也在内）",
  /import \{[^}]*getModelDefinition[^}]*\} from "\.\.\/store\.js/.test(TEAM_CODE)
  && /function findModel\(modelId\) \{[\s\S]{0,320}?return getModelDefinition\(modelId\);/.test(TEAM_CODE));

console.log(`check_team_trace: 通过（${checks} 项判据）`);
