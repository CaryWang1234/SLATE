"""外部 MCP Server 客户端管理器。

支持两种传输：HTTP+SSE（url）与 stdio 子进程（command/args/env，npm 生态的
MCP Server 大多走 npx 启动）。多 Server 同时连接，连接状态持久化。

协议规范：https://modelcontextprotocol.io/docs/concepts/transports
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from backend import scope_overlay
from backend.data_io import atomic_write_json, backup_corrupt
from backend.subprocess_utils import hidden_subprocess_kwargs

logger = logging.getLogger("slate.mcp_client")

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CONFIG_PATH = DATA_DIR / "mcp_servers.json"

# ── 连接状态 ─────────────────────────────────────────────

class McpServerConnection:
    """单个 MCP Server 的 SSE 连接。"""

    def __init__(self, server_id: str, name: str, url: str, enabled: bool = True):
        self.server_id = server_id
        self.name = name
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.status: str = "disconnected"  # disconnected / connecting / connected / error
        self.error: str = ""
        self.tools: list[dict[str, Any]] = []
        self._message_url: str = ""
        self._request_id: int = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._sse_task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None
        self._connected_at: float = 0
        self._endpoint_event = asyncio.Event()
        self._listen_error = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.server_id,
            "name": self.name,
            "url": self.url,
            "enabled": self.enabled,
            "status": self.status,
            "error": self.error,
            "tools": [{"name": t["name"], "description": t.get("description", "")} for t in self.tools],
            "toolCount": len(self.tools),
        }

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _fail_connect(self, error: str) -> bool:
        """连接失败统一出口：记录错误并清理 SSE 监听任务与 HTTP 客户端。"""
        self.status = "error"
        self.error = error
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except BaseException:
                pass
            self._sse_task = None
        if self._client:
            try:
                await self._client.aclose()
            except Exception:
                pass
            self._client = None
        return False

    async def connect(self) -> bool:
        """建立 SSE 连接，获取 message URL，拉取工具列表。

        MCP HTTP+SSE 传输：endpoint 事件绑定当前 SSE 会话（含 sessionId），
        因此必须保持同一条 SSE 连接持续监听，POST 消息全部发往该连接解析出的 URL。
        """
        self.status = "connecting"
        self.error = ""
        self.tools = []

        try:
            self._client = httpx.AsyncClient(timeout=30.0)

            # 1. 建立持久 SSE 监听（后台任务）：endpoint 事件由该连接解析并保存 message URL
            self._endpoint_event = asyncio.Event()
            self._listen_error = ""
            self._sse_task = asyncio.create_task(self._listen_sse())

            # 2. 等待 message endpoint（含 sessionId 绑定），15 秒超时
            try:
                await asyncio.wait_for(self._endpoint_event.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                return await self._fail_connect(self._listen_error or "未收到 message endpoint")
            if not self._message_url:
                return await self._fail_connect(self._listen_error or "未收到 message endpoint")

            # 3. 发送 initialize 请求
            init_result = await self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "SLATE", "version": "1.0.0"},
            })
            if not init_result or "error" in init_result:
                err = (init_result or {}).get("error")
                err_text = err if isinstance(err, str) else (json.dumps(err, ensure_ascii=False)[:200] if err else "无响应")
                return await self._fail_connect(f"initialize 失败: {err_text}")

            # 4. 发送 initialized 通知
            await self._send_notification("notifications/initialized")

            # 5. 拉取工具列表
            tools_result = await self._send_request("tools/list", {})
            if not tools_result or "error" in tools_result:
                err = (tools_result or {}).get("error")
                err_text = err if isinstance(err, str) else (json.dumps(err, ensure_ascii=False)[:200] if err else "无响应")
                return await self._fail_connect(f"tools/list 失败: {err_text}")
            self.tools = tools_result.get("tools") or []

            self.status = "connected"
            self._connected_at = time.time()
            logger.info(f"MCP Server '{self.name}' 已连接，{len(self.tools)} 个工具")
            return True

        except httpx.ConnectError:
            return await self._fail_connect(f"无法连接到 {self.url}")
        except httpx.TimeoutException:
            return await self._fail_connect("连接超时")
        except Exception as e:
            self.error = str(e)[:200]
            logger.exception(f"MCP Server '{self.name}' 连接失败")
            return await self._fail_connect(str(e)[:200])

    async def _listen_sse(self):
        """后台监听 SSE 流：解析 endpoint 事件保存 message URL，持续接收响应与通知。"""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", f"{self.url}/sse", headers={"Accept": "text/event-stream"}) as resp:
                    if resp.status_code != 200:
                        self._listen_error = f"SSE 连接失败: HTTP {resp.status_code}"
                        self._endpoint_event.set()
                        return
                    event_type = ""
                    async for line in resp.aiter_lines():
                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            data = line[5:].strip()
                            # endpoint 事件（MCP 规范），兼容旧式 data 前缀判断
                            if event_type == "endpoint" or data.startswith("/message") or data.startswith("http"):
                                if not self._message_url:
                                    self._message_url = data if data.startswith("http") else f"{self.url}{data}"
                                    self._endpoint_event.set()
                            elif event_type == "message" and data:
                                try:
                                    msg = json.loads(data)
                                    req_id = msg.get("id")
                                    if req_id is not None and req_id in self._pending:
                                        if "error" in msg:
                                            self._pending[req_id].set_result({"error": msg["error"]})
                                        else:
                                            self._pending[req_id].set_result(msg.get("result", {}))
                                except json.JSONDecodeError:
                                    pass
                        elif line == "":
                            event_type = ""
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"MCP SSE 监听断开 ({self.name}): {e}")
            self._listen_error = str(e)[:200]
            self._endpoint_event.set()
            if self.status == "connected":
                self.status = "error"
                self.error = f"连接断开: {e}"
            # 断线后让所有挂起的请求立即失败，避免 15 秒空等
            for req_id, fut in list(self._pending.items()):
                if not fut.done():
                    fut.set_result({"error": "SSE 连接断开"})

    async def _send_request(self, method: str, params: dict) -> dict | None:
        """发送 JSON-RPC 请求并等待响应。"""
        if not self._message_url:
            return None
        req_id = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        }
        future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        try:
            resp = await self._client.post(self._message_url, json=payload, timeout=15.0)
            if resp.status_code not in (200, 202):
                self._pending.pop(req_id, None)
                return {"error": f"HTTP {resp.status_code}"}
            # 等待 SSE 流传回结果
            try:
                result = await asyncio.wait_for(future, timeout=15.0)
                return result
            except asyncio.TimeoutError:
                self._pending.pop(req_id, None)
                return {"error": "响应超时"}
        except Exception as e:
            self._pending.pop(req_id, None)
            return {"error": str(e)[:200]}

    async def _send_notification(self, method: str, params: dict | None = None):
        """发送 JSON-RPC 通知（无 id，无响应）。"""
        if not self._message_url:
            return
        payload = {"jsonrpc": "2.0", "method": method}
        if params:
            payload["params"] = params
        try:
            await self._client.post(self._message_url, json=payload, timeout=5.0)
        except Exception:
            pass

    async def call_tool(self, tool_name: str, arguments: dict) -> dict[str, Any]:
        """调用远程 MCP Server 的工具。"""
        if self.status != "connected":
            return {"error": f"服务器未连接: {self.status}"}
        result = await self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments,
        })
        if result is None:
            return {"error": "请求失败"}
        if "error" in result:
            return {"error": result["error"]}
        return result

    async def disconnect(self):
        """断开连接。"""
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except BaseException:
                pass
            self._sse_task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._pending.clear()
        self.tools = []
        self._message_url = ""
        self.status = "disconnected"


# ── stdio 传输（本地子进程） ────────────────────────────

# cmd.exe 会解释这些字符：走 .cmd/.bat 垫片时命令与参数里出现即拒，
# 配置是用户手输的也不给注入留门
_SHELL_META = set('&|<>^%\r\n"')


def stdio_argv(command: str, args: list[str]) -> list[str]:
    """把 command+args 变成可执行的 argv。

    Windows 上 npx/npm 是 .cmd 垫片，CreateProcess 不认，要经 cmd.exe 转一道；
    其余情况直接 exec，不过 shell。找不到命令原样回命令名，让 spawn 报错信息说话。
    """
    exe = shutil.which(command) or command
    if sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat")):
        if any(c in _SHELL_META for c in [command, *args]):
            raise ValueError("命令或参数含 shell 特殊字符，拒绝经 cmd.exe 启动")
        comspec = os.environ.get("COMSPEC", "cmd.exe")
        return [comspec, "/d", "/c", exe, *args]
    return [exe, *args]


class StdioConnection:
    """单个 MCP Server 的 stdio 连接：JSON-RPC 走子进程 stdin/stdout，逐行一条消息。"""

    def __init__(self, server_id: str, name: str, command: str, args: list[str] | None = None,
                 env: dict[str, str] | None = None, enabled: bool = True):
        self.server_id = server_id
        self.name = name
        self.url = ""  # stdio 没有 URL；品牌识别回落 MCP 官方 mark
        self.command = command
        self.args = list(args or [])
        self.env = dict(env or {})
        self.enabled = enabled
        self.status: str = "disconnected"
        self.error: str = ""
        self.tools: list[dict[str, Any]] = []
        self._request_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr_tail = ""

    def command_line(self) -> str:
        return " ".join([self.command, *self.args])

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.server_id,
            "name": self.name,
            "url": "",
            "transport": "stdio",
            "command": self.command,
            "args": self.args,
            "enabled": self.enabled,
            "status": self.status,
            "error": self.error,
            "tools": [{"name": t["name"], "description": t.get("description", "")} for t in self.tools],
            "toolCount": len(self.tools),
        }

    async def _fail_connect(self, error: str) -> bool:
        self.status = "error"
        self.error = error[:300]
        await self._teardown()
        return False

    async def _teardown(self):
        """收掉读任务与整棵进程树：npx 会再生一层 node 子进程，只杀父进程会留孤儿。"""
        for task in (self._reader_task, self._stderr_task):
            if task:
                task.cancel()
                try:
                    await task
                except BaseException:
                    pass
        self._reader_task = None
        self._stderr_task = None
        proc, self._proc = self._proc, None
        if proc and proc.returncode is None:
            try:
                if sys.platform == "win32":
                    await asyncio.get_running_loop().run_in_executor(
                        None, lambda: subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                            timeout=5, **hidden_subprocess_kwargs()))
                else:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=2)
                    except asyncio.TimeoutError:
                        proc.kill()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result({"error": "stdio 连接已断开"})
        self._pending.clear()

    async def connect(self) -> bool:
        self.status = "connecting"
        self.error = ""
        self.tools = []
        self._stderr_tail = ""
        try:
            argv = stdio_argv(self.command, self.args)
            env = {**os.environ, **self.env} if self.env else None
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                **hidden_subprocess_kwargs(),
            )
        except ValueError as e:
            return await self._fail_connect(str(e))
        except FileNotFoundError:
            return await self._fail_connect(f"找不到命令: {self.command}（确认已装 Node.js/npm 或该程序在 PATH 里）")
        except Exception as e:
            return await self._fail_connect(f"启动失败: {str(e)[:200]}")

        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

        # npx 首次要现下载包，initialize 给足 60 秒；后续请求 15 秒
        init_result = await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "SLATE", "version": "1.0.0"},
        }, timeout=60.0)
        if not init_result or "error" in init_result:
            err = (init_result or {}).get("error")
            detail = err if isinstance(err, str) else (self._stderr_tail or "进程无响应")
            return await self._fail_connect(f"initialize 失败: {str(detail)[:200]}")
        await self._send_notification("notifications/initialized")
        tools_result = await self._send_request("tools/list", {})
        if not tools_result or "error" in tools_result:
            err = (tools_result or {}).get("error")
            return await self._fail_connect(f"tools/list 失败: {str(err or self._stderr_tail)[:200]}")
        self.tools = tools_result.get("tools") or []
        self.status = "connected"
        logger.info(f"MCP Server '{self.name}' (stdio) 已连接，{len(self.tools)} 个工具")
        return True

    async def _read_stdout(self):
        assert self._proc and self._proc.stdout
        try:
            async for line in self._proc.stdout:
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue  # 有些服务器往 stdout 混日志行，跳过
                req_id = msg.get("id")
                if req_id is not None and req_id in self._pending:
                    fut = self._pending.pop(req_id)
                    if not fut.done():
                        fut.set_result({"error": msg["error"]} if "error" in msg else msg.get("result", {}))
        except asyncio.CancelledError:
            return
        except Exception:
            pass
        # stdout 走到头＝进程退了：挂起请求立即失败，状态改错
        if self.status in ("connecting", "connected"):
            self.status = "error"
            self.error = (self._stderr_tail or "进程已退出")[:300]
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_result({"error": "stdio 进程已退出"})

    async def _read_stderr(self):
        assert self._proc and self._proc.stderr
        try:
            async for line in self._proc.stderr:
                self._stderr_tail = (self._stderr_tail + line.decode("utf-8", errors="replace"))[-2000:]
        except asyncio.CancelledError:
            return
        except Exception:
            pass

    async def _send_request(self, method: str, params: dict, timeout: float = 15.0) -> dict | None:
        if not self._proc or not self._proc.stdin or self._proc.returncode is not None:
            return {"error": "stdio 进程未在运行"}
        self._request_id += 1
        req_id = self._request_id
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        try:
            self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            return {"error": "响应超时"}
        except Exception as e:
            self._pending.pop(req_id, None)
            return {"error": str(e)[:200]}

    async def _send_notification(self, method: str, params: dict | None = None):
        if not self._proc or not self._proc.stdin or self._proc.returncode is not None:
            return
        payload = {"jsonrpc": "2.0", "method": method}
        if params:
            payload["params"] = params
        try:
            self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
        except Exception:
            pass

    async def call_tool(self, tool_name: str, arguments: dict) -> dict[str, Any]:
        if self.status != "connected":
            return {"error": f"服务器未连接: {self.status}"}
        result = await self._send_request("tools/call", {"name": tool_name, "arguments": arguments}, timeout=60.0)
        if result is None:
            return {"error": "请求失败"}
        if "error" in result:
            return {"error": result["error"]}
        return result

    async def disconnect(self):
        await self._teardown()
        self.tools = []
        self.status = "disconnected"


# ── 管理器（全局单例） ──────────────────────────────────

_connections: dict[str, Any] = {}
_config_load_error = False  # 原文件损坏时置位，保存前备份防覆盖丢失


def _load_config() -> list[dict[str, Any]]:
    """从磁盘加载 MCP Server 配置。"""
    global _config_load_error
    if not CONFIG_PATH.exists():
        _config_load_error = False
        return []
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        _config_load_error = False
        return data if isinstance(data, list) else []
    except Exception:
        _config_load_error = True
        return []


def _save_config(servers: list[dict[str, Any]]):
    """保存 MCP Server 配置到磁盘（原子写；原文件损坏时先备份再写）。"""
    if _config_load_error:
        backup_corrupt(CONFIG_PATH)
    atomic_write_json(CONFIG_PATH, servers)


def _make_connection(cfg: dict[str, Any]):
    """按配置里的 transport 造连接：缺省与旧配置都是 SSE，stdio 是新增那路。"""
    sid = cfg["id"]
    name = cfg.get("name", "")
    if cfg.get("transport") == "stdio":
        return StdioConnection(sid, name, cfg.get("command", ""), cfg.get("args") or [],
                               cfg.get("env") or {}, cfg.get("enabled", True))
    return McpServerConnection(sid, name, cfg.get("url", ""), cfg.get("enabled", True))


def list_servers(project_id: str = "") -> list[dict[str, Any]]:
    """列出所有已配置的 MCP Server 及其状态。

    带 project 时每条多给两个字段：`effectiveEnabled`（这一项目里到底用不用）与
    `enableScope`（这条结论来自项目掩码还是全局那一份）。面板要写明"现在关的是哪一份"，
    光靠一个开关按钮说不清——关错一份会把别的项目共用的服务器一起停掉。
    """
    configs = _load_config()
    result = []
    for cfg in configs:
        sid = cfg["id"]
        conn = _connections.get(sid)
        base = conn.to_dict() if conn else {
            "id": sid,
            "name": cfg.get("name", ""),
            "url": cfg.get("url", ""),
            "transport": cfg.get("transport", "sse"),
            "command": cfg.get("command", ""),
            "args": cfg.get("args") or [],
            "enabled": cfg.get("enabled", True),
            "status": "disconnected",
            "error": "",
            "tools": [],
            "toolCount": 0,
        }
        default_on = bool(base.get("enabled", True))
        masked = bool(project_id) and str(sid) in scope_overlay.mcp_mask_of(project_id)
        base["effectiveEnabled"] = scope_overlay.server_enabled(project_id, sid, default=default_on)
        base["enableScope"] = "project" if masked else "global"
        result.append(base)
    return result


def get_all_remote_tools(project_id: str = "") -> list[dict[str, Any]]:
    """获取所有已连接 MCP Server 的工具列表（供技能面板和 AI 工具系统使用）。

    带 project 时按该项目掩码过滤：整台关掉的不进列表，只给了白名单的只进白名单那几个。
    """
    tools = []
    for conn in _connections.values():
        if conn.status != "connected" or not conn.enabled:
            continue
        if not scope_overlay.server_enabled(project_id, conn.server_id, default=True):
            continue
        for t in conn.tools:
            if not scope_overlay.tool_allowed(project_id, conn.server_id, t["name"]):
                continue
            tools.append({
                "name": t["name"],
                "description": t.get("description", ""),
                "server": conn.name,
                "serverId": conn.server_id,
                # 带 url 才认得出品牌：Server 名是用户手输的任意字符串，
                # "My MCP" 指向 mcp.notion.com 时前端也该画 Notion 的 mark。
                "url": conn.url,
            })
    return tools


async def add_server(name: str, url: str = "", auto_connect: bool = True, *,
                     command: str = "", args: list[str] | None = None,
                     env: dict[str, str] | None = None) -> dict[str, Any]:
    """添加一个新的 MCP Server：给 url 走 SSE，给 command 走 stdio 子进程。"""
    configs = _load_config()
    import hashlib

    if command:
        args = list(args or [])
        key = json.dumps([command, args], ensure_ascii=False)
        for cfg in configs:
            if cfg.get("transport") == "stdio" and cfg.get("command") == command and (cfg.get("args") or []) == args:
                return {"error": f"该命令已配置: {cfg.get('name', '')}"}
        sid = hashlib.sha256(key.encode()).hexdigest()[:12]
        cfg = {"id": sid, "name": name, "transport": "stdio", "command": command,
               "args": args, "env": dict(env or {}), "enabled": True}
    else:
        # 检查 URL 是否已存在
        for cfg in configs:
            if cfg.get("url") == url:
                return {"error": f"该地址已配置: {cfg.get('name', '')}"}
        sid = hashlib.sha256(url.encode()).hexdigest()[:12]
        cfg = {"id": sid, "name": name, "url": url, "enabled": True}

    configs.append(cfg)
    _save_config(configs)

    if auto_connect:
        conn = _make_connection(cfg)
        _connections[sid] = conn
        ok = await conn.connect()
        if not ok:
            return {**conn.to_dict(), "status": "error", "error": conn.error}
        return conn.to_dict()

    return {**cfg, "status": "disconnected", "error": "", "tools": [], "toolCount": 0}


async def remove_server(server_id: str) -> dict[str, Any]:
    """移除一个 MCP Server。"""
    conn = _connections.pop(server_id, None)
    if conn:
        await conn.disconnect()

    configs = _load_config()
    configs = [c for c in configs if c["id"] != server_id]
    _save_config(configs)
    return {"ok": True}


async def connect_server(server_id: str) -> dict[str, Any]:
    """连接指定的 MCP Server。"""
    configs = _load_config()
    cfg = next((c for c in configs if c["id"] == server_id), None)
    if not cfg:
        return {"error": f"服务器不存在: {server_id}"}

    # 先断开旧连接
    old = _connections.pop(server_id, None)
    if old:
        await old.disconnect()

    conn = _make_connection(cfg)
    _connections[server_id] = conn
    ok = await conn.connect()
    if not ok:
        return conn.to_dict()
    return conn.to_dict()


async def disconnect_server(server_id: str) -> dict[str, Any]:
    """断开指定的 MCP Server。"""
    conn = _connections.pop(server_id, None)
    if conn:
        await conn.disconnect()
    return {"ok": True}


async def call_remote_tool(server_id: str, tool_name: str, arguments: dict, project_id: str = "") -> dict[str, Any]:
    """调用远程 MCP Server 上的工具。

    带 project 时在门口再验一次掩码：列表已经过滤过一轮，这里是防御性复核——
    前端拿到的是旧列表、或有人直接打这条路由，都不该绕过项目的收窄。
    """
    conn = _connections.get(server_id)
    if not conn:
        return {"error": f"服务器未连接: {server_id}"}
    if conn.status != "connected":
        return {"error": f"服务器未连接: {conn.status}"}
    if project_id and not scope_overlay.server_enabled(project_id, server_id, default=conn.enabled):
        return {"error": f"这台服务器在该项目里已关闭: {conn.name}"}
    if project_id and not scope_overlay.tool_allowed(project_id, server_id, tool_name):
        return {"error": f"工具 {tool_name} 不在该项目允许的清单里（服务器：{conn.name}）"}
    return await conn.call_tool(tool_name, arguments)


async def startup_connect_all():
    """启动时自动连接所有已启用的 MCP Server。"""
    configs = _load_config()
    for cfg in configs:
        if not cfg.get("enabled", True):
            continue
        sid = cfg["id"]
        conn = _make_connection(cfg)
        _connections[sid] = conn
        try:
            ok = await conn.connect()
            if ok:
                logger.info(f"MCP Server '{cfg['name']}' 启动连接成功")
            else:
                logger.warning(f"MCP Server '{cfg['name']}' 启动连接失败: {conn.error}")
        except Exception as e:
            logger.warning(f"MCP Server '{cfg['name']}' 启动连接异常: {e}")


async def shutdown_disconnect_all():
    """关闭时断开所有连接。"""
    for conn in _connections.values():
        await conn.disconnect()
    _connections.clear()
