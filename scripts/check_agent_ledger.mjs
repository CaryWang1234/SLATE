/**
 * 事件账本客户端守卫：scripts/check_agent_ledger.mjs
 *
 * P1 把「一次工具循环」变成一份可重放的账：kernel 经 policy.openRun 拿到 agent_ledger 的
 * run 实例，在轮次与调用各节点 emit，轮末与收尾 flush 到 POST /api/events/append。
 * 这个脚本盯三件最容易漂移的事：
 *   1. 上行字段名必须与 backend/routers/events.py 读的 camelCase 逐字对齐（断层过一次）；
 *   2. 落库的是摘要：原文只留在内存账里供投影，参数/输出各裁到 2000 字符并带字节数；
 *   3. 投影形状：projectChat 必须与迁移前手工拼的 [{call, result}] 同形，
 *      projectSteps 只为报到 ready 的调用生成卡片（被去重拦下的计划不留悬空卡）。
 * Node 侧跑：给 window 与 fetch 打桩，不碰真实后端。
 */
import assert from "node:assert/strict";

const listeners = [];
globalThis.window = {
  addEventListener: (type, fn) => { listeners.push([type, fn]); },
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex(([t, f]) => t === type && f === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
};
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, init });
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ code: 0, data: null, message: "ok" }) };
};

const { openRun, projectChat, projectSteps } = await import("../frontend/js/services/agent_ledger.js?v=20260925-011");

const lastBody = () => JSON.parse(posts[posts.length - 1].init.body);
const types = (ledger) => ledger.events.map(e => `${e.type}${e.callId ? ":" + e.callId : ""}`);

// ── 1. 上行契约：字段名与 events.py 读取的键逐字对齐 ─────────────
{
  const ledger = openRun({ conversationId: "conv-9", mode: "target", budget: 20 });
  const call = { name: "file_edit", params: { file_path: "a.txt", content: "x".repeat(5000) } };
  const merged = { ...call, success: true, output: `ok ${"y".repeat(3000)}` };
  // emit 形状照抄 agent_loop.js 的 runEvent / callEvent
  ledger.emit("run.started", { messageId: "m1", round: 0, data: { budget: 20 } });
  ledger.emit("round.started", { messageId: "m1", round: 0, data: {} });
  ledger.emit("call.planned", { callId: "r0c0", tool: "file_edit", messageId: "m1", round: 0, data: { args: call.params } });
  ledger.emit("call.ready", { callId: "r0c0", tool: "file_edit", messageId: "m1", round: 0, data: {} });
  ledger.emit("call.started", { callId: "r0c0", tool: "file_edit", messageId: "m1", round: 0, data: {} });
  ledger.emit("call.finished", { callId: "r0c0", tool: "file_edit", messageId: "m1", round: 0, data: { call, result: merged, status: "done", durationMs: 42 } });
  ledger.emit("round.finished", { messageId: "m1", round: 0, data: { calls: 1, executedTotal: 1, nudged: false, stopped: false } });
  assert.deepEqual(types(ledger), [
    "run.started", "round.started", "call.planned:r0c0", "call.ready:r0c0",
    "call.started:r0c0", "call.finished:r0c0", "round.finished",
  ]);

  ledger.flush();
  assert.ok(posts[posts.length - 1].url.endsWith("/api/events/append"), posts[posts.length - 1].url);
  const body = lastBody();
  assert.deepEqual(
    Object.keys(body.run).sort(),
    ["budgetRounds", "conversationId", "final", "mode", "runId", "startedAtMs", "status"],
    "runs 上行键须与 _run_row 读取的键一致",
  );
  assert.equal(body.run.runId, ledger.runId);
  assert.equal(body.run.conversationId, "conv-9");
  assert.equal(body.run.mode, "target");
  assert.equal(body.run.budgetRounds, 20);
  assert.equal(body.run.final, false);
  for (const e of body.events) {
    assert.deepEqual(
      Object.keys(e).sort(),
      ["callId", "data", "messageId", "parentCallId", "seq", "tool", "ts", "type"],
      `事件上行键须与 append_events 读取的键一致：${e.type}`,
    );
  }
  // parentCallId 是星图 spawn 边的唯一载体：主调用为空，派生出来的行必须非空
  assert.equal(body.events.find(e => e.type === "call.ready").parentCallId, "", "顶层调用不该有父");
  const spawned = ledger.emit("subagent.started", {
    callId: "r0c0s0", parentCallId: "r0c0", tool: "调研子代理", round: 0, data: { task: "看目录" },
  });
  assert.equal(spawned.parentCallId, "r0c0", "emit 须把 parentCallId 留在事件上");
  ledger.flush();
  assert.equal(lastBody().events.find(e => e.type === "subagent.started").parentCallId, "r0c0",
    "上行必须带 parentCallId，否则后端的叶子查询取不到这一行");
  assert.equal(projectSteps(ledger).length, 1, "subagent.* 不得长成第二张步骤卡");
  const seqs = body.events.map(e => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 须单调");
  assert.equal(new Set(seqs).size, seqs.length, "seq 不得重复");

  // 原文只留在内存，上行是摘要
  const planned = body.events.find(e => e.type === "call.planned");
  assert.ok(!("args" in planned.data), "参数原文不得上行");
  assert.equal(planned.data.argsBytes, JSON.stringify(call.params).length);
  assert.equal(planned.data.argsDigest.length, 2000);
  const finished = body.events.find(e => e.type === "call.finished");
  assert.ok(!("call" in finished.data), "调用原文不得上行");
  assert.ok(!("result" in finished.data), "结果原文不得上行");
  assert.equal(finished.data.status, "done");
  assert.equal(finished.data.durationMs, 42);
  assert.equal(finished.data.bytes, merged.output.length);
  assert.equal(finished.data.truncated, true);
  assert.equal(finished.data.resultDigest.length, 2000);
  for (const e of body.events) assert.equal(e.data.round, 0, "轮次须随行带上");
}

// ── 2. 投影：聊天卡片与白板步骤卡同源 ───────────────────────────
{
  const ledger = openRun({ conversationId: "conv-1", mode: "chat", budget: 5 });
  const c1 = { name: "file_edit", params: { file_path: "a.txt" } };
  const c2 = { name: "todo_manage", params: { action: "list" } };
  const r1 = { ...c1, success: true, output: "已写入 a.txt" };
  ledger.emit("run.started", { round: 0, data: {} });
  for (const [i, call] of [c1, c2].entries()) {
    ledger.emit("call.planned", { callId: `r0c${i}`, tool: call.name, round: 0, data: { args: call.params } });
    ledger.emit("call.ready", { callId: `r0c${i}`, tool: call.name, round: 0, data: {} });
    ledger.emit("call.started", { callId: `r0c${i}`, tool: call.name, round: 0, data: {} });
  }
  ledger.emit("call.finished", { callId: "r0c0", tool: "file_edit", round: 0, data: { call: c1, result: r1, status: "done", durationMs: 5 } });
  ledger.emit("call.cancelled", { callId: "r0c1", tool: "todo_manage", round: 0, data: { by: "user" } });

  assert.deepEqual(projectChat(ledger, 0), [{ call: c1, result: r1 }], "只投影跑完的调用，形状须与历史 toolResults 一致");
  assert.deepEqual(projectChat(ledger, 1), [], "投影按轮次过滤");
  const steps = projectSteps(ledger);
  assert.deepEqual(steps.map(s => s.callId), ["r0c0", "r0c1"], "步骤卡按账序");
  assert.equal(steps[0].label, "编辑文件", "标签取自 TOOLS，不再有第二份硬编码描述表");
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].excerpt, "已写入 a.txt");
  assert.equal(steps[0].argsSummary, "file_path=a.txt");
  assert.equal(steps[1].status, "cancelled");

  // 只计划未 ready 的调用（被去重拦下）不生成卡片
  ledger.emit("call.planned", { callId: "r1c0", tool: "file_edit", round: 1, data: { args: { file_path: "b.txt" } } });
  assert.equal(projectSteps(ledger).length, 2, "催办轮的计划不得投影成卡片");
  assert.equal(projectChat(ledger, 1).length, 0);
}

