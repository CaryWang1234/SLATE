/**
 * 生成 frontend/js/services/mcp_icons.js
 *
 * 把 frontend/images/mcp/*.svg 转成内联字符串，交给 icons.js 的 iconSvg() 查表。
 * 为什么不走 <img src="...svg">：这批 mark 用 fill="currentColor" 描色，作为图片
 * 加载时 currentColor 只会退化成黑色，暗色主题下等于没画出来；内联进 DOM 才跟得住
 * 界面文字颜色。文件仍留在 images/mcp/ 里——那才是可复核、可重下的原件。
 *
 * 用法：
 *   node scripts/gen_mcp_icons.mjs          重新生成
 *   node scripts/gen_mcp_icons.mjs --check  只比对，不写盘（守卫用）
 *
 * 第三方 SVG 会被塞进我们自己的文档，所以这里顺带做白名单式体检：带 id、脚本、
 * 外链、事件属性的一律拒绝，而不是默默内联。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "frontend/images/mcp");
const OUT = join(ROOT, "frontend/js/services/mcp_icons.js");
const CHECK = process.argv.includes("--check");

// 危险构造：内联进 DOM 前一律不放行
const UNSAFE = [
  [/<script\b/i, "含 <script>"],
  [/\son[a-z]+\s*=/i, "含事件属性"],
  [/\bhref\s*=/i, "含外链 href"],
  [/\bxlink:href\b/i, "含 xlink:href"],
  [/<image\b/i, "含 <image>（会发起网络请求）"],
  [/<foreignObject\b/i, "含 foreignObject"],
  [/\sid\s*=/i, "含 id（同页多份会撞选择器与 defs）"],
];

function provenance() {
  const src = readFileSync(join(DIR, "SOURCE.md"), "utf8");
  const m = src.match(/`@lobehub\/icons-static-svg@(\d+\.\d+\.\d+)`/);
  if (!m) throw new Error("SOURCE.md 没写明 @lobehub/icons-static-svg 的版本号，产物头就没法记来历");
  return m[0].replace(/[`]/g, "");
}

function parseSvg(file) {
  const text = readFileSync(join(DIR, file), "utf8");
  const base = file.replace(/\.svg$/, "");
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
  // 丢了它，GitHub 的猫、雪花的六角都会糊成实心块——图标在，但画错了。
  const fillRule = (rootTag.match(/\sfill-rule="([^"]+)"/) || [])[1];
  // 品牌 mark 统一挂 mcp- 前缀，免得和 icons.js 里既有的键撞名；
  // 兜底那枚就叫 mcp——它是"这台 Server 认不出品牌"时唯一要画的东西。
  const key = base === "mcp" ? "mcp" : `mcp-${base}`;
  return { key, viewBox, title, body: fillRule ? `<g fill-rule="${fillRule}">${body}</g>` : body };
}

function build() {
  const files = readdirSync(DIR).filter(f => f.endsWith(".svg")).sort();
  if (files.length < 10) throw new Error(`只找到 ${files.length} 个 svg，像是目录没同步完`);
  if (!files.includes("mcp.svg")) throw new Error("缺 mcp.svg：认不出品牌的 Server 就没有兜底 mark");
  const icons = files.map(parseSvg);
  const dup = new Set();
  for (const i of icons) {
    if (dup.has(i.key)) throw new Error(`${i.key} 重复`);
    dup.add(i.key);
  }
  const rows = (pick) => icons.map(i => `  ${JSON.stringify(i.key)}: ${JSON.stringify(pick(i))}`).join(",\n");
  const out = `/* 由 scripts/gen_mcp_icons.mjs 从 frontend/images/mcp/*.svg 生成，勿手改。
 * 图标来源：${provenance()}（MIT），来历与重下命令见 frontend/images/mcp/SOURCE.md。
 * 生成：node scripts/gen_mcp_icons.mjs ；一致性由 scripts/check_mcp_logos.mjs 把关。
 * 消费：icons.js 的 iconSvg()（内联 + currentColor，明暗主题同一条路径）。 */

export const MCP_ICONS = {
${rows(i => i.body)},
};

export const MCP_VIEWBOXES = {
${rows(i => i.viewBox)},
};

/** 品牌名：tooltip 与 aria 用，别让代码里再抄一份拼写 */
export const MCP_ICON_LABELS = {
${rows(i => i.title)},
};

export const MCP_ICON_COUNT = ${icons.length};
`;
  return { out, count: icons.length };
}

const { out, count } = build();
if (CHECK) {
  const current = readFileSync(OUT, "utf8");
  if (current !== out) {
    console.error("mcp_icons.js 与 frontend/images/mcp/ 里的图形不一致，跑：node scripts/gen_mcp_icons.mjs");
    process.exit(1);
  }
  console.log(`MCP mark 生成物核对：通过（${count} 个）`);
} else {
  writeFileSync(OUT, out, "utf8");
  console.log(`已生成 frontend/js/services/mcp_icons.js（${count} 个 mark）`);
}
