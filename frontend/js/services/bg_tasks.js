/**
 * 后台终端任务：面板数据源 + 事件信箱。
 *
 * 分工（与后端 backend/routers/bg_tasks.py 一一对应）：
 *   任务本身活在**后端进程**里 —— 进程一停任务就收尾，日志留在 data/bg_tasks/<id>.log。
 *   前端只做三件事：拉状态给人看、把未读事件领进内存、按需停止某个任务。
 *
 * 轮询纪律：只在"确实有在册任务"时按 POLL_MS 拉；一个都没有就停手，
 * 免得空转把 CPU 和日志刷满。页面刚打开时探一次（另一标签页/上次没关的窗口起的任务
 * 不该看不见），探到有任务自然就转成常轮询。
 *
 * 事件是"至少一次"投递：后端 GET 返回未读事件，前端入内存后再 ack。
 * 拔线/崩溃时事件仍在后端，下次拉取还会来 —— 丢事件比重复投递严重得多。
 *
 * 多项目在册之后多了一层"念给谁"：事件带着 conversation_id 回来，归属是当前会话的
 * 进唤醒池，归属别的会话（多半是别的项目）的进 bgInbox 等主人回来领。
 * 没有归属信息的老事件一律就地念 —— 扣住一条真结局不发，比念错地方更糟。
 */

import { get, post } from "./api.js?v=20260925-004";
import { state, notify, recordTaskFlag, bgResumeUsedOf, markBgResumeUsed } from "../store.js?v=20260925-004";
import { notifyTaskComplete } from "./notify.js?v=20260925-004";

/** 有任务在册时的轮询间隔：够及时，又不至于把 3 秒一次的请求灌满日志 */
export const POLL_MS = 3000;

/** 空闲探测间隔：一个任务都没有时也要偶尔看一眼（别的标签页可能刚起了一个） */
export const IDLE_PROBE_MS = 20000;

/** 一次唤醒最多念几条事件：事件多时先念最近的，剩下的下次再念 */
export const BG_WAKE_MAX_EVENTS = 6;

/** 每条事件带多少字输出尾巴：够看清成败，又不至于把上下文灌爆 */
export const BG_WAKE_TAIL_CHARS = 500;

/** 未读事件池的上限：一次唤醒最多念 6 条，攒更多只是涨内存（后端已 ack，丢了不会再来） */
export const BG_EVENTS_KEEP = 40;

/** 跨会话信箱的上限：不属于当前会话的消息攒在这儿，等用户回到那场会话再念 */
export const BG_INBOX_KEEP = 60;

/**
 * 每个对话允许系统"自己开口"几次。事件注入本身不花配额——每条事件只能唤醒一次，
 * 天然有界；花配额的是"系统主动开一场新的问答"这类会自己滚起来的事，得有个头。
 */
export const BG_RESUME_MAX = 3;

let timer = null;
let inflight = false;
/** 已经就"结束了"提醒过人的任务，避免同一个结局每隔几秒响一次 */
const announced = new Set();
/** task_id → 起它的会话 id。只在内存里：跨重启后归属不可知，宁可不亮徽标 */
const owners = new Map();

export function bgTasks() {
  return Array.isArray(state.bgTasks) ? state.bgTasks : [];
}

export function runningBgTasks() {
  return bgTasks().filter(t => t.state === "running");
}

/** 未读事件（模型唤醒与面板提示共用这一份；由 takeBgEvents 消费并清空） */
export function peekBgEvents() {
  return Array.isArray(state.bgTaskEvents) ? state.bgTaskEvents : [];
}

export function hasBgEvents() {
  return peekBgEvents().length > 0;
}

/** 不改状态地看一眼"这一场能念几条"（配额要留给真有消息的那一次） */
export function peekBgEventsFor(convId = state.currentConversationId) {
  const current = String(convId || "");
  return peekBgEvents().filter(e => {
    const owner = bgEventOwner(e);
    return !owner || owner === current;
  });
}

