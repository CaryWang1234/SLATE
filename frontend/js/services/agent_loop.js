/**
 * SLATE Agent 循环 kernel：桌面与移动共用的工具循环骨架
 *
 * kernel 只持有"骨架"：轮次与预算、abort/会话切换守卫、去重指纹与空转计数、
 * 工具标记剥离与落库时序、结果回灌的槽位、退出清理。
 * 平台差异全部经三个注入面对象交回调用方：
 *   io      —— 与后端/存储打交道的动作（探测调用、执行、落库、续写一轮）
 *   view    —— 与 DOM 打交道的动作（气泡重锚定、渲染、进度条、步骤卡、砚流进度）
 *   policy  —— 与产品策略打交道的决策（空轮如何推进、回灌文案、轮末是否退出）
 *
 * 事件账本同样在 kernel 里落：policy.openRun(run) 返回一个 ledger（agent_ledger.js 的实例，
 * mode 这类平台标签由 policy 决定），kernel 在轮次与调用的各节点 emit。
 * 于是聊天工具卡片与白板步骤卡是同一份账的投影，三端不必各落一遍。
 * io.execute 的 ctx 另带 ledger 与 callIdFor(i)：派生型工具（subagent_run）据此把
 * "谁派生了谁"记进同一份账，星图才画得出真边。
 *
 * 约定：policy 返回的模型可见字符串不被 t() 包裹（t() 只包用户可见文本）。
 */

import { state, addMessage } from "../store.js?v=20260921-001";
import { stripToolCalls } from "./tools.js?v=20260921-001";
import { _pendingToolMsgs } from "./agent_common.js?v=20260921-001";

