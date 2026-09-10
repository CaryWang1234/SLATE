/**
 * 会话总结栏（左栏第三页签）：把当前会话用到的工具、SKILL.md 技能、远程 MCP、
 * 改动过的文件、访问过的网页投影成一份可滚动的清单。
 *
 * 数据源只认 state.messages 上的 toolResults：事件账本按 run 活在内存里，后端又只有写入口，
 * 刷新或切会话就拿不回来；toolResults 随消息落库，是唯一能重载后复原的事实源。
 * 历史恢复出来的卡片（result.historical）不是本次会话真实发生的调用，一律跳过。
 */

import { state, subscribe } from "../store.js?v=20260910-004";
import { t } from "../services/i18n.js?v=20260910-004";
import { toolLabel } from "../services/tool_meta.js?v=20260910-004";

const FILE_WRITE_OPS = ["file_edit", "file_create", "file_append"];
const FILE_READ_ACTIONS = ["view", "read"];
// 名字不带 file_，但确实往磁盘产出文件的技能，一并计入「修改的文件」
const FILE_OUTPUT_SKILLS = new Set([
  "ppt_create", "word_create", "excel_tool", "html_bundle", "chart_create",
  "qrcode_create", "python_api_extract", "mcp_factory", "image_gen", "video_gen",
]);
const RENAME_MAX = 48;

