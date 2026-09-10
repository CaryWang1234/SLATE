/**
 * kernel 行为守卫：scripts/check_agent_loop.mjs
 *
 * P0-b 把桌面手写的 runToolLoop 骨架搬进 services/agent_loop.js，chat.js 只留 policy/view/io。
 * check_agent_prompts.mjs 盯的是提示词字符串逐字不变，这个脚本盯的是"骨架语义"：
 * 轮次推进、去重催办、空轮决策、abort/会话切换守卫、每阶段先后次序、退出清理时机。
 * P1-b 起 kernel 还要落事件账：用假账本收集 emit，验证事件次序、投影形状（projectChat/
 * projectSteps 必须与迁移前手工拼的 [{call, result}] 与步骤卡同形）与退出清扫的取消留痕。
 * 用桩件驱动真 kernel（不复制实现），在 Node 侧跑，不依赖浏览器。
 */
import assert from "node:assert/strict";
import { state, addMessage } from "../frontend/js/store.js?v=20260910-004";
import { _pendingToolMsgs } from "../frontend/js/services/agent_common.js?v=20260910-004";
import { createAgentLoop } from "../frontend/js/services/agent_loop.js?v=20260910-004";
import { projectChat, projectSteps } from "../frontend/js/services/agent_ledger.js?v=20260910-004";

const c1 = [{ name: "read", params: { p: 1 } }];
const c2 = [{ name: "write", params: { p: 2 } }];

/** trace 里若干标记按序出现（允许中间穿插其他标记） */
function appearsInOrder(trace, marks, label) {
  let i = -1;
  for (const m of marks) {
    const next = trace.findIndex((t, idx) => idx > i && t === m);
    assert.notEqual(next, -1, `${label}: 缺少或顺序错误 ${m}\n实际: ${trace.join(" | ")}`);
    i = next;
  }
}

const count = (trace, prefix) => trace.filter(t => t.startsWith(prefix)).length;

