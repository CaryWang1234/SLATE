// 侧栏任务列表守卫：四态判定、五种排序、徽标同源与跨文件契约。
// 判据以"真跑纯函数"为主（task_list.js 零依赖，可在 Node 里直接调），
// 只有无法在 Node 里跑的部分（渲染处接线、settings 白名单、CSS 色调）按源码文本钉住。
// 运行：node scripts/check_task_list.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// 导入必须带与前端一致的 ?v= 串：少了它 Node 里会另起一份模块实例
import * as tl from "../frontend/js/services/task_list.js?v=20260925-007";
import { EN_DICT } from "../frontend/js/services/i18n_dict.js?v=20260925-007";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const NOW_MS = 1_800_000_000_000;
const S = NOW_MS / 1000;   // 服务端 updated_at 是 epoch 秒

const conv = (id, over = {}) => ({ id, title: id, project: "", created_at: S, updated_at: S, total_tokens: 0, ...over });
const flag = (kind, over = {}) => ({ kind, at: NOW_MS, seen: false, ...over });

// ── 1. 四态判定：优先级、未读位、陈旧作废 ──────────────────────
assert.equal(tl.taskStatusOf(conv("a"), { flags: {} }), "idle", "没有记录就没有徽标，不能凭空画一个");
assert.equal(tl.taskStatusOf(conv("a"), { flags: { a: flag("done") } }), "unread", "done 未看过必须是「已完成未查看」");
assert.equal(tl.taskStatusOf(conv("a"), { flags: { a: flag("done", { seen: true }) } }), "idle", "看过之后不能再挂着未读");
assert.equal(tl.taskStatusOf(conv("a"), { flags: { a: flag("needs") } }), "needs");
assert.equal(tl.taskStatusOf(conv("a"), { flags: { a: flag("error") } }), "error");
// 实时生成权赢过一切持久结论
for (const kind of ["done", "needs", "error"]) {
  assert.equal(
    tl.taskStatusOf(conv("a"), { flags: { a: flag(kind) }, activeConvId: "a" }),
    "running",
    `生成中的会话必须报「进行中」，不管上一场是什么（${kind}）`,
  );
}
// 徽标记录早于会话最新一句时一律作废：后来在别处继续过，旧结局不该再压在列表上
assert.equal(tl.taskStatusOf(conv("a", { updated_at: S + 3600 }), { flags: { a: flag("done") } }), "idle", "陈旧结局不得继续显示徽标");
assert.equal(tl.taskStatusOf(conv("a", { updated_at: S + 1 }), { flags: { a: flag("error") } }), "error", "容差内（同一次发送）仍算最新结局");
assert.equal(tl.taskStatusOf({ }, { flags: {} }), "idle", "没有 id 的记录不得误判");

// ── 2. 徽标单一定义：图标真实存在、四种状态互不相同 ─────────────
const BADGES = ["running", "needs", "error", "unread"].map((status) => {
  const badge = tl.statusBadge(status);
  assert.ok(badge, `${status} 必须有徽标`);
  assert.equal(badge.className, "conv-item-status", "两处列表靠同一个类名共享样式，各自起名会分叉");
  assert.equal(badge.status, status);
  assert.ok(badge.label && EN_DICT[badge.label], `徽标文案「${badge?.label}」缺英文词条`);
  return badge;
});
assert.equal(new Set(BADGES.map(b => b.icon)).size, 4, "四态图标必须互不相同，只靠颜色区分等于没有标志");
assert.equal(new Set(BADGES.map(b => b.status)).size, 4);
assert.equal(tl.statusBadge("idle"), null, "idle 不该画出徽标");
const ICON_SRC = read("../frontend/js/services/icons.js");
for (const { icon } of BADGES) {
  // 带连字符的键在源码里是加引号的，两种写法都要认
  assert.ok(new RegExp(`^  ['"]?${icon}['"]?: `, "m").test(ICON_SRC), `icons.js 里没有图标 ${icon}`);
}