/** 取走属于这场会话的未读事件；认得出但不属于它的，退回跨会话信箱。
 *
 * 归属为空 = 起任务时还认不出会话（新对话当场起任务、老版本后端），
 * 那就沿用旧行为就地念——把没依据的消息扣住不念，比念错地方更难查。
 */
export function takeBgEvents(convId = state.currentConversationId) {
  const here = [];
  const away = [];
  for (const e of peekBgEvents()) {
    const owner = bgEventOwner(e);
    (owner && owner !== String(convId || "") ? away : here).push(e);
  }
  state.bgTaskEvents = [];
  notify("bgEvents", []);
  if (away.length) addToInbox(away);
  return here;
}

/** 事件归谁：后端记的 conversation_id 优先，内存里的 owners 只作兜底（跨重启会失效） */
export function bgEventOwner(e) {
  return String(e?.conversation_id || owners.get(String(e?.task_id || "")) || "");
}

/** 跨会话信箱：别的会话（多半是别的项目）里跑完的任务，消息先躺在这儿等主人回来 */
export function bgInbox() {
  return Array.isArray(state.bgInbox) ? state.bgInbox : [];
}

export function unreadInboxCount() {
  return bgInbox().length;
}

function addToInbox(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return;
  const known = new Set(bgInbox().map(e => e.event_id));
  const fresh = list.filter(e => e && e.event_id && !known.has(e.event_id));
  if (!fresh.length) return;
  state.bgInbox = bgInbox().concat(fresh).slice(-BG_INBOX_KEEP);
  notify("bgInbox", state.bgInbox);
  for (const e of fresh) {
    const owner = bgEventOwner(e);
    if (!owner) continue;
    // 徽标是持久化的：用户可能明天才回那场会话看。消息本身只在内存里（后端已 ack），
    // 所以徽标亮着但详情没了是已知取舍——宁可只留"那场有结局没看"，也不假装有内容。
    const ok = e.kind === "exit" || e.kind === "match";
    try { recordTaskFlag(owner, { kind: ok ? "done" : e.kind === "stopped" ? "needs" : "error", seen: false }); } catch (err) { /* 同上 */ }
  }
}

/** 回到某场会话时把它名下的消息搬回唤醒池：下一次空轮/空闲续跑就会念给模型 */
export function drainInboxFor(convId) {
  const key = String(convId || "");
  if (!key) return 0;
  const mine = [], rest = [];
  for (const e of bgInbox()) (bgEventOwner(e) === key ? mine : rest).push(e);
  if (!mine.length) return 0;
  state.bgInbox = rest;
  notify("bgInbox", state.bgInbox);
  const known = new Set(peekBgEvents().map(e => e.event_id));
  state.bgTaskEvents = peekBgEvents().concat(mine.filter(e => !known.has(e.event_id))).slice(-BG_EVENTS_KEEP);
  notify("bgEvents", state.bgTaskEvents);
  return mine.length;
}

export function clearBgInbox() {
  if (!bgInbox().length) return;
  state.bgInbox = [];
  notify("bgInbox", []);
}

function setTasks(tasks) {
  state.bgTasks = Array.isArray(tasks) ? tasks : [];
  notify("bgTasks", state.bgTasks);
}

function pushEvents(events) {
  if (!Array.isArray(events) || !events.length) return;
  const known = new Set(peekBgEvents().map(e => e.event_id).concat(bgInbox().map(e => e.event_id)));
  const fresh = events.filter(e => e && e.event_id && !known.has(e.event_id));
  if (!fresh.length) return;
  // 一到手就先分一次：不属于当前会话的进信箱。等 takeBgEvents 再分太晚——
  // 中间这段时间面板上显示的"未读"会把别的项目的结局算进当前项目头上。
  const here = [];
  const away = [];
  const current = String(state.currentConversationId || "");
  for (const e of fresh) {
    const owner = bgEventOwner(e);
    (owner && owner !== current ? away : here).push(e);
  }
  if (away.length) addToInbox(away);
  if (!here.length) return;
  // 未读池封顶：配额用完 / 用户迟迟没回来时，后端已经 ack 过这些事件，攒着只会涨内存。
  // 一次唤醒最多也只念 BG_WAKE_MAX_EVENTS 条，留太多没有意义，丢最老的。
  state.bgTaskEvents = peekBgEvents().concat(here).slice(-BG_EVENTS_KEEP);
  notify("bgEvents", state.bgTaskEvents);
}

