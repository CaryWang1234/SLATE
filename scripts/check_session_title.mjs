/**
 * 自动会话标题守卫：scripts/check_session_title.mjs
 *
 * 这个功能的危险不在"起不出标题"，而在"把用户自己起的名字覆盖掉"。所以判据围绕两件事：
 * ① 什么时候允许动手（只有占位标题 + 只有首轮）；② 动手之前还要不要再认一次（请求在途的
 * 几秒里用户可能已经改过名）。这两条一条写在发请求前、一条写在写库前——位置本身就是契约：
 * 把第二次检查挪到第一次之前，等于没有第二次检查。
 *
 * 另外钉三处最容易各写一份的地方：占位口径（建场时截 30 字，判据也得按 30 认）、
 * 调用点（桌面/手机都只准调同一个模块）、以及"这趟请求不许拖住回复的收口"。
 *
 * 运行：node scripts/check_session_title.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const MODULE = read("frontend/js/services/session_title.js");
const CHAT = read("frontend/js/components/chat.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const AIFEATURES = read("frontend/js/services/ai_features.js");
const I18N = read("frontend/js/services/i18n_dict.js");
const CHAT_PY = read("backend/routers/chat.py");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);
const has = (src, needle) => src.includes(needle);
/** needle 出现在 hay 中、且落在 after/before 两段之间（位置就是契约时用这个） */
const between = (hay, needle, after, before) => {
  const i = hay.indexOf(needle);
  if (i < 0) return false;
  const lo = after === undefined ? -1 : hay.indexOf(after);
  const hi = before === undefined ? hay.length : hay.indexOf(before);
  if (lo < 0 || hi < 0) return false;
  return i > lo && i < hi;
};

function fnBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

const BODY = fnBody(MODULE, "autoGenerateSessionTitle");
const PLACEHOLDER = fnBody(MODULE, "isPlaceholderTitle");
const SANITIZE = fnBody(MODULE, "sanitizeTitle");

// ── 1. 只在"该动手"的时候动手 ────────────────────

ok("主函数体取到了（后面的判据才有意义）", BODY.length > 800, `只读到 ${BODY.length} 字`);
ok("这一档关着就连一趟都不发", has(BODY, 'isAiFeatureOn("session_title")'));
ok("模型走本档自己选的那一个", has(BODY, 'aiModelFor("session_title"')
  && /target\.id/.test(BODY) && /target\.key/.test(BODY));
ok("没有可用模型时静默退出（不弹错、也不写库）", has(BODY, "if (!target.usable) return false;"));
ok("只管首轮：第二条用户消息一开口就不掺和",
  has(BODY, 'if (thread.filter(m => m.role === "user").length !== 1) return false;'),
  "少了这一条，每轮末尾都要多付一趟标题请求");
ok("隐藏轮不算用户开口（催办 / 工具回灌 / 后台唤醒都不算）",
  has(BODY, String.raw`.filter(m => !m.hidden && (m.role === "user" || m.role === "assistant"))`));
ok("一问一答都在才发起", has(BODY, "if (!firstUser || !lastAssistant) return false;"));

// ── 2. 占位判据的两处落点：位置就是契约 ────────────

ok("发请求之前认一次占位",
  between(BODY, "isPlaceholderTitle(conv.title, seeds)", "const conv = entry();", "streamChat({"));
ok("写库之前再认一次（请求在途那几秒里用户可能已经改了名）",
  between(BODY, "isPlaceholderTitle(fresh.title, seeds)", "for await (const chunk of streamChat({", "patch(`/chat/conversations/"));
ok("两次都现读会话表，不是一开始的快照", has(BODY, "const fresh = entry();")
  && has(BODY, String.raw`const entry = () => (state.conversations || []).find(c => c?.id === convId);`),
  "第二次若复用第一次那条 conv，覆盖手动改名照样会发生");
