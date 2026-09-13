# -*- coding: utf-8 -*-
"""Actions 路由：data/actions/<id>.yml，一文件一份流程说明书。

设计见 ACTIONS-DESIGN.md。P0 是读（目录、详情、试校验），P1 补上写：
整份覆盖写入、删除、以及 `.history/` 留底与回滚。写入口本身不设二次确认——
用户侧的审批门在前端（面板编辑器 + `actions_write` 工具都要人明示点确认），
后端保证的是「进来的东西必须能解析」，以及「覆盖/删除之前必先留底」。

不抛 500：所有失败都回 {code:-1, message:中文}（与 diagnostics 同口径），
否则前端只会看到一个没有上下文的请求错误。
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.data_io import atomic_write_text
from backend.skills.code_scan import SECRET_PATTERNS
from backend.slate_yaml import (
    MAX_FILE_BYTES,
    SayError,
    load_action,
    parse,
    validate_action,
    ACTION_ID_RE,
)

router = APIRouter(prefix="/actions", tags=["actions"])
logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
ACTIONS_DIR = DATA_DIR / "actions"
HISTORY_DIR = ACTIONS_DIR / ".history"
HISTORY_KEEP = 5
# 留底时间戳定宽，字典序即时序；restore 入参先按这条正则消毒，再谈拼路径
HISTORY_TS_RE = re.compile(r"^\d{8}T\d{6}(?:-\d{1,2})?$")


class ActionDraft(BaseModel):
    content: str = ""


class ActionRestore(BaseModel):
    ts: str = ""


def _clean_id(raw: Any) -> str:
    """先消毒再拼路径：不合法直接返回空串，绝不拿去 join。"""
    text = str(raw or "").strip()
    return text if ACTION_ID_RE.match(text) else ""


def _action_path(clean_id: str) -> Path | None:
    """解析后必须仍在 data/actions 内，挡住 ../ 与符号链接外逃。"""
    if not clean_id:
        return None
    base = ACTIONS_DIR.resolve()
    target = (base / f"{clean_id}.yml").resolve()
    return target if target.parent == base else None


def _read_source(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise SayError(f"文件超过 {MAX_FILE_BYTES} 字节上限")
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise SayError(f"读取失败：{exc.__class__.__name__}") from exc


def _secret_warnings(text: str) -> list[str]:
    """明文凭证不阻断写入，但必须说清楚：Action 会长期进系统提示，等于把 Key 摆给模型。
    正则口径直接复用 code_scan，两处各写一份必然漂移。"""
    return sorted({
        f"内容疑似「{rule.category}」（{rule.description}）。Action 会注入系统提示，建议改成引用环境变量或文件位置，不要写明文"
        for rule in SECRET_PATTERNS if rule.pattern.search(text)
    })


def _history_path(clean_id: str, raw_ts: Any) -> Path | None:
    """ts 先过正则再拼路径，解析后仍须留在 .history 内。"""
    ts = str(raw_ts or "").strip()
    if not clean_id or not HISTORY_TS_RE.match(ts):
        return None
    base = HISTORY_DIR.resolve()
    target = (base / f"{clean_id}.{ts}.yml").resolve()
    return target if target.parent == base else None


def _history_versions(clean_id: str) -> list[dict[str, Any]]:
    if not clean_id or not HISTORY_DIR.is_dir():
        return []
    prefix = f"{clean_id}."
    out: list[dict[str, Any]] = []
    for entry in HISTORY_DIR.iterdir():
        if not entry.is_file() or not entry.name.endswith(".yml") or not entry.name.startswith(prefix):
            continue
        ts = entry.name[:-4][len(prefix):]
        if not HISTORY_TS_RE.match(ts):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        out.append({"ts": ts, "bytes": size})
    out.sort(key=lambda item: item["ts"], reverse=True)
    return out


def _prune_history(clean_id: str) -> None:
    for entry in _history_versions(clean_id)[HISTORY_KEEP:]:
        try:
            path = _history_path(clean_id, entry["ts"])
            if path:
                path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Action %s 旧留底清理失败: %s", clean_id, exc)


def _backup(clean_id: str, path: Path) -> str:
    """覆盖/删除前留底，返回留底时间戳（没有旧文件则空串）。

    留底失败绝不允许把写入也一起废掉——用户点了保存就该落盘；但也不假装留了底。
    """
    if not path.is_file():
        return ""
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("Action %s 留底读取失败: %s", clean_id, exc)
        return ""
    try:
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        target = HISTORY_DIR / f"{clean_id}.{stamp}.yml"
        suffix = 1
        while target.exists():
            target = HISTORY_DIR / f"{clean_id}.{stamp}-{suffix}.yml"
            suffix += 1
        atomic_write_text(target, source)
    except OSError as exc:
        logger.warning("Action %s 留底写入失败: %s", clean_id, exc)
        return ""
    _prune_history(clean_id)
    return target.name[:-4][len(clean_id) + 1:]


def _write_action(clean_id: str, text: str, *, note: str) -> dict[str, Any]:
    """PUT 与回滚共用的唯一落盘路径：体积 → 解析 → 留底 → 原子写。
    两条入口分开写两遍的话，早晚会有一条偷偷少做一次校验。"""
    path = _action_path(clean_id)
    if not path:
        return {"code": -1, "data": None, "message": "Action 路径不合法"}
    size = len(text.encode("utf-8"))
    if size > MAX_FILE_BYTES:
        return {"code": -1, "data": None, "message": f"内容 {size} 字节，超过 {MAX_FILE_BYTES} 字节上限"}
    try:
        spec, warnings = load_action(text, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"Action {clean_id} 校验未通过：{exc}"}
    created = not path.is_file()
    try:
        backed_up = _backup(clean_id, path)
        atomic_write_text(path, text)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"写入失败：{exc.__class__.__name__}"}
    return {
        "code": 0,
        "data": {
            "id": clean_id,
            "path": str(path),
            "created": created,
            "stepCount": len(spec["steps"]),
            "inputCount": len(spec["inputs"]),
            "warnings": [*warnings, *_secret_warnings(text)],
            "backedUp": backed_up,
        },
        "message": note,
    }


def _describe(clean_id: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": clean_id,
        "name": spec["name"],
        "description": spec["description"],
        "when": spec["when"],
        "tags": spec["tags"],
        "author": spec["author"],
        "stepCount": len(spec["steps"]),
        "inputCount": len(spec["inputs"]),
    }


def _load_all() -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """返回 (可用 Action 摘要, 解析失败的文件)。失败的文件必须露出来，
    否则用户改坏一个 yml 只会看到它凭空消失。"""
    specs: list[dict[str, Any]] = []
    broken: list[dict[str, str]] = []
    if not ACTIONS_DIR.is_dir():
        return specs, broken
    for entry in sorted(ACTIONS_DIR.glob("*.yml")):
        clean_id = _clean_id(entry.stem)
        if not clean_id:
            broken.append({"id": entry.name, "error": "文件名不合法：只允许小写字母开头的 a-z0-9_-"})
            continue
        try:
            spec, _warnings = load_action(_read_source(entry), action_id=clean_id)
        except SayError as exc:
            broken.append({"id": clean_id, "error": str(exc) or exc.reason})
            continue
        except Exception as exc:  # 解析器不该有未穷尽路径，兜住以免一个坏文件拖垮整个面板
            logger.warning("Action %s 解析异常: %s", clean_id, exc)
            broken.append({"id": clean_id, "error": f"解析异常：{exc.__class__.__name__}"})
            continue
        specs.append(_describe(clean_id, spec))
    return specs, broken


@router.get("")
async def list_actions() -> dict[str, Any]:
    """Action 目录（只给摘要，正文按 id 另取）。"""
    specs, broken = _load_all()
    return {
        "code": 0,
        "data": {"path": str(ACTIONS_DIR), "actions": specs, "broken": broken},
        "message": "ok",
    }


@router.post("/validate")
async def validate_draft(body: ActionDraft) -> dict[str, Any]:
    """试校验一段草稿：不落盘，供编辑器实时报错定位到行。"""
    text = str(body.content or "")
    try:
        spec, warnings = validate_action(parse(text))
    except SayError as exc:
        return {
            "code": 0,
            "data": {"ok": False, "errors": [{"line": exc.line, "reason": exc.reason}], "warnings": []},
            "message": "校验未通过",
        }
    return {
        "code": 0,
        "data": {"ok": True, "errors": [], "warnings": [*warnings, *_secret_warnings(text)], "action": spec},
        "message": "ok",
    }


@router.get("/{action_id}")
async def get_action(action_id: str) -> dict[str, Any]:
    """单个 Action 的完整结构 + 原文（面板与 actions_read 工具共用）。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    path = _action_path(clean_id)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"Action 不存在: {clean_id}"}
    try:
        source = _read_source(path)
        spec, warnings = load_action(source, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"Action {clean_id} 无法解析：{exc}"}
    return {
        "code": 0,
        "data": {"action": spec, "raw": source, "path": str(path), "warnings": warnings},
        "message": "ok",
    }


