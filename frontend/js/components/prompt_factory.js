/**
 * SLATE 提示词工厂：生成、预览、编辑、导出
 */

import { state, subscribe } from "../store.js?v=20260730-13";
import { get } from "../services/api.js?v=20260730-13";

let factoryTask, factoryContext, factoryConstraints;
let btnGenerate, promptOutput, promptResult, btnCopy;
let constitutionDisplay;

// ── 宪法展示 ─────────────────────────────────

function renderConstitution() {
  if (!state.constitution || !constitutionDisplay) return;
  const rules = state.constitution.rules || [];
  if (rules.length === 0) {
    constitutionDisplay.textContent = "暂无宪法，请在设置中配置。";
    return;
  }
  constitutionDisplay.innerHTML = rules
    .map((r, i) => `<div>${i + 1}. ${r}</div>`)
    .join("");
}

// ── 提示词生成 ───────────────────────────────

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

function generatePrompt() {
  const task = factoryTask.value.trim();
  if (!task) {
    showToast("请输入任务描述");
    return;
  }

  const context = factoryContext.value.trim();
  const constraints = factoryConstraints.value.trim();
  const constitution = state.constitution;

  // 组装提示词
  const parts = [];

  // 1. 项目宪法摘要
  if (constitution && constitution.rules && constitution.rules.length > 0) {
    parts.push("【项目宪法】");
    constitution.rules.forEach((rule, i) => {
      parts.push(`  ${i + 1}. ${rule}`);
    });
    parts.push("");
  }

  // 2. 相关文件上下文
  if (context) {
    parts.push("【相关文件上下文】");
    context.split("\n").forEach(line => {
      parts.push(`  ${line}`);
    });
    parts.push("");
  }

  // 3. 任务描述
  parts.push("【任务描述】");
  task.split("\n").forEach(line => {
    parts.push(`  ${line}`);
  });
  parts.push("");

  // 4. 约束条件
  if (constraints) {
    parts.push("【约束条件】");
    constraints.split("\n").forEach(line => {
      parts.push(`  ${line}`);
    });
    parts.push("");
  }

  // 5. 交付物要求
  parts.push("【交付物要求】");
  parts.push("  请输出完整的代码文件（包含必要的注释），不要省略任何部分。");
  parts.push("  如需修改现有文件，请标注文件路径和修改位置。");

  const output = parts.join("\n");

  promptResult.textContent = output;
  promptOutput.classList.remove("hidden");
}

// ── 复制 ─────────────────────────────────────

async function copyPrompt() {
  const text = promptResult.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btnCopy.textContent = "✓";
    setTimeout(() => { btnCopy.textContent = "⧉"; }, 1500);
  } catch (e) {
    // fallback
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    btnCopy.textContent = "✓";
    setTimeout(() => { btnCopy.textContent = "⧉"; }, 1500);
  }
}

// ── 初始化 ───────────────────────────────────

function initPromptFactory() {
  factoryTask = document.getElementById("factory-task");
  factoryContext = document.getElementById("factory-context");
  factoryConstraints = document.getElementById("factory-constraints");
  btnGenerate = document.getElementById("btn-generate-prompt");
  promptOutput = document.getElementById("prompt-output");
  promptResult = document.getElementById("prompt-result");
  btnCopy = document.getElementById("btn-copy-prompt");
  constitutionDisplay = document.getElementById("constitution-display");

  btnGenerate.addEventListener("click", generatePrompt);
  btnCopy.addEventListener("click", copyPrompt);

  // 加载宪法
  loadConstitution();

  subscribe("constitution", renderConstitution);
}

async function loadConstitution() {
  const res = await get("/constitution");
  if (res.code === 0 && res.data) {
    state.constitution = res.data;
    renderConstitution();
  }
}

export { initPromptFactory, generatePrompt };
