"""技能：持久化终端会话（支持多会话、状态保持、进程管理）。

核心特性：
- 每个会话维护独立的 shell 进程，保持 cwd 和环境变量
- 支持创建/列出/关闭多个终端会话
- 命令在会话内执行，状态（cd、export）跨命令保持
- 后台进程可真正终止（kill）
- 高危命令双层拦截（写死规则 + 用户审批）

会话管理：
- action="create"：创建新会话，返回 session_id
- action="list"：列出所有会话
- action="close"：关闭指定会话
- action="kill"：终止会话内正在运行的进程
- 默认 action=""：在指定会话（或 default）中执行命令
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from backend.subprocess_utils import hidden_subprocess_kwargs
from backend.skills.sandbox import truncate_output, MAX_OUTPUT_CHARS

# 默认工作目录
DEFAULT_WORK_DIR = "."
# 命令超时（秒）
TIMEOUT = 30
# 最大命令长度
MAX_COMMAND_LENGTH = 10_000
# 最大输出大小
MAX_OUTPUT = MAX_OUTPUT_CHARS
# Terminal pipes use UTF-8 regardless of the Windows ANSI/OEM code page.
TERMINAL_ENCODING = "utf-8"
# 禁止的命令前缀（无条件拦截）
BLOCKED_PREFIXES = ("rm -rf /", "format", "mkfs", "dd if=")

# 高危命令规则（写死）
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

PIPE_TO_SHELL = re.compile(
    r"(curl|wget|invoke-webrequest|iwr)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh|Invoke-Expression|\biex\b",
    re.I,
)

WINDOWS_NATIVE_PREFIXES = (
    "python", "py", "node", "npm", "pnpm", "yarn", "npx",
    "git", "rg", "ripgrep", "grep", "findstr",
    "pip", "uv", "pytest", "ruff", "mypy",
    "cargo", "go", "java", "javac", "dotnet",
)

POWERSHELL_HINTS = re.compile(
    r"(^|\s)(Get-|Set-|New-|Remove-|Select-|Where-|ForEach-|Write-|Test-|"
    r"Start-|Stop-|Copy-|Move-|Invoke-)|\$env:|Select-String|Out-File|"
    r"\b(Measure-Object|Sort-Object|Format-Table|Format-List)\b",
    re.I,
)


def check_high_risk(command: str) -> str:
    """返回命中的高危原因；未命中返回空字符串。"""
    cmd = str(command or "").strip()
    if not cmd:
        return ""
    if PIPE_TO_SHELL.search(cmd):
        return "从网络下载并直接执行脚本"
    for seg in re.split(r"&&|\|\||;|\|", cmd):
        seg = seg.strip()
        if not seg:
            continue
        for pattern, reason in HIGH_RISK_PATTERNS:
            if pattern.search(seg):
                return reason
    return ""


def _get_shell() -> list[str]:
    """返回当前平台的 shell 命令。"""
    if sys.platform == "win32":
        # Windows: 优先 PowerShell，回退 cmd
        return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-NoExit", "-Command", "-"]
    else:
        # Unix: 优先 bash，回退 sh
        return ["/bin/bash", "--norc", "--noprofile", "-i"]


def _command_with_marker(command: str, marker: str) -> str:
    if sys.platform == "win32":
        return (
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "$env:PYTHONIOENCODING = 'utf-8'\n"
            "$env:PYTHONUTF8 = '1'\n"
            "chcp.com 65001 > $null\n"
            f"{command}\n"
            "$slateExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n"
            f'Write-Output "{marker}:$slateExit"'
        )
    return f"{command}\nprintf '\\n{marker}:%s\\n' \"$?\""


def _strip_completion_marker(output: str, marker: str) -> tuple[str, int | None]:
    marker_prefix = f"{marker}:"
    exit_code: int | None = None
    kept: list[str] = []
    for line in output.splitlines():
        if marker_prefix in line:
            _, _, tail = line.partition(marker_prefix)
            match = re.match(r"\s*(-?\d+)", tail)
            if match:
                exit_code = int(match.group(1))
            continue
        kept.append(line)
    return "\n".join(kept).strip(), exit_code


def _looks_like_windows_native_command(command: str) -> bool:
    """Prefer direct subprocess capture for native commands on Windows.

    Windows PowerShell 5 decodes native stdout through the legacy code page in
    many cases, which corrupts UTF-8 output from Python/Node/Git. Direct capture
    keeps those bytes under Python's UTF-8 decoder.
    """
    if sys.platform != "win32":
        return False
    cmd = (command or "").strip()
    if not cmd or "\n" in cmd or POWERSHELL_HINTS.search(cmd):
        return False
    first = re.split(r"\s+", cmd, 1)[0].strip("\"'").lower()
    base = Path(first).stem.lower()
    return base in WINDOWS_NATIVE_PREFIXES


class TerminalSession:
    """持久化终端会话。"""

    def __init__(self, session_id: str, cwd: str):
        self.session_id = session_id
        self.cwd = Path(cwd).resolve()
        self.env = os.environ.copy()
        self.env["PYTHONIOENCODING"] = "utf-8"
        self.env["PYTHONUTF8"] = "1"
        self.env.setdefault("DOTNET_CLI_UI_LANGUAGE", "en")
        # 清理敏感环境变量
        for key in list(self.env.keys()):
            if key.upper() in ("AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DATABASE_URL", "SECRET_KEY", "PRIVATE_KEY"):
                del self.env[key]
        
        self.process: subprocess.Popen | None = None
        self.output_buffer: list[str] = []
        self.error_buffer: list[str] = []
        self.running = False
        self.current_command = ""
        self._reader_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        
    def start(self) -> None:
        """启动 shell 进程。"""
        if self.process and self.process.poll() is None:
            return  # 已在运行
        
        shell_cmd = _get_shell()
        self.process = subprocess.Popen(
            shell_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(self.cwd),
            env=self.env,
            text=True,
            encoding=TERMINAL_ENCODING,
            errors="replace",
            bufsize=1,  # 行缓冲
            **hidden_subprocess_kwargs(),
        )
        self._start_reader_thread()
    
    def _start_reader_thread(self) -> None:
        """启动读取线程。"""
        self._stop_event.clear()
        self._reader_thread = threading.Thread(target=self._read_output, daemon=True)
        self._reader_thread.start()
    
    def _read_output(self) -> None:
        """异步读取 stdout/stderr。"""
        if not self.process:
            return
        
        def read_stream(stream, buffer):
            try:
                for line in iter(stream.readline, ""):
                    if self._stop_event.is_set():
                        break
                    buffer.append(line)
            except Exception:
                pass
        
        stdout_thread = threading.Thread(target=read_stream, args=(self.process.stdout, self.output_buffer), daemon=True)
        stderr_thread = threading.Thread(target=read_stream, args=(self.process.stderr, self.error_buffer), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        stdout_thread.join()
        stderr_thread.join()

    def _run_command_direct(self, command: str, timeout: float = TIMEOUT) -> dict[str, Any]:
        """Run a Windows native command without PowerShell's text transcoding."""
        self.current_command = command
        self.running = True
        try:
            proc = subprocess.run(
                command,
                cwd=str(self.cwd),
                env=self.env,
                shell=True,
                capture_output=True,
                text=True,
                encoding=TERMINAL_ENCODING,
                errors="replace",
                timeout=max(float(timeout or TIMEOUT), 0.1),
                **hidden_subprocess_kwargs(),
            )
            output = (proc.stdout or "").strip()
            errors = (proc.stderr or "").strip()
            if errors:
                output += f"\n[STDERR]\n{errors}"
            output, was_truncated = truncate_output(output or "(无输出)")
            return {
                "command": command,
                "session_id": self.session_id,
                "work_dir": str(self.cwd),
                "output": output,
                "exit_code": proc.returncode,
                "truncated": was_truncated,
            }
        except subprocess.TimeoutExpired as e:
            partial = "\n".join(part for part in (e.stdout, e.stderr) if part)
            partial, was_truncated = truncate_output(partial or "(无输出)")
            return {
                "error": f"命令超时（{timeout}s）",
                "command": command,
                "session_id": self.session_id,
                "work_dir": str(self.cwd),
                "output": partial,
                "truncated": was_truncated,
            }
        except Exception as e:
            return {"error": f"执行失败: {e}"}
        finally:
            self.running = False
            self.current_command = ""
    
    def run_command(self, command: str, timeout: float = TIMEOUT) -> dict[str, Any]:
        """在会话中执行命令。"""
        if _looks_like_windows_native_command(command):
            return self._run_command_direct(command, timeout)

        if not self.process or self.process.poll() is not None:
            self.start()
        
        if not self.process or not self.process.stdin:
            return {"error": "Shell 进程未启动"}
        
        # 清空缓冲区
        self.output_buffer.clear()
        self.error_buffer.clear()
        self.current_command = command
        self.running = True
        
        try:
            # 发送命令
            marker = f"__SLATE_DONE_{uuid.uuid4().hex}__"
            self.process.stdin.write(_command_with_marker(command, marker) + "\n")
            self.process.stdin.flush()
            
            deadline = time.monotonic() + max(float(timeout or TIMEOUT), 0.1)
            timed_out = False
            while True:
                output_snapshot = "".join(self.output_buffer)
                if marker in output_snapshot:
                    break
                if self.process.poll() is not None:
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.05)
            
            # 收集输出
            output = "".join(self.output_buffer).strip()
            errors = "".join(self.error_buffer).strip()
            output, exit_code = _strip_completion_marker(output, marker)
            
            if errors:
                output += f"\n[STDERR]\n{errors}"
            
            if timed_out:
                partial, was_truncated = truncate_output(output or "(无输出)")
                self.kill_process()
                return {
                    "error": f"命令超时（{timeout}s）",
                    "command": command,
                    "session_id": self.session_id,
                    "work_dir": str(self.cwd),
                    "output": partial,
                    "truncated": was_truncated,
                }

            # 截断
            output, was_truncated = truncate_output(output or "(无输出)")
            
            return {
                "command": command,
                "session_id": self.session_id,
                "work_dir": str(self.cwd),
                "output": output,
                "exit_code": exit_code,
                "truncated": was_truncated,
            }
        except Exception as e:
            return {"error": f"执行失败: {e}"}
        finally:
            self.running = False
            self.current_command = ""
    
    def kill_process(self) -> None:
        """终止 shell 进程。"""
        self._stop_event.set()
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None
    
    def close(self) -> None:
        """关闭会话。"""
        self.kill_process()


