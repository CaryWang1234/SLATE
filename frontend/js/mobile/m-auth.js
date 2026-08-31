/**
 * SLATE Mobile — 审批与变更确认
 * 1. mGuardTerminal：移动端高危命令守卫（接管 tools.js 的 window.__slateGuardOverride）
 * 2. mHandleStructured：file_edit/file_create 的 diff 预览 → 接受/拒绝（file_append 调用时即写入）
 */

import { state, getModelKey } from "../store.js?v=20260901-001";
import { post } from "../services/api.js?v=20260901-001";
import { isHighRiskCommand } from "../services/riskguard.js?v=20260901-001";
import { mShowRiskSheet, mShowDiffSheet, mToast, t } from "./m-ui.js?v=20260901-001";

/** 用当前模型解释命令目的（与桌面 explainCommand 同一逻辑，失败返回兜底文案） */
async function mExplainCommand(command) {
  const modelId = state.currentModel?.id;
  const apiKey = modelId ? getModelKey(modelId) : "";
  if (!modelId || !apiKey) return t("（当前未配置模型 API Key，无法生成目的说明）");
  try {
    const res = await post("/proxy/chat", {
      model: modelId,
      api_key: apiKey,
      base_url: state.currentModel?.base_url || "",
      provider: state.currentModel?.provider || "",
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

/**
 * 高危命令守卫（与 riskguard.guardSkillParams 同逻辑，审批 UI 换成移动底部 sheet）
 * - full 直放 / auto 注入 approved / ask 弹 sheet
 */
export async function mGuardTerminal(skill, params) {
  if (skill !== "terminal" || !params?.command) return true;
  if (state.permissionMode === "full") return true;
  const risk = isHighRiskCommand(params.command);
  if (!risk.risk) return true;
  if (state.permissionMode === "auto") {
    params.approved = true;
    return true;
  }
  const explain = await mExplainCommand(params.command);
  const approved = await mShowRiskSheet({ command: params.command, reason: risk.reason, explain });
  if (approved) {
    params.approved = true;
    return true;
  }
  return false;
}

/**
 * 处理结构化工具结果（file_edit / file_create / file_append）。
 * applied === "auto" 或 file_append 已直接写入磁盘 → 直接返回 "applied"。
 * 否则弹 diff sheet：接受 → 调后端落盘；拒绝 → 仅标记不写盘。
 * 返回 "applied" | "accepted" | "rejected" | "skipped"
 */
export async function mHandleStructured(structured) {
  if (!structured || !structured._type) return "skipped";
  const type = structured._type;
  if (!["file_edit", "file_create", "file_append"].includes(type)) return "skipped";
  if (structured.applied === "auto" || structured.applied === true) return "applied";

  const path = structured.file_path_rel || structured.file_name || structured.file || "";
  const diff = structured.diff || "";
  if (!diff && structured.errors?.length) {
    mToast(structured.errors[0], 3500);
    return "rejected";
  }

  const decision = await mShowDiffSheet({ filePath: path, diff, title: t("文件变更预览 · {type}", { type: type }) });
  if (decision !== "accept") {
    if (decision === "reject") mToast(t("已拒绝写入"));
    return "rejected";
  }

  try {
    let res;
    if (type === "file_edit") {
      res = await post("/projects/apply-edit", { file_path: structured.file, content: structured.new_content });
    } else if (type === "file_create") {
      res = await post("/projects/create-file", { file_path: structured.file, content: structured.content });
    } else {
      res = await post("/projects/append-file", { file_path: structured.file, content: structured.content });
    }
    if (res.code === 0) {
      mToast(t("已写入磁盘"));
      return "accepted";
    }
    mToast(t("写入失败: {msg}", { msg: res.message || t("未知错误") }), 3500);
    return "rejected";
  } catch (e) {
    mToast(t("写入失败: {msg}", { msg: e.message }), 3500);
    return "rejected";
  }
}

export { t };
