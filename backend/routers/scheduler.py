"""定时任务路由 + 后台调度器。

任务持久化在 data/scheduled_tasks.json；后台协程每 30 秒检查一次，
触发时：创建 [定时] 专属会话 → 用 desktop_state.json 中的 API Key
调用 OpenAI 兼容模型 → 将用户提示词与模型回复归档进会话。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter

from backend.routers.chat import _get_db, add_message, create_conversation
from backend.routers.proxy import _find_model
from backend.routers.settings import STATE_PATH

router = APIRouter(prefix="/schedule", tags=["schedule"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
TASKS_PATH = DATA_DIR / "scheduled_tasks.json"

_loop_started = False
_running: set[str] = set()  # 正在执行中的任务 id，防止长任务被重复触发


# ── 持久化 ────────────────────────────────────

def _load_tasks() -> list[dict[str, Any]]:
    if not TASKS_PATH.exists():
        return []
    try:
        data = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_tasks(tasks: list[dict[str, Any]]) -> None:
    TASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    TASKS_PATH.write_text(json.dumps(tasks, ensure_ascii=False, indent=2), encoding="utf-8")


def _update_task(task: dict[str, Any]) -> None:
    tasks = _load_tasks()
    for i, t in enumerate(tasks):
        if t.get("id") == task.get("id"):
            tasks[i] = task
            break
    _save_tasks(tasks)


# ── 到期判断 ──────────────────────────────────

def _parse_hhmm(s: str) -> tuple[int, int] | None:
    try:
        h, m = str(s).split(":")
        h, m = int(h), int(m)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except Exception:
        pass
    return None


def _today_occurrence(hhmm: tuple[int, int]) -> datetime:
    now = datetime.now()
    return now.replace(hour=hhmm[0], minute=hhmm[1], second=0, microsecond=0)


def _should_run(task: dict[str, Any], now_ts: float) -> bool:
    mode = task.get("mode", "daily")
    last_run = task.get("last_run") or 0

    if mode == "interval":
        minutes = max(1, int(task.get("every_minutes") or 60))
        base = last_run or task.get("created_at") or now_ts
        return now_ts - base >= minutes * 60

    hhmm = _parse_hhmm(task.get("time", ""))
    if not hhmm:
        return False
    occ_ts = _today_occurrence(hhmm).timestamp()
    if now_ts < occ_ts:
        return False
    if mode == "once":
        return last_run == 0  # 只执行一次
    return last_run < occ_ts  # daily：今天的时间点尚未执行


# ── 任务执行 ──────────────────────────────────

def _finish_run(task: dict[str, Any], error: str | None = None, conversation_id: str | None = None) -> None:
    task["last_run"] = time.time()
    task["last_status"] = f"error: {error}" if error else "ok"
    if conversation_id:
        task["last_conversation_id"] = conversation_id
    if task.get("mode") == "once":
        task["enabled"] = False
    _update_task(task)


async def _run_task(task: dict[str, Any]) -> None:
    model_id = task.get("model_id", "")
    prompt = task.get("prompt", "")

    try:
        shared = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}
    except Exception:
        shared = {}

    api_key = (shared.get("modelKeys") or {}).get(model_id, "")
    if not api_key:
        _finish_run(task, error="未配置该模型的 API Key")
        return

    model = _find_model(model_id)
    base_url = model["base_url"] if model else None
    provider = model.get("provider") if model else "openai"
    if not base_url:
        for cm in shared.get("customModels") or []:
            if cm.get("id") == model_id:
                base_url = cm.get("base_url")
                provider = "openai"
                break
    if not base_url:
        _finish_run(task, error="找不到模型的 base_url")
        return
    if provider != "openai":
        _finish_run(task, error="定时任务目前仅支持 OpenAI 兼容模型")
        return

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": "你是 SLATE 的定时任务执行器。请直接、完整地执行用户给出的定时指令并输出结果，不要反问；结果有结构时用清晰的 Markdown 组织。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 8192,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(base_url.rstrip("/") + "/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not reply:
        _finish_run(task, error="模型返回为空")
        return

    # 归档到专属会话
    stamp = datetime.now().strftime("%m-%d %H:%M")
    title = f"[定时] {task.get('name') or '未命名'} · {stamp}"
    conv = await create_conversation({"title": title})
    conv_id = conv["data"]["id"]
    await add_message(conv_id, {"role": "user", "content": prompt, "model": ""})
    await add_message(conv_id, {"role": "assistant", "content": reply, "model": model_id})
    # add_message 会用首条用户消息覆盖标题，这里改回 [定时] 标题
    conn = _get_db()
    conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conv_id))
    conn.commit()
    conn.close()

    _finish_run(task, conversation_id=conv_id)


async def _guarded_run(task: dict[str, Any]) -> None:
    task_id = task.get("id", "")
    _running.add(task_id)
    try:
        await _run_task(task)
    except httpx.HTTPStatusError as exc:
        _finish_run(task, error=f"模型 API 错误 {exc.response.status_code}")
    except Exception as exc:
        _finish_run(task, error=str(exc))
    finally:
        _running.discard(task_id)


# ── 后台循环 ──────────────────────────────────

async def _tick() -> None:
    now_ts = time.time()
    for task in _load_tasks():
        if not task.get("enabled"):
            continue
        if task.get("id") in _running:
            continue
        if _should_run(task, now_ts):
            asyncio.create_task(_guarded_run(dict(task)))


async def _loop() -> None:
    while True:
        try:
            await _tick()
        except Exception:
            pass
        await asyncio.sleep(30)


def start_scheduler() -> None:
    global _loop_started
    if _loop_started:
        return
    _loop_started = True
    asyncio.create_task(_loop())


# ── API ───────────────────────────────────────

@router.get("/tasks")
async def list_tasks() -> dict[str, Any]:
    return {"code": 0, "data": _load_tasks(), "message": "ok"}


@router.post("/tasks")
async def create_task(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name", "")).strip()
    prompt = str(body.get("prompt", "")).strip()
    model_id = str(body.get("model_id", "")).strip()
    mode = body.get("mode", "daily")
    if mode not in ("once", "daily", "interval"):
        return {"code": 1, "message": "无效的执行方式"}
    if not name or not prompt or not model_id:
        return {"code": 1, "message": "名称、提示词、模型均必填"}
    if mode != "interval" and not _parse_hhmm(body.get("time", "")):
        return {"code": 1, "message": "请填写有效的执行时间（HH:MM）"}
    task = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "prompt": prompt,
        "model_id": model_id,
        "mode": mode,
        "time": body.get("time", "09:00") if mode != "interval" else "",
        "every_minutes": max(1, int(body.get("every_minutes") or 60)) if mode == "interval" else 0,
        "enabled": True,
        "created_at": time.time(),
        "last_run": None,
        "last_status": "",
        "last_conversation_id": "",
    }
    tasks = _load_tasks()
    tasks.append(task)
    _save_tasks(tasks)
    return {"code": 0, "data": task, "message": "ok"}


@router.patch("/tasks/{task_id}")
async def update_task(task_id: str, body: dict[str, Any]) -> dict[str, Any]:
    tasks = _load_tasks()
    target = next((t for t in tasks if t.get("id") == task_id), None)
    if not target:
        return {"code": 1, "message": "任务不存在"}
    allowed = {"name", "prompt", "model_id", "mode", "time", "every_minutes", "enabled"}
    for key in allowed:
        if key in body:
            target[key] = body[key]
    _save_tasks(tasks)
    return {"code": 0, "data": target, "message": "ok"}


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str) -> dict[str, Any]:
    tasks = [t for t in _load_tasks() if t.get("id") != task_id]
    _save_tasks(tasks)
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/tasks/{task_id}/run")
async def run_task_now(task_id: str) -> dict[str, Any]:
    target = next((t for t in _load_tasks() if t.get("id") == task_id), None)
    if not target:
        return {"code": 1, "message": "任务不存在"}
    if task_id in _running:
        return {"code": 1, "message": "任务正在执行中"}
    asyncio.create_task(_guarded_run(dict(target)))
    return {"code": 0, "data": None, "message": "已触发"}
