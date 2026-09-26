/**
 * 消息归属不变量守卫：scripts/check_current_thread_binding.mjs
 *
 * 病灶（2026-09 用户实测）：开一个无项目的对话发消息，气泡上看得见，模型却像没读过——
 * 上游收到的 messages 只有 ['system']。链路：state.messages 与 threads（每场一份消息数组）
 * 被拆成两只桶之后，addMessage 的"可见"分支往 state.messages 推，而 messagesOf(convId) 读
 * threads.get(convId)；新建对话时没人把可见线程绑到新会话，于是用户消息进了上一场（或 _scratch）
 * 那只数组，取历史时读到空数组 → 只发系统提示。
 * 盯的契约（两处都要在）：
 *   ① store.js 的可见分支当场兑现"state.messages 是可见那一份的引用"——手上这只是别场的桶时
 *      （漏绑）让位给本场自己的桶，是调用方摆的本场数组时收下它（kernel 标记的渲染抑制对象
 *      住在那只数组里，换掉会让标记永远释放不掉）；
 *   ② 凡是改 state.currentConversationId 的地方（且该文件在用 messagesOf），紧随其后重绑线程。
 * 判据落在比较行与相邻关系上：删掉任一处的重绑、把判据取反、或让赋值后不再重绑，本守卫必须变红。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const JS_ROOT = path.join(ROOT, "frontend", "js");

const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

const store = readFileSync(path.join(JS_ROOT, "store.js"), "utf8");
const chat = readFileSync(path.join(JS_ROOT, "components", "chat.js"), "utf8");

// ── ① store.js：可见分支必须先把 state.messages 指到 key 那条数组上，再 push ──
// 只切「可见分支本体」：整个 addMessage 里非可见分支还有一份同样的 set/push 兜底，
// 按函数切会让断言被那两份喂饱（删掉可见分支那份也不红）。
const addFn = store.slice(store.indexOf("function addMessage("), store.indexOf("function updateLastAssistantMessage("));
const visStart = addFn.indexOf("if (visible) {");
const visReturn = addFn.indexOf("return;", visStart);
const visibleBranch = addFn.slice(visStart, visReturn === -1 ? visStart + 500 : visReturn);
const pushAt = visibleBranch.indexOf("state.messages.push(msg)");
const rebindAt = visibleBranch.indexOf("state.messages = bindVisibleThread(convId);");
const adoptAt = visibleBranch.indexOf("threads.set(key, state.messages);");
must(visibleBranch.includes("isThreadBucket(state.messages)"),
  "addMessage 可见分支没有分辨「手上这只是别场的桶还是本场数组」（漏绑会写错桶 / 换掉数组会丢 kernel 的标记）");
must(rebindAt !== -1,
  "addMessage 可见分支没有为「手上是别场的桶」让位（新会话会把上一场的历史当自己的发出去）");
must(adoptAt !== -1,
  "addMessage 可见分支没有收下调用方摆的本场数组（kernel 标记的渲染抑制对象住在那只数组里，换掉就永远释放不掉）");
// 极性：判据只能往「让位」那一侧走。写成 !isThreadBucket(...) 时文本仍在，但这行必须拦住它。
must(!/!\s*isThreadBucket\(/.test(visibleBranch),
  "addMessage 可见分支把判据取反了：手上是别场的桶时反而认了它");
must(rebindAt < adoptAt,
  "addMessage 可见分支的分支顺序反了：先认手上那只、再考虑让位，等于从不让位");
must(pushAt !== -1 && rebindAt < pushAt && adoptAt < pushAt,
  "addMessage 可见分支必须先绑定再 push，顺序反了等于没修");
// 判据本体：不遍历 threads 就认不出「这只数组是别场的桶」，includes 到这里才算有牙
const helperAt = store.indexOf("function isThreadBucket(");
must(helperAt !== -1, "store.js 里没有 isThreadBucket —— 可见分支的判据无处落地");
if (helperAt !== -1) {
  const helperBody = store.slice(helperAt, store.indexOf("\nfunction ", helperAt + 1));
  must(/for \(const \w+ of threads\.values\(\)\)/.test(helperBody) && helperBody.includes("=== list"),
    "isThreadBucket 没有按引用在 threads 里比对：认不出别场的桶，判据形同虚设");
}

// ── ② 新建会话：赋值之后必须紧跟重绑（这是实测漏掉的那一处） ──
must(/state\.currentConversationId = res\.data\.id;\s*\n(?:\s*\/\/[^\n]*\n)*\s*bindVisibleThread\(res\.data\.id\);/.test(chat),
  "桌面端新建会话后没有重绑可见线程（bindVisibleThread(res.data.id)），新对话会发空历史");

// ── ③ 扫描：用 messagesOf 的文件里，改 currentConversationId 必须随后重绑 ──
const WINDOW = 500;
function listJs(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== "node_modules") listJs(p, out); }
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const ASSIGN = /state\.currentConversationId = /g;
let scanned = 0;
for (const file of listJs(JS_ROOT)) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("messagesOf(")) continue;   // 不读 threads 的文件（如手机端直读 state.messages）不受这条约束
  scanned++;
  const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");
  for (const m of src.matchAll(ASSIGN)) {
    if (src.slice(m.index, m.index + 40).includes("== ")) continue;
    const seg = src.slice(m.index, m.index + WINDOW);
    if (!/setMessages\(|bindVisibleThread\(/.test(seg)) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${rel}:${line} 改了 currentConversationId 却没有重绑线程（${WINDOW} 字符内没有 setMessages/bindVisibleThread）`);
    }
  }
}
must(scanned > 0, "扫描范围空了：没有任何文件命中 messagesOf，判据形同虚设");

if (problems.length) {
  console.error(`conversation thread binding check failed with ${problems.length} issue(s):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`conversation thread binding check passed (scanned ${scanned} file(s)).`);
