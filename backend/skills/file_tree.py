"""技能：扫描目录树（仅第一层），返回文件与子目录列表。"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def execute(directory: str = ".", **_: Any) -> dict[str, Any]:
    """扫描指定目录，返回第一层内容。"""
    target = Path(directory).resolve()

    if not target.is_dir():
        return {"error": f"目录不存在: {directory}"}

    items: list[dict[str, str]] = []
    try:
        for entry in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            item_type = "dir" if entry.is_dir() else "file"
            size = ""
            if entry.is_file():
                try:
                    size_bytes = entry.stat().st_size
                    if size_bytes < 1024:
                        size = f"{size_bytes}B"
                    elif size_bytes < 1024 * 1024:
                        size = f"{size_bytes // 1024}KB"
                    else:
                        size = f"{size_bytes // (1024 * 1024)}MB"
                except OSError:
                    size = "?"
            items.append({"name": entry.name, "type": item_type, "size": size})
    except PermissionError:
        return {"error": f"无权限访问: {directory}"}

    return {
        "directory": str(target),
        "count": len(items),
        "items": items,
    }
