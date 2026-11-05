/**
 * 压缩后的线程重建。
 *
 * 上下文压缩会把"保留下来的那一段"再写回 store，而后端回传的 keep_messages 是
 * 发请求时那份**字段投影的副本**（只剩 role/content），带着它重建线程就会丢掉
 * hidden 与 model 标记——于是发给模型的 [系统警告]、[系统自动推进提醒]、工具结果
 * 投喂这些隐藏轮，在下一次重绘时变成普普通通的用户气泡，看上去就像"模型回复里
 * 冒出了系统警告"。所以保留段一律按 compress_count 从本地消息数组现取。
 *
 * 后端两个压缩路由都把保留段算成 messages[split_point:]，且 compress_count 就是
 * split_point（backend/routers/chat.py 的 /compress 与 /compress-manual），
 * 因此"本地数组切掉前 compress_count 条"与"keep_messages"是同一段。
 *
 * 摘要消息也在这一份里构造（historySummaryMessage）：三个压缩落点各自拼一次字符串，
 * 前缀就会漂成三份，而渲染层与 isHistorySummary 认的正是这个前缀。
 */
import { isAiToolOff } from "./ai_features.js?v=20261006-005";
import { HISTORY_SUMMARY_PREFIX } from "./agent_common.js?v=20261006-005";

/**
 * 压缩写回的那条 system 消息：前缀 + 摘要正文 +（能查回时）一条面包屑。
 *
 * 压缩只折不删：原文整条留在本机对话库里，摘要一旦漏掉某个细节，模型就只能凭摘要编。
 * 所以这里把"可以查回来"写进载荷本身。面包屑按开关现判：
 * 「设置 → AI 辅助功能」里关掉 history_search 后工具已不在目录里，
 * 再告诉模型可以调它，只会换来一次打空的调用。
 */
export function historySummaryMessage(summary, foldedCount) {
  const n = Number(foldedCount);
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const crumb = count > 0 && !isAiToolOff("history_search")
    ? `\n\n[可查回] 本段由 ${count} 条更早的消息折叠而成，原文并未删除，仍保存在本机这一场的对话记录里。摘要没写到的细节不要推断：用 history_search（action=search，query=关键词）按原话查回，需要上下文再用 action=read 配 message_id 取那条前后。`
    : "";
  return { role: "system", content: `${HISTORY_SUMMARY_PREFIX} ${String(summary || "").trim()}${crumb}` };
}

export function compressedThread(summaryMsg, localMessages, compressCount) {
  const list = Array.isArray(localMessages) ? localMessages : [];
  const n = Number(compressCount);
  const cut = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), list.length) : 0;
  return [summaryMsg, ...list.slice(cut)].filter(Boolean);
}