const GROUPS = [
  { key: "tools", title: () => t("工具") },
  { key: "skills", title: () => t("技能") },
  { key: "mcp", title: () => t("MCP 工具") },
  { key: "files", title: () => t("修改的文件") },
  { key: "web", title: () => t("访问的网页") },
];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clip(text, max = RENAME_MAX) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function isHttp(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

/** skill_run 包一层：真正的调用对象是 params.skill + params.params */
function innerOf(call) {
  const params = call?.params || {};
  if (call?.name === "skill_run") {
    return { name: String(params.skill || ""), params: params.params || {} };
  }
  return { name: String(call?.name || ""), params };
}

/** 工具输出：内置技能走 skill_run 时是 JSON 字符串，能解析才拿来用 */
function parseOutput(result) {
  const out = result?.output;
  if (typeof out !== "string") return null;
  const s = out.trim();
  if (!s.startsWith("{")) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function filePathOf(name, params, result, out) {
  const st = result?._structured;
  const reading = !!params?.action && FILE_READ_ACTIONS.includes(params.action);
  if (!reading) {
    if (st && FILE_WRITE_OPS.includes(st._type)) {
      return String(st.file_path_rel || st.file || st.file_path || params.file_path || params.path || params.relative_path || "");
    }
    if (FILE_WRITE_OPS.includes(name)) {
      return String(params.file_path || params.path || params.relative_path || "");
    }
  }
  if (FILE_OUTPUT_SKILLS.has(name)) return String(out?.file_path || "");
  return "";
}

function webUrlsOf(name, params, out) {
  if (name === "web_fetch") return [out?.url || params?.url];
  if (name === "web_search") return params?.mode === "fetch" ? [params.query] : [];
  if (name === "browser_automation") return [params?.url];
  return [];
}

/** 项目内路径收敛成相对路径，长路径只剩文件名可读 */
function displayPath(raw) {
  const s = String(raw || "").trim().replace(/\\/g, "/");
  const proj = String(state.project?.path || "").replace(/\\/g, "/");
  if (proj && s.toLowerCase().startsWith(proj.toLowerCase())) {
    const rel = s.slice(proj.length).replace(/^\/+/, "");
    if (rel) return rel;
  }
  return s;
}

function groupKeyFor(name) {
  if (name.startsWith("mcp__")) return "mcp";
  if (state.skills?.skills && name in state.skills.skills) return "skills";
  return "tools";
}

function collect() {
  const buckets = { tools: new Map(), skills: new Map(), mcp: new Map(), files: new Map(), web: new Map() };

  const add = (kind, key, build, touch) => {
    if (!key) return;
    const cur = buckets[kind].get(key);
    if (cur) { cur.count += 1; if (touch) touch(cur); return; }
    const item = build(key);
    if (item) buckets[kind].set(key, item);
  };

  for (const msg of state.messages || []) {
    const rows = Array.isArray(msg?.toolResults) ? msg.toolResults
      : Array.isArray(msg?.metadata?.toolResults) ? msg.metadata.toolResults : [];
    for (const row of rows) {
      const call = row?.call, result = row?.result;
      if (!call || result?.historical) continue;
      const { name, params } = innerOf(call);
      if (!name) continue;
      const failed = result?.success === false;
      const out = parseOutput(result);

      add(groupKeyFor(name), name, (key) => {
        if (key.startsWith("mcp__")) {
          const parts = key.split("__");
          const label = clip(parts[parts.length - 1] || key, 28);
          const server = clip(parts[1] || "mcp", 24);
          return { label, detail: server === label ? "" : server, title: key, count: 1, failed };
        }
        return { label: toolLabel(key, { skill: key }) || key, detail: "", title: key, count: 1, failed };
      }, (cur) => { cur.failed = failed; });

      const path = filePathOf(name, params, result, out);
      if (path) {
        const rel = displayPath(path);
        const idx = rel.lastIndexOf("/");
        add("files", rel.toLowerCase(), (key) => ({
          label: idx >= 0 ? rel.slice(idx + 1) : rel,
          detail: idx > 0 ? rel.slice(0, idx) : "",
          title: rel, count: 1, failed,
        }), (cur) => { cur.failed = failed; });
      }

      for (const url of webUrlsOf(name, params, out)) {
        if (!isHttp(url)) continue;
        let host = "", path = "";
        try {
          const u = new URL(url); host = u.hostname; path = (u.pathname + u.search).replace(/\/$/, "");
        } catch (e) { continue; }
        add("web", url, () => ({
          label: clip(host, 28), detail: clip(path, 40), title: url, count: 1, failed,
        }), (cur) => { cur.failed = failed; });
      }
    }
  }
  return buckets;
}

function rowOf(item) {
  const row = el("div", "ss-item" + (item.failed ? " is-failed" : ""));
  row.title = item.title || item.label;
  row.append(el("span", "ss-dot"));
  const main = el("span", "ss-item-main");
  main.append(el("span", "ss-item-name", item.label));
  if (item.detail) main.append(el("span", "ss-item-detail", item.detail));
  row.append(main);
  if (item.count > 1) row.append(el("span", "ss-item-count", `×${item.count}`));
  return row;
}

let root = null;
let timer = 0;
let pending = false;

/** 页签未激活、边栏收起或 Codex 模式整栏隐藏时，offsetParent 为 null */
function isShown() {
  return !!root && root.offsetParent !== null;
}

export function renderSessionSummary() {
  if (!root) return;
  const buckets = collect();
  root.textContent = "";
  const used = GROUPS.reduce((sum, g) => sum + buckets[g.key].size, 0);
  if (!used) {
    root.append(el("div", "ss-empty", t("本次会话还没有工具调用")));
    return;
  }
  for (const g of GROUPS) {
    const items = buckets[g.key];
    if (!items.size) continue;
    const sec = el("div", "ss-group");
    const head = el("div", "ss-group-header");
    head.append(el("span", "ss-group-title", g.title()));
    head.append(el("span", "ss-group-count", String(items.size)));
    sec.append(head);
    for (const item of items.values()) sec.append(rowOf(item));
    root.append(sec);
  }
}

function scheduleRender() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = 0;
    if (isShown()) renderSessionSummary();
    else pending = true;
  }, 200);
}

export function initSessionSummary() {
  root = document.getElementById("session-summary");
  if (!root) return;
  // 流式输出每块都会 notify("messages")，必须防抖，否则边说边重排整栏
  subscribe("messages", scheduleRender);
  subscribe("skills", scheduleRender);
  subscribe("project", scheduleRender);
  window.addEventListener("slate:left-pane", () => {
    if (pending && isShown()) { pending = false; renderSessionSummary(); }
  });
  renderSessionSummary();
}
