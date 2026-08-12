"""Local desktop/web shared settings."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/settings", tags=["settings"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
STATE_PATH = DATA_DIR / "desktop_state.json"


class SharedStateRequest(BaseModel):
    data: dict[str, Any]


@router.get("/state")
async def get_shared_state():
    if not STATE_PATH.exists():
        return {"code": 0, "data": {}, "message": "ok"}
    try:
        return {
            "code": 0,
            "data": json.loads(STATE_PATH.read_text(encoding="utf-8")),
            "message": "ok",
        }
    except Exception as exc:
        return {"code": 1, "message": f"读取设置失败: {exc}"}


@router.put("/state")
async def save_shared_state(req: SharedStateRequest):
    allowed_keys = {
        "modelKeys",
        "customModels",
        "currentModelId",
        "autoReview",
        "outputSettings",
        "knowledgeSettings",
    }
    # 合并式写入：只更新本次提交的字段，避免漏传字段把已存设置抹掉
    existing: dict[str, Any] = {}
    if STATE_PATH.exists():
        try:
            existing = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                existing = {}
        except Exception:
            existing = {}
    data = {**existing}
    for key in allowed_keys:
        if key in req.data and req.data[key] is not None:
            data[key] = req.data[key]
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"code": 0, "data": data, "message": "ok"}
    except Exception as exc:
        return {"code": 1, "message": f"保存设置失败: {exc}"}


# ── 存储空间管理 ──────────────────────

def _path_size(path: Path) -> int:
    """文件/目录总字节数（不存在的返回 0，权限错误跳过）。"""
    try:
        if path.is_file():
            return path.stat().st_size
        if path.is_dir():
            total = 0
            for f in path.rglob("*"):
                try:
                    if f.is_file():
                        total += f.stat().st_size
                except OSError:
                    continue
            return total
    except OSError:
        pass
    return 0


@router.get("/storage")
async def storage_usage():
    """统计 data 目录各部分占用（存储空间管理面板用）。"""
    db_main = DATA_DIR / "chat_history.db"
    db_files = [db_main, DATA_DIR / "chat_history.db-wal", DATA_DIR / "chat_history.db-shm"]
    chat_size = sum(_path_size(p) for p in db_files)
    webview_size = _path_size(DATA_DIR / "webview_profile")
    skills_size = _path_size(DATA_DIR / "skills")
    state_size = _path_size(STATE_PATH)
    total = _path_size(DATA_DIR)
    other_size = max(0, total - chat_size - webview_size - skills_size - state_size)
    return {
        "code": 0,
        "data": {
            "total": total,
            "items": [
                {"key": "chat", "label": "对话历史数据库", "size": chat_size, "cleanable": True},
                {"key": "webview", "label": "内置浏览器缓存", "size": webview_size, "cleanable": True},
                {"key": "skills", "label": "自定义技能", "size": skills_size, "cleanable": False},
                {"key": "state", "label": "配置文件", "size": state_size, "cleanable": False},
                {"key": "other", "label": "其他（知识库/日志等）", "size": other_size, "cleanable": False},
            ],
        },
        "message": "ok",
    }


class CleanupRequest(BaseModel):
    target: str


@router.post("/storage/cleanup")
async def storage_cleanup(req: CleanupRequest):
    """清理指定目标：vacuum 压缩数据库 / history 清空全部对话 / webview 清理浏览器缓存。"""
    db_path = DATA_DIR / "chat_history.db"
    freed = 0
    try:
        if req.target in ("vacuum", "history") and not db_path.exists():
            return {"code": 0, "data": {"freed": 0}, "message": "ok"}
        if req.target == "vacuum":
            before = sum(_path_size(p) for p in (db_path, DATA_DIR / "chat_history.db-wal", DATA_DIR / "chat_history.db-shm"))
            # isolation_level=None（autocommit）：VACUUM 不能在隐式事务内执行
            conn = sqlite3.connect(str(db_path), timeout=10.0, isolation_level=None)
            try:
                conn.execute("VACUUM")
            finally:
                conn.close()
            freed = max(0, before - _path_size(db_path))
            return {"code": 0, "data": {"freed": freed}, "message": "ok"}

        if req.target == "history":
            before = sum(_path_size(p) for p in (db_path, DATA_DIR / "chat_history.db-wal", DATA_DIR / "chat_history.db-shm"))
            conn = sqlite3.connect(str(db_path), timeout=10.0, isolation_level=None)
            try:
                conn.execute("DELETE FROM messages")
                conn.execute("DELETE FROM conversations")
                conn.execute("VACUUM")
            finally:
                conn.close()
            freed = max(0, before - _path_size(db_path))
            return {"code": 0, "data": {"freed": freed}, "message": "ok"}

        if req.target == "webview":
            profile = DATA_DIR / "webview_profile"
            if not profile.exists():
                return {"code": 0, "data": {"freed": 0}, "message": "ok"}
            # 逐文件尝试删除：应用运行中被占用的文件会失败，跳过即可
            removed = 0
            for f in profile.rglob("*"):
                try:
                    if f.is_file():
                        size = f.stat().st_size
                        f.unlink()
                        removed += size
                except OSError:
                    continue
            # 清空残留的空目录
            for d in sorted((p for p in profile.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
                try:
                    d.rmdir()
                except OSError:
                    continue
            return {"code": 0, "data": {"freed": removed}, "message": "ok"}

        return {"code": 1, "message": f"未知清理目标: {req.target}"}
    except Exception as exc:
        return {"code": 1, "message": f"清理失败: {exc}"}
