"""Local desktop/web shared settings."""

from __future__ import annotations

import json
import os
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
        "knowledgeSettings",
    }
    data = {key: req.data.get(key) for key in allowed_keys if key in req.data}
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"code": 0, "data": data, "message": "ok"}
    except Exception as exc:
        return {"code": 1, "message": f"保存设置失败: {exc}"}