export function createAgentLoop({ policy = {}, view = {}, io }) {
  const reasonOf = (key) => policy.exitReasons?.[key] ?? "";

  return async function runAgentLoop(opts) {
    const { signal = null, maxRounds, genConvId = null } = opts;
    const run = {
      opts, signal, maxRounds, genConvId,
      bubble: opts.bubble,
      round: 0, lastMsg: null, calls: [], results: [], cards: null, turn: null,
      prevCallsSig: "", dupRounds: 0, stallStreak: 0,
      nudged: false, successfulTool: false, exitReason: "",
      // exitKind 由 policy 在决定退出时标注："done"=走完完成通道，"stopped"=其余一切。
      // 上层据此区分"干完了"和"停下了"，不再把后者报成前者。
      exitKind: "",
      extra: policy.beginRun ? policy.beginRun(opts) : {},
    };
    const switched = () => genConvId !== null && state.currentConversationId !== genConvId;
    run.ledger = policy.openRun?.(run) ?? null;
    const ledger = run.ledger;
    const settledIds = new Set();
    const startedAt = new Map();

    const runEvent = (type, data) => {
      if (!ledger) return;
      ledger.emit(type, { messageId: run.lastMsg?.id || "", round: run.round, data });
    };
    const callEvent = (index, type, data) => {
      if (!ledger) return;
      const callId = ledger.callId(run.round, index);
      if (type === "call.finished") settledIds.add(callId);
      ledger.emit(type, {
        callId,
        tool: run.calls[index]?.name || "",
        messageId: run.lastMsg?.id || "",
        round: run.round,
        data,
      });
    };

    const readyCalls = [];
    runEvent("run.started", { budget: maxRounds });
    policy.onStart?.(run);
    let failure = null;
    try {
      for (let round = 0; round < maxRounds; round++) {
        run.round = round;
        if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }
        if (switched()) { run.exitReason = reasonOf("switched"); break; }

        const lastMsg = state.messages[state.messages.length - 1];
        if (!lastMsg || lastMsg.role !== "assistant") {
          // 队尾不是待处理的回复（异常收尾、被外部改写）：如实留痕，
          // 否则 finish() 会把它当成"轮数用尽"报给上层
          run.exitReason = reasonOf("noReply");
          break;
        }
        run.lastMsg = lastMsg;
        _pendingToolMsgs.add(lastMsg);
        runEvent("round.started");
        try {
          // 整表重渲染会让捕获的气泡脱离文档：重新锚定到活节点，本轮 DOM 写入才不落空
          const live = view.reanchorBubble?.(run.bubble, state.messages.length - 1);
          if (live) run.bubble = live;

          run.calls = io.detectCalls(lastMsg);
          run.nudged = false;
          for (let i = 0; i < run.calls.length; i++) callEvent(i, "call.planned", { args: run.calls[i].params });

          // 相同调用去重：与上一轮完全一致时不重复执行（避免无效副作用与空转耗尽轮数）
          if (run.calls.length > 0) {
            run.stallStreak = 0;
            const sig = JSON.stringify(run.calls.map(c => [c.name, c.params]));
            if (sig === run.prevCallsSig) {
              run.dupRounds++;
              const r = policy.dedupRound?.(run) ?? null;
              runEvent("notice", { kind: "dedup", dupRounds: run.dupRounds, text: r?.hiddenMsg?.content || r?.exitReason || "" });
              if (!r || r.action === "break") {
                if (r?.exitReason !== undefined) run.exitReason = r.exitReason;
                break;
              }
              if (r.hiddenMsg) addMessage(r.hiddenMsg);
              if (r.progressText !== undefined) view.setProgress?.(r.progressText);
              run.nudged = true;
            } else {
              run.dupRounds = 0;
            }
            run.prevCallsSig = sig;
          }

          if (run.calls.length === 0) {
            const r = policy.emptyRound?.(run) ?? { action: "break" };
            if (r.action === "break") {
              if (r.exitReason !== undefined) run.exitReason = r.exitReason;
              runEvent("notice", { kind: "round_exit", text: r.exitReason || "" });
              break;
            }
            runEvent("notice", { kind: r.kind || "nudge", text: r.hiddenMsg?.content || "" });
            if (r.hiddenMsg) addMessage(r.hiddenMsg);
            if (r.progressText !== undefined) view.setProgress?.(r.progressText);
            run.nudged = true;
            run.stallStreak++;
          }

          const progressText = policy.progressForRound?.(run);
          if (progressText !== undefined) view.setProgress?.(progressText);

          // 剥离工具标记后回显（模型标记不进正文）
          const cleanContent = stripToolCalls(run.lastMsg.content);
          run.lastMsg.content = cleanContent;
          view.renderBubble?.(run.bubble, cleanContent);

          if (!run.nudged) {
            policy.markActivity?.();
            for (let i = 0; i < run.calls.length; i++) {
              if (ledger) readyCalls.push({ callId: ledger.callId(run.round, i), round: run.round, tool: run.calls[i].name });
              callEvent(i, "call.ready");
            }
            run.cards = view.toolCards?.begin?.(run) ?? null;
            const progress = view.execProgress?.(run.bubble) ?? null;
            run.results = await io.execute(run.calls, {
              signal,
              // 账本 callId 交给执行器透传：派生型工具（subagent_run）据此把 spawn 边
              // 挂到自己的那一行上，星图才认得出谁派生了谁
              callIdFor: (i) => (ledger ? ledger.callId(run.round, i) : ""),
              ledger,
              onCallStart: (call, i) => {
                if (ledger) startedAt.set(ledger.callId(run.round, i), Date.now());
                callEvent(i, "call.started");
                progress?.onCallStart?.(call, i);
              },
              onEvent: (env, call, i) => progress?.onEvent?.(env, call, i),
              onCallEnd: (call, i, result) => {
                const callId = ledger ? ledger.callId(run.round, i) : "";
                const t0 = startedAt.get(callId) || Date.now();
                callEvent(i, "call.finished", {
                  call: run.calls[i],
                  // 与 executeToolCalls 落库的合并体同形，投影出来才和今天的 toolResults 一致
                  result: result === undefined ? undefined : { ...run.calls[i], ...result },
                  status: result === undefined ? "failed" : result.success === false ? "error" : "done",
                  durationMs: Math.max(0, Date.now() - t0),
                });
                progress?.onCallEnd?.(call, i, result);
              },
            });
            progress?.endAll?.(run.calls);
            if (run.results.some(result => result.success !== false)) run.successfulTool = true;
            policy.markActivity?.();
            if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }
            if (switched()) { run.exitReason = reasonOf("switched"); break; }

            await policy.postExec?.(run);
            await io.commitResults(run);
            view.toolCards?.finish?.(run);

            for (const msg of policy.buildFeeds(run) || []) addMessage(msg);
          }

          // 新建 assistant 气泡并流式续写（若期间已切换会话，则不向新会话注入幻影气泡）
          if (switched()) { run.exitReason = reasonOf("switched"); break; }
          run.turn = await io.streamTurn(run);
          if (run.turn?.bubble) run.bubble = run.turn.bubble;
          // 轮内 await 点（如上下文刷新）可能观测到 kernel 看不见的中止
          if (run.turn?.stop !== undefined) { run.exitReason = run.turn.stop; break; }
          if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }

          const r = await policy.endTurn?.(run);
          if (r?.bubble) run.bubble = r.bubble;
          if (r?.action === "break") {
            if (r.exitReason !== undefined) run.exitReason = r.exitReason;
            break;
          }
        } finally {
          runEvent("round.finished", {
            calls: run.calls.length,
            executedTotal: run.results.length,
            nudged: run.nudged,
            stopped: Boolean(run.exitReason),
          });
          ledger?.flush();
        }
      }
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      // 报到过 ready 却没跑完的调用（中止、异常、轮数耗尽）留痕为取消，账本里不留悬空步骤
      const by = signal?.aborted ? "user" : failure ? "error" : "run-end";
      if (ledger) {
        for (const c of readyCalls) {
          if (!settledIds.has(c.callId)) ledger.emit("call.cancelled", { callId: c.callId, tool: c.tool, round: c.round, messageId: run.lastMsg?.id || "", data: { by } });
        }
      }
      ledger?.finish({
        status: failure ? "error" : signal?.aborted ? "cancelled" : switched() ? "switched" : "completed",
        stops: run.exitReason || (failure ? String(failure?.message || failure) : ""),
      });
      try {
        policy.finish?.(run);
      } finally {
        // 无论以何种方式退出（abort / 去重拦截 / 会话切换 / 轮数上限 / 抛异常），
        // 都要解除渲染抑制，防止残留标记被渲染成伪造的"历史恢复"卡片。
        // 必须在 policy.finish 之后：其重渲染依赖抑制标记仍然生效
        _pendingToolMsgs.clear();
      }
    }
    return run;
  };
}
