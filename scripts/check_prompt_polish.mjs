/**
 * 「优化提示词」按钮守卫：scripts/check_prompt_polish.js 一侧的接线
 *
 * 这个功能只有一个错法是用户能看见的：稿子被换了。所以这里钉的不是"按钮在不在"，
 * 而是"写回输入框那条路是不是只有一扇、并且锁在审阅弹窗后面"：
 *   ① HTML：#btn-polish 在 .input-toolbar-right 里、排在语音按钮左边（用户点的位置），
 *      图标与 icons.js 的 sparkles 同一份路径（两处各画一次迟早长得不一样），不许学语音按钮
 *      带 display:none——那颗是按能力显隐的，这颗没有能力可缺；
 *   ② JS：闸门与选模型在发请求那个函数体内；模型话术不经 t()；写回只有一次、
 *      且在 dlgReview 返回真之后；请求在途与弹窗在途两段都要认草稿有没有被改过；
 *      disabled 成对（只 true 不 false＝按钮永久点不动，只 false 不 true＝连点付两趟钱）；
 *   ③ dialog.js：四条退出通道（保留原文 / ESC / × / 背景）都返回"不采用"，
 *      正文两段带 data-i18n-skip（英文界面下词典会把用户的原话翻掉，"原文"就不是原文了）；
 *   ④ CSS：JS 里切的每个 class 都得有规则块，否则像素不动、看起来没生效。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const CHAT = read("frontend/js/components/chat.js");
const POLISH = read("frontend/js/components/prompt_polish.js");
const DIALOG = read("frontend/js/services/dialog.js");
const ICONS = read("frontend/js/services/icons.js");
const DICT = read("frontend/js/services/i18n_dict.js");
const SERVICE = read("frontend/js/services/ai_features.js");

const problems = [];
const must = (cond, msg, detail = "") => { if (!cond) problems.push(`${msg}${detail ? ` → ${detail}` : ""}`); };

/** 从某属性出现的位置往回找包住它的那个 <div>，再按标签深度配平 </div>。
 *  起点必须 lastIndexOf：向前搜才找得到父开标签；深度不许把起始 <div 自己算进去，
 *  否则配平点会落到兄弟节点上，"按钮被搬出这一栏"这种改动就测不出来。 */
function divBlock(src, attrAt) {
  const open = src.lastIndexOf("<div", attrAt);
  if (open === -1) return "";
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open + 4;
  let depth = 1;
  for (let m; (m = tag.exec(src)); ) {
    if (m[0] === "</div>") {
      if (--depth === 0) return src.slice(open, m.index + 6);
    } else depth++;
  }
  return "";
}

/** 取某个顶层函数的函数体（这些文件里函数都是顶格 } 收尾）。 */
function fnBody(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 2);
}

// ── ① HTML ────────────────────────────────────────────────
const BTN_AT = HTML.indexOf('id="btn-polish"');
must(BTN_AT !== -1, "index.html 里没有 #btn-polish（按钮整颗没了）");
const RIGHT_AT = HTML.indexOf('class="input-toolbar-right"');
const RIGHT = divBlock(HTML, RIGHT_AT);
must(RIGHT.includes('id="btn-polish"'),
  "#btn-polish 不在 .input-toolbar-right 里（用户要它在语音按钮左边，且排布走查按这一栏量基线）");
must(/id="btn-polish"[^>]*class="[^"]*\bicon-btn\b/.test(HTML),
  "#btn-polish 没挂 icon-btn：拿不到 26px 那条基线，会凸出来");
must(!/id="btn-polish"[^>]*style="[^"]*display:\s*none/.test(HTML),
  "#btn-polish 带了 display:none：这颗没有能力可缺，藏起来等于功能没做");
