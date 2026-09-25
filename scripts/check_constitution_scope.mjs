/**
 * 项目宪法分项目生效守卫：scripts/check_constitution_scope.mjs
 *
 * 「让项目宪法分项目而不同」要同时成立四件事，缺一条就会串台：
 * ①两份宪法各存各的：全局在 state.constitution，项目的留在 state.project.constitution，
 *   生效哪一份现算（以前是打开项目就把项目那份盖进全局，关项目/换项目都没人还原）；
 * ②所有提示词消费点都走同一个"生效宪法"，桌面与移动同一口径；
 * ③工具目录那份系统提示不再重复注入一遍项目宪法（同一条系统提示里说两遍，白花 token）；
 * ④保存目标与界面说明一致：开着项目写进项目，没开写进全局，且非法 JSON 要出声。
 * ①②③④都在这里真跑或真读源码，不靠肉眼比对。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "../frontend/js/store.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const APP = read("frontend/js/app.js");
const CHAT = read("frontend/js/components/chat.js");
const MCHAT = read("frontend/js/mobile/m-chat.js");
const FACTORY = read("frontend/js/components/prompt_factory.js");
const METER = read("frontend/js/services/context_meter.js");
const TOOLS = read("frontend/js/services/tools.js");
const STORE = read("frontend/js/store.js");
const HTML = read("frontend/index.html");
const DICT = read("frontend/js/services/i18n_dict.js");

// ── 1. 两份各存各的，生效的那份现算（真跑） ────────────────────
const GLOBAL = { rules: ["全局规则"] };
const PROJECT = { rules: ["只属于这个项目的规则"] };
store.state.constitution = GLOBAL;

assert.deepEqual(store.effectiveConstitution(), GLOBAL, "没开项目时应该用全局宪法");
assert.equal(store.constitutionScope(), "global", "没开项目却说要写进项目");

// 打开一个自带宪法的项目：生效的是项目那份，全局那份必须原样留着
store.setProject({ path: "/tmp/p", name: "p", config: { constitution: PROJECT }, constitution: PROJECT });
assert.deepEqual(store.effectiveConstitution(), PROJECT, "项目宪法没接管");
assert.deepEqual(store.state.constitution, GLOBAL, "全局宪法被项目覆写了——这正是串台的根因");
assert.equal(store.constitutionScope(), "project", "开着项目时作用域该报 project");

// 切到一个没写宪法的项目：回到全局，而不是沿用上一个项目的
store.setProject({ path: "/tmp/q", name: "q", config: {}, constitution: null });
assert.deepEqual(store.effectiveConstitution(), GLOBAL, "换项目后还在用上一个项目的宪法");
// 关掉项目同理：关完不能继续留着项目的规则
store.setProject({ path: "/tmp/p", name: "p", config: { constitution: PROJECT }, constitution: PROJECT });
store.setProject(null);
assert.deepEqual(store.effectiveConstitution(), GLOBAL, "关掉项目后项目规则还在生效");
// 空数组也算"这个项目有主张"：显式写了 rules:[] 就是不要规则，不该回落到全局
store.setProject({ path: "/tmp/e", name: "e", config: {}, constitution: { rules: [] } });
assert.deepEqual(store.effectiveConstitution(), { rules: [] }, "项目显式清空宪法被当成没写");
store.setProject(null);

// setProject 里不许再有任何覆写全局宪法的动作
const setProjectBody = STORE.slice(STORE.indexOf("function setProject(data)"), STORE.indexOf("function setProjectFileTree"));
assert.ok(!/setConstitution\(/.test(setProjectBody), "setProject 又去覆写全局宪法了");

// ── 2. 消费点统一走 effectiveConstitution ──────────────────────
// 桌面（可并行）：宪法先由 buildAdapterHistory 按"这一场的项目"现算成 history._constitution，
// 取不到才回落 effectiveConstitution()——后台那场不能拿屏幕上那个项目的规则去问模型。
assert.match(CHAT, /buildMessages\(history, history\._constitution \|\| effectiveConstitution\(\)/, "chat.js 的系统提示没走生效宪法");
for (const [rel, src] of [["m-chat.js", MCHAT]]) {
  // 移动端一次只跑一场，全局那份生效宪法就是它自己的现场
  assert.match(src, /buildMessages\(history, effectiveConstitution\(\)/, `${rel} 的系统提示没走生效宪法`);
  assert.ok(!/buildMessages\(history, state\.constitution/.test(src), `${rel} 还在直接把全局宪法喂给模型`);
}
assert.ok(!/buildMessages\(history, effectiveConstitution\(\)[,)]/.test(CHAT), "chat.js 还在直接把屏幕上那个项目的宪法喂给模型");
assert.match(CHAT, /const rules = effectiveConstitution\(\)\?\.rules/, "自动推进审查的宪法段没走生效宪法");
assert.match(METER, /buildSystemContent\([^,]+, effectiveConstitution\(\)/, "上下文条估算没按生效宪法算（分桶会和实际载荷不符）");
assert.match(FACTORY, /function getRules\(\)[\s\S]{0,120}effectiveConstitution\(\)/, "提示词工厂读的不是生效宪法");
assert.match(FACTORY, /subscribe\("project", \(\) => \{[\s\S]*?renderConstitution\(\);[\s\S]*?renderChecklist\(\);[\s\S]*?\}\)/,
  "换项目后提示词工厂没重画宪法展示");
assert.match(TOOLS, /const c = effectiveConstitution\(\);/, "生成提示词工具没走生效宪法");

// ── 3. 工具目录不再重复注入项目宪法 ────────────────────────────
assert.doesNotMatch(TOOLS, /s \+= "项目宪法:\\n"/, "工具提示里又注入一遍项目宪法：同一条系统提示会说两遍");
// P2 起这一行写的是"这一场的项目"（proj = 传入的 project || state.project）：并行时
// 后台那场的工具目录里若写着屏幕上那个项目，模型就会让它去读别人的文件。
assert.match(TOOLS, /\[当前项目\] \$\{proj\.name\} \(\$\{proj\.path\}\)/, "项目身份还该在工具提示里（且按这一场的项目取）");
assert.match(TOOLS, /const proj = project \|\| state\.project;/, "工具目录的项目身份没按这一场的项目取");

// ── 4. 设置页：读的是生效那份，写的目标说清楚 ──────────────────
assert.match(APP, /function renderConstitutionSettings\(\)/, "宪法设置没有统一的渲染函数");
assert.match(APP, /const active = effectiveConstitution\(\);[\s\S]{0,200}box\.value = JSON\.stringify\(active, null, 2\)/,
  "设置页宪法框读的不是生效宪法");
assert.match(APP, /hint\.textContent = constitutionScope\(\) === "project"/, "设置页没说明这次改的是哪一份");
assert.match(HTML, /id="constitution-scope"/, "缺少写明宪法归属的提示位");
assert.match(APP, /if \(state\.project\) \{[\s\S]{0,300}updateProjectConfig\(config\)[\s\S]{0,200}setProject\(res\.data\)/,
  "开着项目保存宪法没写进项目配置");
assert.match(APP, /await put\("\/constitution", constData\);\s*setConstitution\(constData\);/,
  "全局宪法保存后没走 setConstitution（订阅方不会刷新）");
assert.ok(!/^\s*state\.constitution = /m.test(APP), "app.js 里又直接赋值 state.constitution");
assert.match(APP, /toast\(t\("宪法不是合法 JSON，未保存"\)\)/, "非法 JSON 又静默吞掉了");

// ── 5. 双语文案齐备 ───────────────────────────────────────────
for (const key of ["正在编辑项目「{name}」的宪法：存入该项目 .slate/config.json，只对该项目生效",
  "正在编辑全局宪法：项目自带宪法时以项目为准", "宪法不是合法 JSON，未保存", "项目宪法保存失败：{msg}"]) {
  assert.ok(DICT.includes(`"${key}"`), `i18n 缺词条：${key}`);
}

console.log("项目宪法作用域守卫：通过（真跑接管/回落 4 组，消费点 5 处）");
