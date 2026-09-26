/**
 * 输入框左下的审批模式选择器：三档在**这一场对话**里随时可改。
 * 判口（哪一档该问什么）只有一个，在 services/riskguard.approvalNeededFor；
 * 这里只管"屏幕上现在生效的是哪一档"和"改这一场的档"，两边不各存一份判断。
 */

import { state, subscribe, permissionModeFor, setPermissionModeFor } from "../store.js?v=20260925-011";
import { iconSvgEl } from "../services/icons.js?v=20260925-011";
import { t } from "../services/i18n.js?v=20260925-011";

const MODES = [
  { id: "ask", icon: "shield", label: "手动审批", hint: "执行命令、访问网络都先问你" },
  { id: "auto", icon: "zap", label: "自动审批", hint: "只在命中高危规则时问你，其余直接放行" },
  { id: "full", icon: "unlock", label: "完全访问", hint: "不询问（灾难级命令仍由后端拦截）", danger: true },
];

let popOpen = false;
let rowsBuilt = false;

function modeOf(id) {
  return MODES.find(m => m.id === id) || MODES[0];
}

function setPop(open) {
  const pop = document.getElementById("approval-pop");
  const btn = document.getElementById("btn-approval");
  if (!pop || !btn) return;
  popOpen = Boolean(open);
  pop.classList.toggle("hidden", !popOpen);
  btn.setAttribute("aria-expanded", popOpen ? "true" : "false");
  syncActiveRow();
}

function syncActiveRow() {
  const active = permissionModeFor(state.currentConversationId);
  for (const row of document.querySelectorAll("#approval-pop .approval-opt")) {
    row.classList.toggle("is-on", row.dataset.mode === active);
    row.setAttribute("aria-checked", row.dataset.mode === active ? "true" : "false");
  }
  const scope = document.getElementById("approval-pop-scope");
  if (scope) {
    scope.textContent = state.currentConversationId
      ? t("只改这一场")
      : t("还没建会话：这一场的选择会带给它");
  }
}

function buildRows() {
  const pop = document.getElementById("approval-pop");
  if (!pop || rowsBuilt) return;
  pop.textContent = "";
  const head = document.createElement("div");
  head.className = "approval-pop-head";
  const title = document.createElement("strong");
  title.textContent = t("审批模式");
  const scope = document.createElement("span");
  scope.className = "approval-pop-scope";
  scope.id = "approval-pop-scope";
  head.append(title, scope);
  pop.appendChild(head);

  for (const m of MODES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `approval-opt${m.danger ? " is-full" : ""}`;
    row.dataset.mode = m.id;
    row.setAttribute("role", "menuitemradio");
    const ico = document.createElement("span");
    ico.className = "approval-opt-icon";
    ico.appendChild(iconSvgEl(m.icon));
    const wrap = document.createElement("span");
    wrap.className = "approval-opt-body";
    const name = document.createElement("b");
    name.textContent = t(m.label);
    const hint = document.createElement("span");
    hint.className = "approval-opt-hint";
    hint.textContent = t(m.hint);
    wrap.append(name, hint);
    row.append(ico, wrap);
    row.addEventListener("click", () => {
      setPermissionModeFor(state.currentConversationId, m.id);
      setPop(false);
    });
    pop.appendChild(row);
  }
  rowsBuilt = true;
}

function syncApprovalPicker() {
  const btn = document.getElementById("btn-approval");
  const label = document.getElementById("approval-pill-label");
  const iconWrap = document.getElementById("approval-pill-icon");
  if (!btn || !label || !iconWrap) return;
  buildRows();
  const mode = modeOf(permissionModeFor(state.currentConversationId));
  label.textContent = t(mode.label);
  if (iconWrap.dataset.icon !== mode.icon) {
    iconWrap.dataset.icon = mode.icon;
    iconWrap.textContent = "";
    iconWrap.appendChild(iconSvgEl(mode.icon));
  }
  // 完全访问：图标和文字一起标红（图标是 currentColor，红在容器上）
  btn.classList.toggle("is-full", mode.id === "full");
  btn.title = t("{mode}：{hint}", { mode: t(mode.label), hint: t(mode.hint) });
  syncActiveRow();
}

function initApprovalPicker() {
  const btn = document.getElementById("btn-approval");
  if (!btn) return;
  buildRows();
  btn.addEventListener("click", () => setPop(!popOpen));
  document.addEventListener("pointerdown", (e) => {
    if (popOpen && !e.target?.closest?.("#approval-picker")) setPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popOpen) {
      setPop(false);
      btn.focus();
    }
  });
  // 设置页改默认档、另一台设备同步下来时，胶囊上那一档可能跟着变
  subscribe("permissionMode", syncApprovalPicker);
  syncApprovalPicker();
}

export { initApprovalPicker, syncApprovalPicker };
