"""技能：读取文件前 N 行（默认 30，上限 50）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

MAX_LINES = 50
DEFAULT_LINES = 30


def execute(file_path: str = "", lines: int = DEFAULT_LINES, **_: Any) -> dict[str, Any]:
    """读取指定文件的前 N 行。"""
    if not file_path:
        return {"error": "文件路径不能为空"}

    target = Path(file_path).resolve()
    if not target.is_file():
        return {"error": f"文件不存在: {file_path}"}

    # 安全检查：禁止读取敏感路径
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin"}
    if target.suffix.lower() in blocked_suffixes:
        return {"error": "不支持读取二进制文件"}

    line_count = min(lines, MAX_LINES)

    try:
        with target.open("r", encoding="utf-8", errors="replace") as f:
            content_lines: list[str] = []
            for i, line in enumerate(f):
                if i >= line_count:
                    break
                content_lines.append(line.rstrip("\n"))
    except PermissionError:
        return {"error": f"无权限读取: {file_path}"}

    total_lines = 0
    try:
        with target.open("r", encoding="utf-8", errors="replace") as f:
            for _ in f:
                total_lines += 1
    except OSError:
        total_lines = -1

    return {
        "file": str(target),
        "total_lines": total_lines,
        "returned_lines": len(content_lines),
        "content": "\n".join(content_lines),
        "truncated": total_lines > line_count,
    }
