"""技能：文件编辑 —— 基于 diff 的精确文件修改，只改指定内容。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.skills.sandbox import is_path_safe, validate_file_size


def execute(
    file_path: str = "",
    edits: str = "",
    **_kw: Any,
) -> dict[str, Any]:
    """
    对指定文件执行 diff 编辑。

    参数:
        file_path: 目标文件的绝对路径
        edits: JSON 数组字符串，每项包含 old_text 和 new_text
               例: [{"old_text": "原内容", "new_text": "新内容"}]
    """
    import json

    if not file_path:
        return {"error": "文件路径不能为空"}

    # 沙箱路径验证
    safe, reason = is_path_safe(file_path)
    if not safe:
        return {"error": reason}

    # 文件大小检查
    size_ok, size_reason = validate_file_size(file_path)
    if not size_ok:
        return {"error": size_reason}

    # 解析 edits
    if isinstance(edits, str):
        try:
            edit_list = json.loads(edits)
        except json.JSONDecodeError as e:
            return {"error": f"edits 格式错误: {e}"}
    elif isinstance(edits, list):
        edit_list = edits
    else:
        return {"error": "edits 必须是 JSON 数组"}

    if not edit_list or not isinstance(edit_list, list):
        return {"error": "edits 不能为空"}

    target = Path(file_path)
    if not target.is_file():
        return {"error": f"文件不存在: {file_path}"}

    # 安全检查：禁止编辑二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico"}
    if target.suffix.lower() in blocked_suffixes:
        return {"error": "不支持编辑二进制文件"}

    # 读取文件
    try:
        original = target.read_text(encoding="utf-8")
    except PermissionError:
        return {"error": f"无权限读取: {file_path}"}
    except UnicodeDecodeError:
        return {"error": "文件不是 UTF-8 文本"}

    # 逐条应用 diff，收集结果
    content = original
    applied: list[dict[str, Any]] = []
    errors: list[str] = []

    for i, edit in enumerate(edit_list):
        old_text = edit.get("old_text", "")
        new_text = edit.get("new_text", "")

        if not old_text and old_text != "":
            errors.append(f"第 {i + 1} 项缺少 old_text")
            continue

        # 检查 old_text 是否存在
        count = content.count(old_text)
        if count == 0:
            errors.append(f"第 {i + 1} 项: old_text 在文件中未找到")
            continue
        if count > 1:
            errors.append(f"第 {i + 1} 项: old_text 在文件中出现 {count} 次，需更精确以唯一匹配")
            continue

        # 唯一匹配，执行替换
        content = content.replace(old_text, new_text, 1)

        # 计算行号
        before = content[:content.index(new_text)] if new_text in content else ""
        line_no = before.count("\n") + 1 if new_text else content[:len(content) - len(new_text)].count("\n") + 1

        applied.append({
            "index": i + 1,
            "line": line_no,
            "old_lines": old_text.count("\n") + 1,
            "new_lines": new_text.count("\n") + 1,
        })

    if errors and not applied:
        # 即使全部失败，也返回结构化数据（前端可渲染 diff 查看器展示错误）
        return {
            "file": str(target),
            "file_name": target.name,
            "diff": "",
            "applied": [],
            "errors": errors,
            "stats": {
                "edits_total": len(edit_list),
                "edits_applied": 0,
                "lines_added": 0,
                "lines_removed": 0,
            },
            "new_content": original,
            "note": "所有编辑均未匹配。请检查 old_text 是否与文件内容完全一致。",
        }

    # 生成 unified diff
    import difflib
    diff_lines = list(difflib.unified_diff(
        original.splitlines(keepends=True),
        content.splitlines(keepends=True),
        fromfile=str(target.name),
        tofile=str(target.name),
        lineterm="",
    ))
    diff_text = "".join(diff_lines)

    # 统计
    added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))

    return {
        "file": str(target),
        "file_name": target.name,
        "diff": diff_text,
        "applied": applied,
        "errors": errors,
        "stats": {
            "edits_total": len(edit_list),
            "edits_applied": len(applied),
            "lines_added": added,
            "lines_removed": removed,
        },
        "new_content": content,
        "note": "编辑已预览。用户可选择「接受」写入文件、「拒绝」放弃、「复制」拷贝 diff。",
    }
