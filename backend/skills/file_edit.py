"""技能：文件编辑 —— 支持 diff 编辑、行操作、剪贴板（复制/粘贴/剪切）。

操作类型：
- edit: 基于 diff 的精确修改（old_text → new_text）
- read: 读取文件内容（支持行号范围）
- insert: 在指定行插入内容
- delete: 删除指定行范围
- copy: 复制内容到剪贴板
- paste: 从剪贴板粘贴到指定位置
- cut: 剪切内容（复制 + 删除）

剪贴板支持命名存储，可在多次操作间保持内容。
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any

from backend.skills.sandbox import is_path_safe, validate_file_size

# 全局剪贴板存储（支持多个命名剪贴板）
_clipboards: dict[str, str] = {}


def _read_file(file_path: str) -> tuple[str | None, str | None]:
    """安全读取文件，返回 (content, error)。"""
    target = Path(file_path)
    
    # 沙箱路径验证
    safe, reason = is_path_safe(file_path)
    if not safe:
        return None, reason
    
    # 文件大小检查
    size_ok, size_reason = validate_file_size(file_path)
    if not size_ok:
        return None, size_reason
    
    if not target.is_file():
        return None, f"文件不存在: {file_path}"
    
    # 禁止二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico"}
    if target.suffix.lower() in blocked_suffixes:
        return None, "不支持编辑二进制文件"
    
    try:
        content = target.read_text(encoding="utf-8")
        return content, None
    except PermissionError:
        return None, f"无权限读取: {file_path}"
    except UnicodeDecodeError:
        return None, "文件不是 UTF-8 文本"


def _write_file(file_path: str, content: str) -> str | None:
    """写入文件，返回 error 或 None。"""
    target = Path(file_path)
    
    safe, reason = is_path_safe(file_path)
    if not safe:
        return reason
    
    try:
        target.write_text(content, encoding="utf-8")
        return None
    except PermissionError:
        return f"无权限写入: {file_path}"
    except Exception as e:
        return f"写入失败: {e}"


def _generate_diff(original: str, content: str, filename: str) -> str:
    """生成 unified diff。"""
    diff_lines = list(difflib.unified_diff(
        original.splitlines(keepends=True),
        content.splitlines(keepends=True),
        fromfile=filename,
        tofile=filename,
        lineterm="",
    ))
    return "".join(diff_lines)


def _execute_edit(file_path: str, edits: Any) -> dict[str, Any]:
    """执行 diff 编辑（原有逻辑）。"""
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
    
    content, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    original = content
    target = Path(file_path)
    applied: list[dict[str, Any]] = []
    errors: list[str] = []
    
    for i, edit in enumerate(edit_list):
        old_text = edit.get("old_text", "")
        new_text = edit.get("new_text", "")
        
        if not old_text and old_text != "":
            errors.append(f"第 {i + 1} 项缺少 old_text")
            continue
        
        count = content.count(old_text)
        if count == 0:
            errors.append(f"第 {i + 1} 项: old_text 在文件中未找到")
            continue
        if count > 1:
            errors.append(f"第 {i + 1} 项: old_text 在文件中出现 {count} 次，需更精确以唯一匹配")
            continue
        
        content = content.replace(old_text, new_text, 1)
        
        before = content[:content.index(new_text)] if new_text in content else ""
        line_no = before.count("\n") + 1 if new_text else content[:len(content) - len(new_text)].count("\n") + 1
        
        applied.append({
            "index": i + 1,
            "line": line_no,
            "old_lines": old_text.count("\n") + 1,
            "new_lines": new_text.count("\n") + 1,
        })
    
    if errors and not applied:
        return {
            "file": str(target),
            "file_name": target.name,
            "diff": "",
            "applied": [],
            "errors": errors,
            "stats": {"edits_total": len(edit_list), "edits_applied": 0, "lines_added": 0, "lines_removed": 0},
            "new_content": original,
            "note": "所有编辑均未匹配。请检查 old_text 是否与文件内容完全一致。",
        }
    
    diff_text = _generate_diff(original, content, target.name)
    added = sum(1 for l in diff_text.splitlines() if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_text.splitlines() if l.startswith("-") and not l.startswith("---"))
    
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


def _execute_read(file_path: str, start_line: int = 0, end_line: int = 0) -> dict[str, Any]:
    """读取文件内容（支持行号范围）。"""
    content, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = content.splitlines(keepends=True)
    total = len(lines)
    
    # 处理行号范围
    if start_line > 0 or end_line > 0:
        start = max(1, start_line) - 1  # 转为 0-based
        end = min(total, end_line) if end_line > 0 else total
        selected = lines[start:end]
        return {
            "file": file_path,
            "total_lines": total,
            "range": f"{start + 1}-{end}",
            "content": "".join(selected),
            "line_count": len(selected),
        }
    
    return {
        "file": file_path,
        "total_lines": total,
        "content": content,
        "line_count": total,
    }


def _execute_insert(file_path: str, content: str, start_line: int) -> dict[str, Any]:
    """在指定行插入内容。"""
    if not content:
        return {"error": "content 不能为空"}
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    
    original, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    insert_pos = min(start_line - 1, len(lines))  # 0-based
    
    # 确保插入内容有换行符
    if not content.endswith("\n"):
        content += "\n"
    
    lines.insert(insert_pos, content)
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "insert",
        "line": start_line,
        "inserted_lines": content.count("\n"),
        "new_content": new_content,
        "note": "插入已预览。用户可选择「接受」写入文件。",
    }


def _execute_delete(file_path: str, start_line: int, end_line: int) -> dict[str, Any]:
    """删除指定行范围。"""
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    if end_line < start_line:
        return {"error": "end_line 必须 >= start_line"}
    
    original, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    total = len(lines)
    
    start = max(1, start_line) - 1  # 0-based
    end = min(total, end_line)
    
    deleted = lines[start:end]
    del lines[start:end]
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "delete",
        "range": f"{start_line}-{end_line}",
        "deleted_lines": len(deleted),
        "deleted_content": "".join(deleted),
        "new_content": new_content,
        "note": "删除已预览。用户可选择「接受」写入文件。",
    }


def _execute_copy(file_path: str, start_line: int = 0, end_line: int = 0, clipboard_name: str = "default") -> dict[str, Any]:
    """复制内容到剪贴板。"""
    content, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = content.splitlines(keepends=True)
    
    if start_line > 0 or end_line > 0:
        start = max(1, start_line) - 1
        end = min(len(lines), end_line) if end_line > 0 else len(lines)
        selected = "".join(lines[start:end])
    else:
        selected = content
    
    _clipboards[clipboard_name] = selected
    
    return {
        "file": file_path,
        "action": "copy",
        "clipboard": clipboard_name,
        "copied_lines": selected.count("\n"),
        "copied_chars": len(selected),
        "preview": selected[:200] + ("..." if len(selected) > 200 else ""),
    }


def _execute_paste(file_path: str, start_line: int, clipboard_name: str = "default") -> dict[str, Any]:
    """从剪贴板粘贴到指定位置。"""
    if clipboard_name not in _clipboards:
        return {"error": f"剪贴板 '{clipboard_name}' 为空"}
    
    clipboard_content = _clipboards[clipboard_name]
    
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    
    original, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    insert_pos = min(start_line - 1, len(lines))
    
    lines.insert(insert_pos, clipboard_content)
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "paste",
        "clipboard": clipboard_name,
        "line": start_line,
        "pasted_lines": clipboard_content.count("\n"),
        "new_content": new_content,
        "note": "粘贴已预览。用户可选择「接受」写入文件。",
    }


def _execute_cut(file_path: str, start_line: int, end_line: int, clipboard_name: str = "default") -> dict[str, Any]:
    """剪切内容（复制到剪贴板 + 删除）。"""
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    if end_line < start_line:
        return {"error": "end_line 必须 >= start_line"}
    
    original, error = _read_file(file_path)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    total = len(lines)
    
    start = max(1, start_line) - 1
    end = min(total, end_line)
    
    cut_content = "".join(lines[start:end])
    _clipboards[clipboard_name] = cut_content
    
    del lines[start:end]
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "cut",
        "clipboard": clipboard_name,
        "range": f"{start_line}-{end_line}",
        "cut_lines": len(cut_content.splitlines()),
        "cut_chars": len(cut_content),
        "new_content": new_content,
        "note": "剪切已预览（内容已存入剪贴板）。用户可选择「接受」写入文件。",
    }


def execute(
    file_path: str = "",
    action: str = "edit",
    edits: Any = None,
    content: str = "",
    start_line: int = 0,
    end_line: int = 0,
    clipboard_name: str = "default",
    **_kw: Any,
) -> dict[str, Any]:
    """
    文件编辑工具：支持 diff 编辑、行操作、剪贴板。

    Args:
        file_path: 目标文件路径
        action: 操作类型 - edit/read/insert/delete/copy/paste/cut
        edits: JSON 数组（edit 操作），每项含 old_text 和 new_text
        content: 要插入的内容（insert 操作）
        start_line: 起始行号（1-based，用于 insert/delete/copy/paste/cut）
        end_line: 结束行号（1-based，用于 delete/copy/cut）
        clipboard_name: 剪贴板名称（默认 "default"，支持多个命名剪贴板）
    """
    if not file_path:
        return {"error": "文件路径不能为空"}
    
    action = (action or "edit").strip().lower()
    
    if action == "edit":
        if edits is None:
            return {"error": "edit 操作需要 edits 参数"}
        return _execute_edit(file_path, edits)
    
    if action == "read":
        return _execute_read(file_path, start_line, end_line)
    
    if action == "insert":
        return _execute_insert(file_path, content, start_line)
    
    if action == "delete":
        return _execute_delete(file_path, start_line, end_line)
    
    if action == "copy":
        return _execute_copy(file_path, start_line, end_line, clipboard_name)
    
    if action == "paste":
        return _execute_paste(file_path, start_line, clipboard_name)
    
    if action == "cut":
        return _execute_cut(file_path, start_line, end_line, clipboard_name)
    
    return {"error": f"未知操作: {action}，可选: edit/read/insert/delete/copy/paste/cut"}
