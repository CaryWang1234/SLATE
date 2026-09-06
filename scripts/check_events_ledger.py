"""事件账本写入语义守卫：幂等重放、runs upsert 只补不覆盖、并发无 database is locked。

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

from backend.routers.events import append_events  # noqa: E402
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

    print("events.py 账本写入语义：通过")


asyncio.run(main())