const posPolish = RIGHT.indexOf('id="btn-polish"');
const posVoice = RIGHT.indexOf('id="btn-voice"');
const posSend = RIGHT.indexOf('id="btn-send"');
must(posPolish !== -1 && posVoice !== -1 && posSend !== -1 && posPolish < posVoice && posVoice < posSend,
  "右排顺序不是 优化 → 语音 → 发送", `polish=${posPolish} voice=${posVoice} send=${posSend}`);

// 图标与 icons.js 同源：同一种星星画两处，改了一处就分叉
const SPARK = (ICONS.match(/^\s*sparkles:\s*'<path d="([^"]+)"/m) || ["", ""])[1];
const HTML_PATH = (HTML.slice(BTN_AT, BTN_AT + 900).match(/<path d="([^"]+)"/) || ["", ""])[1];
must(SPARK !== "" && HTML_PATH !== "" && HTML_PATH === SPARK,
  "#btn-polish 的图标路径与 icons.js 的 sparkles 不是同一份", `html=${HTML_PATH.slice(0, 32)}… icons=${SPARK.slice(0, 32)}…`);
must(/id="btn-polish"[^>]*title="优化提示词"/.test(HTML), "#btn-polish 没有 title=优化提示词（悬停与读屏都不知道那是干什么的）");
must(DICT.includes('"优化提示词":'), "字典里没有「优化提示词」键（英文界面会冒中文）");

// ── ② prompt_polish.js ────────────────────────────────────
const BODY = fnBody(POLISH, "polishDraft");
must(BODY !== "", "找不到 polishDraft 函数体：请求与审阅没有唯一落点");
must(/if \(aiFeatureBlocked\("prompt_polish"\)\) return;/.test(BODY),
  "polishDraft 里没有 prompt_polish 的闸门（设置里关了照样发请求）");
must(/aiModelFor\("prompt_polish", state\.currentModel\)/.test(BODY),
  "polishDraft 没走 prompt_polish 的选模型（设置里那颗下拉是摆设）");
must(/model: target\.id/.test(BODY) && /api_key: target\.key/.test(BODY),
  "解析出来的模型没进请求参数");
must(/const draft = base\.trim\(\);/.test(BODY), "请求前没把草稿取出来（写回与发出去的不是同一份）");
must(/content: buildPolishPrompt\(draft\)/.test(BODY),
  "请求正文里不是原样的 buildPolishPrompt(draft)：草稿没进请求，或被 t() 包了（载荷不许翻译）");
must(!/\bt\(/.test(fnBody(POLISH, "buildPolishPrompt")),
  "发给模型的话术走了 t()（约定：载荷不经 i18n，否则英文界面下连提示词都被翻译）");

// 写回只有一扇，而且锁在审阅后面
must((POLISH.match(/applyToInput\(/g) || []).length === 2,
  "applyToInput 的调用点不是「定义 1 处 + 采用后 1 处」", `实际 ${(POLISH.match(/applyToInput\(/g) || []).length} 处`);
const REVIEW_GUARD = /if \(!await dlgReview\(\{ original: base, revised \}\)\) return;/.test(BODY);
must(REVIEW_GUARD, "审阅弹窗的返回值没被当成写回的唯一前提（不点采用也可能回填）");
const iReview = BODY.indexOf("dlgReview(");
const iApply = BODY.indexOf("applyToInput(input, revised)");
must(iReview !== -1 && iApply !== -1 && iReview < iApply,
  "写回发生在审阅之前（模型还没确认就改了稿子）");
must((BODY.match(/input\.value !== base/g) || []).length === 2,
  "「草稿被改过就不回填」要请求在途与弹窗在途各一条", `实际 ${(BODY.match(/input.value !== base/g) || []).length} 条`);
must(/dispatchEvent\(new Event\("input"\)\)/.test(fnBody(POLISH, "applyToInput")),
  "回填后没派发 input 事件：自适应高度、草稿暂存、@提及高亮都不会更新");
must(/btn\.disabled = true;/.test(BODY) && /finally \{[\s\S]*?btn\.disabled = false;/.test(BODY),
  "按钮的 disabled 不成对（只 true＝跑完点不动，只 false＝连点付两趟钱）");
must(/reportError\(e, "prompt_polish"\)/.test(BODY),
  "失败没上报（reportError(err, where) 的参数顺序也别反：反了栈迹就归不到这个功能）");
must(/dlgToast\(t\("优化失败：\{msg\}"/.test(BODY), "请求失败时界面毫无反馈，用户只会反复点");

// 接线：chat.js 真的把它挂上了
must(/import \{ initPromptPolish \} from "\.\/prompt_polish\.js\?v=\d{8}-\d+"/.test(CHAT),
  "chat.js 没 import initPromptPolish（按钮点不动：没人给它绑 click）");
must(/initPromptPolish\(\);/.test(CHAT), "chat.js 的 initChat 没调用 initPromptPolish()");

// 登记表挂号（名字与说明在 ai_features.js，这里是同一张表的另一侧）
must(/id: "prompt_polish"/.test(SERVICE), "prompt_polish 没在 AI 辅助功能登记表里挂号（关不掉，也选不了模型）");

// 本文件用到的用户可见文案都要有词条（全局覆盖审计还没上线，先在自己范围内钉住）
for (const key of [...POLISH.matchAll(/\bt\("([^"]+)"/g)].map(m => m[1])) {
  must(DICT.includes(`"${key}"`), `字典里缺「${key}」这个键（英文界面会冒中文）`);
}

// ── ③ dialog.js：dlgReview ────────────────────────────────
const REVIEW = fnBody(DIALOG, "dlgReview");
must(/export function dlgReview\(/.test(DIALOG), "dialog.js 没有导出的 dlgReview");
must(/adoptBtn\.addEventListener\("click", \(\) => finish\(true\)\)/.test(REVIEW),
  "「采用」不是唯一返回 true 的按钮");
must((REVIEW.match(/finish\(true\)/g) || []).length === 1,
  "返回 true 的出口不止一个（每个出口都是一次改写用户的稿子）",
  `${(REVIEW.match(/finish\(true\)/g) || []).length} 处`);
for (const [label, re] of [
  ["保留原文", /keepBtn\.addEventListener\("click", \(\) => finish\(false\)\)/],
  ["背景点击", /backdrop\.addEventListener\("click", \(\) => finish\(false\)\)/],
  ["× 关闭", /closeBtn\.addEventListener\("click", \(\) => finish\(false\)\)/],
  ["Escape", /e\.key !== "Escape"[\s\S]{0,120}finish\(false\)/],
]) must(re.test(REVIEW), `dlgReview 的 ${label} 出口没写成"不采用"`);
must(/content\.dataset\.i18nSkip = "";/.test(REVIEW),
  "审阅正文没打 data-i18n-skip：英文界面的词典会把用户自己的稿子翻掉");
for (const key of ["审阅优化结果", "原文", "优化后", "保留原文", "采用"]) {
  must(DICT.includes(`"${key}"`), `字典里缺审阅弹窗的「${key}」键`);
}

// ── ④ CSS：JS 里切的每个 class 都要有规则块 ────────────────
for (const sel of [".polish-btn.polish-busy", ".dlg-review-grid", ".dlg-review-pane",
  ".dlg-review-label", ".dlg-review-text"]) {
  must(CSS.includes(`${sel} {`), `style.css 里没有 ${sel} 规则块（类在切、像素不动）`);
}
must(/\.dlg-modal\.dlg-review-modal \.modal-content \{[^}]*width:/.test(CSS),
  "审阅弹窗没加宽：两段正文挤在 400px 里，比对就成了猜字");

if (problems.length) {
  console.error(`prompt polish check failed with ${problems.length} issue(s):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`prompt polish check OK: 按钮在右排最左、写回锁在审阅后面、四条退出都不采用、图标与词条同源 (${POLISH.length} bytes)`);
