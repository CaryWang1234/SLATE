"""项目管理路由：打开本地目录作为项目，每个项目拥有独立的宪法、配置和文件上下文。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.subprocess_utils import hidden_subprocess_kwargs
from backend.skills.text_io import read_text_file, write_text_file

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
TEXT_NAMES = {
    ".env", ".env.example", ".gitignore", ".gitattributes", ".dockerignore",
    ".editorconfig", ".npmrc", ".python-version", ".node-version",
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


def _normalize_project_subpath(path: str | None) -> str:
    """Keep real dot-prefixed names while treating empty, dot, and dot-slash as project root."""
    raw = (path or "").strip().replace("\\", "/")
    return "" if raw in {"", ".", "./"} else raw


def _is_ignored_project_entry(path: Path) -> bool:
    """Hide only explicit noisy/generated directories; keep project dotfiles such as .github."""
    return path.is_dir() and path.name in IGNORE_DIRS


def _is_text_project_file(path: Path) -> bool:
    return path.suffix.lower() in TEXT_EXTS or path.name.lower() in TEXT_NAMES


def _run_git(project_dir: Path, args: list[str], timeout: int = 10) -> tuple[int, str, str]:
    result = subprocess.run(
        ["git", *args],
        cwd=project_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        **hidden_subprocess_kwargs(),
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _split_git_record(line: str) -> list[str]:
    return line.split("\x1f")


def _parse_porcelain_status(text: str) -> dict[str, list[dict[str, str]]]:
    staged: list[dict[str, str]] = []
    unstaged: list[dict[str, str]] = []
    untracked: list[dict[str, str]] = []
    for raw in text.splitlines():
        if not raw or raw.startswith("##"):
            continue
        xy = raw[:2]
        path = raw[3:].strip()
        if not path:
            continue
        item = {"status": xy.strip() or "?", "path": path}
        if xy == "??":
            untracked.append(item)
            continue
        if xy[0] != " ":
            staged.append({"status": xy[0], "path": path})
        if xy[1] != " ":
            unstaged.append({"status": xy[1], "path": path})
    return {"staged": staged, "unstaged": unstaged, "untracked": untracked}


def _parse_worktrees(text: str) -> list[dict[str, str | bool]]:
    worktrees: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] = {}
    for line in [*text.splitlines(), ""]:
        if not line:
            if current:
                worktrees.append(current)
                current = {}
            continue
        if line.startswith("worktree "):
            current["path"] = line.removeprefix("worktree ").strip()
        elif line.startswith("HEAD "):
            current["head"] = line.removeprefix("HEAD ").strip()[:12]
        elif line.startswith("branch "):
            current["branch"] = line.removeprefix("branch ").strip().removeprefix("refs/heads/")
        elif line == "bare":
            current["bare"] = True
        elif line == "detached":
            current["detached"] = True
    return worktrees


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
    sub = _normalize_project_subpath(req.path)

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
        if _is_text_project_file(target) or target.suffix.lower() in {".svg"}:
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
        if _is_ignored_project_entry(item):
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


# ── Code Review：Git Diff 读取与解析 ──────────

class ReviewDiffRequest(BaseModel):
    mode: str = "unstaged"           # staged | unstaged | commit
    from_commit: str = ""            # for mode=commit
    to_commit: str = "HEAD"          # for mode=commit
    max_lines: int = 8000            # safety cap


def _parse_unified_diff(diff_text: str) -> list[dict]:
    """Parse unified diff into structured per-file data with line numbers."""
    files: list[dict] = []
    current_file: dict | None = None
    current_chunk: dict | None = None
    old_line = 0
    new_line = 0

    for raw_line in diff_text.splitlines():
        # File header
        if raw_line.startswith("diff --git"):
            current_file = None
            current_chunk = None
            continue
        if raw_line.startswith("--- a/"):
            current_file = {"file": raw_line[6:], "changes": []}
            files.append(current_file)
            continue
        if raw_line.startswith("+++ b/"):
            if current_file:
                current_file["file"] = raw_line[6:]
            continue

        # Hunk header
        if raw_line.startswith("@@"):
            if current_file is None:
                continue
            parts = raw_line.split("@@")
            if len(parts) >= 3:
                ranges = parts[1].strip().split()
                old_start = int(ranges[0].split(",")[0].lstrip("-")) if ranges else 1
                new_start = int(ranges[1].split(",")[0].lstrip("+")) if len(ranges) > 1 else 1
                old_line = old_start
                new_line = new_start
                current_chunk = {
                    "old_start": old_start,
                    "new_start": new_start,
                    "lines": [],
                }
                current_file["changes"].append(current_chunk)
            continue

        # Diff content lines
        if current_chunk is None:
            continue
        if raw_line.startswith("+"):
            current_chunk["lines"].append({"type": "add", "old_line": None, "new_line": new_line, "content": raw_line[1:]})
            new_line += 1
        elif raw_line.startswith("-"):
            current_chunk["lines"].append({"type": "del", "old_line": old_line, "new_line": None, "content": raw_line[1:]})
            old_line += 1
        elif raw_line.startswith(" "):
            current_chunk["lines"].append({"type": "ctx", "old_line": old_line, "new_line": new_line, "content": raw_line[1:]})
            old_line += 1
            new_line += 1

    return files


@router.post("/review/diff")
async def review_diff(req: ReviewDiffRequest):
    """Read git diff from project directory and return structured parse result."""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}
    project_dir = Path(_current_project["path"])

    # Verify it's a git repo
    try:
        subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=project_dir, capture_output=True, timeout=10, check=True,
            **hidden_subprocess_kwargs(),
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return {"code": 1, "message": "该项目不是 Git 仓库"}

    # Build git diff command
    if req.mode == "staged":
        cmd = ["git", "diff", "--cached", "-U3"]
    elif req.mode == "commit":
        if not req.from_commit:
            return {"code": 1, "message": "commit 模式需要指定 from_commit"}
        cmd = ["git", "diff", "-U3", req.from_commit, req.to_commit or "HEAD"]
    else:  # unstaged
        cmd = ["git", "diff", "-U3"]

    try:
        result = subprocess.run(
            cmd, cwd=project_dir, capture_output=True, text=True, timeout=30,
            **hidden_subprocess_kwargs(),
        )
        diff_text = result.stdout
    except subprocess.TimeoutExpired:
        return {"code": 1, "message": "git diff 超时（30s）"}
    except Exception as e:
        return {"code": 1, "message": f"git diff 失败: {e}"}

    if not diff_text.strip():
        return {"code": 0, "data": {"files": [], "raw": "", "total_changes": 0, "message": "无变更"}, "message": "ok"}

    # Safety cap
    lines = diff_text.splitlines()
    truncated = len(lines) > req.max_lines
    if truncated:
        diff_text = "\n".join(lines[:req.max_lines])

    files = _parse_unified_diff(diff_text)

    # Count changes
    total_add = sum(
        1 for f in files for c in f["changes"] for ln in c["lines"] if ln["type"] == "add"
    )
    total_del = sum(
        1 for f in files for c in f["changes"] for ln in c["lines"] if ln["type"] == "del"
    )

    return {
        "code": 0,
        "data": {
            "files": files,
            "raw": diff_text[:200000],
            "total_files": len(files),
            "total_add": total_add,
            "total_del": total_del,
            "total_changes": total_add + total_del,
            "truncated": truncated,
            "mode": req.mode,
        },
        "message": "ok",
    }


@router.get("/git/graph")
async def git_graph() -> dict[str, Any]:
    """Return a read-only Git graph for the currently opened project."""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}
    project_dir = Path(_current_project["path"])

    try:
        code, root, err = _run_git(project_dir, ["rev-parse", "--show-toplevel"])
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"code": 1, "message": "该项目不是 Git 仓库"}
    if code != 0:
        return {"code": 1, "message": f"该项目不是 Git 仓库: {err or project_dir}"}

    repo_dir = Path(root)
    _code, current_branch, _err = _run_git(repo_dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    _code, head_full, _err = _run_git(repo_dir, ["rev-parse", "HEAD"])
    _code, status_text, _err = _run_git(repo_dir, ["status", "--porcelain=v1", "-b"])
    status = _parse_porcelain_status(status_text)

    _code, branch_text, _err = _run_git(
        repo_dir,
        [
            "branch",
            "--format=%(refname:short)\x1f%(objectname:short)\x1f%(upstream:short)\x1f%(upstream:trackshort)\x1f%(HEAD)",
        ],
    )
    branches = []
    for line in branch_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) < 5:
            continue
        branches.append({
            "name": parts[0],
            "hash": parts[1],
            "upstream": parts[2],
            "track": parts[3],
            "current": parts[4] == "*",
        })

    _code, remote_branch_text, _err = _run_git(
        repo_dir,
        ["branch", "-r", "--format=%(refname:short)\x1f%(objectname:short)"],
    )
    remote_branches = []
    for line in remote_branch_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) >= 2 and "HEAD" not in parts[0]:
            remote_branches.append({"name": parts[0], "hash": parts[1]})

    _code, remote_text, _err = _run_git(repo_dir, ["remote", "-v"])
    remotes: dict[str, dict[str, str]] = {}
    for line in remote_text.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            entry = remotes.setdefault(parts[0], {})
            direction = parts[2].strip("()")
            entry[direction] = parts[1]

    _code, tag_text, _err = _run_git(
        repo_dir,
        ["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:short)"],
    )
    tags = []
    for line in tag_text.splitlines()[:40]:
        parts = _split_git_record(line)
        if len(parts) >= 2:
            tags.append({"name": parts[0], "hash": parts[1], "date": parts[2] if len(parts) > 2 else ""})

    _code, stash_text, _err = _run_git(repo_dir, ["stash", "list", "--format=%gd\x1f%h\x1f%cr\x1f%s"])
    stashes = []
    for line in stash_text.splitlines()[:20]:
        parts = _split_git_record(line)
        if len(parts) >= 4:
            stashes.append({"name": parts[0], "hash": parts[1], "date": parts[2], "subject": parts[3]})

    _code, worktree_text, _err = _run_git(repo_dir, ["worktree", "list", "--porcelain"])
    worktrees = _parse_worktrees(worktree_text)

    _code, log_text, _err = _run_git(
        repo_dir,
        [
            "log",
            "--all",
            "--decorate=short",
            "--date=format:%Y-%m-%d %H:%M",
            "--pretty=format:%h\x1f%H\x1f%p\x1f%D\x1f%an\x1f%ad\x1f%s",
            "--max-count=40",
        ],
        timeout=20,
    )
    commits = []
    for line in log_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) < 7:
            continue
        commits.append({
            "hash": parts[0],
            "full_hash": parts[1],
            "parents": [p[:7] for p in parts[2].split() if p],
            "refs": parts[3],
            "author": parts[4],
            "date": parts[5],
            "subject": parts[6],
        })

    upstream = ""
    ahead = behind = 0
    unpushed = []
    code, upstream_text, _err = _run_git(repo_dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    if code == 0 and upstream_text:
        upstream = upstream_text
        code, counts, _err = _run_git(repo_dir, ["rev-list", "--left-right", "--count", f"{upstream}...HEAD"])
        if code == 0:
            vals = counts.split()
            if len(vals) >= 2:
                behind = int(vals[0] or 0)
                ahead = int(vals[1] or 0)
        code, unpushed_text, _err = _run_git(
            repo_dir,
            [
                "log",
                f"{upstream}..HEAD",
                "--date=format:%Y-%m-%d %H:%M",
                "--pretty=format:%h\x1f%H\x1f%an\x1f%ad\x1f%s",
                "--max-count=20",
            ],
        )
        if code == 0:
            for line in unpushed_text.splitlines():
                parts = _split_git_record(line)
                if len(parts) >= 5:
                    unpushed.append({
                        "hash": parts[0],
                        "full_hash": parts[1],
                        "author": parts[2],
                        "date": parts[3],
                        "subject": parts[4],
                    })

    return {
        "code": 0,
        "message": "ok",
        "data": {
            "repo": str(repo_dir),
            "project_path": str(project_dir),
            "current_branch": current_branch,
            "head": head_full[:12],
            "upstream": upstream,
            "ahead": ahead,
            "behind": behind,
            "branches": branches,
            "remote_branches": remote_branches,
            "remotes": remotes,
            "tags": tags,
            "stashes": stashes,
            "worktrees": worktrees,
            "status": status,
            "unpushed": unpushed,
            "commits": commits,
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
            if _is_ignored_project_entry(path):
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
        existing = read_text_file(target)
        written = write_text_file(target, req.content, existing.encoding)
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
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
        written = write_text_file(target, req.content, "utf-8")
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
    except Exception as e:
        return {"code": 1, "message": f"创建失败: {e}"}


# ── 追加内容到已有文件（超长文件分段写入 / 截断续写兜底） ─────


class AppendFileRequest(BaseModel):
    file_path: str
    content: str


@router.post("/append-file")
async def append_file(req: AppendFileRequest):
    """向已有文件末尾追加内容（用户点击「接受」时调用）"""
    if not _current_project:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(_current_project["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if not target.exists():
        return {"code": 1, "message": "文件不存在，请先用 file_create 创建"}

    try:
        existing = read_text_file(target)
        written = write_text_file(target, existing.content + req.content, existing.encoding)
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
    except Exception as e:
        return {"code": 1, "message": f"追加失败: {e}"}


# ── Better Project Understanding：项目扫描 ─────

class ScanRequest(BaseModel):
    level: str = "balanced"  # brief | balanced | detailed


# 三档扫描预算（写死）：目录深度 / 树条目上限 / 精读文件数 / 每文件行数
SCAN_LEVELS = {
    "brief":    {"depth": 2, "scan_depth": 5, "max_tree": 300,  "max_files": 6,  "head_lines": 40},
    "balanced": {"depth": 3, "scan_depth": 7, "max_tree": 600,  "max_files": 16, "head_lines": 70},
    "detailed": {"depth": 5, "scan_depth": 9, "max_tree": 1200, "max_files": 36, "head_lines": 110},
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

KEY_PATH_PARTS = (
    "frontend/js/components",
    "frontend/js/services",
    "frontend/js/store",
    "backend/routers",
    "backend/skills",
    "scripts",
)

UNDERSTAND_PATH_HINTS = (
    "understand",
    "project_bar",
    "projects.py",
    "i18n",
    "markdown",
    "api.js",
    "store.js",
)


def _file_priority(rel: str, name: str, ext: str) -> int:
    """精读优先级：越小越重要"""
    low = name.lower()
    rel_low = rel.lower()
    if rel_low.endswith("frontend/js/components/understand.js"):
        return 0
    if rel_low.endswith("backend/routers/projects.py"):
        return 1
    if low.startswith("readme"):
        return 2
    if any(hint in rel_low for hint in UNDERSTAND_PATH_HINTS):
        return 3
    if low in KEY_NAMES:
        return 4
    if any(part in rel_low for part in KEY_PATH_PARTS):
        return 5
    if ext in (".md", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini"):
        return 6
    if ext in TEXT_EXTS or low in TEXT_NAMES:
        return 7
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
        if depth > budget["scan_depth"]:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError:
            return
        visible = [
            e for e in entries
            if not _is_ignored_project_entry(e)
        ]
        emit_tree = depth <= budget["depth"]
        for i, entry in enumerate(visible):
            last = i == len(visible) - 1
            next_prefix = prefix
            if emit_tree and len(tree_lines) < budget["max_tree"]:
                branch = "└─ " if last else "├─ "
                tree_lines.append(f"{prefix}{branch}{entry.name}{'/' if entry.is_dir() else ''}")
                next_prefix = prefix + ("   " if last else "│  ")
            elif emit_tree:
                truncated = True

            if entry.is_dir():
                walk(entry, depth + 1, next_prefix)
            elif entry.is_file():
                size = _safe_file_size(entry) or 0
                if size <= 2 * 1024 * 1024:  # 跳过超大文件
                    files.append(
                        (entry.relative_to(project_dir).as_posix(), entry.name, entry.suffix.lower(), size)
                    )

    tree_lines.append(project_dir.name + "/")
    walk(project_dir, 1, "")

    # 按优先级选出精读文件；同等优先级下短路径优先，避免深层生成物挤掉入口文件。
    files.sort(key=lambda f: (_file_priority(f[0], f[1], f[2]), len(f[0]), f[0]))
    heads: list[dict] = []
    for rel, name, ext, size in files:
        if len(heads) >= budget["max_files"]:
            break
        if ext not in TEXT_EXTS and name.lower() not in TEXT_NAMES:
            continue
        try:
            content = (project_dir / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = content.splitlines()
        head_lines = budget["head_lines"]
        head = "\n".join(lines[:head_lines])
        truncated_head = len(lines) > head_lines
        if truncated_head:
            head += f"\n…（共 {len(lines)} 行，已截取开头）"
        heads.append({
            "path": rel,
            "content": head[:6000],
            "size": size,
            "lines": len(lines),
            "head_lines": min(len(lines), head_lines),
            "truncated": truncated_head or len(head) > 6000,
        })

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
