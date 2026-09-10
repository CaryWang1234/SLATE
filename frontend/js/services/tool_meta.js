/**
 * 工具元信息投影：卡片标题与参数摘要从一处事实源派生。
 *
 * 白板原先另养了一份 14 条工具描述表和一条硬编码参数挑选链，聊天卡片又另养了一份
 * TOOL_LABELS，同一笔调用在两个界面叫法不同（系统信息 / 系统元认知）。这里并成一处：
 * 短标签表 + TOOLS schema，两个投影都只认这里。
 */

import { TOOLS } from "./tools.js?v=20260910-004";
import { t } from "./i18n.js?v=20260910-004";

const SUMMARY_MAX = 60;

// 既覆盖前端注册工具，也覆盖 skill_run 下的内置技能名
const TOOL_LABELS = {
  file_create: "创建文件",
  file_edit: "编辑文件",
  file_append: "追加文件",
  file_tree: "查看目录",
  file_peek: "查看文件",
  terminal: "执行命令",
  skill_run: "技能",
  project_info: "项目信息",
  project_files: "文件列表",
  project_read_file: "读取文件",
  project_find_file: "查找文件",
  code_search: "代码搜索",
  web_search: "联网搜索",
  web_fetch: "抓取网页",
  image_gen: "生成图片",
  video_gen: "生成视频",
  chart_create: "生成图表",
  qrcode_create: "生成二维码",
  html_render: "渲染 HTML",
  css_color: "CSS 配色",
  doc_write: "生成文档",
  ppt_create: "生成演示文稿",
  word_create: "生成 Word",
  text_summarize: "文本摘要",
  json_tool: "JSON 处理",
  regex_test: "正则测试",
  repo_stats: "项目统计",
  todo_scan: "待办扫描",
  todo_manage: "任务清单",
  git_tool: "Git 操作",
  code_scan: "代码扫描",
  doc_scan: "文档扫描",
  excel_tool: "表格处理",
  pdf_tool: "PDF 处理",
  browser_automation: "浏览器自动化",
  computer_use: "桌面自动化",
  mcp_factory: "工具工厂",
  screenshot_to_code: "截图转码",
  user_ask: "询问用户",
  skill_search: "技能搜索",
  subagent_run: "并行子代理",
  system_info: "系统信息",
  board_add: "添加卡片",
  board_read: "读取黑板",
  board_update: "更新卡片",
  board_batch: "批量操作",
  board_clear: "清空黑板",
  knowledge_search: "知识检索",
  knowledge_add: "知识添加",
  prompt_gen: "提示词生成",
  chat_context: "对话上下文",
};

/**
 * 工具中文名，已过 i18n：短标签表 → skill_run 的子技能名 → TOOLS schema → 裸英文名。
 * 裸英文名原样返回，调用处可据此判断「无名」。
 */
export function toolLabel(name, args) {
  if (name === "skill_run") {
    const skill = args?.skill;
    if (skill && TOOL_LABELS[skill]) return t(TOOL_LABELS[skill]);
    return skill ? t("技能 · {name}", { name: skill }) : t("技能");
  }
  if (name && TOOL_LABELS[name]) return t(TOOL_LABELS[name]);
  const known = TOOLS?.[name]?.name;
  return known ? t(known) : name || "";
}

function isScalar(v) {
  return typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim() !== "");
}

/** 参数摘要：schema 里 required 的标量优先，其次按声明序取第一个标量 */
export function toolArgsSummary(args, toolName = "") {
  const schema = TOOLS?.[toolName]?.params;
  const keys = Object.keys({ ...(schema || {}), ...(args || {}) });
  const scalars = keys.filter(k => isScalar(args?.[k]));
  const pick = scalars.find(k => schema?.[k]?.required) || scalars[0];
  if (!pick) return "";
  const text = String(args[pick]).trim().replace(/\s+/g, " ");
  return `${pick}=${text.slice(0, SUMMARY_MAX)}${text.length > SUMMARY_MAX ? "…" : ""}`;
}