function makeStubs(scenario) {
  const trace = [];
  const pending = scenario.rounds.slice(1);   // 第 0 条已在种子里给出，streamTurn 依次补后续轮
  // 假账本：形状与 agent_ledger.openRun 的返回一致，投影函数可直接吃下 events
  const ledger = {
    runId: "run_test",
    events: [],
    roundSeen: -1,
    callId: (round, index) => `r${round}c${index}`,
    emit(type, { callId = "", tool = "", round, data } = {}) {
      const event = { seq: ledger.events.length + 1, ts: 0, type, callId, tool, round, data: data || {} };
      ledger.events.push(event);
      if (typeof round === "number") ledger.roundSeen = Math.max(ledger.roundSeen, round);
      trace.push(`emit(${type}${callId ? ":" + callId : ""})`);
      return event;
    },
    flush() { trace.push("ledgerFlush"); },
    finish({ status = "", stops = "" } = {}) { trace.push(`ledgerFinish(${status},${stops})`); },
  };
  const ctx = {
    trace,
    ledger,
    io: {
      detectCalls(msg) {
        trace.push(`detect(${msg.seq})`);
        return msg.calls || [];
      },
      async execute(calls, opts) {
        trace.push(`execute(${calls.length})`);
        const stopped = scenario.partialExecute ? 1 : calls.length;
        calls.forEach((call, i) => {
          const result = { success: true, output: `out-${call.name}-${i}` };
          opts.onCallStart?.(call, i);
          opts.onEvent?.({ type: "chunk" }, call, i);
          if (i < stopped) opts.onCallEnd?.(call, i, result);
        });
        scenario.onExecute?.();
        return calls.slice(0, stopped).map((call, i) => ({ success: true, output: `out-${call.name}-${i}` }));
      },
      async commitResults(run) {
        trace.push(`commit(${run.results.length})`);
        if (scenario.throwOnCommit) throw new Error("落库炸了");
        run.lastMsg.committed = true;
      },
      async streamTurn(run) {
        trace.push(`turn(${run.round})`);
        const next = pending.shift();
        if (!next) {
          // 真实循环每轮结尾都会新建 assistant 气泡；桩件重复上一条以保持该不变量
          const repeat = { role: "assistant", content: run.lastMsg.content, seq: run.lastMsg.seq, calls: run.lastMsg.calls };
          addMessage(repeat);
          return { bubble: { tag: `bubble-${repeat.seq}` }, message: repeat, content: repeat.content };
        }
        const msg = { role: "assistant", content: `text-${next.seq}`, seq: next.seq, calls: next.calls };
        addMessage(msg);
        if (scenario.switchAfterTurn) state.currentConversationId = "other-conv";
        return { bubble: { tag: `bubble-${next.seq}` }, message: msg, content: msg.content, ...(next.stop ? { stop: next.stop } : {}) };
      },
    },
    view: {
      reanchorBubble(el) { trace.push("reanchor"); return el; },
      renderBubble(el, content) { trace.push(`render(${content})`); },
      setProgress(text) { trace.push(`progress(${text})`); },
      execProgress() {
        return {
          onCallStart: (call) => trace.push(`inkStart(${call.name})`),
          onEvent: () => trace.push("inkEvent"),
          onCallEnd: (call) => trace.push(`inkEnd(${call.name})`),
          endAll: (calls) => trace.push(`inkEndAll(${calls.length})`),
        };
      },
      toolCards: {
        begin(run) { trace.push(`cardsBegin(${run.calls.length})`); return run.calls.map((call, i) => `card-${call.name}-${i}`); },
        finish(run) { trace.push(`cardsFinish(${run.results.length})`); },
      },
    },
    policy: {
      exitReasons: { aborted: "手动停止", switched: "会话已切换" },
      beginRun() { trace.push("beginRun"); return { nudges: 0, ...scenario.extra }; },
      openRun() { trace.push("openRun"); return scenario.noLedger ? null : ledger; },
      onStart() { trace.push("onStart"); },
      markActivity() { trace.push("markActivity"); },
      dedupRound(run) {
        trace.push(`dedupRound(dup=${run.dupRounds},stall=${run.stallStreak})`);
        if (run.dupRounds >= 2 && !scenario.keepDedupGoing) return { action: "break" };
        return {
          action: "nudge",
          hiddenMsg: { role: "user", model: "[dedup]", content: `dedup-${run.round}`, hidden: true },
          progressText: "dedup-progress",
        };
      },
      emptyRound(run) {
        trace.push(`emptyRound(round=${run.round},stall=${run.stallStreak},ok=${run.successfulTool})`);
        if (run.stallStreak < (scenario.warnAfter ?? 1)) {
          return { action: "nudge", hiddenMsg: { role: "user", model: "[stall_warn]", content: `warn-${run.stallStreak}`, hidden: true } };
        }
        return { action: "break", exitReason: `stalled-${run.stallStreak}` };
      },
      progressForRound(run) {
        return run.extra?.progress ? `round-${run.round + 1}` : undefined;
      },
      buildFeeds(run) {
        trace.push(`feeds(${run.results.length})`);
        return run.calls.map((call, i) => ({ role: "tool", model: "[tool_results]", content: `feed-${call.name}-${i}`, tool_call_id: call.id, hidden: true }));
      },
      async endTurn(run) {
        trace.push(`endTurn(${run.round})`);
        return { action: "continue", bubble: run.bubble };
      },
      finish(run) {
        trace.push(`finish(exit=${run.exitReason},pending=${_pendingToolMsgs.size})`);
      },
    },
  };
  // 稀疏 policy：移动端没有 idle 打点/进度文案/收尾钩子，kernel 不得硬要求
  if (scenario.sparsePolicy) {
    for (const k of ["beginRun", "onStart", "markActivity", "progressForRound", "endTurn", "finish"]) delete ctx.policy[k];
  }
  return ctx;
}

