/**
 * MCP 品牌 mark 守卫：scripts/check_mcp_logos.mjs
 *
 * 一条 mark 从下载文件到出现在界面上要过四道：images/mcp/*.svg（原件）→
 * gen_mcp_icons.mjs（内联表）→ icons.js（查表 + currentColor）→ 面板/工具行（选哪一枚）。
 * 每一道掉链子都不会报错，只会画错或画不出来，所以这里逐道真跑：
 * ①原件体检：viewBox、fill-rule、以及"第三方 SVG 敢不敢内联进我们自己的文档"；
 * ②生成物与原件同源（跑 gen_mcp_icons.mjs --check，不靠肉眼比对）；
 * ③别名表按事实匹配：认得出 GitHub/Notion，也绝不能把 ghost 认成 gh；
 * ④两个消费点（MCP Server 行 / mcp__* 工具图标）与样式都接上了。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const DIR = "frontend/images/mcp";

// ── 1. 原件体检 ────────────────────────────────────────────────
const files = readdirSync(join(ROOT, DIR)).filter(f => f.endsWith(".svg")).sort();
assert.ok(files.length >= 20, `mark 原件只剩 ${files.length} 张，像是目录被动过`);
assert.ok(files.includes("mcp.svg"), "mcp.svg 必须在：认不出品牌的 Server 全靠它兜底");

const SOURCE = read(`${DIR}/SOURCE.md`);
assert.match(SOURCE, /`@lobehub\/icons-static-svg@\d+\.\d+\.\d+`/, "SOURCE.md 得写明图标来自哪个包的哪个版本");
assert.match(SOURCE, /MIT/, "MIT 许可要随文件带上，来历不明的美术资源不能进仓库");
assert.match(SOURCE, /registry\.npmmirror\.com/, "得留一条能重下的命令，不然哪天想换 logo 只能靠猜");

for (const f of files) {
  const svg = read(`${DIR}/${f}`);
  assert.match(svg, /\sviewBox="0 0 24 24"/, `${f}: 内联后靠 viewBox 跟随字号，24 网格是这套 mark 的约定`);
  assert.match(svg, /<svg[^>]*fill-rule="evenodd"/, `${f}: 根标签没写 fill-rule，镂空会糊成实心`);
  assert.doesNotMatch(svg, /<script|<image|foreignObject|\son[a-z]+\s*=|\shref\s*=/,
    `${f}: 带脚本/外链/事件属性的 SVG 一律不许内联`);
  assert.doesNotMatch(svg, /\sid="/, `${f}: 带 id 的图形同页放两份会撞（defs/样式互相污染）`);
}

// ── 2. 生成物与原件同源 ────────────────────────────────────────
const gen = spawnSync(process.execPath, ["scripts/gen_mcp_icons.mjs", "--check"], {
  cwd: ROOT, encoding: "utf8", timeout: 120000,
});
assert.equal(gen.status, 0, `内联表与 images/mcp/ 不同源：\n${gen.stdout || ""}${gen.stderr || ""}`);

const icons = await import("../frontend/js/services/mcp_icons.js");
const logos = await import("../frontend/js/services/mcp_logos.js");

const keys = Object.keys(icons.MCP_ICONS).sort();
assert.deepEqual(keys, Object.keys(icons.MCP_VIEWBOXES).sort(), "图形表和 viewBox 表对不上");
assert.deepEqual(keys, Object.keys(icons.MCP_ICON_LABELS).sort(), "图形表和品牌名对不上");
assert.equal(keys.length, icons.MCP_ICON_COUNT, "MCP_ICON_COUNT 与表里的条数不一致");
assert.equal(keys.length, files.length, "images/mcp/ 与内联表条数不一致");
assert.ok(keys.includes(logos.MCP_FALLBACK_ICON), `兜底键 ${logos.MCP_FALLBACK_ICON} 不在表里`);
for (const k of keys) {
  assert.ok(k === "mcp" || k.startsWith("mcp-"), `${k}: 品牌 mark 必须挂 mcp- 前缀，免得撞 icons.js 既有的键`);
  assert.match(icons.MCP_ICONS[k], /^<g fill-rule="evenodd">/, `${k}: fill-rule 没跟着内联，镂空会画错`);
  assert.doesNotMatch(icons.MCP_ICONS[k], /\sid=|<script|href=/, `${k}: 内联串里不该有 id/脚本/外链`);
}

// ── 3. 别名表：该认的认出来，不该认的别乱认 ─────────────────────
const CASES = [
  [["GitHub"], "mcp-github"],
  [["@modelcontextprotocol/server-github"], "mcp-github"],
  [["gh"], "mcp-github"],
  [["ghost"], "mcp"],            // 短别名只做整词，否则一切带 gh 的名字都成 GitHub
  [["My Notion", "https://mcp.notion.com/sse"], "mcp-notion"],
  [["search", "https://api.exa.ai/mcp"], "mcp-exa"],
  [["figma-developer-mcp", "https://mcp.figma.com/mcp"], "mcp-figma"],
  [["n8n-workflow"], "mcp-n8n"],
  [["hugging-face"], "mcp-huggingface"],
  [["bailian", "https://dashscope.aliyuncs.com/compatible-mode/v1"], "mcp-bailian"],
  [["filesystem", "http://localhost:3000"], "mcp"],
  [["sqlite"], "mcp"],
  [["Everything", "http://127.0.0.1:8080/sse"], "mcp"],
  [["", ""], "mcp"],
  [[undefined, null], "mcp"],
];
for (const [parts, want] of CASES) {
  assert.equal(logos.mcpIconKey(...parts), want, `mcpIconKey(${JSON.stringify(parts)}) 认错了品牌`);
}
assert.equal(
  logos.mcpIconKeyFromTool("mcp__1__get_issue", [{ serverId: 1, server: "GitHub", url: "https://api.githubcopilot.com/mcp" }]),
  "mcp-github", "数字 serverId 反查不到 Server 名：工具行就画不出品牌"
);
assert.equal(
  logos.mcpIconKeyFromTool("mcp__7__whatever", []), "mcp",
  "反查不到时必须落回兜底 mark，不能抛错或返回空"
);
assert.equal(logos.mcpIconLabel("mcp-github"), icons.MCP_ICON_LABELS["mcp-github"]);

// ── 4. 两个消费点 + 样式 ──────────────────────────────────────
const ICONS_JS = read("frontend/js/services/icons.js");
const TOOL_META = read("frontend/js/services/tool_meta.js");
const PANEL = read("frontend/js/components/mcp_server_panel.js");
const CSS = read("frontend/css/style.css");
const MCP_CLIENT = read("backend/mcp_client.py");

assert.match(ICONS_JS, /import \{ MCP_ICONS, MCP_VIEWBOXES \} from "\.\/mcp_icons\.js\?v=/,
  "icons.js 没接上内联表：mark 下载了也画不出来");
assert.match(ICONS_JS, /ICONS\[name\] \|\| CUSTOM_ICONS\[name\] \|\| MCP_ICONS\[name\]/, "iconSvg 查表链里漏了 MCP 品牌 mark");
assert.match(ICONS_JS, /const vb = CUSTOM_VIEWBOXES\[name\] \|\| MCP_VIEWBOXES\[name\]/,
  "viewBox 没认 MCP 表：非 24 网格的图形会被拉变形");
assert.match(ICONS_JS, /const fill = \(CUSTOM_VIEWBOXES\[name\] \|\| MCP_VIEWBOXES\[name\]\) \? "fill=/,
  "填充色没认 MCP 表：品牌 mark 会以 stroke 描边的方式画成一团线");

// 先判"又全画插头"：整段回退时这句更有指向性，别让上面那条 match 先抢着报
assert.doesNotMatch(TOOL_META, /startsWith\("mcp__"\)\s*\?\s*"plug"/,
  "又退回全部 MCP 都画插头的老写法了：这次要的就是分品牌");
assert.match(TOOL_META, /mcpIconKeyFromTool\(key, state\.skills\?\.remoteTools\)/,
  "mcp__* 工具图标没走品牌匹配");

assert.match(PANEL, /dataset\.mcpIcon = mcpIconKey\(srv\.name, srv\.url\)/,
  "Server 行没把匹配结果留在 DOM 上：走查与排障无从核对认成了哪一枚");
assert.match(PANEL, /iconSvgEl\(avatar\.dataset\.mcpIcon, "mcp-server-logo"\)/,
  "头像不是内联 SVG（改成 <img> 的话 currentColor 会退成黑色，暗色主题看不见）");
assert.match(PANEL, /nameRow\.appendChild\(statusDot\)/, "状态灯丢了：头像只说哪家 Server，连接状态还得看得见");
assert.match(CSS, /\.mcp-server-avatar\s*\{[^}]*border:\s*1px solid var\(--border\)/, "头像没描边，会和内容糊在一起");
assert.match(CSS, /\.mcp-server-avatar\s*\{[^}]*color:\s*var\(--text-muted\)/,
  "头像色没跟主题走：暗色下就是画在深色上的一块黑");
assert.match(CSS, /\.mcp-server-logo\s*\{[^}]*width:\s*17px/, "mark 尺寸没定，1em 的原始尺寸会跟着字号乱缩");

// 后端把 url 一起带回来，前端才可能从"我的服务器"这种名字认出新店
assert.match(MCP_CLIENT, /"url": conn\.url/, "remoteTools 少了 url：只认名字的话，改名就丢品牌");

console.log(`MCP 品牌 mark 守卫：通过（原件 ${files.length} 张，别名 ${keys.length - 1} 家，判例 ${CASES.length} 条）`);
