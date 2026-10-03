/**
 * 生成 frontend/js/services/model_icons.js
 *
 * 把 frontend/images/models/*.svg 转成内联字符串，交给 icons.js 的 iconSvg() 查表。
 * 一家品牌取哪一份：**有 `<brand>-color.svg` 就取彩色原件**（品牌自己的颜色，任何主题下都不改），
 * 没有彩色版的才退回单色 `<brand>.svg`（`fill="currentColor"`，靠界面给的中性灰描色）。
 * 为什么仍然内联而不是 `<img src>`：单色那批要 currentColor 才在深色底上看得见；内联也让
 * 彩色那批不必为每只图标多一次请求。代价是第三方 defs 会进我们的文档，所以 id 必须改名（见下）。
 * 原件留在 images/models/ 里——那才是可复核、可重下的。
 *
 * 用法：
 *   node scripts/gen_model_icons.mjs          重新生成
 *   node scripts/gen_model_icons.mjs --check  只比对，不写盘（守卫用）
 *
 * 第三方 SVG 会被塞进我们自己的文档，所以这里顺带做白名单式体检：带脚本、外链、
 * 事件属性、`<image>` 的一律拒绝，而不是默默内联。`id` 单独处理——彩色版几乎都带渐变，
 * 一律拒绝等于放弃品牌色，所以改成**按品牌加前缀改名**（`mi-<brand>-<id>`），
 * 并把 `url(#旧名)` 的引用一起改写；改完还要每条引用都指得到本图标内的 id，指空就拒绝。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "frontend/images/models");
const OUT = join(ROOT, "frontend/js/services/model_icons.js");
const CHECK = process.argv.includes("--check");

// 危险构造：内联进 DOM 前一律不放行
const UNSAFE = [
  [/<script\b/i, "含 <script>"],
  [/\son[a-z]+\s*=/i, "含事件属性"],
  [/\bhref\s*=/i, "含外链 href"],
  [/\bxlink:href\b/i, "含 xlink:href"],
  [/<image\b/i, "含 <image>（会发起网络请求）"],
  [/<foreignObject\b/i, "含 foreignObject"],
];

/** 把第三方 defs 的 id 改成本图标独有的名字，并同步改写所有 url(#…) 引用。
 *  前缀带品牌名：同一页可以并排画两只不同品牌的 mark，撞了 id 就会拿别人的渐变。 */
