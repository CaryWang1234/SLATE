"""外部 MCP Server 客户端管理器。

通过 SSE 传输协议连接外部 MCP Server，发现并调用其工具。
支持多 Server 同时连接，连接状态持久化。

协议规范：https://modelcontextprotocol.io/docs/concepts/transports
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

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

    async def connect(self) -> bool:
        """建立 SSE 连接，获取 message URL，拉取工具列表。"""
        self.status = "connecting"
        self.error = ""
        self.tools = []

        try:
            self._client = httpx.AsyncClient(timeout=30.0)

            # 1. 连接 SSE 端点，获取 message URL
            sse_url = f"{self.url}/sse"
            async with self._client.stream("GET", sse_url, headers={"Accept": "text/event-stream"}) as resp:
                if resp.status_code != 200:
                    self.status = "error"
                    self.error = f"SSE 连接失败: HTTP {resp.status_code}"
                    return False

                # 读取第一个 SSE 事件：endpoint
                async for line in resp.aiter_lines():
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data.startswith("/message"):
                            # message URL 可能是相对路径
                            if data.startswith("http"):
                                self._message_url = data
                            else:
                                self._message_url = f"{self.url}{data}"
                            break
                        elif data.startswith("http"):
                            self._message_url = data
                            break

                if not self._message_url:
                    self.status = "error"
                    self.error = "未收到 message endpoint"
                    return False

            # SSE 流需要保持，重新建立长连接在后台监听
            self._sse_task = asyncio.create_task(self._listen_sse())

            # 等一小段时间让 SSE 连接稳定
            await asyncio.sleep(0.3)

            # 2. 发送 initialize 请求
            init_result = await self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "SLATE", "version": "1.0.0"},
            })

            # 3. 发送 initialized 通知
            await self._send_notification("notifications/initialized")

            # 4. 拉取工具列表
            tools_result = await self._send_request("tools/list", {})
            if tools_result and "tools" in tools_result:
                self.tools = tools_result["tools"]

            self.status = "connected"
            self._connected_at = time.time()
            logger.info(f"MCP Server '{self.name}' 已连接，{len(self.tools)} 个工具")
            return True

        except httpx.ConnectError:
            self.status = "error"
            self.error = f"无法连接到 {self.url}"
            return False
        except httpx.TimeoutException:
            self.status = "error"
            self.error = "连接超时"
            return False
        except Exception as e:
            self.status = "error"
            self.error = str(e)[:200]
            logger.exception(f"MCP Server '{self.name}' 连接失败")
            return False

    async def _listen_sse(self):
        """后台监听 SSE 流，处理响应和通知。"""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", f"{self.url}/sse", headers={"Accept": "text/event-stream"}) as resp:
                    event_type = ""
                    async for line in resp.aiter_lines():
                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            data = line[5:].strip()
                            if event_type == "message" and data:
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
            if self.status == "connected":
                self.status = "error"
                self.error = f"连接断开: {e}"

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
        future = asyncio.get_event_loop().create_future()
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
            self._sse_task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._pending.clear()
        self.tools = []
        self._message_url = ""
        self.status = "disconnected"


# ── 管理器（全局单例） ──────────────────────────────────

_connections: dict[str, McpServerConnection] = {}


def _load_config() -> list[dict[str, Any]]:
    """从磁盘加载 MCP Server 配置。"""
    if not CONFIG_PATH.exists():
        return []
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_config(servers: list[dict[str, Any]]):
    """保存 MCP Server 配置到磁盘。"""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(servers, ensure_ascii=False, indent=2), encoding="utf-8")


def list_servers() -> list[dict[str, Any]]:
    """列出所有已配置的 MCP Server 及其状态。"""
    configs = _load_config()
    result = []
    for cfg in configs:
        sid = cfg["id"]
        conn = _connections.get(sid)
        if conn:
            result.append(conn.to_dict())
        else:
            result.append({
                "id": sid,
                "name": cfg.get("name", ""),
                "url": cfg.get("url", ""),
                "enabled": cfg.get("enabled", True),
                "status": "disconnected",
                "error": "",
                "tools": [],
                "toolCount": 0,
            })
    return result


def get_all_remote_tools() -> list[dict[str, Any]]:
    """获取所有已连接 MCP Server 的工具列表（供技能面板和 AI 工具系统使用）。"""
    tools = []
    for conn in _connections.values():
        if conn.status == "connected" and conn.enabled:
            for t in conn.tools:
                tools.append({
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "server": conn.name,
                    "serverId": conn.server_id,
                })
    return tools


async def add_server(name: str, url: str, auto_connect: bool = True) -> dict[str, Any]:
    """添加一个新的 MCP Server。"""
    configs = _load_config()
    # 检查 URL 是否已存在
    for cfg in configs:
        if cfg.get("url") == url:
            return {"error": f"该地址已配置: {cfg.get('name', '')}"}

    import hashlib
    sid = hashlib.sha256(url.encode()).hexdigest()[:12]

    cfg = {"id": sid, "name": name, "url": url, "enabled": True}
    configs.append(cfg)
    _save_config(configs)

    if auto_connect:
        conn = McpServerConnection(sid, name, url)
        _connections[sid] = conn
        ok = await conn.connect()
        if not ok:
            return {"id": sid, "name": name, "url": url, "status": "error", "error": conn.error, "tools": [], "toolCount": 0}
        return conn.to_dict()

    return {"id": sid, "name": name, "url": url, "status": "disconnected", "tools": [], "toolCount": 0}


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

    conn = McpServerConnection(server_id, cfg["name"], cfg["url"], cfg.get("enabled", True))
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


async def call_remote_tool(server_id: str, tool_name: str, arguments: dict) -> dict[str, Any]:
    """调用远程 MCP Server 上的工具。"""
    conn = _connections.get(server_id)
    if not conn:
        return {"error": f"服务器未连接: {server_id}"}
    if conn.status != "connected":
        return {"error": f"服务器未连接: {conn.status}"}
    return await conn.call_tool(tool_name, arguments)


async def startup_connect_all():
    """启动时自动连接所有已启用的 MCP Server。"""
    configs = _load_config()
    for cfg in configs:
        if not cfg.get("enabled", True):
            continue
        sid = cfg["id"]
        conn = McpServerConnection(sid, cfg["name"], cfg["url"])
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