# 全局会话存储
_sessions: dict[str, TerminalSession] = {}


def _get_or_create_session(session_id: str, cwd: str) -> TerminalSession:
    """获取或创建会话。"""
    if session_id not in _sessions:
        _sessions[session_id] = TerminalSession(session_id, cwd)
    return _sessions[session_id]


def execute(
    command: str = "",
    work_dir: str = DEFAULT_WORK_DIR,
    approved: bool = False,
    background: bool = False,
    action: str = "",
    session_id: str = "default",
    timeout: float = TIMEOUT,
    **_: Any,
) -> dict[str, Any]:
    """在持久化终端会话中执行命令或管理会话。

    Args:
        command: 要执行的命令（action="" 时必填）
        work_dir: 工作目录（创建新会话时使用）
        approved: 高危命令是否已获用户批准
        background: 已废弃，保留兼容
        action: 操作类型 - create/list/close/kill 或空（执行命令）
        session_id: 会话 ID（默认 "default"）
        timeout: 命令超时秒数（默认 30）
    """
    # ── 会话管理操作 ─────────────────────────────
    
    if action == "create":
        cwd = Path(work_dir).resolve()
        if not cwd.is_dir():
            return {"error": f"工作目录不存在: {work_dir}"}
        
        # 生成唯一 session_id（如果已存在）
        if session_id in _sessions:
            base_id = session_id
            session_id = f"{base_id}_{uuid.uuid4().hex[:6]}"
        
        session = _get_or_create_session(session_id, str(cwd))
        session.start()
        return {
            "message": f"会话已创建: {session_id}",
            "session_id": session_id,
            "work_dir": str(session.cwd),
        }
    
    if action == "list":
        sessions = []
        for sid, sess in _sessions.items():
            sessions.append({
                "session_id": sid,
                "work_dir": str(sess.cwd),
                "running": sess.running,
                "current_command": sess.current_command,
                "process_alive": sess.process is not None and sess.process.poll() is None,
            })
        return {"sessions": sessions, "count": len(sessions)}
    
    if action == "close":
        if session_id not in _sessions:
            return {"error": f"会话不存在: {session_id}"}
        _sessions[session_id].close()
        del _sessions[session_id]
        return {"message": f"会话已关闭: {session_id}"}
    
    if action == "kill":
        if session_id not in _sessions:
            return {"error": f"会话不存在: {session_id}"}
        sess = _sessions[session_id]
        if sess.process and sess.process.poll() is None:
            sess.kill_process()
            return {"message": f"会话 {session_id} 的进程已终止"}
        return {"message": f"会话 {session_id} 无运行中的进程"}
    
    # ── 命令执行 ─────────────────────────────────
    
    if not command:
        return {"error": "命令不能为空"}
    
    if len(command) > MAX_COMMAND_LENGTH:
        return {"error": f"命令过长（{len(command)} 字符 > {MAX_COMMAND_LENGTH} 限制）"}
    
    # 灾难级命令：无条件禁止
    cmd_lower = command.lower().strip()
    for prefix in BLOCKED_PREFIXES:
        if cmd_lower.startswith(prefix):
            return {"error": f"禁止执行的危险命令: {prefix}"}
    
    # 高危命令：未获用户批准即拦截
    risk_reason = check_high_risk(command)
    if risk_reason and not bool(approved):
        return {"error": f"高危命令（{risk_reason}）未获用户批准，已拦截: {command}"}
    
    # 获取或创建会话
    cwd = Path(work_dir).resolve()
    if not cwd.is_dir():
        return {"error": f"工作目录不存在: {work_dir}"}
    
    session = _get_or_create_session(session_id, str(cwd))
    
    # 执行命令
    result = session.run_command(command, timeout=timeout)
    return result