/**
 * 拉一次全量。返回在册任务数（0 = 可以让轮询歇会儿）。
 * 失败不抛：后端没起来时静默退避，轮询继续但不再空转刷错。
 */
export async function refreshBgTasks() {
  if (inflight) return bgTasks().length;
  inflight = true;
  try {
    const res = await get("/bg-tasks");
    if (res?.code !== 0) return bgTasks().length;
    const data = res.data || {};
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    setTasks(tasks);
    // 先入内存再 ack：ack 之后后端就忘了，崩在这之间有丢事件的风险
    pushEvents(data.events);
    const ids = (data.events || []).map(e => e?.event_id).filter(Boolean);
    if (ids.length) post("/bg-tasks/events/ack", { eventIds: ids }).catch(() => {});
    announceFinished(tasks);
    return tasks.length;
  } catch (e) {
    return bgTasks().length;
  } finally {
    inflight = false;
  }
}

/** 人向提醒：任务刚结束时响一次（模型唤醒是另一条通道，两边互不影响） */
function announceFinished(tasks) {
  for (const t of tasks) {
    if (!t || t.state === "running" || announced.has(t.task_id)) continue;
    announced.add(t.task_id);
    const ok = t.state === "exited" && t.exit_code === 0;
    const title = ok ? "后台任务已完成" : t.state === "stopped" ? "后台任务已停止" : "后台任务异常结束";
    const body = `${t.label || t.task_id}${t.exit_code === null || t.exit_code === undefined ? "" : `（exit ${t.exit_code}）`}`;
    try { notifyTaskComplete(title, body); } catch (e) { /* 通知不是关键路径 */ }
    // 归属会话：后端记的 conversation_id 优先（重启后还在），内存登记只兜老数据
    const convId = String(t.conversation_id || owners.get(t.task_id) || "");
    if (convId) {
      try { recordTaskFlag(convId, { kind: ok ? "done" : "error", seen: false }); } catch (e) { /* 同上 */ }
    }
  }
}

/**
 * 确保处于轮询状态并**立刻**探一次：有任务时按 POLL_MS，空态退到 IDLE_PROBE_MS 的慢探。
 * 用 setTimeout 串行而不是 setInterval：上一次没回来就不该再发下一次。
 *
 * 这里是"重排"而不是"已在跑就直接返回"：刚起完任务时挂着的多半是 20 秒的空闲慢探，
 * 直接返回就要等最多 20 秒才看得到结局（面板停在"进行中"，事件也不来）。
 */
export function startBgPolling() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const tick = async () => {
    timer = null;
    const count = await refreshBgTasks();
    schedule(count > 0 ? POLL_MS : IDLE_PROBE_MS);
  };
  const schedule = delay => {
    if (timer === null) timer = setTimeout(tick, delay);
  };
  schedule(0);
}

export function stopBgPolling() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 工具刚起了一个任务：把快照先塞进面板，并立刻进入常轮询 */
export function noteBgTaskStarted(data, convId = "") {
  const task = data && data.task ? data.task : null;
  if (!task || !task.task_id) return;
  const rest = bgTasks().filter(t => t.task_id !== task.task_id);
  setTasks([task].concat(rest));
  announced.delete(task.task_id);
  // 归属以带上的那个为准：convId 是"起它时这一场"，task.conversation_id 是后端记下来的同一条事实
  const owner = String(convId || task.conversation_id || "");
  if (owner) owners.set(task.task_id, owner);
  // 新任务一律把面板撑开：模型刚说"我起了个后台任务"，人得立刻看得见它
  state.bgPanelOpen = true;
  notify("bgPanelOpen", true);
  startBgPolling();
}

