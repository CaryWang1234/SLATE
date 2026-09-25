/**
 * 输出中断不得静默守卫：scripts/check_stream_endings.mjs
 *
 * 用户实测：让他执行任务，第一次思考一半停掉、重新生成后"思考完了就不输出"，第三次又正常。
 * 两条静默路径都出自同一个门：
 *   ① api.js 里流自然结束（既无 [DONE]、也无 finish_reason）= 上游/代理提前收流，
 *      过去一律当成功——半截回复于是静默收场；
 *   ② chat.js 收尾时的通知与续跑入口都挂在 autopilotOn 上，非 Autopilot/目标模式下
 *      一轮"只出了思考、没有正文"没有任何出口，用户只看到"它自己停了"。
 * 盯的契约：提前收流要在 meta 上留痕 → 挂到该轮消息上 → 收尾时**不分模式**如实报出来。
 * 判据落在比较行上（不是"文件里有没有这个名字"）：把「!meta.finishReason」「!extra.autopilotOn」
 * 这两处比较改回旧写法，或删掉任一留痕行，本守卫必须变红。
 * 失败用短消息报错（不 dump 整份源码）：这些断言的对象是几千行的前端文件。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

const api = read("frontend/js/services/api.js");
const chat = read("frontend/js/components/chat.js");
const dict = read("frontend/js/services/i18n_dict.js");

// ── 1. 提前收流才留痕：必须同时排除 [DONE]（done）与已有 finish_reason ──
const MARK = "if (meta && !meta.finishReason) meta.truncated = true;";
must(api.includes(MARK), "api.js 丢了「无 [DONE] 且无 finish_reason → meta.truncated」这条留痕");
{
  // 这句必须待在 !done 分支里：放在分支外会把正常收尾也标成截断
  const at = api.indexOf(MARK);
  const guardAt = api.lastIndexOf("if (!done) {", at);
  must(at !== -1 && guardAt !== -1 && at > guardAt && at - guardAt < 600,
    "留痕必须在 !done 分支内（否则正常收尾被误标成截断）");
}

// ── 2. 留痕要挂到该轮消息上，收尾才读得到 ──
must(chat.includes("if (streamMeta.truncated) assistantMsg.truncated = true;"),
  "chat.js 没把提前收流的标记挂到本轮消息上，收尾处就无从谈起");

// ── 3. 非 Autopilot/目标模式也要报：闸门不得再挂回 autopilotOn ──
must(chat.includes('if (!extra.autopilotOn && !run.signal?.aborted && run.exitKind !== "done") {'),
  "chat.js 零正文/截断的出口又被挂回 autopilotOn 了（非目标模式将重新变成静默停止）");
must(chat.includes('dlgToast(t("生成中断：{reason}。可调低思考强度或调高输出上限，点「继续」接着写", { reason }), 6000);'),
  "零正文时没有给出可见提示（只有通知/声音不算，非目标模式下的用户看不到）");
must(chat.includes("showResumeHint(reason)"), "零正文时没有挂出续跑入口");
must(chat.includes('showResumeHint(t("上游连接提前中断，这条回复可能不完整"))'),
  "正文有内容但流提前断的情况没有任何提示");

// ── 4. 文案两侧都要在：中文源串即键，缺了英文就是中文串直接露出去 ──
for (const key of [
  "生成中断：{reason}。可调低思考强度或调高输出上限，点「继续」接着写",
  "上游连接提前中断，这一轮的正文没写完",
  "这一轮只产出了思考、没有正文",
  "上游连接提前中断，这条回复可能不完整",
]) {
  must(dict.includes(`"${key}":`), `i18n_dict.js 缺词条：${key}`);
}

// ── 5. 两种原因要能分开说：截断与"只有思考"不是同一句话 ──
must(/run\.lastMsg\?\.truncated\s*\n\s*\? t\("上游连接提前中断，这一轮的正文没写完"\)\s*\n\s*: t\("这一轮只产出了思考、没有正文"\)/.test(chat),
  "截断与空正文没有区分原因，用户拿到的诊断会退化成同一句空话");

if (problems.length) {
  console.error(`stream endings check failed with ${problems.length} issue(s):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("stream endings check passed.");
