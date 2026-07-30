"""技能：创建文件 —— 预览新文件内容，用户确认后写入。"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def execute(
    file_path: str = "",
    content: str = "",
    **_kw: Any,
) -> dict[str, Any]:
    """
    预览并创建新文件。

    参数:
        file_path: 新文件的绝对路径
        content: 文件内容
    """
    if not file_path:
        return {"error": "文件路径不能为空"}

    target = Path(file_path)

    # 检查文件是否已存在
    if target.exists():
        return {"error": f"文件已存在: {file_path}，请使用 file_edit 工具编辑"}

    # 安全检查：禁止创建二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico"}
    if target.suffix.lower() in blocked_suffixes:
        return {"error": "不支持创建二进制文件"}

    if not content and content != "":
        return {"error": "文件内容不能为空"}

    # 生成 diff 预览（以空文件为基准）
    import difflib
    diff_lines = list(difflib.unified_diff(
        [],
        content.splitlines(keepends=True),
        fromfile="/dev/null",
        tofile=str(target.name),
        lineterm="",
    ))
    diff_text = "".join(diff_lines)

    line_count = content.count("\n") + 1

    return {
        "file": str(target),
        "file_name": target.name,
        "file_path_rel": str(target.parent),
        "diff": diff_text,
        "content": content,
        "stats": {
            "lines": line_count,
            "chars": len(content),
        },
        "note": "新文件已预览。用户可选择「接受」创建文件、「拒绝」放弃、「复制」拷贝内容。",
    }
