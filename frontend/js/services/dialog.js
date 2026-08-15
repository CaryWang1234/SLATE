/**
 * 应用内对话框服务：统一替代浏览器原生 alert / confirm / prompt
 * （webview 中原生弹窗阻塞线程、样式割裂，全部改为应用内模态）
 *
 * - dlgAlert(message, opts)   -> Promise<void>     单按钮提示
 * - dlgConfirm(message, opts) -> Promise<boolean>  确认框（danger 时确认按钮为红色）
 * - dlgPrompt(message, opts)  -> Promise<string|null>  输入框（取消返回 null，确认返回字符串）
 * - dlgToast(message, duration) 轻量通知，复用页面 #toast-container
 *
 * opts: { title, okText, cancelText, danger, value, placeholder, textarea, rows, options }
 *       options: [{value,label}] 传入时渲染下拉选择（替代手敲枚举值）
 */

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