function namespaceIds(body, brand) {
  const prefix = `mi-${brand}-`;
  const safe = (id) => prefix + id.replace(/[^A-Za-z0-9_-]+/g, "-");
  const ids = [...new Set([...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))];
  let out = body;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\bid="${esc}"`, "g"), `id="${safe(id)}"`);
    out = out.replace(new RegExp(`url\\(\\s*#${esc}\\s*\\)`, "g"), `url(#${safe(id)})`);
  }
  const defined = new Set([...out.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const m of out.matchAll(/url\(\s*#([^)\s]+)\s*\)/g)) {
    if (!defined.has(m[1])) throw new Error(`${brand}: 引用了 #${m[1]}，但本图标里没有这个 id（改名没盖住）`);
  }
  for (const id of defined) {
    if (!id.startsWith(prefix)) throw new Error(`${brand}: id="${id}" 没被改名到 ${prefix}… 前缀下`);
  }
  return out;
}

function provenance() {
  const src = readFileSync(join(DIR, "SOURCE.md"), "utf8");
  const m = src.match(/`@lobehub\/icons-static-svg@(\d+\.\d+\.\d+)`/);
  if (!m) throw new Error("SOURCE.md 没写明 @lobehub/icons-static-svg 的版本号，产物头就没法记来历");
  return m[0].replace(/[`]/g, "");
}

function parseSvg(file, brand) {
  const text = readFileSync(join(DIR, file), "utf8");
  const base = brand;
  if (!/^\s*<svg\b/.test(text)) throw new Error(`${file}: 不是以 <svg> 开头`);
  const viewBox = (text.match(/\sviewBox="([^"]+)"/) || [])[1];
  if (!viewBox) throw new Error(`${file}: 缺 viewBox，内联后尺寸无法跟随字号`);
  for (const [re, why] of UNSAFE) if (re.test(text)) throw new Error(`${file}: ${why}，拒绝内联`);
  const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1] || base;
  const rootTag = text.slice(0, text.indexOf(">") + 1);
  const body = text
    .slice(text.indexOf(">") + 1, text.lastIndexOf("</svg>"))
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!body) throw new Error(`${file}: 剥掉 svg 外壳后是空的`);
  if (!/<(path|circle|rect|ellipse|polygon|line|g)\b/.test(body)) {
    throw new Error(`${file}: 里没有可画的图形元素`);
  }
  // 根标签上的 fill-rule 会随外壳一起被剥掉，而这套 mark 全靠 evenodd 挖镂空：
  // 丢了它，Kimi 的斜杠、火山的三角都会糊成实心块——图标在，但画错了。
  const fillRule = (rootTag.match(/\sfill-rule="([^"]+)"/) || [])[1];
  const named = namespaceIds(body, base);
  // 统一挂 model- 前缀：provider 字段在这套注册表里是「线路协议」而不是品牌
  // （openai / anthropic / google 三个值都被当协议用），裸名会撞车。
  const key = `model-${base}`;
  return { key, viewBox, title, body: fillRule ? `<g fill-rule="${fillRule}">${named}</g>` : named };
}

function build() {
  const files = readdirSync(DIR).filter(f => f.endsWith(".svg"));
  // 一家品牌一份产物：有彩色原件就用彩色的，没有才用单色那份兜底。
  const brands = [...new Set(files.map(f => f.replace(/-color\.svg$/, "").replace(/\.svg$/, "")))].sort();
  if (brands.length < 40) throw new Error(`只找到 ${brands.length} 家品牌，像是目录没同步完`);
  for (const must of ["openai", "deepseek", "qwen"]) {
    if (!brands.includes(must)) throw new Error(`缺 ${must}.svg：内置模型注册表里有整个系列要靠它画品牌`);
  }
  const pick = (b) => (files.includes(`${b}-color.svg`) ? `${b}-color.svg` : `${b}.svg`);
  const icons = brands.map(b => parseSvg(pick(b), b));
  const dup = new Set();
  for (const i of icons) {
    if (dup.has(i.key)) throw new Error(`${i.key} 重复`);
    dup.add(i.key);
  }
  const rows = (pick) => icons.map(i => `  ${JSON.stringify(i.key)}: ${JSON.stringify(pick(i))}`).join(",\n");
  const out = `/* 由 scripts/gen_model_icons.mjs 从 frontend/images/models/*.svg 生成，勿手改。
 * 图标来源：${provenance()}（MIT），来历、取舍与重下命令见 frontend/images/models/SOURCE.md。
 * 生成：node scripts/gen_model_icons.mjs ；一致性由 scripts/check_model_logos.mjs 把关。
 * 消费：icons.js 的 iconSvg()。彩色原件带自己的 fill，任何主题下都是品牌色；
 * 只有单色版的那几家靠 currentColor 描色，由界面给中性灰。 */

export const MODEL_ICONS = {
${rows(i => i.body)},
};

export const MODEL_VIEWBOXES = {
${rows(i => i.viewBox)},
};

/** 品牌名：tooltip 与 aria 用，别让代码里再抄一份拼写 */
export const MODEL_ICON_LABELS = {
${rows(i => i.title)},
};

export const MODEL_ICON_COUNT = ${icons.length};
`;
  return { out, count: icons.length };
}

const { out, count } = build();
if (CHECK) {
  const current = readFileSync(OUT, "utf8");
  if (current !== out) {
    console.error("model_icons.js 与 frontend/images/models/ 里的图形不一致，跑：node scripts/gen_model_icons.mjs");
    process.exit(1);
  }
  console.log(`模型 mark 生成物核对：通过（${count} 个）`);
} else {
  writeFileSync(OUT, out, "utf8");
  console.log(`已生成 frontend/js/services/model_icons.js（${count} 个 mark）`);
}
