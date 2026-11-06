/**
 * 组件标：11 个有身份的面板各一枚，共用一套笔画纪律而不是共用一个图形。
 *
 * 纪律（改动前先读）：24 栅格、1.6 线宽、圆头圆角、无填充面、实心点每标最多一处、
 * 没有字母/脸/渐变/外框徽标。颜色一律 currentColor —— 明暗主题与自定义配色都只换
 * 颜色，不换图。尺寸由 CSS 决定（.cmp-mark），这里不写 px。
 *
 * 用法：HTML 里给容器挂 data-cmp-mark="chat"，初始化时调 decorateComponentMarks()
 * 在容器开头插入 <svg>。挂点不写死 svg，是为了全站只有这一份 path 数据。
 *
 * 例外：MCP Server 用官方 Logo（LobeHub 图标集，MIT，原件见 frontend/images/mcp/mcp.svg），
 * 它是填充图形，不能按上面的描边纪律重画。图形直接引用 mcp_icons.js 的生成结果，
 * 这里只发外壳；另抄一份 path 会分家。
 */
import { MCP_ICONS } from "./mcp_icons.js?v=20261106-002";

export const COMPONENT_MARKS = Object.freeze({
  chat: '<path d="M6 3.5 H15 L19 7.5 V15.5 A2 2 0 0 1 17 17.5 H11.5 V21.5 L8 17.5 H6 A2 2 0 0 1 4 15.5 V5.5 A2 2 0 0 1 6 3.5 Z"/><path d="M8 10.4 H15.2"/>',
  board: '<rect x="4" y="4.5" width="16" height="11" rx="2"/><path d="M7.8 9.6 H14.8"/><path d="M4 18.4 H20"/>',
  ext: '<path d="M9.5 7 V11.2 M14.5 7 V11.2"/><rect x="6.5" y="11.2" width="11" height="6.6" rx="1.8"/><path d="M12 17.8 V21"/>',
  settings: '<path d="M4 8.5 H7.2 M11.8 8.5 H20"/><circle cx="9.5" cy="8.5" r="2.3"/><path d="M4 15.5 H12.7 M17.3 15.5 H20"/><circle cx="15" cy="15.5" r="2.3"/>',
  skills: '<path d="M6 3.5 H14.5 L19.5 8.5 V18.5 A2 2 0 0 1 17.5 20.5 H6 A2 2 0 0 1 4 18.5 V5.5 A2 2 0 0 1 6 3.5 Z"/><path d="M14.5 3.5 V8.5 H19.5"/><path d="M7.5 12.4 H16 M7.5 15.7 H12.4"/>',
  tools: '<path d="M4.5 19.2 L12.9 11.1"/><path d="M19.89 7.99 A4.1 4.1 0 1 1 16.01 4.11"/>',
  modes: '<path d="M7.5 4 H18.5 A2 2 0 0 1 20.5 6 V16.5"/><rect x="3.5" y="7.5" width="15" height="12.5" rx="2"/>',
  evolved: '<path d="M12 3.5 L13.4 10.6 L20.5 12 L13.4 13.4 L12 20.5 L10.6 13.4 L3.5 12 L10.6 10.6 Z"/>',
  experts: '<path d="M12 4.5 L18.5 8.25 V15.75 L12 19.5 L5.5 15.75 V8.25 Z"/><path d="M9.2 12.2 L11.3 14.3 L15 10.6"/>',
  actions: '<circle cx="6.5" cy="6.5" r="2.2"/><circle cx="17.5" cy="6.5" r="2.2"/><circle cx="12" cy="17.8" r="2.2"/><path d="M8.7 6.5 H15.3"/><path d="M6.5 8.7 V12 H12 V15.6"/><path d="M17.5 8.7 V12 H12"/>',
});

/** 品牌标用填充外壳；几何体仍只有 mcp_icons.js 一份（LobeHub 图标集，MIT）。 */
const BRAND_MARKS = Object.freeze({
  mcp: MCP_ICONS.mcp,
});

export function componentMarkHTML(name) {
  const brand = BRAND_MARKS[name];
  if (brand) {
    return (
      '<svg class="cmp-mark cmp-mark--brand" viewBox="0 0 24 24" fill="currentColor"'
      + ' fill-rule="evenodd" aria-hidden="true" focusable="false">' + brand + "</svg>"
    );
  }
  const body = COMPONENT_MARKS[name];
  if (!body) return "";
  return (
    '<svg class="cmp-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true" focusable="false">' + body + "</svg>"
  );
}

/** 幂等：同一容器重复调用不会再插一枚。root 可以是 document 或某个刚重绘的容器。 */
export function decorateComponentMarks(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const el of root.querySelectorAll("[data-cmp-mark]")) {
    if (el.querySelector(":scope > .cmp-mark")) continue;
    const html = componentMarkHTML(el.dataset.cmpMark);
    if (!html) continue;
    el.insertAdjacentHTML("afterbegin", html);
  }
}
