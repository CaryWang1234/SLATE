"""项目管理路由：打开本地目录作为项目，每个项目拥有独立的宪法、配置和文件上下文。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/projects", tags=["projects"])

# 服务端当前项目状态（内存态，重启丢失）
_current_project: dict[str, Any] | None = None

IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", "dist", "build", ".next", ".nuxt", "target",
    ".slate",
}
TEXT_EXTS = {
    ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css",
    ".json", ".yaml", ".yml", ".xml", ".sh", ".bat", ".ps1", ".toml",
    ".ini", ".cfg", ".env", ".log", ".csv", ".sql", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
}


def _read_slate_config(project_dir: Path) -> dict:
    """读取 .slate/config.json"""
    config_path = project_dir / ".slate" / "config.json"
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _project_info(project_dir: Path, config: dict) -> dict:
    return {
        "path": str(project_dir),
        "name": project_dir.name,
        "config": config,
        "constitution": config.get("constitution"),
        "has_slate_dir": (project_dir / ".slate").is_dir(),
    }


def _safe_file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


# ── 请求模型 ──────────────────────────────────

class OpenProjectRequest(BaseModel):
    path: str


class UpdateConfigRequest(BaseModel):
    config: dict


class BrowseRequest(BaseModel):
    path: str = ""


class FindRequest(BaseModel):
    query: str
    limit: int = 30


# ── 路由 ──────────────────────────────────────

@router.post("/open")
async def open_project(req: OpenProjectRequest):
    """打开本地目录作为项目"""
    global _current_project
    p = Path(req.path).resolve()
    if not p.exists():
        return {"code": 1, "message": f"目录不存在: {p}"}
    if not p.is_dir():
        return {"code": 1, "message": "路径不是目录"}

    config = _read_slate_config(p)
    _current_project = _project_info(p, config)

    return {"code": 0, "data": _current_project}


@router.get("/current")
async def get_current_project():
    """获取当前项目"""
    if _current_project:
        return {"code": 0, "data": _current_project}
    return {"code": 0, "data": None}


@router.post("/close")
async def close_project():
    """关闭当前项目"""
    global _current_project
    _current_project = None
    return {"code": 0}


@router.put("/config")
async def update_project_config(req: UpdateConfigRequest):
    """更新项目配置（写入 .slate/config.json）"""
    global _current_project
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(_current_project["path"])
    slate_dir = project_dir / ".slate"
    slate_dir.mkdir(exist_ok=True)

    config_path = slate_dir / "config.json"
    config_path.write_text(
        json.dumps(req.config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    _current_project = _project_info(project_dir, req.config)

    return {"code": 0, "data": _current_project}


@router.post("/browse")
async def browse_files(req: BrowseRequest):
    """浏览项目目录（默认根目录）"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(_current_project["path"])
    sub = req.path.strip(".") if req.path else ""

    if sub:
        target = (project_dir / sub).resolve()
    else:
        target = project_dir

    # 安全检查：防止目录穿越
    try:
        target.relative_to(project_dir)
    except ValueError:
        return {"code": 1, "message": "路径超出项目范围"}

    if not target.exists():
        return {"code": 1, "message": "路径不存在"}

    if target.is_file():
        # 返回文件内容（文本文件）
        ext = target.suffix.lower()
        if ext in TEXT_EXTS or ext in {".svg"}:
            try:
                content = target.read_text(encoding="utf-8", errors="replace")
                return {
                    "code": 0,
                    "data": {
                        "type": "file",
                        "name": target.name,
                        "path": str(target.relative_to(project_dir)),
                        "size": _safe_file_size(target),
                        "content": content[:50000],
                    },
                }
            except Exception as e:
                return {"code": 1, "message": f"读取失败: {e}"}
        return {"code": 1, "message": "非文本文件"}

    # 目录列表
    entries = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except OSError:
        return {"code": 1, "message": "无权限访问"}

    for item in items:
        if item.name.startswith(".") and item.name != ".env":
            continue
        if item.is_dir() and item.name in IGNORE_DIRS:
            continue
        entries.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "path": str(item.relative_to(project_dir)),
            "size": _safe_file_size(item),
        })

    return {
        "code": 0,
        "data": {
            "type": "dir",
            "name": target.name,
            "path": str(target.relative_to(project_dir)) if target != project_dir else ".",
            "entries": entries,
        },
    }


@router.post("/find")
async def find_files(req: FindRequest):
    """按文件名或相对路径查找项目文件"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    query = (req.query or "").strip().lower()
    if not query:
        return {"code": 1, "message": "缺少查询条件"}

    project_dir = Path(_current_project["path"])
    limit = max(1, min(req.limit or 30, 100))
    matches = []

    stack = [project_dir]
    while stack and len(matches) < limit:
        current = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            continue
        for path in children:
            if len(matches) >= limit:
                break
            if path.name.startswith(".") and path.name != ".env":
                continue
            if path.is_dir() and path.name in IGNORE_DIRS:
                continue
            rel = path.relative_to(project_dir).as_posix()
            name = path.name.lower()
            rel_lower = rel.lower()
            if query == name or query in name or query in rel_lower:
                matches.append({
                    "name": path.name,
                    "type": "dir" if path.is_dir() else "file",
                    "path": rel,
                    "size": _safe_file_size(path),
                })
            if path.is_dir():
                stack.append(path)

    return {"code": 0, "data": {"query": req.query, "matches": matches}}


@router.get("/drives")
async def list_drives():
    """列出系统磁盘（Windows）或根目录（Linux/macOS）"""
    import os
    import string

    drives = []
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            drive = Path(f"{letter}:\\")
            if drive.exists():
                drives.append({"path": str(drive), "name": f"{letter}:"})
    else:
        drives.append({"path": "/", "name": "/"})
        home = Path.home()
        if home.exists():
            drives.append({"path": str(home), "name": "~ (Home)"})

    return {"code": 0, "data": drives}


# ── 文件编辑（接受 diff） ───────────────────────

class ApplyEditRequest(BaseModel):
    file_path: str
    content: str


@router.post("/apply-edit")
async def apply_file_edit(req: ApplyEditRequest):
    """将编辑后的内容写入文件（用户点击「接受」时调用）"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(_current_project["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if not target.is_file():
        return {"code": 1, "message": "文件不存在"}

    try:
        target.write_text(req.content, encoding="utf-8")
        return {"code": 0, "data": {"file": str(target.relative_to(project_dir))}, "message": "ok"}
    except Exception as e:
        return {"code": 1, "message": f"写入失败: {e}"}


# ── 创建新文件 ─────────────────────────────

class CreateFileRequest(BaseModel):
    file_path: str
    content: str


@router.post("/create-file")
async def create_file(req: CreateFileRequest):
    """创建新文件（用户点击「接受」时调用）"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(_current_project["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if target.exists():
        return {"code": 1, "message": "文件已存在"}

    try:
        # 自动创建父目录
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(req.content, encoding="utf-8")
        return {"code": 0, "data": {"file": str(target.relative_to(project_dir))}, "message": "ok"}
    except Exception as e:
        return {"code": 1, "message": f"创建失败: {e}"}