// ── 3. 五种排序：逐个给出可核对的次序，而不是只断言"排过序" ─────
const convs = [
  conv("old-urgent", { project: "Zed", updated_at: S - 900, total_tokens: 10 }),
  conv("mid", { project: "Alpha", updated_at: S - 400, total_tokens: 300 }),
  conv("new-quiet", { project: "", updated_at: S, total_tokens: 5 }),
];
const flags = { "old-urgent": flag("error"), mid: flag("needs") };
const ctx = { flags, activeConvId: "" };
const order = (mode) => tl.sortConversations(convs, mode, ctx).map(c => c.id).join(">");
assert.equal(order("recent"), "new-quiet>mid>old-urgent", "默认按最近更新倒序");
assert.equal(order("created"), "new-quiet>mid>old-urgent", "创建时间同日时按更新时间兜底，次序必须稳定");
assert.equal(order("usage"), "mid>old-urgent>new-quiet", "按用量从高到低");
assert.equal(order("project"), "mid>old-urgent>new-quiet", "按项目名排，且没有项目的垫底");
assert.equal(order("status"), "mid>old-urgent>new-quiet", "按状态排要把最该处理的排前面（需要操作 > 出错 > 无徽标）");
assert.equal(order("乱写的偏好"), "new-quiet>mid>old-urgent", "未知排序值必须回落到默认，不能让列表变成随机序");
assert.deepEqual(tl.sortConversations(undefined, "recent", ctx), [], "非数组入参不得抛异常");
// 主键相同一律以"最近更新"兜底，同键次序才不会每次重绘都变
const sameProject = [conv("b", { project: "P", updated_at: S - 10 }), conv("a", { project: "P", updated_at: S - 5 })];
assert.equal(tl.sortConversations(sameProject, "project", { flags: {} }).map(c => c.id).join(""), "ab");

// ── 4. 分组：组序跟随同一偏好，未分类永远最后 ──────────────────
const groupsBy = (mode) => tl.groupConversationsByProject(convs, mode, ctx).map(([name]) => name).join("|");
assert.equal(groupsBy("project"), "Alpha|Zed|未分类", "按项目排时组名即主键");
assert.equal(groupsBy("recent"), "未分类|Alpha|Zed", "按时间排时组序取组内最新那条");
assert.equal(groupsBy("status"), "Alpha|Zed|未分类", "按状态排时最急的组在前");
assert.deepEqual(
  tl.groupConversationsByProject(convs, "recent", ctx).map(([name, list]) => `${name}:${list.map(c => c.id).join(",")}`),
  ["未分类:new-quiet", "Alpha:mid", "Zed:old-urgent"],
  "组内条目必须真的按偏好排过",
);
assert.equal(tl.projectLabel(conv("x", { project: "  " })), "未分类", "只有空白的 project 也算未分类");

// ── 5. 入参清洗：持久化里可能是旧版本或手写坏掉的数据 ──────────
assert.equal(tl.normalizeTaskListSort("status"), "status");
assert.equal(tl.normalizeTaskListSort("nope"), "recent");
assert.equal(tl.normalizeTaskListSort(undefined), "recent");
assert.equal(tl.normalizeTaskFlag({ kind: "running", at: 1 }), null, "进行中不许进持久层：重启后会留下永远转不完的僵尸态");
assert.equal(tl.normalizeTaskFlag({ kind: "done", at: 0 }), null);
assert.equal(tl.normalizeTaskFlag({ kind: "done", at: 5, seen: "yes" }).seen, false, "seen 只认真假的布尔");
const many = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`c${i}`, flag("done", { at: NOW_MS + i })]));
assert.equal(Object.keys(tl.normalizeTaskFlags(many)).length, 300, "映射必须封顶，否则跑一年就撑爆持久化体积");
assert.equal(tl.normalizeTaskFlags(many)["c349"].at, NOW_MS + 349, "裁剪要留下最近的，不是最老的");
assert.deepEqual(tl.normalizeTaskFlags(null), {});

// ── 6. 跨文件契约：谁写这份状态、谁同步到哪里 ──────────────────
const STORE = read("../frontend/js/store.js");
const CHAT = read("../frontend/js/components/chat.js");
const APP = read("../frontend/js/app.js");
const HTML = read("../frontend/index.html");
const CSS = read("../frontend/css/style.css");
const SETTINGS = read("../backend/routers/settings.py");
const KERNEL = read("../frontend/js/services/agent_loop.js");

