/**
 * 提示词工厂守卫：scripts/check_prompt_factory.mjs
 *
 * 这一轮把「工厂」从顶栏页签改成了一扇弹窗，入口先落在输入行、随后按用户要求挪进
 * 「设置 → 上下文与项目」（只挪门，不把工作台整页塞进设置页）。改法本身风险不大，
 * 真正会静默坏掉的都在"两头对不上"上：
 *  ① 页签撤了但 #panel-factory 或 data-panel="factory" 还留着 —— switchPanel 仍会去切一个
 *     不存在的页，点了没反应；反过来，`case "factory"` 留在 dock 分发里同理；
 *  ② 入口与弹窗分处两地，但按钮没绑 openPromptFactory —— 点了什么都不发生（最典型）；
 *     入口只许有一处：设置页有、输入行还留着，就是第二个点不开的幽灵按钮；
 *  ③ 弹窗靠在 .hidden 上收放，而桌面 CSS 没有全局 .hidden —— 缺一条 .modal.hidden 规则，
 *     关不掉的弹窗会永远铺在界面上；
 *  ④ 表单是 renderShell() 渲进 #factory-area 的，容器 id 改了组件还按旧的取 —— 渲染进 null，
 *     弹窗打开是空的；
 *  ⑤ Esc / 背景 / × 三条退出通道少一条 —— 键盘用户被困在弹窗里，或点了背景关不掉。
 *
 * 组件本身的行为（宪法镜像、清单、生成）由 check_constitution_scope.mjs 与 check_prompt_polish.mjs
 * 一侧兜住，这里只钉"页面结构 ↔ 弹窗入口"的接线。
 *
 * 运行：node scripts/check_prompt_factory.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const HTML = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const APP = read("frontend/js/app.js");
const FACTORY = read("frontend/js/components/prompt_factory.js");
const POLISH = read("frontend/js/components/prompt_polish.js");
const DICT = read("frontend/js/services/i18n_dict.js");

const results = [];
const ok = (name, passed, detail = "") => results.push([Boolean(passed), name, detail]);

/** 取某个顶层函数的函数体（这些文件里函数都是顶格 } 收尾）。 */
function fnBody(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 2);
}

/** 从某属性出现的位置往回找包住它的那个 <div>，再按标签深度配平 </div>。 */
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

// ── 1. 页签已经撤掉，不留半截入口 ─────────────────────────
ok("顶栏不再有工厂页签（data-panel=\"factory\" 一处不许留）",
  !/data-panel="factory"/.test(HTML), "留着的话 switchPanel 会去切一个不存在的页");
ok("#panel-factory 整块不再存在（页签撤了面板也别留）",
  !HTML.includes('id="panel-factory"'));
ok("app.js 的 dock 分发里没有 case \"factory\"（点了会切到空气）",
  !/case "factory":/.test(APP));
ok("app.js 不再按 panel-factory 判高亮（高亮没处落＝一直亮错项）",
  !APP.includes("panel-factory"));