/** 停一个任务：停完立刻重拉，别让面板停在"进行中" */
export async function stopBgTask(taskId) {
  try {
    const res = await post(`/bg-tasks/${encodeURIComponent(taskId)}/stop`, {});
    if (res?.code === 0 && res.data?.task) {
      const next = bgTasks().map(t => (t.task_id === res.data.task.task_id ? { ...t, ...res.data.task } : t));
      setTasks(next);
    }
    return res;
  } finally {
    refreshBgTasks();
  }
}

/** 清掉已结束的记录（日志文件留在磁盘） */
export async function clearFinishedBgTasks() {
  const res = await post("/bg-tasks/clear", {});
  await refreshBgTasks();
  return res;
}

// ── 唤醒模型：三层触发共用的判据与话术 ──────────────────────

/** 还有活没交接完：有未读事件，或有任务仍在跑 */
export function hasBgWork() {
  return hasBgEvents() || runningBgTasks().length > 0;
}

/**
 * 取一次"系统主动开口"的配额。谁花谁记账：
 *   · 空轮注入事件   —— 不花（事件消费掉就没了，天然有界）
 *   · 触顶放宽轮数   —— 要花（否则"任务一直跑着"就能一直续）
 *   · 空闲起新一场   —— 要花（最会滚起来的一条路，必须封顶）
 * 开关关掉时一律不给：用户说的是"别自己开口"，那就一次都别开口。
 */
export function takeBgResumeGrant(convId) {
  const key = convId || "";
  if (state.bgAutoResume === false || !key) return false;
  if (bgResumeUsedOf(key) >= BG_RESUME_MAX) return false;
  markBgResumeUsed(key);
  return true;
}

export function bgResumeLeft(convId) {
  return Math.max(0, BG_RESUME_MAX - bgResumeUsedOf(convId || ""));
}

function eventKindText(kind) {
  return kind === "match" ? "命中触发条件"
    : kind === "exit" ? "正常结束"
      : kind === "fail" ? "异常结束"
        : kind === "stopped" ? "被停止"
          : String(kind || "有动静");
}

/**
 * 事件 → 模型可见的一段话。刻意点名"这是系统送来的，不是用户发的"：
 * 模型很容易把注入的 user 消息当成用户新要求，于是去回答用户根本没问的事。
 */
export function bgWakeText(events) {
  const all = Array.isArray(events) ? events : [];
  const list = all.slice(-BG_WAKE_MAX_EVENTS);
  const dropped = all.length - list.length;
  const lines = list.map(e => {
    const code = e.exit_code === null || e.exit_code === undefined ? "" : ` exit=${e.exit_code}`;
    const tail = String(e.tail || "").trim().slice(-BG_WAKE_TAIL_CHARS);
    const body = tail ? `\n  最近输出：\n${tail.split("\n").map(l => "    " + l).join("\n")}` : "";
    return `- [${e.task_id}] ${e.label || e.task_id}：${eventKindText(e.kind)}${code}${body}`;
  });
  const head = `[系统 · 后台任务消息] 以下是你之前起的后台任务刚发来的动静（${list.length} 条${dropped > 0 ? `，更早的 ${dropped} 条已略过` : ""}）。这不是用户发来的话，不要当成新要求：`;
  const tail = "\n\n请先判断这些结果对当前任务意味着什么：需要接着干就直接输出下一步工具调用（用 bg_task action=status/log 取更完整的输出）；已经完事就简短汇报结果，不要在没必要时重新跑一遍命令。";
  return head + "\n" + lines.join("\n") + tail;
}
