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


# ── Better Project Understanding：项目扫描 ─────

class ScanRequest(BaseModel):
    level: str = "balanced"  # brief | balanced | detailed


# 三档扫描预算（写死）：目录深度 / 树条目上限 / 精读文件数 / 每文件行数
SCAN_LEVELS = {
    "brief":    {"depth": 2, "max_tree": 300,  "max_files": 6,  "head_lines": 40},
    "balanced": {"depth": 3, "max_tree": 600,  "max_files": 16, "head_lines": 70},
    "detailed": {"depth": 5, "max_tree": 1200, "max_files": 36, "head_lines": 110},
}

KEY_NAMES = {
    "readme.md", "readme", "readme.txt", "readme.rst",
    "package.json", "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg",
    "cargo.toml", "go.mod", "pom.xml", "build.gradle", "makefile", "cmakelists.txt",
    "dockerfile", "docker-compose.yml", "docker-compose.yaml", ".env.example",
    "rules.md", "qoder.md", "constitution.json", "slate.spec",
    "tsconfig.json", "vite.config.js", "vite.config.ts", "webpack.config.js",
    "index.html", "main.py", "app.py", "desktop.py", "main.js", "app.js", "index.js",
}


def _file_priority(rel: str, name: str, ext: str) -> int:
    """精读优先级：越小越重要"""
    low = name.lower()
    if low.startswith("readme"):
        return 0
    if low in KEY_NAMES:
        return 1
    if ext in (".md", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini"):
        return 2
    if ext in TEXT_EXTS:
        return 3
    return 9


@router.post("/understand/scan")
async def scan_project(req: ScanRequest):
    """全量扫描项目：目录树 + 关键文件头部内容，供 AI 生成导览与规则"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}
    budget = SCAN_LEVELS.get(req.level, SCAN_LEVELS["balanced"])
    project_dir = Path(_current_project["path"])

    tree_lines: list[str] = []
    files: list[tuple[str, str, str, int]] = []  # (rel, name, ext, size)
    truncated = False

    def walk(d: Path, depth: int, prefix: str) -> None:
        nonlocal truncated
        if truncated or depth > budget["depth"]:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError:
            return
        visible = [
            e for e in entries
            if not (e.name.startswith(".") and e.name != ".env")
            and not (e.is_dir() and e.name in IGNORE_DIRS)
        ]
        for i, entry in enumerate(visible):
            if len(tree_lines) >= budget["max_tree"]:
                truncated = True
                return
            last = i == len(visible) - 1
            branch = "└─ " if last else "├─ "
            tree_lines.append(f"{prefix}{branch}{entry.name}{'/' if entry.is_dir() else ''}")
            if entry.is_dir():
                walk(entry, depth + 1, prefix + ("   " if last else "│  "))
            elif entry.is_file():
                size = _safe_file_size(entry) or 0
                if size <= 2 * 1024 * 1024:  # 跳过超大文件
                    files.append(
                        (entry.relative_to(project_dir).as_posix(), entry.name, entry.suffix.lower(), size)
                    )

    tree_lines.append(project_dir.name + "/")
    walk(project_dir, 1, "")

    # 按优先级选出精读文件
    files.sort(key=lambda f: (_file_priority(f[0], f[1], f[2]), f[0]))
    heads: list[dict] = []
    for rel, name, ext, size in files[: budget["max_files"]]:
        if ext not in TEXT_EXTS:
            continue
        try:
            content = (project_dir / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = content.splitlines()
        head = "\n".join(lines[: budget["head_lines"]])
        if len(lines) > budget["head_lines"]:
            head += f"\n…（共 {len(lines)} 行，已截取开头）"
        heads.append({"path": rel, "content": head[:6000]})

    return {
        "code": 0,
        "data": {
            "project": _current_project["name"],
            "level": req.level if req.level in SCAN_LEVELS else "balanced",
            "tree": "\n".join(tree_lines),
            "truncated": truncated,
            "total_files": len(files),
            "heads": heads,
        },
    }