async function runLoop(scenario) {
  const ctx = makeStubs(scenario);
  state.currentConversationId = "conv-1";
  state.messages = [
    { role: "user", content: "任务" },
    { role: "assistant", content: `text-${scenario.rounds[0].seq}`, seq: scenario.rounds[0].seq, calls: scenario.rounds[0].calls },
  ];
  _pendingToolMsgs.clear();
  const loop = createAgentLoop({ policy: ctx.policy, view: ctx.view, io: ctx.io });
  const run = await loop({
    bubble: { tag: "bubble-0" },
    modelId: "m",
    apiKey: "k",
    baseUrl: "u",
    params: {},
    signal: scenario.signal ?? null,
    maxRounds: scenario.maxRounds ?? 5,
    genConvId: "conv-1",
  });
  return { trace: ctx.trace, run, ledger: ctx.ledger, pendingLeft: _pendingToolMsgs.size };
}

async function expectReject(scenario) {
  const ctx = makeStubs(scenario);
  state.currentConversationId = "conv-1";
  state.messages = [{ role: "user", content: "任务" }, { role: "assistant", content: "text-0", seq: 0, calls: c1 }];
  _pendingToolMsgs.clear();
  const loop = createAgentLoop({ policy: ctx.policy, view: ctx.view, io: ctx.io });
  await assert.rejects(
    () => loop({ bubble: { tag: "b" }, modelId: "m", apiKey: "k", baseUrl: "u", params: {}, maxRounds: 5, genConvId: "conv-1" }),
    /落库炸了/,
  );
  return { trace: ctx.trace, ledger: ctx.ledger, pendingLeft: _pendingToolMsgs.size };
}

// ── 1. 每轮骨架次序：探测 → 轮次进度 → 剥离回显 → 建卡 → 执行 → 落库 → 卡片收尾 → 回灌 → 续写
{
  const { trace, ledger } = await runLoop({ rounds: [{ seq: 0, calls: c1 }], maxRounds: 1, extra: { progress: true } });
  appearsInOrder(trace, [
    "beginRun", "onStart", "reanchor", "detect(0)",
    "progress(round-1)", "render(text-0)",
    "markActivity", "cardsBegin(1)", "inkStart(read)", "inkEvent", "inkEnd(read)", "inkEndAll(1)", "markActivity",
    "commit(1)", "cardsFinish(1)", "feeds(1)", "turn(0)", "endTurn(0)",
    "finish(exit=,pending=1)",
  ], "骨架次序");
  assert.equal(_pendingToolMsgs.size, 0, "退出后必须解除渲染抑制");

  // 事件账：一次调用一圈，轮末落一次账，收尾只给终态
  assert.deepEqual(
    ledger.events.map(e => `${e.type}${e.callId ? ":" + e.callId : ""}`),
    [
      "run.started",
      "round.started",
      "call.planned:r0c0",
      "call.ready:r0c0",
      "call.started:r0c0",
      "call.finished:r0c0",
      "round.finished",
    ],
    trace.join(" | "),
  );
  assert.equal(count(trace, "ledgerFlush"), 1, trace.join(" | "));
  appearsInOrder(trace, ["ledgerFlush", "ledgerFinish(completed,)", "finish(exit=,pending=1)"], "账本收尾先于 policy.finish");

  // 投影须与迁移前手工拼的 [{call, result}] 同形：result 是 call 与裸结果的合并体
  assert.deepEqual(
    projectChat(ledger, 0),
    [{ call: c1[0], result: { ...c1[0], success: true, output: "out-read-0" } }],
    "projectChat 形状漂移会改写历史 metadata.toolResults",
  );
  const [step] = projectSteps(ledger);
  assert.equal(step.callId, "r0c0");
  assert.equal(step.status, "done");
  assert.equal(step.argsSummary, "p=1");
  assert.equal(step.excerpt, "out-read-0");
}

