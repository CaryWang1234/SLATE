"""技能：受限终端执行（沙箱模式，仅允许指定目录）。

高危命令采用写死的规则判定（与前端 riskguard.js 保持同一份清单）：
- BLOCKED_PREFIXES：灾难级命令，无条件禁止
- HIGH_RISK_PATTERNS：高危命令，必须携带 approved=True（用户在前端批准后注入）
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

# 默认允许的工作目录
DEFAULT_WORK_DIR = "."
# 命令超时（秒）
TIMEOUT = 30
# 禁止的命令前缀（无条件拦截）
BLOCKED_PREFIXES = ("rm -rf /", "format", "mkfs", "dd if=")

# 高危命令规则（写死）：命中任一条即要求用户批准
HIGH_RISK_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\brm\b", re.I), "删除文件（rm）"),
    (re.compile(r"\b(rmdir|shred|unlink)\b", re.I), "删除文件/目录"),
    (re.compile(r"\b(del|erase)\b\s", re.I), "删除文件（del/erase）"),
    (re.compile(r"\brd\b\s", re.I), "删除目录（rd）"),
    (re.compile(r"Remove-Item", re.I), "删除文件（Remove-Item）"),
    (re.compile(r"\bdd\b(?=.*\bof=)", re.I), "磁盘写入（dd）"),
    (re.compile(r"\b(fdisk|diskpart|parted)\b", re.I), "磁盘分区操作"),
    (re.compile(r"\b(shutdown|reboot|poweroff|halt)\b", re.I), "关机/重启"),
    (re.compile(r"\binit\s+[06]\b"), "关机/重启"),
    (re.compile(r"\bsudo\b", re.I), "提权执行（sudo）"),
    (re.compile(r"\b(taskkill|killall)\b", re.I), "强制结束进程"),
    (re.compile(r"\bkill\s+-9\b", re.I), "强制结束进程（kill -9）"),
    (re.compile(r"reg\s+(delete|add)\b", re.I), "修改注册表"),
    (re.compile(r"\bsc\s+(delete|stop)\b", re.I), "管理系统服务"),
    (re.compile(r"\bnet\s+user\b", re.I), "修改用户账户"),
    (re.compile(r"\b(takeown|icacls)\b", re.I), "修改文件所有权/权限"),
    (re.compile(r"\bchmod\s+(-R\s+)?777\b", re.I), "开放全部权限（chmod 777）"),
    (re.compile(r"git\s+push\s+[^;]*(--force\b|-f\b|--force-with-lease)", re.I), "Git 强制推送"),
    (re.compile(r"git\s+reset\s+--hard", re.I), "Git 硬重置（丢弃改动）"),
    (re.compile(r"git\s+clean\s+-[a-z]*f", re.I), "Git 清理未跟踪文件"),
    (re.compile(r"git\s+branch\s+-D\b", re.I), "Git 强制删除分支"),
    (re.compile(r"(drop\s+(database|table|schema)|truncate\s+table)", re.I), "数据库删表/删库"),
    (re.compile(r"(npm|pnpm|yarn)\s+(uninstall|remove)\s+(-g|--global)", re.I), "卸载全局依赖"),
]

# 从网络下载并直接交给 shell 执行（整条命令级别判定）
PIPE_TO_SHELL = re.compile(
    r"(curl|wget|invoke-webrequest|iwr)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh|Invoke-Expression|\biex\b",
    re.I,
)


def check_high_risk(command: str) -> str:
    """返回命中的高危原因；未命中返回空字符串。"""
    cmd = str(command or "").strip()
    if not cmd:
        return ""
    if PIPE_TO_SHELL.search(cmd):
        return "从网络下载并直接执行脚本"
    # 拆分命令链（&&、||、;、|），逐段检查
    for seg in re.split(r"&&|\|\||;|\|", cmd):
        seg = seg.strip()
        if not seg:
            continue
        for pattern, reason in HIGH_RISK_PATTERNS:
            if pattern.search(seg):
                return reason
    return ""


def execute(command: str = "", work_dir: str = DEFAULT_WORK_DIR, approved: bool = False, **_: Any) -> dict[str, Any]:
    """在指定目录中执行 Shell 命令。高危命令须 approved=True（前端用户批准后注入）。"""
    if not command:
        return {"error": "命令不能为空"}

    # 灾难级命令：无条件禁止
    cmd_lower = command.lower().strip()
    for prefix in BLOCKED_PREFIXES:
        if cmd_lower.startswith(prefix):
            return {"error": f"禁止执行的危险命令: {prefix}"}

    # 高危命令：未获用户批准即拦截
    risk_reason = check_high_risk(command)
    if risk_reason and not bool(approved):
        return {"error": f"高危命令（{risk_reason}）未获用户批准，已拦截: {command}"}

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
