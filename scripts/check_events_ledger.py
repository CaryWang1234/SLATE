"""事件账本写入语义守卫：幂等重放、runs upsert 只补不覆盖、并发无 database is locked、
团队会话（星图数据源）的落库与读图形状。

绕过 HTTP 直接 await 路由函数（FastAPI 路由就是普通 async 函数），
在临时 SLATE_DATA_DIR 上跑，不碰开发库。运行：python scripts/check_events_ledger.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="slate_ledger_check_")
os.environ["SLATE_DATA_DIR"] = _TMP  # 必须在 import backend 之前

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.routers.events import append_events, append_team, latest_team, read_team  # noqa: E402
from backend.routers.chat import DB_PATH  # noqa: E402


def _rows() -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM tool_events ORDER BY run_id, seq").fetchall()]
    finally:
        conn.close()


def _run_row(run_id: str) -> dict | None:
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _ev(seq: int, type_: str, **kw) -> dict:
    return {"seq": seq, "ts": 1_700_000_000_000 + seq, "type": type_, **kw}


async def main() -> None:
    # ── 1. 幂等重放：同批两次，第二次必须 no-op ──────────────
    batch = {
        "run": {"runId": "run_a1b2", "conversationId": "conv1", "mode": "target",
                "startedAtMs": 1_700_000_000_000, "budgetRounds": 8},
        "events": [_ev(1, "run.started"), _ev(2, "round.started"), _ev(3, "call.planned", tool="terminal")],
    }
    first = await append_events(batch)
    assert first["code"] == 0 and first["data"]["accepted"] == 3, first
    replay = await append_events(batch)
    assert replay["code"] == 0 and replay["data"]["accepted"] == 0, f"重放必须 no-op: {replay}"
    # 部分重叠：seq3 已存在，只有 seq4 入库
    overlap = await append_events({**batch, "events": [_ev(3, "call.planned", tool="terminal"), _ev(4, "call.ready")]})
    assert overlap["data"]["accepted"] == 1, overlap
    assert len(_rows()) == 4, _rows()

    # ── 2. runs upsert 只补不覆盖，final 不回退 ──────────────
    run = _run_row("run_a1b2")
    assert run["conversation_id"] == "conv1" and run["final"] == 0, run
    assert run["status"] == "", run
    final = await append_events({
        "run": {"runId": "run_a1b2", "endedAtMs": 1_700_000_009_000, "status": "done",
                "wallMs": 9000, "final": True},
        "events": [_ev(5, "run.finished")],
    })
    assert final["code"] == 0, final
    run = _run_row("run_a1b2")
    assert run["final"] == 1 and run["status"] == "done" and run["wall_ms"] == 9000, run
    assert run["conversation_id"] == "conv1" and run["budget_rounds"] == 8, run  # 稀疏批不得抹掉已知字段
    # 收尾之后再补一批发到 final=0 的批次，final 必须仍为 1
    await append_events({"run": {"runId": "run_a1b2", "final": False}, "events": [_ev(6, "notice")]})
    assert _run_row("run_a1b2")["final"] == 1, "final 不得回退"
    assert len(_rows()) == 6, len(_rows())

    # ── 3. 脏输入：缺 runId / events 非数组 / 非法条目 ────────
    assert (await append_events({"events": [_ev(1, "run.started")]}))["code"] == 1
    assert (await append_events({"run": {"runId": "run_x"}}))["code"] == 1
    dirty = await append_events({"run": {"runId": "run_x"}, "events": [_ev(1, "run.started"), {"type": "无 seq"}]})
    assert dirty["data"]["accepted"] == 1, dirty
    # 空批次合法：只把 runs 的终态补上（收尾时 pending 已被 flush 清空的情况）
    empty = await append_events({"run": {"runId": "run_x", "final": True, "status": "done"}, "events": []})
    assert empty["code"] == 0 and empty["data"]["accepted"] == 0, empty
    assert _run_row("run_x")["final"] == 1 and _run_row("run_x")["status"] == "done", _run_row("run_x")

    # ── 4. 超大 payload 落账前裁切 ───────────────────────────
    await append_events({
        "run": {"runId": "run_big"},
        "events": [_ev(1, "call.finished", callId="cal_0", tool="terminal",
                       data={"resultDigest": "x" * 20000, "bytes": 20000})],
    })
    payload = json.loads([r for r in _rows() if r["run_id"] == "run_big"][0]["payload"])
    assert payload.get("truncated") == 1 and payload["bytes"] > 8000, list(payload)[:4]

    # ── 5. 并发 4 路 append 不得 database is locked ──────────
    results = await asyncio.gather(*[
        append_events({"run": {"runId": f"run_c{i}"}, "events": [_ev(s, "call.started", tool="terminal") for s in range(1, 41)]})
        for i in range(4)
    ])
    assert all(r["code"] == 0 and r["data"]["accepted"] == 40 for r in results), results
    assert len({r["run_id"] for r in _rows() if r["run_id"].startswith("run_c")}) == 4

    # ── 6. 团队会话：名册去重/hue 收范围、发言幂等、只补不覆盖 ──
    roster = [
        {"id": "m_a", "name": "分析师", "role": "analyst", "modelId": "deepseek-flash", "hue": 40},
        {"id": "m_d", "name": "决策者", "role": "decider", "modelId": "gpt-5.6-sol", "hue": 720},
        {"id": "m_a", "name": "重复的名册项", "role": "member", "hue": 1},
        {"id": "", "name": "无 id 不上图", "role": "member", "hue": 2},
    ]
    session = {
        "id": "ts_1", "conversationId": "convT", "topic": "要不要换构建工具",
        "createdAtMs": 1_700_000_100_000, "status": "running", "members": roster,
    }
    turns = [
        {"seq": 1, "round": 1, "memberId": "m_a", "memberName": "分析师", "role": "analyst",
         "action": "propose", "runId": "run_t1", "text": "先说成本", "ts": 1_700_000_101_000},
        {"seq": 2, "round": 1, "memberId": "m_d", "memberName": "决策者", "role": "decider",
         "action": "rebut", "targetMemberId": "m_a", "runId": "run_t2", "text": "反驳", "ts": 1_700_000_102_000},
        # @ 到一个不在名册的名字：不得凭空造一颗星，也不得画一条边
        {"seq": 3, "round": 2, "memberId": "m_a", "memberName": "分析师", "role": "analyst",
         "action": "supplement", "targetMemberId": "ghost", "runId": "run_t1", "text": "补一句", "ts": 1_700_000_103_000},
    ]
    first_team = await append_team({"session": session, "turns": turns})
    assert first_team["code"] == 0 and first_team["data"]["accepted"] == 3, first_team
    replay_team = await append_team({"session": session, "turns": turns})
    assert replay_team["data"]["accepted"] == 0, f"同一 (session,seq) 重放必须 no-op: {replay_team}"
    assert (await append_team({"session": {"id": ""}, "turns": []}))["code"] == 1, "缺 session.id 必须拒"
    # 稀疏收尾批：只补终态，名册与议题不得被抹平
    await append_team({
        "session": {"id": "ts_1", "status": "decided", "rounds": 2, "endedAtMs": 1_700_000_109_000,
                    "verdictText": "不换", "summaryMarkdown": "## 结论", "members": []},
        "turns": [],
    })
    graph = (await latest_team("convT"))["data"]
    assert graph["session"]["id"] == "ts_1" and graph["session"]["status"] == "decided", graph["session"]
    assert graph["session"]["topic"] == "要不要换构建工具", "空字段不得覆盖已落的名册与议题"
    members = {m["id"]: m for m in graph["members"]}
    assert set(members) == {"m_a", "m_d"}, graph["members"]
    assert members["m_a"]["name"] == "分析师", "同 id 后到的名册项不得覆盖先到的"
    assert 0 <= members["m_d"]["hue"] < 360, members["m_d"]
    assert members["m_a"]["turns"] == 2 and members["m_d"]["turns"] == 1, "发言数按名册算"
    assert graph["edges"] == [{"from": "m_d", "to": "m_a", "kind": "reply", "weight": 1}], graph["edges"]
    assert len(graph["turns"]) == 3

    # ── 7. 星图叶子：一次调用只数一遍，spawn 边按 parent 非空认 ──
    async def _member_run(run_id: str, tools: list[str], spawns: list[tuple[str, str]]) -> None:
        events, seq = [], 0
        for i, tool in enumerate(tools):
            call_id = f"r0c{i}"
            seq += 1
            events.append(_ev(seq, "call.ready", callId=call_id, tool=tool))
        for i, (parent, label) in enumerate(spawns):
            seq += 1
            events.append(_ev(seq, "subagent.started", callId=f"{parent}s{i}", parentCallId=parent, tool=label))
            seq += 1
            # finished 也发一遍：读图若误用 finished，同一子代理会被数两遍
            events.append(_ev(seq, "subagent.finished", callId=f"{parent}s{i}", parentCallId=parent, tool=label))
        await append_events({"run": {"runId": run_id, "conversationId": "convT", "mode": "team"}, "events": events})

    await _member_run("run_t1", ["terminal", "code_search"], [("r0c0", "调研子代理")])
    await _member_run("run_t2", ["web_search"], [])
    graph = (await latest_team("convT"))["data"]
    leaves = {(l["memberId"], l["kind"], l["label"]): l["count"] for l in graph["leaves"]}
    assert leaves == {
        ("m_a", "tool", "terminal"): 1,
        ("m_a", "tool", "code_search"): 1,
        ("m_a", "subagent", "调研子代理"): 1,
        ("m_d", "tool", "web_search"): 1,
    }, leaves
    # 按 id 直读与按对话取最近一场必须给同一张图
    assert (await read_team("ts_1"))["data"]["edges"] == graph["edges"]
    # 对话之间不得串台
    assert (await latest_team("conv-other"))["data"] is None, "另一场对话不该看到这张图"
    # 不传 conversationId：退化成"最近一场"，仍要能出图（团队面板可以在没有会话时空开）
    assert (await latest_team(""))["data"]["session"]["id"] == "ts_1"

    print("events.py 账本写入语义：通过")


asyncio.run(main())
