/**
 * 应用内对话框服务：统一替代浏览器原生 alert / confirm / prompt
 * （webview 中原生弹窗阻塞线程、样式割裂，全部改为应用内模态）
 *
 * - dlgAlert(message, opts)   -> Promise<void>     单按钮提示
 * - dlgConfirm(message, opts) -> Promise<boolean>  确认框（danger 时确认按钮为红色）
 * - dlgPrompt(message, opts)  -> Promise<string|null>  输入框（取消返回 null，确认返回字符串）
 * - dlgToast(message, duration) 轻量通知，复用页面 #toast-container
 * - dlgUserAsk(question, options) -> Promise<string|null>  模型主动弹窗询问（选择题 chips + 自由输入）
 *
 * opts: { title, okText, cancelText, danger, value, placeholder, textarea, rows, options }
 *       options: [{value,label}] 传入时渲染下拉选择（替代手敲枚举值）
 */

import { t } from "./i18n.js?v=20260907-002";

// 对话框需要盖在已有模态（卡片编辑、技能执行等，z-index:1000）之上
let zTop = 2000;

/** 构建模态外壳：复用 .modal 样式体系，返回各部件引用 */
function buildShell(title) {
  const root = document.createElement("div");
  root.className = "modal dlg-modal";
  root.style.zIndex = (zTop += 10);

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const content = document.createElement("div");
  content.className = "modal-content";

  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("span");
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close icon-btn";
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "modal-body";

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  content.appendChild(header);
  content.appendChild(body);
  content.appendChild(footer);
  root.appendChild(backdrop);
  root.appendChild(content);
  document.body.appendChild(root);
  return { root, backdrop, closeBtn, body, footer };
}

function makeBtn(text, cls) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  return b;
}

/**
 * 通用对话框。finish(value) 结束并 resolve；cancelValue 为取消语义的返回值。
 * 支持 ESC / 背景点击 / × 取消，Enter 确认（textarea 为 Enter 不带 Shift）。
 */
function openDialog({ title, message, okText = "确定", cancelText = "取消", danger = false, withCancel = false, cancelValue = null, buildBody = null }) {
  return new Promise((resolve) => {
    const { root, backdrop, closeBtn, body, footer } = buildShell(title);
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(value);
    };

    if (message) {
      const msg = document.createElement("div");
      msg.className = "dlg-message";
      msg.textContent = message;
      body.appendChild(msg);
    }
    const inputEl = buildBody ? buildBody(body) : null;

    if (withCancel) {
      const cancelBtn = makeBtn(cancelText, "dlg-btn");
      cancelBtn.addEventListener("click", () => finish(cancelValue));
      footer.appendChild(cancelBtn);
    }
    const okBtn = makeBtn(okText, danger ? "dlg-btn dlg-btn-danger" : "dlg-btn dlg-btn-primary");
    okBtn.addEventListener("click", () => finish(inputEl ? inputEl.value : true));
    footer.appendChild(okBtn);

    backdrop.addEventListener("click", () => finish(withCancel ? cancelValue : (inputEl ? inputEl.value : true)));
    closeBtn.addEventListener("click", () => finish(withCancel ? cancelValue : (inputEl ? inputEl.value : true)));

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(withCancel ? cancelValue : (inputEl ? inputEl.value : true));
      } else if (e.key === "Enter" && inputEl) {
        if (inputEl.tagName === "TEXTAREA" && e.shiftKey) return; // textarea 允许 Shift+Enter 换行
        e.preventDefault();
        finish(inputEl.value);
      }
    };
    document.addEventListener("keydown", onKey, true);

    (inputEl || okBtn).focus();
    if (inputEl && inputEl.select) inputEl.select();
  });
}

/** 提示框（替代 alert）：仅需知晓，单按钮关闭 */
export function dlgAlert(message, opts = {}) {
  return openDialog({
    title: opts.title || "提示",
    message,
    okText: opts.okText || "知道了",
  });
}