// 偏好跨设备同步，未读位不跨设备（"看过了"说的是这块屏幕）
assert.match(SETTINGS, /"taskListSort",/, "排序偏好没进 /settings/state 白名单：手机上改了桌面重启后又回落到默认");
assert.ok(!/"taskFlags"/.test(SETTINGS), "taskFlags 不得进服务端白名单：阅读进度不该跨设备覆盖");
assert.ok(
  /function getSharedPersistentData[\s\S]*?\n\}/.test(STORE)
  && /taskListSort: normalizeTaskListSort\(data\.taskListSort\)/.test(STORE)
  && !/taskFlags:/.test(/function getSharedPersistentData[\s\S]*?\n\}/.exec(STORE)[0]),
  "共享持久化里只该有排序偏好，不该有未读位",
);
assert.match(STORE, /taskFlags: state\.taskFlags,/, "taskFlags 没进本机持久化：重启后徽标全丢");
// 两条装载路径都得清洗：漏一条就等于从那条路径进来的是脏数据
assert.equal((STORE.match(/normalizeTaskFlags\(data\.taskFlags\)/g) || []).length, 1, "本机装载路径要清洗 taskFlags");
assert.match(STORE, /state\.taskFlags = normalizeTaskFlags\(\{/, "写入即清洗+裁剪，别把裁剪留给读的时候");
assert.match(STORE, /if \(Object\.prototype\.hasOwnProperty\.call\(data, "taskListSort"\)\)/, "共享装载路径要按存在性覆盖排序偏好");

// 渲染处不许自己算状态或自己挑图标
for (const [src, label] of [[CHAT, "classic"], [APP, "Codex"]]) {
  assert.match(src, /statusBadge\(taskStatusOf\(/, `${label} 列表的徽标必须由 taskStatusOf 派生`);
  assert.match(src, /dataset\.status = badge\.status/, `${label} 的色调由 data-status 驱动，不能在 JS 里写死颜色`);
}
// 这条原本钉的是 `sortConversations(conversations, …)`：classic 列表后来加了"按项目"分组
// 分支（列表先分流再排序），形参改名成 list。判据没变——仍然是"classic 列表必须按偏好排"，
// 只是源码形状换了，所以跟着改锚点，不是放宽。
assert.match(CHAT, /sortConversations\(list, state\.taskListSort/, "classic 列表没按偏好排序");
assert.match(CHAT, /groupConversationsByProject\(list, state\.taskListSort, ctx\)/,
  "classic 的按项目分组必须由 task_list 派生：自己算一份就会和 Codex 分组口径不一致");
assert.match(APP, /groupConversationsByProject\(cxConvsCache, state\.taskListSort/, "Codex 分组没按同一偏好排序");
assert.match(CHAT, /subscribe\("taskFlags", refreshTaskBadges\)/, "徽标变了不重绘：工具收口/手机侧继续跑之后列表还停在旧状态");
assert.match(CHAT, /subscribe\("taskListSort", refreshTaskBadges\)/, "排序偏好变了不重绘：换了排序要点开列表才生效");
assert.match(APP, /slate:task-badges-updated/, "Codex 列表没接重绘事件：两处列表会各显示一套状态");
assert.match(CHAT, /pruneTaskFlags\(\(res\.data \|\| \[\]\)\.map\(c => c\?\.id\)\)/, "会话删除后徽标残项要跟着清");
assert.match(CHAT, /markTaskSeen\(convId\)/, "切进会话不清未读：徽标会永远挂着");
assert.match(CHAT, /if \(!loopOutcome\)[\s\S]{0,160}?noteTaskOutcome\(genConvId/, "循环没跑时发送链路要补记结局");
assert.match(CHAT, /noteTaskOutcome\(run\.genConvId, run\.exitStatus === "error"/, "结局要按 kernel 的 exitStatus 分档，别把中断报成完成");
assert.match(KERNEL, /run\.exitStatus = exitStatus/, "kernel 不再透出 exitStatus：侧栏就分不清异常退出与正常收尾");
// 排序选项在 JS 里造：写死在 HTML 的中文选项切到英文界面不会被翻译
assert.match(HTML, /<select id="conv-sort"[^>]*><\/select>/, "任务页签缺排序控件（或它带了写死的选项）");
assert.match(CHAT, /for \(const mode of SORT_MODES\)[\s\S]{0,200}?opt\.textContent = t\(mode\.label\)/, "排序选项必须逐条过 t()");
// Codex 栏得自带一份控件：只挂在经典栏的话，一直用 Codex 的人永远够不到这个设置
assert.match(APP, /sel\.id = "cx-conv-sort"/, "Codex 侧栏缺排序控件：同一份偏好在极简布局里没有入口");
assert.match(APP, /setTaskListSort\(sel\.value\)/, "Codex 排序控件必须写回同一份偏好，别在本地另起一套");
assert.match(APP, /subscribe\("taskListSort", \(mode\) => \{ sel\.value = normalizeTaskListSort\(mode\); \}\)/, "经典栏改了排序，Codex 的控件不回显就是假控件");
// 四态各有色调，且全部走变量；缺一个选择器就有一个状态画成灰的
for (const status of ["running", "needs", "error", "unread"]) {
  assert.match(CSS, new RegExp(`\\.conv-item-status\\[data-status="${status}"\\]`), `CSS 缺 ${status} 的色调`);
}
assert.match(CSS, /--task-needs: #9A5B12;/, "浅色主题的「需要操作」色");
assert.match(CSS, /\[data-theme="dark"\][\s\S]*?--task-needs: #E0A94A;/, "深色主题的「需要操作」要更亮，黑金底上才醒目");
assert.match(CSS, /\.conv-item-status\[data-status="running"\][\s\S]{0,120}?animation: conv-status-pulse/, "进行中要有呼吸，静止的图标读不出「在跑」");
assert.match(CSS, /@keyframes conv-status-pulse[\s\S]*?@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.conv-item-status\[data-status="running"\] \{ animation: none; \}/, "减弱动效偏好下必须停掉呼吸动画");
for (const [needle, why] of [[".conv-item.is-unread .conv-item-title", "未读没有标题加重"], [".codex-hist-item.is-unread", "Codex 未读没有标题加重"], [".codex-hist-dot.conv-item-status", "Codex 的状态点没有从装饰点放大成徽标"]]) {
  assert.ok(CSS.includes(needle), `CSS ${why}`);
}

// 词条不许只写键不写译文（t() 未命中会原样返回中文，英文界面就露馅）
for (const { label } of BADGES) assert.ok(EN_DICT[label] && EN_DICT[label] !== label);
for (const mode of tl.SORT_MODES) assert.ok(EN_DICT[mode.label], `排序档位「${mode.label}」缺英文词条`);
assert.ok(EN_DICT["任务列表排序"], "排序控件的 aria 标题缺英文词条");

// ── 右栏 TODOLIST 的开合：一份状态、两处入口、折叠不许被系统擅自撑回 ──
// 折叠的是"这一栏占不占我的屏幕"，所以它既不能同步到手机（那边根本不长这样），
// 也不能只在有清单时才可点——那等于没有随时一说。
assert.match(HTML, /<button id="btn-todo-panel" class="icon-btn"[^>]*aria-pressed=/,
  "顶栏缺右栏开关（或它没带 aria-pressed，读屏器不知道现在是展开还是收起）");
assert.match(STORE, /todoPanelOpen: state\.todoPanelOpen !== false,/,
  "开合偏好没进本机持久化：折叠一次，刷新就又弹回来");
assert.match(STORE, /state\.todoPanelOpen = data\.todoPanelOpen !== false;/,
  "本机装载要认这个键（老状态文件里没有它 = 默认展开）");
assert.ok(!/todoPanelOpen/.test(/function getSharedPersistentData[\s\S]*?\n\}/.exec(STORE)[0]),
  "右栏开合是本机的事，不该被同步进手机遥控那份状态");
assert.match(CHAT, /setTodoPanelOpen\(state\.todoPanelOpen === false\)/,
  "顶栏开关没写回 store：栏里栏外各记一套，折叠撑不过切会话");
assert.match(CHAT, /items\.length \|\| state\.todoPanelOpen === false/,
  "折叠了照样渲染右栏：整栏还占着 280px，折叠就是假的");
assert.match(CHAT, /subscribe\("todoPanelOpen"/,
  "另一处入口改了开合而这一处不重绘：顶栏金着、Codex 那侧却显示收起");
// 经典布局的 panel-header 在 Codex 下是 display:none，只挂顶栏的控件对 Codex 用户等于不存在
assert.match(APP, /\{ key: "todo", label: "任务清单", source: "btn-todo-panel" \}/,
  "Codex 快捷行没挂右栏开关：极简布局里这个偏好根本没有入口");
assert.match(CHAT, /data-cx-key="todo"/,
  "开关没同时回显 Codex 快捷行那一份：两处显示两种开合状态就是在骗人");
// 收合靠切 hidden 类：桌面 style.css 没有全局 .hidden 工具类（那是 mobile.css 的）
assert.match(CSS, /\.todo-panel\.hidden\s*\{[^}]*display:\s*none/,
  "右栏靠 hidden 收合，桌面 CSS 必须有对应隐藏规则，否则类在切、像素不动");
assert.match(CSS, /\.icon-btn\.is-na[\s\S]{0,200}?\.cx-quick-item\.is-na/,
  "没有清单时开关的置灰态没样式：按钮看着仍可点，点了却什么都不发生");
for (const key of ["折叠任务清单", "展开任务清单 {done}/{total}", "这一场还没有任务清单"]) {
  assert.ok(EN_DICT[key] && EN_DICT[key] !== key, `右栏开关缺英文词条：${key}`);
}
// 收起之后清单彻底看不见，进度只能靠这颗按钮的悬浮说明报一句
assert.match(CHAT, /t\("展开任务清单 \{done\}\/\{total\}", \{ done, total: count \}\)/,
  "折叠态的开关没报进度：收起来就等于和这场任务清单失联");

console.log("侧栏任务列表：四态判定、五种排序、分组、清洗与跨文件契约全等：通过");
