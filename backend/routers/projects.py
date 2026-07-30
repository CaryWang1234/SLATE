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


# ── 请求模型 ──────────────────────────────────

class OpenProjectRequest(BaseModel):
    path: str


class UpdateConfigRequest(BaseModel):
    config: dict


class BrowseRequest(BaseModel):
    path: str = ""


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
                        "size": target.stat().st_size,
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
    except PermissionError:
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
            "size": item.stat().st_size if item.is_file() else None,
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
