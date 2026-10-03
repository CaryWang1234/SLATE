/**
 * 模型品牌 mark 守卫：scripts/check_model_logos.mjs
 *
 * 一条 mark 从下载文件到出现在界面上要过四道：images/models/*.svg（原件）→
 * gen_model_icons.mjs（内联表）→ icons.js（查表 + currentColor）→ 顶栏/列表/气泡（选哪一枚）。
 * 每一道掉链子都不报错，只会画错或画不出来，所以这里逐道真跑：
 * ①原件体检：24 网格、fill-rule、以及"第三方 SVG 敢不敢内联进我们自己的文档"；一家品牌两份
 *    （`<brand>-color.svg` 彩色原件 + `<brand>.svg` 单色兜底），有彩色的就用彩色的；
 * ②生成物与原件同源（跑 gen_model_icons.mjs --check，不靠肉眼比对）；
 * ③别名表按事实匹配：把 backend 注册表里的 26 条现读一遍，每条都得有 mark；
 *    同时喂一批负样本——把 yitian 认成 Yi、把 metadata 认成 Llama 这种画错品牌的错，
 *    比留白严重得多；
 * ④消费点（顶栏槽、自定义模型行、密钥行、气泡下的模型名）与样式都接上了，
 *    而且旧的 <img src> + 按 src 配反转滤镜那套补丁不许回来；
 * ⑤取色分两支：彩色原件画品牌自己的颜色（fill 写死在图形上，任何主题都不改），
 *    没有彩色版的 11 家才走 currentColor——那批的取色钉在跨主题的中性灰上，
 *    因为自定义主题把 --text-muted 做成墨色的衍色，跟着它走会被染成主题色（挑米出米、挑蓝出蓝）。
 *    两条都不许越界：CSS 里不许出现给 mark 图形上 fill 的规则（那会把品牌色压平），
 *    deriveTokens 也不许把中性灰掺上色相。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const DIR = "frontend/images/models";

// ── 1. 原件体检 ────────────────────────────────────────────────
const files = readdirSync(join(ROOT, DIR)).filter(f => f.endsWith(".svg")).sort();
const brandOf = (f) => f.replace(/-color\.svg$/, "").replace(/\.svg$/, "");
const brands = [...new Set(files.map(brandOf))].sort();
assert.ok(brands.length >= 50, `mark 原件只剩 ${brands.length} 家品牌，像是目录被动过`);
for (const must of ["openai.svg", "deepseek.svg", "qwen.svg", "ollama.svg", "zai.svg"]) {
  assert.ok(files.includes(must), `${must} 必须在：内置注册表里有整个系列靠它画品牌`);
}
// 一家品牌两份：彩色原件（有就用它）+ 单色原件（没有彩色版时的兜底，也是"跟随界面"那批）
const usedFile = {};
for (const b of brands) usedFile[b] = files.includes(`${b}-color.svg`) ? `${b}-color.svg` : `${b}.svg`;

let coloredBrands = 0;
const srcFillRules = {};
const defsOwner = {};
// 两份原件都要体检：单色那份即使暂时没被用上（这家有彩色版），也是"没有彩色版时该长什么样"
// 的基线。只检被选中的那份，闲置文件里的越界（写死颜色、带 id、viewBox 漂走）就没人管了。
for (const f of files) {
  const b = brandOf(f);
  const svg = read(`${DIR}/${f}`);
  const isColor = f.endsWith("-color.svg");
  assert.match(svg, /\sviewBox="0 0 24 24"/, `${f}: 内联后靠 viewBox 跟随字号，24 网格是这套 mark 的约定`);
  // 镂空靠 evenodd。单色那批是 LobeHub 的一贯做法（根标签写一次，path 上不再写），
  // 彩色那批各家随意（有的整只没有 fill-rule，因为它本来就不靠 evenodd 挖洞）。
  // 这里记下条数与取值，第 2 道比对"原件写了几处、内联后就该有几处"。
  const fillRules = svg.match(/fill-rule="[^"]+"/g) || [];
  srcFillRules[f.replace(/\.svg$/, "")] = fillRules;
  if (!isColor) {
    assert.match(svg, /<svg[^>]*fill-rule="evenodd"/, `${f}: 单色原件根标签没写 fill-rule，镂空会糊成实心`);
  }
  assert.doesNotMatch(svg, /<script|<image|foreignObject|\son[a-z]+\s*=|\shref\s*=|xlink:href/,
    `${f}: 带脚本/外链/事件属性的 SVG 一律不许内联`);
  if (isColor) {
    coloredBrands += 1;
    assert.match(svg, /fill="(?:#[0-9a-fA-F]{3,8}|url\(#)/,
      `${f}: 挂着 -color 的名字却没有自己的颜色，等于白占一份原件`);
    for (const m of svg.matchAll(/\sid="([^"]+)"/g)) {
      // 品牌名各家拼法不同（chatglm 的 id 里写的是 chat-glm），所以这里只认包自己的前缀；
      // 真正防撞的是内联时改的 mi-<brand>- 前缀（见下面第 2 道）。
      assert.ok(m[1].startsWith("lobe-icons-"),
        `${f}: id="${m[1]}" 不是 LobeHub 自己的命名，来历不明的 defs 不放行`);
      if (defsOwner[m[1]] && defsOwner[m[1]] !== b) {
        assert.fail(`${f}: id="${m[1]}" 与 ${defsOwner[m[1]]} 撞名，同页并排会互相拿错渐变`);
      }
      defsOwner[m[1]] = b;
    }
  } else {
    assert.match(svg, /<svg[^>]*fill="currentColor"/,
      `${f}: 单色兜底那份根标签不是 currentColor，深色底上跟不过来自界面文字色`);
    assert.doesNotMatch(svg, /fill="#[0-9a-fA-F]{3,8}"/,
      `${f}: 单色兜底那份写死了颜色——它要在深色底上跟着界面变亮`);
    assert.doesNotMatch(svg, /\sid="/, `${f}: 单色原件不该带 id（没有 defs 却要改名，多半是拿错了文件）`);
  }
}

const SOURCE = read(`${DIR}/SOURCE.md`);
assert.match(SOURCE, /`@lobehub\/icons-static-svg@\d+\.\d+\.\d+`/, "SOURCE.md 得写明图标来自哪个包的哪个版本");
assert.match(SOURCE, /MIT/, "MIT 许可要随文件带上，来历不明的美术资源不能进仓库");
assert.match(SOURCE, /registry\.npmmirror\.com/, "得留一条能重下的命令，不然哪天想换 logo 只能靠猜");
assert.match(SOURCE, /-color\.svg/, "SOURCE.md 要写清两份原件的取用顺序（彩色优先、单色兜底），否则下次重下只会拿回单色那批");

// ── 2. 生成物与原件同源 ────────────────────────────────────────
const gen = spawnSync(process.execPath, ["scripts/gen_model_icons.mjs", "--check"], {
  cwd: ROOT, encoding: "utf8", timeout: 120000,
});
assert.equal(gen.status, 0, `内联表与 images/models/ 不同源：\n${gen.stdout || ""}${gen.stderr || ""}`);

const icons = await import("../frontend/js/services/model_icons.js");
const logos = await import("../frontend/js/services/model_logos.js");

const keys = Object.keys(icons.MODEL_ICONS).sort();
assert.deepEqual(keys, Object.keys(icons.MODEL_VIEWBOXES).sort(), "图形表和 viewBox 表对不上");
assert.deepEqual(keys, Object.keys(icons.MODEL_ICON_LABELS).sort(), "图形表和品牌名对不上");
assert.equal(keys.length, icons.MODEL_ICON_COUNT, "MODEL_ICON_COUNT 与表里的条数不一致");
assert.equal(keys.length, brands.length, "images/models/ 里的品牌数与内联表条数不一致（一家两份原件不该生成两条）");
let coloredInGen = 0;
for (const k of keys) {
  assert.ok(k.startsWith("model-"), `${k}: 品牌 mark 必须挂 model- 前缀——provider 字段里 openai/anthropic/google 是线路协议名，裸名会撞车`);
  const body = icons.MODEL_ICONS[k];
  const b = k.slice("model-".length);
  const srcRules = srcFillRules[usedFile[b].replace(/\.svg$/, "")];
  assert.deepEqual(body.match(/fill-rule="[^"]+"/g) || [], srcRules,
    `${k}: 内联串里的 fill-rule 与原件（${usedFile[b]}）对不上（原件 ${srcRules.length} 处），镂空会画错`);
  assert.doesNotMatch(body, /<script|href=|xlink:href/, `${k}: 内联串里不该有脚本/外链`);
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ids) {
    assert.ok(id.startsWith(`mi-${b}-`),
      `${k}: 内联 id="${id}" 没改名到 mi-${b}- 前缀——同页并排两只不同品牌的 mark 会互相拿错渐变`);
  }
  const defined = new Set(ids);
  for (const m of body.matchAll(/url\(\s*#([^)\s]+)\s*\)/g)) {
    assert.ok(defined.has(m[1]), `${k}: 引用 #${m[1]} 但本图标里没有这个 id，渐变指空就是画成黑的`);
  }
  const colored = /fill="(#[0-9a-fA-F]{3,8}|url\()/.test(body);
  if (colored) coloredInGen += 1;
  assert.equal(colored, usedFile[b].endsWith("-color.svg"),
    `${k}: 生成物与原件的"彩色/单色"对不上（原件取的是 ${usedFile[b]}）`);
}
assert.equal(coloredInGen, coloredBrands, `${coloredBrands} 家有彩色原件，生成物里却只数到 ${coloredInGen} 只带品牌色`);

// ── 3. 别名表：注册表现读 + 显式期望 + 负样本 ───────────────────
const PROXY = read("backend/routers/proxy.py");
const registry = [...PROXY.matchAll(/\{"id": "([^"]+)", "name": "([^"]+)", "provider": "([^"]+)",\s*\n?\s*"base_url": "([^"]+)"/g)]
  .map((m) => ({ id: m[1], name: m[2], provider: m[3], base_url: m[4] }));
assert.ok(registry.length >= 20, `只从 proxy.py 解析出 ${registry.length} 条注册表，正则该跟着注册表格式改了`);

for (const m of registry) {
  const key = logos.modelIconKey(m);
  assert.ok(key, `内置模型 ${m.id} 认不出品牌：整条注册表都该有 mark，用户不用猜`);
  assert.ok(keys.includes(key), `内置模型 ${m.id} 认成了 ${key}，可这张 mark 不在表里`);
}

// 名字与端点各指一个品牌时，名字赢：deepseek-r1 跑在 Ollama 上该画 DeepSeek
const EXPECT = [
  // 自定义模型：名字里带品牌就按名字，端点只兜名字认不出的（这两条最先红，红了就是"名字先/端点后"排倒了）
  [{ id: "deepseek-r1:1.5b", base_url: "http://localhost:11434/v1" }, "model-deepseek"],
  [{ id: "llama3.1:8b", base_url: "http://localhost:11434/v1" }, "model-meta"],
  [{ id: "deepseek-v4-pro", base_url: "https://api.deepseek.com/v1" }, "model-deepseek"],
  [{ id: "kimi-k3", base_url: "https://api.moonshot.cn/v1" }, "model-kimi"],
  [{ id: "qwen3.8-max", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, "model-qwen"],
  [{ id: "glm-5.2", base_url: "https://open.bigmodel.cn/api/paas/v4" }, "model-zai"],
  [{ id: "doubao-seed-2-1-pro-260628", base_url: "https://ark.cn-beijing.volces.com/api/v3" }, "model-doubao"],
  [{ id: "ernie-5.1", base_url: "https://qianfan.baidubce.com/v2" }, "model-wenxin"],
  [{ id: "MiniMax-M3", base_url: "https://api.minimax.cn/v1" }, "model-minimax"],
  [{ id: "gpt-5.6-sol", base_url: "https://api.openai.com/v1" }, "model-openai"],
  [{ id: "claude-opus-5", base_url: "https://api.anthropic.com" }, "model-claude"],
  [{ id: "gemini-3.6-flash", base_url: "https://generativelanguage.googleapis.com/v1beta" }, "model-gemini"],
  [{ id: "local", name: "本地模型 (Ollama/LM Studio)", base_url: "http://localhost:11434/v1" }, "model-ollama"],
  [{ id: "command-r-plus", base_url: "https://api.cohere.com/v1" }, "model-cohere"],
  [{ id: "nemotron-51b", base_url: "https://integrate.api.nvidia.com/v1" }, "model-nvidia"],
  [{ id: "granite-4-tiny", base_url: "https://us-south.ml.cloud.ibm.com/v1" }, "model-ibm"],
  [{ id: "mimo-v2", base_url: "https://api.xiaomimimo.com/v1" }, ""],
  [{ name: "公司自研", id: "", base_url: "https://llm.example.com/v1" }, ""],
  [{ id: "flux-dev", base_url: "https://api.bfl.ml/v1" }, "model-flux"],
  [{ id: "stable-diffusion-xl", base_url: "https://api.stability.ai/v1" }, "model-stability"],
];
for (const [model, want] of EXPECT) {
  assert.equal(logos.modelIconKey(model), want,
    `${model.id || model.name} 应认成 ${want || "（留白）"}，认错了就是给用户画了个假品牌`);
}

// 短别名不许撞进别人的词里：yi / hf / glm 都是两个三个字符，撞一次就画错一整列
for (const word of ["yitian-710", "hifiasm", "metadata-helper", "ghost", "filesystem-mcp", "glmnote"]) {
  assert.equal(logos.modelIconKey({ id: word }), "", `${word} 里并没有对应品牌，不该被短别名抢走`);
}

// 别名表里每个别名都得指到一张真实 mark（写错一个键名是静默的：查不到就什么也不画）。
// 一行里挂着好几个别名，所以按"别名: \"model-…"的形状现读，别按行数算。
const LOGOS_SRC = read("frontend/js/services/model_logos.js");
const aliasKeys = [
  ...[...LOGOS_SRC.matchAll(/(?:^|[\s{,])([a-z][a-z0-9]*)\s*:\s*"model-/gm)].map(m => m[1]),
  ...[...LOGOS_SRC.matchAll(/"([^"]+)"\s*:\s*"model-/g)].map(m => m[1]),
];
assert.ok(aliasKeys.length >= 60, `别名表只解析出 ${aliasKeys.length} 条，格式该跟着 model_logos.js 一起改`);
for (const a of aliasKeys) {
  const key = logos.modelIconKey({ id: a });
  assert.ok(key && keys.includes(key), `别名 ${a} 指向的 mark 不在表里（多半是键名手滑）`);
}

// ── 4. 消费点与样式 ────────────────────────────────────────────
const INDEX = read("frontend/index.html");
const APP = read("frontend/js/app.js");
const CHAT = read("frontend/js/components/chat.js");
const ICONS = read("frontend/js/services/icons.js");
const CSS = read("frontend/css/style.css");

assert.match(ICONS, /import \{ MODEL_ICONS, MODEL_VIEWBOXES \} from "\.\/model_icons\.js\?v=/,
  "icons.js 没接上内联表：mark 下载了也画不出来");
assert.match(ICONS, /MCP_ICONS\[name\] \|\| MODEL_ICONS\[name\]/, "iconSvg 查表链里漏了模型品牌 mark");
assert.match(ICONS, /const vb = CUSTOM_VIEWBOXES\[name\] \|\| MCP_VIEWBOXES\[name\] \|\| MODEL_VIEWBOXES\[name\]/,
  "viewBox 没认模型表：非 24 网格的图形会被拉变形");

assert.match(INDEX, /<span id="model-icon" class="model-icon"/,
  "顶栏槽位该是装内联 SVG 的 span");
assert.doesNotMatch(INDEX, /<img id="model-icon"/,
  "顶栏又用回 <img> 了：那张图里的 currentColor 只会退成黑色，暗色主题等于没画");

assert.match(APP, /import \{ modelIconKey, modelIconLabel \} from "\.\/services\/model_logos\.js\?v=/,
  "app.js 没引别名表：品牌判定又长回两处就没法一致");
assert.match(APP, /const key = modelIconKey\(model\)/, "顶栏那颗 mark 没走别名表");
assert.match(APP, /modelMarkSpan\(model\)/, "自定义模型行没画 mark（用户主要就在这儿加模型）");
assert.doesNotMatch(APP, /MODEL_ICON_MAP|getModelIconUrl/,
  "旧的 MODEL_ICON_MAP / getModelIconUrl 又回来了：品牌判定必须只在 model_logos.js 一处");

assert.match(CHAT, /modelIconKey\(msg\.model\)/, "气泡下的模型名没画 mark：那里只剩名字字符串，靠同一张别名表认");
assert.match(APP, /span\.dataset\.modelIcon = key/, "自定义模型行没把认成的品牌留在 DOM 上：走查与排障无从核对");
assert.match(APP, /slot\.dataset\.modelIcon = key/, "顶栏槽位没把认成的品牌留在 DOM 上");
assert.match(CHAT, /label\.dataset\.modelIcon = markKey/, "气泡下的模型名没把认成的品牌留在 DOM 上");

assert.doesNotMatch(CSS, /\.model-icon\[src\*=/,
  "按 src 配反转滤镜的旧补丁回来了：内联 mark 走 currentColor，不需要逐只纠色");

// ── mark 的取色：彩色原件画品牌色，单色那批不许被自定义主题染色 ──────────
// 有 `<brand>-color.svg` 的 47 家：颜色写死在图形 fill 上，任何主题都不该改——所以 CSS
// 里绝不允许出现给 mark 图形上 fill 的规则（一条 `.model-mark path { fill: … }` 就能把整套品牌色压平）。
// 没有彩色版的 11 家（openai / anthropic / grok / zai …）走 currentColor，取色钉在跨主题的中性灰：
// 用户挑米色墨 → --text-muted 就是米色衍色，mark 跟着变米；挑蓝灰就变蓝。
// 这只灰只在自定义主题下由 deriveTokens 发；内置主题没这个变量，回落 var(--text-muted) 即原样。
// 深底/浅底仍分两支（明暗切换照旧）。
const THEME = read("frontend/js/services/theme_custom.js");
for (const cls of [".model-icon", ".model-mark"]) {
  const sel = cls.replace(/^\./, "\\.");
  assert.match(CSS, new RegExp(`${sel} \\{[^}]*color: var\\(--mark-neutral, var\\(--text-muted\\)\\)`),
    `${cls} 又直接用 --text-muted：自定义主题的墨色会把单色那批 mark 染成主题色`);
  assert.doesNotMatch(CSS, new RegExp(`${sel}[^{]*\\{[^}]*\\bfill:`),
    `${cls} 那条链上出现了 fill 规则：它会把彩色原件的品牌色一起压平`);
}
assert.doesNotMatch(CSS, /--mark-neutral:/,
  "--mark-neutral 不该在 style.css 里定义：内置主题要的正是「没有这个变量 → 回落 --text-muted」");

const neutral = THEME.match(/"--mark-neutral":\s*isDark\s*\?\s*"(#[0-9A-Fa-f]{6})"\s*:\s*"(#[0-9A-Fa-f]{6})"/);
assert.ok(neutral, 'deriveTokens 里 --mark-neutral 必须是 isDark ? "#深底灰" : "#浅底灰" 这一对写死值');
const spread = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const [darkGray, lightGray] = [neutral[1], neutral[2]];
assert.ok(spread(darkGray) <= 20 && spread(lightGray) <= 20,
  `mark 的钉色得基本无色相：浅 ${lightGray} 色宽 ${spread(lightGray)}、深 ${darkGray} 色宽 ${spread(darkGray)}（>20 就是带色相；夜金的米墨 32、深海的蓝墨 35，都是被主题染掉的样子）`);
assert.ok(lum(darkGray) > lum(lightGray),
  "深底那支要比浅底那支亮：写反了在深色配色下等于把 mark 画进背景里");
const NEUTRAL_LINE = THEME.slice(THEME.indexOf('"--mark-neutral"'), THEME.indexOf('"--mark-neutral"') + 120);
assert.doesNotMatch(NEUTRAL_LINE, /ink|accent|colors\./,
  "--mark-neutral 掺进了 ink/accent：那就又跟着主题的墨色与强调色走了");

console.log(`check_model_logos: 通过（${keys.length} 张 mark · ${coloredBrands} 只品牌彩色 · ${keys.length - coloredBrands} 只中性灰 · ${aliasKeys.length} 条别名 · 注册表 ${registry.length} 条全认得出）`);