// ── 3. 收尾：final 只补终态字段，run.finished 带 rounds 与 stops ─
{
  const ledger = openRun({ conversationId: "conv-2", mode: "autopilot", budget: 8 });
  ledger.emit("round.started", { round: 3, data: {} });
  ledger.flush();
  posts.length = 0;
  await ledger.finish({ status: "cancelled", stops: "已手动停止" });
  const body = lastBody();
  assert.equal(body.run.final, true);
  assert.equal(body.run.status, "cancelled");
  assert.ok(body.run.endedAtMs >= ledger.startedAtMs);
  assert.equal(body.run.wallMs, body.run.endedAtMs - ledger.startedAtMs);
  const done = body.events.find(e => e.type === "run.finished");
  assert.equal(done.data.rounds, 4, "rounds 取最后一个有事件的轮次 + 1");
  assert.equal(done.data.stops, "已手动停止");
  assert.equal(done.data.status, "cancelled");
  // 收尾后账已关闭：再 emit 与再 finish 都不得产生新上行
  const posted = posts.length;
  ledger.emit("notice", { data: { kind: "late" } });
  await ledger.finish({ status: "completed" });
  assert.equal(posts.length, posted, "已收尾的账不得再落事件");
}

// ── 4. pagehide：页面要走时只补发终态，且带 keepalive ───────────
{
  posts.length = 0;
  const ledger = openRun({ conversationId: "conv-3", mode: "chat", budget: 20 });
  ledger.emit("round.started", { round: 0, data: {} });
  const pageHide = listeners.filter(([type]) => type === "pagehide").pop();
  assert.ok(pageHide, "openRun 必须挂 pagehide 监听");
  pageHide[1]();
  const { init } = posts[posts.length - 1];
  assert.equal(init.keepalive, true, "页面卸载的上行必须带 keepalive");
  const body = JSON.parse(init.body);
  assert.equal(body.run.final, true);
  assert.equal(body.run.status, "interrupted");
  assert.deepEqual(body.events.map(e => e.type), ["run.finished"], "只补发终态，不搬运在飞事件");
  assert.equal(body.events[0].data.stops, "页面已关闭");
  assert.equal(body.events[0].seq, 2, "seq 仍与常规批共用同一序空间");
  // 已关闭后再收 pagehide 不重复上报
  posts.length = 0;
  pageHide[1]();
  assert.equal(posts.length, 0);
}

console.log("agent_ledger.js 上行契约与投影守卫：通过");
