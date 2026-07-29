"""技能：受限终端执行（沙箱模式，仅允许指定目录）。"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

# 默认允许的工作目录
DEFAULT_WORK_DIR = "."
# 命令超时（秒）
TIMEOUT = 30
# 禁止的命令前缀
BLOCKED_PREFIXES = ("rm -rf /", "format", "mkfs", "dd if=")


def execute(command: str = "", work_dir: str = DEFAULT_WORK_DIR, **_: Any) -> dict[str, Any]:
    """在指定目录中执行 Shell 命令。"""
    if not command:
        return {"error": "命令不能为空"}

    # 安全检查
    cmd_lower = command.lower().strip()
    for prefix in BLOCKED_PREFIXES:
        if cmd_lower.startswith(prefix):
            return {"error": f"禁止执行的危险命令: {prefix}"}

    cwd = Path(work_dir).resolve()
    if not cwd.is_dir():
        return {"error": f"工作目录不存在: {work_dir}"}

    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
        )
        output = result.stdout
        if result.stderr:
            output += f"\n[STDERR]\n{result.stderr}"
        return {
            "command": command,
            "work_dir": str(cwd),
            "exit_code": result.returncode,
            "output": output.strip() or "(无输出)",
        }
    except subprocess.TimeoutExpired:
        return {"error": f"命令执行超时（{TIMEOUT}秒）: {command}"}
    except Exception as e:
        return {"error": f"执行失败: {e}"}