// ── 2. 相同调用去重：第二轮只催办不执行，第三轮 dupRounds>=2 退出
{
  const same = [{ seq: 0, calls: c1 }, { seq: 1, calls: c1 }, { seq: 2, calls: c1 }];
  const { trace, run, ledger } = await runLoop({ rounds: same, maxRounds: 5, extra: {} });
  assert.equal(count(trace, "execute("), 1, trace.join(" | "));
  assert.equal(count(trace, "turn("), 2, trace.join(" | "));
  appearsInOrder(trace, ["execute(1)", "dedupRound(dup=1,stall=0)", "progress(dedup-progress)", "render(text-1)", "dedupRound(dup=2,stall=0)"], "去重");
  assert.equal(count(trace, "cardsBegin"), 1, "催办轮不得建步骤卡");
  assert.equal(run.exitReason, "", "去重退出不写退出原因（与旧实现一致）");
  // 账上：三轮各留一条 planned，只有第一轮报到 ready；催办轮以 notice 旁白留痕
  assert.equal(count(trace, "emit(call.planned"), 3, trace.join(" | "));
  assert.equal(count(trace, "emit(call.ready"), 1, trace.join(" | "));
  assert.equal(count(trace, "emit(notice"), 2, trace.join(" | "));
  assert.equal(projectSteps(ledger).length, 1, "被去重拦下的计划不得投影成卡片");
}

// ── 3. 空轮：先催办、连续空转到阈值后止损
{
  const { trace, run } = await runLoop({ rounds: [{ seq: 0, calls: [] }], maxRounds: 6, warnAfter: 2, extra: {} });
  appearsInOrder(trace, [
    "emptyRound(round=0,stall=0,ok=false)", "turn(0)",
    "emptyRound(round=1,stall=1,ok=false)", "turn(1)",
    "emptyRound(round=2,stall=2,ok=false)",
  ], "空轮");
  assert.equal(run.exitReason, "stalled-2", trace.join(" | "));
  assert.equal(count(trace, "execute("), 0, "无调用轮不得执行");
  assert.equal(count(trace, "emptyRound"), 3, trace.join(" | "));
}

// ── 4. abort：执行期间被停止 → 记退出原因且不再续写
{
  const ctrl = new AbortController();
  const { trace, run } = await runLoop({ rounds: [{ seq: 0, calls: c1 }], maxRounds: 5, signal: ctrl.signal, onExecute: () => ctrl.abort(), extra: {} });
  assert.equal(run.exitReason, "手动停止", trace.join(" | "));
  assert.equal(count(trace, "turn("), 0, "停止后不得新建气泡续写");
  assert.equal(count(trace, "feeds("), 0, "停止后不得回灌结果");
}

// ── 5. 会话切换：本轮续写完成后下一轮开头退出，不再注入幻影气泡
{
  const { trace, run } = await runLoop({ rounds: [{ seq: 0, calls: c1 }, { seq: 1, calls: c2 }], maxRounds: 5, switchAfterTurn: true, extra: {} });
  assert.equal(count(trace, "turn("), 1, trace.join(" | "));
  assert.equal(run.exitReason, "会话已切换", trace.join(" | "));
  appearsInOrder(trace, ["turn(0)", "endTurn(0)"], "切换守卫");
}

// ── 6. 轮内 stop：streamTurn 观测到 kernel 看不见的中止 → 不走 endTurn
{
  const { trace, run } = await runLoop({ rounds: [{ seq: 0, calls: c1 }, { seq: 1, calls: [], stop: "轮内停止" }], maxRounds: 5, extra: {} });
  assert.equal(run.exitReason, "轮内停止", trace.join(" | "));
  assert.equal(count(trace, "endTurn("), 0, "stop 必须早于 endTurn");
}

// ── 7. 抛异常：policy.finish 与渲染抑制解除仍然发生
{
  const { trace, pendingLeft } = await expectReject({ rounds: [{ seq: 0, calls: c1 }], throwOnCommit: true, extra: {} });
  assert.equal(pendingLeft, 0, "异常路径也必须解除渲染抑制");
  assert.ok(trace.some(t => t.startsWith("finish(")), trace.join(" | "));
  appearsInOrder(trace, ["finish(exit=,pending=1)"], "清理次序：finish 先于 clear");
}

// ── 8. 轮数上限：跑满 maxRounds 不多走一轮
{
  const { trace, run } = await runLoop({
    rounds: [{ seq: 0, calls: c1 }, { seq: 1, calls: c2 }, { seq: 2, calls: c1 }, { seq: 3, calls: c2 }],
    maxRounds: 3,
    extra: {},
  });
  assert.equal(count(trace, "turn("), 3, trace.join(" | "));
  assert.equal(run.round, 2);
  assert.equal(count(trace, "execute("), 3, "每轮调用指纹不同，都应执行");
}

