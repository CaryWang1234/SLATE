"""Agent 事件账本路由：一次工具循环（run）的事件按序落账。

前端 agent_ledger.js 把 kernel 观测到的 run/round/call 事件在轮次边界与收尾时
批量 POST 到这里，白板步骤卡与聊天工具卡片都是这份账的投影。

写入语义：
- 单事务 BEGIN IMMEDIATE —— app 内还有 scheduler 后台写者与可能的第二个 uvicorn server，
  并发只靠事务保证，不靠"应该没有第二个写者"的假设。
- INSERT OR IGNORE + UNIQUE(run_id, seq) —— 同一批重放即 no-op，前端可放心重试。
- runs 每批 upsert 且字段 COALESCE —— 只补不覆盖，收尾批把 final 置 1。

时间戳单位是 epoch 毫秒（前端 Date.now()），与 messages.created_at 的秒不同，列名以 _ms 结尾自证。
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter

from backend.routers.chat import _get_db

router = APIRouter(prefix="/events", tags=["events"])

MAX_EVENTS_PER_REQUEST = 500
MAX_PAYLOAD_CHARS = 8000


def _append_ledger_ddl(conn) -> None:
    """建表（幂等）。跟随 chat.py 惯例：每次调用都跑 CREATE TABLE IF NOT EXISTS。"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            conversation_id TEXT DEFAULT '',
            mode TEXT DEFAULT '',
            started_at_ms INTEGER DEFAULT 0,
            ended_at_ms INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            budget_rounds INTEGER DEFAULT 0,
            wall_ms INTEGER DEFAULT 0,
            final INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tool_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            type TEXT NOT NULL,
            call_id TEXT DEFAULT '',
            parent_call_id TEXT DEFAULT '',
            tool TEXT DEFAULT '',
            message_id TEXT DEFAULT '',
            payload TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tool_events_run ON tool_events(run_id, seq)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_events_seq ON tool_events(run_id, seq)")


def _upsert_run(conn, row: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO runs (run_id, conversation_id, mode, started_at_ms, ended_at_ms, "
        "status, budget_rounds, wall_ms, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(run_id) DO UPDATE SET "
        "conversation_id = COALESCE(NULLIF(excluded.conversation_id, ''), runs.conversation_id), "
        "mode = COALESCE(NULLIF(excluded.mode, ''), runs.mode), "
        "started_at_ms = CASE WHEN excluded.started_at_ms > 0 THEN excluded.started_at_ms ELSE runs.started_at_ms END, "
        "ended_at_ms = CASE WHEN excluded.ended_at_ms > 0 THEN excluded.ended_at_ms ELSE runs.ended_at_ms END, "
        "status = COALESCE(NULLIF(excluded.status, ''), runs.status), "
        "budget_rounds = CASE WHEN excluded.budget_rounds > 0 THEN excluded.budget_rounds ELSE runs.budget_rounds END, "
        "wall_ms = CASE WHEN excluded.wall_ms > 0 THEN excluded.wall_ms ELSE runs.wall_ms END, "
        "final = MAX(excluded.final, runs.final)",
        (
            row["run_id"],
            row["conversation_id"],
            row["mode"],
            _as_int(row["started_at_ms"]),
            _as_int(row["ended_at_ms"]),
            row["status"],
            _as_int(row["budget_rounds"]),
            _as_int(row["wall_ms"]),
            1 if row["final"] else 0,
        ),
    )


def _run_row(run: dict[str, Any], run_id: str) -> dict[str, Any]:
    """上行 camelCase → 列名 snake_case，一处映射。"""
    return {
        "run_id": run_id,
        "conversation_id": str(run.get("conversationId") or ""),
        "mode": str(run.get("mode") or ""),
        "started_at_ms": run.get("startedAtMs"),
        "ended_at_ms": run.get("endedAtMs"),
        "status": str(run.get("status") or ""),
        "budget_rounds": run.get("budgetRounds"),
        "wall_ms": run.get("wallMs"),
        "final": bool(run.get("final")),
    }


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _clip_payload(event: dict[str, Any]) -> str:
    data = event.get("data")
    if data is None:
        return ""
    try:
        text = json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError):
        text = json.dumps({"unserializable": str(data)[:500]}, ensure_ascii=False)
    if len(text) <= MAX_PAYLOAD_CHARS:
        return text
    return json.dumps(
        {"truncated": 1, "bytes": len(text), "digest": _as_str(data)[:500]},
        ensure_ascii=False,
    )


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


@router.post("/append")
async def append_events(body: dict[str, Any]) -> dict[str, Any]:
    """追加一批事件。响应只报写入了多少条，读端点属 P6。"""
    run = body.get("run") if isinstance(body.get("run"), dict) else {}
    run_id = str(run.get("runId") or body.get("runId") or "")
    events = body.get("events")
    if not run_id:
        return {"code": 1, "data": None, "message": "缺少 runId"}
    if not isinstance(events, list):
        return {"code": 1, "data": None, "message": "events 必须是数组"}

    events = events[:MAX_EVENTS_PER_REQUEST]
    conn = _get_db()
    conn.isolation_level = None  # 交回事务控制权，显式 BEGIN IMMEDIATE
    inserted = 0
    try:
        _append_ledger_ddl(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            _upsert_run(conn, _run_row(run, run_id))
            for event in events:
                if not isinstance(event, dict) or event.get("seq") is None or not event.get("type"):
                    continue
                cur = conn.execute(
                    "INSERT OR IGNORE INTO tool_events "
                    "(run_id, seq, ts, type, call_id, parent_call_id, tool, message_id, payload) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        run_id,
                        _as_int(event.get("seq")),
                        _as_int(event.get("ts")) or int(time.time() * 1000),
                        str(event["type"])[:64],
                        str(event.get("callId") or "")[:64],
                        str(event.get("parentCallId") or "")[:64],
                        str(event.get("tool") or "")[:64],
                        str(event.get("messageId") or "")[:64],
                        _clip_payload(event),
                    ),
                )
                inserted += cur.rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()

    return {
        "code": 0,
        "data": {
            "runId": run_id,
            "accepted": inserted,
            "dropped": max(0, len(body.get("events") or []) - len(events)),
        },
        "message": "ok",
    }
