/**
 * 国际化引擎：语言在安装时选定（安装程序写入 data/language.txt），应用内不切换。
 *
 * 机制：
 * - initI18n() 启动时从后端取语言；en 时先全量翻译当前 DOM，再启动 MutationObserver
 *   捕获后续动态插入的内容（toast、弹窗、生成的面板），做到界面文字全覆盖；
 * - 词典以中文原文为键（i18n_dict.js），命中即替换，未命中保持原文；
 * - t(key, vars) 供带变量的动态字符串在调用处使用，支持{var} 占位符；
 * - 模型生成内容与用户输入不翻译（SKIP_SELECTOR / data-i18n-skip 标记）。
 */

import { EN_DICT } from "./i18n_dict.js?v=20260828-129";

let LANG = "zh";
let observer = null;
let observing = false;

// 不翻译的区域：代码块、输入框、消息正文等模型/用户内容
const SKIP_SELECTOR =
  "script, style, textarea, input, pre, code, iframe, canvas, svg, " +
  ".msg-content, .markdown-body, .prompt-result, .skill-result, .risk-command, " +
  "[data-i18n-skip]";

const TRANS_ATTRS = ["title", "placeholder", "alt", "aria-label"];

const ZH_RE = /[\u4e00-\u9fff]/;

export const getLang = () => LANG;
export const isEn = () => LANG === "en";

/** 带变量翻译：zh 原样返回；en 查词典并替换 {var} 占位符 */
export function t(key, vars) {
  let s = LANG === "en" ? (EN_DICT[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** 单段文本翻译：保留前后空白，仅替换中间命中词典的中文 */
function translateText(s) {
  const trimmed = s.trim();
  if (!trimmed || !ZH_RE.test(trimmed)) return s;
  const hit = EN_DICT[trimmed];
  return hit ? s.replace(trimmed, hit) : s;
}

function skipped(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.matches(SKIP_SELECTOR) || !!el.closest(SKIP_SELECTOR);
}

/** 翻译元素子树：文本节点 + 可翻译属性 */
function translateNode(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    if (root.parentElement && skipped(root.parentElement)) return;
    const nv = translateText(root.data);
    if (nv !== root.data) root.data = nv;
    return;
  }
  if (root.nodeType !== 1 || skipped(root)) return;

  // 元素自身属性
  for (const a of TRANS_ATTRS) {
    const v = root.getAttribute(a);
    if (v && ZH_RE.test(v)) {
      const nv = translateText(v);
      if (nv !== v) root.setAttribute(a, nv);
    }
  }

  // 文本节点
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (!ZH_RE.test(n.data)) continue;
    if (n.parentElement && skipped(n.parentElement)) continue;
    const nv = translateText(n.data);
    if (nv !== n.data) n.data = nv;
  }

  // 子元素属性
  const els = root.querySelectorAll("[title], [placeholder], [alt], [aria-label]");
  for (const el of els) {
    if (skipped(el)) continue;
    for (const a of TRANS_ATTRS) {
      const v = el.getAttribute(a);
      if (v && ZH_RE.test(v)) {
        const nv = translateText(v);
        if (nv !== v) el.setAttribute(a, nv);
      }
    }
  }
}

/** 启动：拉取语言配置；en 时翻译全页并监听后续 DOM 变更 */
export async function initI18n() {
  try {
    const r = await fetch("/api/i18n/lang");
    const d = await r.json();
    LANG = d?.data?.lang === "en" ? "en" : "zh";
  } catch (e) {
    LANG = "zh";
  }
  document.documentElement.classList.remove("i18n-pending");
  if (LANG !== "en") return LANG;

  document.documentElement.lang = "en";
  translateNode(document.documentElement);

  observer = new MutationObserver((mutations) => {
    if (observing) return;
    observing = true;
    try {
      for (const m of mutations) {
        for (const n of m.addedNodes) translateNode(n);
        if (m.type === "characterData" && ZH_RE.test(m.target.data || "")) {
          translateNode(m.target);
        }
        if (m.type === "attributes" && m.target.nodeType === 1) {
          const a = m.attributeName;
          if (TRANS_ATTRS.includes(a)) {
            const v = m.target.getAttribute(a);
            if (v && ZH_RE.test(v)) {
              const nv = translateText(v);
              if (nv !== v) m.target.setAttribute(a, nv);
            }
          }
        }
      }
    } finally {
      observing = false;
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANS_ATTRS,
  });
  return LANG;
}