// ── 9. 回灌：native 调用按 policy 顺序进消息列表，且均为 hidden
{
  const calls = [{ name: "read", params: {}, id: "call-a" }, { name: "write", params: {}, id: "call-b" }];
  const ctx = makeStubs({ rounds: [{ seq: 0, calls }], extra: {}, warnAfter: 99 });
  state.currentConversationId = "conv-1";
  state.messages = [{ role: "user", content: "任务" }, { role: "assistant", content: "text-0", seq: 0, calls }];
  _pendingToolMsgs.clear();
  const loop = createAgentLoop({ policy: ctx.policy, view: ctx.view, io: ctx.io });
  await loop({ bubble: { tag: "b" }, modelId: "m", apiKey: "k", baseUrl: "u", params: {}, maxRounds: 1, genConvId: "conv-1" });
  const feeds = state.messages.filter(m => m.model === "[tool_results]");
  assert.deepEqual(feeds.map(m => m.content), ["feed-read-0", "feed-write-1"], "回灌顺序须与调用顺序一致");
  assert.ok(feeds.every(m => m.hidden), "回灌消息不得渲染成气泡");
}

// ── 10. 退出清扫：在飞的调用补取消，且落在自己的轮次
{
  const ctrl = new AbortController();
  const two = [{ name: "read", params: { p: 1 } }, { name: "write", params: { p: 2 } }];
  const { trace, ledger } = await runLoop({
    rounds: [{ seq: 0, calls: two }],
    maxRounds: 5,
    partialExecute: true,
    signal: ctrl.signal,
    onExecute: () => ctrl.abort(),
    extra: {},
  });
  const cancelled = ledger.events.find(e => e.type === "call.cancelled");
  assert.ok(cancelled, `缺少取消留痕: ${trace.join(" | ")}`);
  assert.equal(cancelled.callId, "r0c1");
  assert.equal(cancelled.data.by, "user");
  const ready = ledger.events.find(e => e.type === "call.ready" && e.callId === cancelled.callId);
  assert.equal(cancelled.round, ready.round, "取消事件须落在调用自己的轮次，不能借用收尾轮次");
  assert.ok(!ledger.events.some(e => e.type === "call.cancelled" && e.callId === "r0c0"), "已跑完的调用不得再补取消");
  const step = projectSteps(ledger).find(s => s.callId === "r0c1");
  assert.equal(step.status, "cancelled");
  assert.ok(trace.includes("ledgerFinish(cancelled,手动停止)"), trace.join(" | "));
}

// ── 11. 无账路径：openRun 返回 null 时骨架照旧，落账失败不得影响聊天
{
  const { trace } = await runLoop({ rounds: [{ seq: 0, calls: c1 }], maxRounds: 1, extra: {}, noLedger: true });
  assert.equal(count(trace, "emit("), 0, "无账时不得 emit");
  assert.equal(count(trace, "ledger"), 0, "无账时不得 flush/finish");
  appearsInOrder(trace, ["openRun", "detect(0)", "cardsBegin(1)", "inkStart(read)", "commit(1)", "turn(0)", "finish(exit=,pending=1)"], "无账路径");
}

// ── 12. 稀疏 policy：只留必需钩子也能跑完一轮（移动装配没有 idle 打点/进度文案/收尾钩子）
{
  const { trace, run } = await runLoop({ rounds: [{ seq: 0, calls: c1 }], maxRounds: 1, extra: {}, sparsePolicy: true });
  assert.equal(count(trace, "markActivity"), 0, trace.join(" | "));
  assert.equal(count(trace, "beginRun"), 0, trace.join(" | "));
  assert.equal(count(trace, "finish("), 0, trace.join(" | "));
  appearsInOrder(trace, ["detect(0)", "cardsBegin(1)", "commit(1)", "feeds(1)", "turn(0)"], "稀疏 policy 骨架");
  assert.equal(run.round, 0, trace.join(" | "));
  assert.equal(_pendingToolMsgs.size, 0, "缺 policy.finish 也要解除渲染抑制");
}

console.log("agent_loop.js 骨架语义守卫：通过");