ok("起了个和现在一样的名字就不写库", has(BODY, 'if (String(fresh.title || "").trim() === title) return false;'));
ok("写库只有一条通道（多一条就多一处绕过复查的覆盖）",
  (MODULE.match(/patch\(`\/chat\/conversations\//g) || []).length === 1);

// ── 3. 什么算占位：口径要和建场那两处同源 ────────────

ok("占位＝首条消息截一段那两种写法都认",
  has(PLACEHOLDER, "if (cur === head || cur === ") && has(PLACEHOLDER, "${head}...`) return true;"));
ok("截断长度按 30 认，且前端建场仍截 30",
  has(PLACEHOLDER, "const head = seed.slice(0, 30);")
  && has(CHAT, 'title: (text || filesForMessage[0]?.name || "新对话").slice(0, 30),'));
ok("截断长度与后端建场一致", has(CHAT_PY, String.raw`content[:30] + ("..." if len(content) > 30 else "")`));
ok("建场兜底名与模块里是同一个字符串", has(MODULE, 'const FALLBACK_TITLE = "新对话";'));
ok("空标题也按占位处理（只发文件的首条消息曾被写成空的）", has(PLACEHOLDER, "if (!cur) return true;"));
ok("后端不再拿空正文覆盖建场时的文件名标题",
  has(CHAT_PY, 'if count == 1 and role == "user" and isinstance(content, str) and content.strip():'));
ok("随消息进来的第一个文件名也是占位线索",
  has(MODULE, "const firstName = firstUser?.files?.[0]?.name;"));
ok("空种子不许把任何标题都判成占位", has(PLACEHOLDER, "if (!seed) continue;"));

// ── 4. 起出来的标题要能用 ────────────────────────

const capMatch = MODULE.match(/const MAX_TITLE_CHARS = (\d+);/);
ok("标题长度有上限", !!capMatch, "没读到 MAX_TITLE_CHARS");
ok("上限不超过后端 PATCH 的截断（60），也不会短到没法看",
  !!capMatch && Number(capMatch[1]) >= 8 && Number(capMatch[1]) <= 60, `实际 ${capMatch ? capMatch[1] : "无"}`);
ok("只取第一行（模型爱在后面补解释）", has(SANITIZE, String.raw`split(/\r?\n/)[0]`));
ok("剥掉「标题：」这种自报家门（中英两种都剥）",
  has(SANITIZE, String.raw`s.replace(/^\s*(?:会话)?标题\s*[:：]\s*/, "")`)
  && has(SANITIZE, String.raw`s.replace(/^\s*title\s*[:：]\s*/i, "")`));
ok("剥成对包裹要看两头，不是按字符类硬削",
  has(MODULE, "const TITLE_PAIRS = [")
  && has(MODULE, String.raw`out.startsWith(a) && out.endsWith(b) && out.length > a.length + b.length`)
  && has(SANITIZE, "s = unwrapTitle(s.trim());"));
ok("开头孤立的中括号不许被削掉（【任务】整理导出流程 那种，标题里就有它）",
  !has(SANITIZE, String.raw`s.replace(/^[\s"'`));
// 顺序要两头都钉：只比"标点 vs 最后一次剥包裹"的话，把第一次剥包裹整条删掉（先剥标点、
// 后剥包裹）仍然满足，实测这条毒就是靠这个空子过去的。
ok("句末标点在包裹之后才剥，且剥完再认一次包裹（「…。）」这种）",
  has(SANITIZE, String.raw`s.replace(/[。．！!？?；;，,]+$/, "")`)
  && SANITIZE.indexOf("s = unwrapTitle(s.trim());")
    < SANITIZE.indexOf(String.raw`s.replace(/[。．！!？?；;，,]+$/, "")`)
  && SANITIZE.indexOf(String.raw`s.replace(/[。．！!？?；;，,]+$/, "")`)
    < SANITIZE.lastIndexOf("s = unwrapTitle(s.trim());"));
ok("超长就截断", has(SANITIZE, "if (s.length > MAX_TITLE_CHARS) s = s.slice(0, MAX_TITLE_CHARS).trim();"));
ok("太短、或正好是兜底名的结果当没起出来",
  has(SANITIZE, 'if (s.length < 2 || s === FALLBACK_TITLE) return "";'));
ok("思考分片不拼进标题（带 reasoning 的模型在同一条流里混着发）",
  has(BODY, "if (s.startsWith(REASONING_PREFIX) || s.startsWith(REASONING_INLINE_PREFIX)) continue;"));
ok("问与答都截了上限（别把整场对话塞进标题请求）",
  has(MODULE, "question.slice(0, QUESTION_CHARS)") && has(MODULE, "answer.slice(0, ANSWER_CHARS)")
  && has(MODULE, "const QUESTION_CHARS = 600;") && has(MODULE, "const ANSWER_CHARS = 400;"));
ok("话术只给模型看：这个模块没引 i18n", !has(MODULE, "i18n.js"));

// ── 5. 改成功之后：本地一份 + 通知一份，且不许打扰人 ────

ok("写库成功之后才改本地那一条", has(BODY, "fresh.title = title;")
  && between(BODY, "fresh.title = title;", "if (res?.code !== 0) return false;", undefined));
ok("改完通知订阅者（两种侧栏都跟着重画）", has(BODY, 'notify("conversations", state.conversations);'));
ok("后端没认就一行都不改", has(BODY, "if (res?.code !== 0) return false;"));
ok("整条链路只 warn 不抛、也不弹提示", !/\bthrow\b/.test(BODY) && !/Toast|toast\(/.test(BODY)
  && has(BODY, 'console.warn("自动会话标题生成失败:", e);'),
  "这是后台顺手做的事，不值得为它弹错");
ok("刷新回调抛了不把整条链路带崩", has(BODY, "try { await onApplied(title); } catch"));

// ── 6. 接线：桌面与手机都只调同一个模块 ────────────

const IMPORT_RE = /import \{ autoGenerateSessionTitle \} from "\.\.\/services\/session_title\.js\?v=\d{8}-\d+";/;
ok("桌面 import 了这个模块（?v= 不写死具体值）", IMPORT_RE.test(CHAT));
ok("手机 import 了同一个模块", IMPORT_RE.test(MCHAT));
ok("桌面调用排在压缩检查同一批里（首轮收尾，别提前也别拖到最后）",
  CHAT.indexOf("autoGenerateSessionTitle({") > CHAT.indexOf("checkAndCompress(modelId, apiKey, baseUrl, genConvId);"));
ok("手机调用排在压缩检查之后",
  MCHAT.indexOf("autoGenerateSessionTitle({") > MCHAT.indexOf("mCheckCompress(modelId, apiKey, baseUrl);"));
ok("手机被停止时不发这一趟",
  MCHAT.slice(Math.max(0, MCHAT.indexOf("autoGenerateSessionTitle({") - 220), MCHAT.indexOf("autoGenerateSessionTitle({"))
    .includes("!signal?.aborted"));
ok("两端都不 await：回复的收口不等这趟请求",
  !/await\s+autoGenerateSessionTitle/.test(CHAT) && !/await\s+autoGenerateSessionTitle/.test(MCHAT));
ok("桌面改完走一次全量刷新（Codex 侧栏也认这条）", has(CHAT, "onApplied: () => refreshConversationList()"));
ok("两端递的都是这一场的 id（后台那场不能替前台改名）",
  has(CHAT, "convId: genConvId,") && has(MCHAT, "convId: genConvId,"));
ok("占位判据只有一处：调用点不许自己再判一遍",
  !has(CHAT, "isPlaceholderTitle(") && !has(MCHAT, "isPlaceholderTitle("));

// ── 7. 挂号、词条与走查入口 ───────────────────────

ok("登记表里有这一项（自动 + 可单独选模型）",
  has(AIFEATURES, 'id: "session_title", name: "自动会话标题", mode: "自动", model: true,'));
const table = AIFEATURES.slice(AIFEATURES.indexOf("export const AI_FEATURES"));
ok("登记表条目数不少于 15（这一项不许被悄悄删掉）",
  (table.match(/^\s*id:\s*"[a-z_]+"/gm) || []).length >= 15,
  `只数到 ${(table.match(/^\s*id:\s*"[a-z_]+"/gm) || []).length} 项`);
ok("词条：自动会话标题", has(I18N, '"自动会话标题":'));
ok("词条：这一项的说明", has(I18N, '"新对话跑完首轮后请模型补一个短标题换上，只替换还是「首条消息前 30 字」那种占位标题，手动改过的名字不动":'));
ok("两个纯函数导出了（走查要从页面直调，不能只信整条链路）",
  has(MODULE, "export function isPlaceholderTitle") && has(MODULE, "export function sanitizeTitle"));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "PASS" : "FAIL"}  ${name}${!p && detail ? `  → ${detail}` : ""}`);
}
console.log(`\ncheck_session_title: ${results.length - failed.length}/${results.length} 通过`);
assert.equal(failed.length, 0, `${failed.length} 条契约被破坏：${failed.map(([, n]) => n).join(" | ")}`);