/** 确认框（替代 confirm）：返回是否确认；danger 用于删除等不可逆操作 */
export function dlgConfirm(message, opts = {}) {
  return openDialog({
    title: opts.title || "请确认",
    message,
    okText: opts.okText || "确定",
    cancelText: opts.cancelText || "取消",
    danger: !!opts.danger,
    withCancel: true,
    cancelValue: false,
  });
}

/** 输入框（替代 prompt）：取消返回 null；opts.textarea 时多行输入 */
export function dlgPrompt(message, opts = {}) {
  return openDialog({
    title: opts.title || "请输入",
    message,
    okText: opts.okText || "确定",
    cancelText: opts.cancelText || "取消",
    withCancel: true,
    cancelValue: null,
    buildBody: (body) => {
      let input;
      if (opts.options) {
        input = document.createElement("select");
        input.className = "dlg-input";
        for (const o of opts.options) {
          const op = document.createElement("option");
          op.value = o.value;
          op.textContent = o.label;
          if (o.value === opts.value) op.selected = true;
          input.appendChild(op);
        }
      } else if (opts.textarea) {
        input = document.createElement("textarea");
        input.className = "dlg-textarea";
        input.rows = opts.rows || 5;
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.className = "dlg-input";
      }
      input.value = opts.value || "";
      if (opts.placeholder && input.placeholder !== undefined && input.tagName !== "SELECT") input.placeholder = opts.placeholder;
      body.appendChild(input);
      return input;
    },
  });
}

/** 需求输入框（user_ask 工具）：模型主动弹窗询问关键条件。
 * question 为问题文本；options 为选择题选项数组（可选），
 * 点选选项（单选）自动填入输入框，也可直接输入自定义答案。
 * 确定返回输入框文本，取消/ESC/×/背景点击返回 null。 */
export function dlgUserAsk(question, options) {
  return new Promise((resolve) => {
    const { root, backdrop, closeBtn, body, footer } = buildShell(t("模型需要补充条件"));
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(value);
    };

    const msg = document.createElement("div");
    msg.className = "dlg-message";
    msg.textContent = String(question || "").trim() || "请补充所需条件";
    body.appendChild(msg);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dlg-input";
    input.placeholder = t("或自定义输入");

    const optList = Array.isArray(options)
      ? options.map(o => String(o || "").trim()).filter(Boolean).slice(0, 6)
      : [];

    if (optList.length > 0) {
      const row = document.createElement("div");
      row.className = "dlg-options-row";
      const pick = (value) => {
        for (const b of row.querySelectorAll(".dlg-option-btn")) {
          b.classList.toggle("active", b.dataset.value === value);
        }
        input.value = value;
        input.focus();
      };
      for (const opt of optList) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "review-mode-btn dlg-option-btn";
        btn.textContent = opt;
        btn.dataset.value = opt;
        btn.addEventListener("click", () => pick(opt));
        row.appendChild(btn);
      }
      body.appendChild(row);
      const hint = document.createElement("div");
      hint.className = "dlg-options-hint";
      hint.textContent = t("或自定义输入");
      body.appendChild(hint);
    }

    // 手动输入时清除选中态（自定义输入优先）
    input.addEventListener("input", () => {
      for (const b of body.querySelectorAll(".dlg-option-btn.active")) b.classList.remove("active");
    });

    body.appendChild(input);

    const cancelBtn = makeBtn(t("取消"), "dlg-btn");
    cancelBtn.addEventListener("click", () => finish(null));
    footer.appendChild(cancelBtn);

    const okBtn = makeBtn(t("确定"), "dlg-btn dlg-btn-primary");
    okBtn.addEventListener("click", () => finish(input.value.trim()));
    footer.appendChild(okBtn);

    backdrop.addEventListener("click", () => finish(null));
    closeBtn.addEventListener("click", () => finish(null));

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim());
      }
    };
    document.addEventListener("keydown", onKey, true);

    input.focus();
  });
}

/** 轻量通知：复用 index.html 的 #toast-container 与 .toast 样式 */
export function dlgToast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}