ok("提示词工厂的提示词文案没被连带删掉（组件还在跑）",
  /const FACTORY_PRESETS = \{/.test(FACTORY) && /function buildPrompt\(/.test(FACTORY));

// ── 2. 入口：挪进「设置 → 上下文与项目」，输入行里一颗不许留 ────────
const RIGHT_AT = HTML.indexOf('class="input-toolbar-right"');
const RIGHT = divBlock(HTML, RIGHT_AT);
ok("输入行右排里不再有 #btn-prompt-factory（留半截＝两处入口，其中一处点不开）",
  !RIGHT.includes('id="btn-prompt-factory"'));
const posPolish = RIGHT.indexOf('id="btn-polish"');
const posSend = RIGHT.indexOf('id="btn-send"');
ok("右排顺序是 优化 → … → 发送",
  posPolish !== -1 && posSend !== -1 && posPolish < posSend,
  `polish=${posPolish} send=${posSend}`);
const CTX_AT = HTML.indexOf('id="settings-context"');
const CTX = CTX_AT === -1 ? "" : HTML.slice(CTX_AT, HTML.indexOf("</section>", CTX_AT));
ok("#btn-prompt-factory 落在「设置 → 上下文与项目」里（工厂吃的就是这份宪法）",
  CTX.includes('id="btn-prompt-factory"'), "不在设置页＝用户按说好的地方找不到");
ok("那颗按钮用设置页通用的 send-btn send-btn-sm（不是把工具行的 icon-btn 整颗搬过来）",
  /id="btn-prompt-factory"[^>]*class="[^"]*\bsend-btn\b[^"]*\bsend-btn-sm\b/.test(HTML));
ok("按钮带看得见的文字「打开工作台」（只有图标＝没人知道点得开什么）",
  CTX.includes("打开工作台"));

// ── 3. 弹窗结构：靠 .hidden 收放，且桌面 CSS 真有那条规则 ────────
const MODAL_AT = HTML.indexOf('id="factory-modal"');
ok("index.html 里有 #factory-modal",
  MODAL_AT !== -1);
const MODAL = MODAL_AT === -1 ? "" : divBlock(HTML, MODAL_AT);
ok("#factory-modal 初始带 hidden（不改就是在开机时盖住整页）",
  /id="factory-modal"[^>]*class="[^"]*\bmodal\b[^"]*\bhidden\b/.test(HTML));
ok("弹窗自带 modal 基类（否则没有居中/遮罩那套通用样式）",
  /id="factory-modal"[^>]*class="[^"]*\bmodal\b/.test(HTML));
ok("#factory-area 落在弹窗里（renderShell 往这里渲，取不到就是空弹窗）",
  MODAL.includes('id="factory-area"'));
ok("桌面 CSS 声明了 .modal.hidden（桌面没有全局 .hidden，缺这条就关不掉）",
  /\.modal\.hidden\s*\{\s*display:\s*none;\s*\}/.test(CSS),
  "关弹窗只是 classList.add(\"hidden\")，没有规则＝像素不动");

// 三条退出通道：背景 / × / Esc，各要能在 DOM 上找得到挂点
ok("背景与 × 都带 data-factory-close（一条选择器收掉两条通道）",
  MODAL_AT !== -1 && (HTML.slice(MODAL_AT, MODAL_AT + 700).match(/data-factory-close/g) || []).length >= 2,
  "少一条＝有一扇门关不掉");
ok("#btn-factory-close 是 × 那颗（右上角总得有个关的）",
  /id="btn-factory-close"[^>]*data-factory-close/.test(HTML));

// ── 4. 组件：入口按钮 → openPromptFactory；三条通道 → close；Esc 也关 ──
const OPEN = fnBody(FACTORY, "openPromptFactory");
ok("openPromptFactory 被导出了（chat/app 才有得挂）",
  /export function openPromptFactory\(/.test(FACTORY));
ok("openPromptFactory 真的把 .hidden 摘掉（只挪焦点不摘 class＝弹窗不出现）",
  /classList\.remove\("hidden"\)/.test(OPEN));
ok("openPromptFactory 把焦点放到任务描述框（打开就能直接写）",
  /getElementById\("factory-task"\)/.test(OPEN));
const CLOSE = fnBody(FACTORY, "closePromptFactory");
ok("closePromptFactory 用 .hidden 收起（与 CSS 那条规则同源）",
  /classList\.add\("hidden"\)/.test(CLOSE));
const BIND = fnBody(FACTORY, "bindModalChannels");
ok("设置页那颗按钮绑到了 openPromptFactory",
  /getElementById\("btn-prompt-factory"\)[\s\S]{0,80}openPromptFactory/.test(BIND),
  "按钮没绑＝点了什么都不发生");
ok("[data-factory-close] 全被绑到关闭（背景 + × 一次收）",
  /querySelectorAll\("\[data-factory-close\]"\)[\s\S]{0,120}closePromptFactory/.test(BIND));
// Esc 不在组件里自己挂：app.js 的全局快捷键已经把 .modal:not(.hidden) 全部收起，
// 工厂弹窗带 .modal 跟着一起关。组件里再挂一条是死支——变异证明删掉也看不见差别。
ok("Esc 关闭由全局快捷键统一收（工厂弹窗是 .modal，被一起收起）",
  /querySelectorAll\("\.modal:not\(\.hidden\)"\)[\s\S]{0,80}classList\.add\("hidden"\)/.test(APP));
ok("bindModalChannels 在 initPromptFactory 里被调用（定义了不调＝两扇门都没挂）",
  /bindModalChannels\(\);/.test(fnBody(FACTORY, "initPromptFactory")));

// 草稿留在 DOM：收起只加 class，不许清空内容（再打开还在）
ok("收起不清表单（只切 class，草稿/勾选/结果都留着）",
  !/clearFactory\(\)/.test(CLOSE) && !/\.value = ""/.test(CLOSE));

// ── 5. app.js 仍把组件拉起 ────────────────────────────────
ok("app.js import 了 initPromptFactory",
  /import \{ initPromptFactory \} from "\.\/components\/prompt_factory\.js\?v=\d{8}-\d+"/.test(APP));
ok("app.js 在启动序列里 initPromptFactory",
  /safeInit\("提示词工厂", initPromptFactory\)/.test(APP));

// ── 6. 样式：弹窗宽高与两栏工作台 ─────────────────────────
// 必须把 .modal-content 一起写进选择器：通用 .modal-content{width:460px} 定义在本段之后，
// 同特异度靠后胜出，光写 .factory-modal-content 会被按回 460px（走查 F2 抓到的真 bug）。
// 只断言"有规则块"没有牙——它当初就绿着放过了这个 bug。
ok("弹窗宽高规则用 .modal-content.factory-modal-content（压得住通用 460px）",
  /\.modal-content\.factory-modal-content\s*\{[^}]*width:\s*min\(1180px/.test(CSS));
ok("弹窗的 body 不再自己滚（滚动交给 .factory-area）",
  /\.factory-modal-content\s+\.modal-body\s*\{[^}]*overflow:\s*hidden/.test(CSS));
ok(".factory-area 仍是有规则块的滚动容器（两栏工作台一起滚）",
  /\.factory-area\s*\{/.test(CSS));

// ── 7. 文案：入口/弹窗的字面量都得在词典里（漏一条＝英文界面留着中文原话）──
for (const key of ["提示词工厂", "打开工作台",
  "把宪法摘要、上下文片段、任务描述、约束与交付要求整合成一份可交付 Prompt。收起后再打开，写过的内容还在。"]) {
  ok(`词条：${key.length > 16 ? key.slice(0, 16) + "…" : key}`, DICT.includes(`"${key}":`));
}
// 工厂挪去设置页，不许顺手把优化提示词那颗一起端掉
ok("优化提示词的按钮也还在（工厂是挪走，不是把它顶掉）",
  RIGHT.includes('id="btn-polish"') && /export function initPromptPolish/.test(POLISH));

const failed = results.filter(([p]) => !p);
for (const [p, name, detail] of results) {
  console.log(`${p ? "ok" : " x"} ${name}${!p && detail ? ` → ${detail}` : ""}`);
}
console.log(`\n提示词工厂守卫：共 ${results.length} 项，失败 ${failed.length}`);
assert.equal(failed.length, 0, `${failed.length} 项不合`);
