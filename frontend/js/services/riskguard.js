/**
 * SLATE 终端高危命令守卫
 * - 高危判定为写死规则（与后端 backend/skills/terminal.py 同一份清单）
 * - 命中后弹出审批框，并调用当前模型解释命令目的
 * - 用户批准后注入 approved 参数放行；拒绝后返回拒绝结果给模型
 */

import { state, getModelKey } from "../store.js?v=20260907-002";
import { post } from "./api.js?v=20260907-002";
import { t } from "./i18n.js?v=20260907-002";

// 高危命令规则（写死）：命中任一条即要求批准
const HIGH_RISK_PATTERNS = [
  { re: /\brm\b/i, reason: "删除文件（rm）" },
  { re: /\b(rmdir|shred|unlink)\b/i, reason: "删除文件/目录" },
  { re: /\b(del|erase)\b\s/i, reason: "删除文件（del/erase）" },
  { re: /\brd\b\s/i, reason: "删除目录（rd）" },
  { re: /Remove-Item/i, reason: "删除文件（Remove-Item）" },
  { re: /\bdd\b(?=.*\bof=)/i, reason: "磁盘写入（dd）" },
  { re: /\b(fdisk|diskpart|parted)\b/i, reason: "磁盘分区操作" },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "关机/重启" },
  { re: /\binit\s+[06]\b/, reason: "关机/重启" },
  { re: /\bsudo\b/i, reason: "提权执行（sudo）" },
  { re: /\b(taskkill|killall)\b/i, reason: "强制结束进程" },
  { re: /\bkill\s+-9\b/i, reason: "强制结束进程（kill -9）" },
  { re: /reg\s+(delete|add)\b/i, reason: "修改注册表" },
  { re: /\bsc\s+(delete|stop)\b/i, reason: "管理系统服务" },
  { re: /\bnet\s+user\b/i, reason: "修改用户账户" },
  { re: /\b(takeown|icacls)\b/i, reason: "修改文件所有权/权限" },
  { re: /\bchmod\s+(-R\s+)?777\b/i, reason: "开放全部权限（chmod 777）" },
  { re: /git\s+push\s+[^;]*(--force\b|-f\b|--force-with-lease)/i, reason: "Git 强制推送" },
  { re: /git\s+reset\s+--hard/i, reason: "Git 硬重置（丢弃改动）" },
  { re: /git\s+clean\s+-[a-z]*f/i, reason: "Git 清理未跟踪文件" },
  { re: /git\s+branch\s+-D\b/i, reason: "Git 强制删除分支" },
  { re: /(drop\s+(database|table|schema)|truncate\s+table)/i, reason: "数据库删除删库" },
  { re: /(npm|pnpm|yarn)\s+(uninstall|remove)\s+(-g|--global)/i, reason: "卸载全局依赖" },
];

// 从网络下载并直接交给 shell 执行（整条命令级别判定）
const PIPE_TO_SHELL = /(curl|wget|invoke-webrequest|iwr)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh|Invoke-Expression|\biex\b/i;

/**
 * 判断命令是否高危：返回 { risk, reason }
 */
function isHighRiskCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { risk: false, reason: "" };
  if (PIPE_TO_SHELL.test(cmd)) return { risk: true, reason: "从网络下载并直接执行脚本" };
  // 拆分命令链（&&、||、;、|），逐段检测
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const s = seg.trim();
    if (!s) continue;
    for (const { re, reason } of HIGH_RISK_PATTERNS) {
      if (re.test(s)) return { risk: true, reason };
    }
  }
  return { risk: false, reason: "" };
}

/**
 * 用当前模型解释命令目的（失败时返回兜底文案）
 */
async function explainCommand(command) {
  const modelId = state.currentModel?.id;
  const apiKey = modelId ? getModelKey(modelId) : "";
  if (!modelId || !apiKey) return "（当前未配置模型 API Key，无法生成目的说明）";
  try {
    const res = await post("/proxy/chat", {
      model: modelId,
      api_key: apiKey,
      stream: false,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: "system", content: "你是终端命令安全分析器。用一两句话客观解释该命令的目的与潜在影响，不超过60字，不要给出执行建议" },
        { role: "user", content: command },
      ],
    });
    const text = res?.data?.choices?.[0]?.message?.content?.trim();
    return text || t("（模型未返回说明）");
  } catch (e) {
    return t("（说明生成失败: {msg}）", { msg: e.message });
  }
}

// ── 审批弹窗（Promise 化） ───────────────────

let modal, cmdEl, reasonEl, explainEl;
let pendingResolve = null;

function settle(approved) {
  modal?.classList.add("hidden");
  const resolveFn = pendingResolve;
  pendingResolve = null;
  if (resolveFn) resolveFn(approved);
}

/**
 * 请求用户批准高危命令。返回 Promise<boolean>。
 * 弹窗展示命令、命中规则与模型生成的目的说明。
 */
function requestHighRiskApproval(command, reason) {
  if (!modal) return Promise.resolve(false);
  return new Promise((resolve) => {
    // 已有待决审批时直接拒绝，避免叠框
    if (pendingResolve) {
      resolve(false);
      return;
    }
    pendingResolve = resolve;
    cmdEl.textContent = command;
    reasonEl.textContent = t("触发规则：{reason}", { reason: t(reason) });
    explainEl.textContent = t("正在用模型分析命令目的…");
    modal.classList.remove("hidden");
    explainCommand(command).then(text => {
      if (pendingResolve === resolve) explainEl.textContent = text;
    });
  });
}

/**
 * 统一守卫入口：若为 terminal 且命令高危则按权限模式处理。
 * - 人工审批（ask，默认）：弹窗询问，批准后注入 approved 放行
 * - 自动审批（auto）：直接注入 approved 放行，不再弹窗
 * - 完全访问（full）：不做高危判定直接放行（灾难级命令仍由后端强制拦截）
 */
async function guardSkillParams(skill, params) {
  if (skill !== "terminal" || !params?.command) return true;
  if (state.permissionMode === "full") return true;
  const risk = isHighRiskCommand(params.command);
  if (!risk.risk) return true;
  if (state.permissionMode === "auto") {
    params.approved = true;
    return true;
  }
  const approved = await requestHighRiskApproval(params.command, risk.reason);
  if (approved) {
    params.approved = true;
    return true;
  }
  return false;
}

function initRiskGuard() {
  modal = document.getElementById("risk-modal");
  if (!modal) return;
  cmdEl = document.getElementById("risk-command");
  reasonEl = document.getElementById("risk-reason");
  explainEl = document.getElementById("risk-explain");

  document.getElementById("btn-risk-approve")?.addEventListener("click", () => settle(true));
  document.getElementById("btn-risk-reject")?.addEventListener("click", () => settle(false));
  modal.querySelector(".modal-close")?.addEventListener("click", () => settle(false));
  modal.querySelector(".modal-backdrop")?.addEventListener("click", () => settle(false));
}

export { isHighRiskCommand, requestHighRiskApproval, guardSkillParams, initRiskGuard };