@router.put("/{action_id}")
async def put_action(action_id: str, body: ActionDraft) -> dict[str, Any]:
    """整份覆盖写入一个 Action（面板保存与 actions_write 共用）。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    return _write_action(clean_id, str(body.content or ""), note="已写入")


@router.delete("/{action_id}")
async def delete_action(action_id: str) -> dict[str, Any]:
    """删除一份 Action：先留底再删，给用户留「我反悔了」的出口。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    path = _action_path(clean_id)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"Action 不存在: {clean_id}"}
    backed_up = _backup(clean_id, path)
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"删除失败：{exc.__class__.__name__}"}
    return {
        "code": 0,
        "data": {"removed": clean_id, "backedUp": backed_up, "path": str(HISTORY_DIR)},
        "message": "已删除",
    }


@router.get("/{action_id}/history")
async def list_history(action_id: str) -> dict[str, Any]:
    """某份 Action 的留底清单（最新在前）。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    return {
        "code": 0,
        "data": {"id": clean_id, "keep": HISTORY_KEEP, "versions": _history_versions(clean_id)},
        "message": "ok",
    }


@router.get("/{action_id}/history/{ts}")
async def read_history(action_id: str, ts: str) -> dict[str, Any]:
    """读一个留底的原文：回滚前得让人看清楚要恢复什么。"""
    clean_id = _clean_id(action_id)
    path = _history_path(clean_id, ts)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean_id} @ {ts}"}
    try:
        source = _read_source(path)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    return {
        "code": 0,
        "data": {"id": clean_id, "ts": ts, "content": source, "bytes": len(source.encode("utf-8"))},
        "message": "ok",
    }


@router.post("/{action_id}/history/restore")
async def restore_history(action_id: str, body: ActionRestore) -> dict[str, Any]:
    """回滚到某个留底。回滚也是写：解析不了的旧版本不许直接盖回去。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    path = _history_path(clean_id, body.ts)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean_id} @ {body.ts}"}
    try:
        source = _read_source(path)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    try:
        load_action(source, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"该历史版本已无法解析，不回滚：{exc}"}
    return _write_action(clean_id, source, note="已回滚")
