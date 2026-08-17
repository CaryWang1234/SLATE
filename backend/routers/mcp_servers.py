"""外部 MCP Server 管理路由。

提供 REST API 增删查改外部 MCP Server 连接，
以及代理调用远程工具。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import mcp_client

router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])


@router.get("")
async def list_mcp_servers() -> dict[str, Any]:
    """列出所有已配置的 MCP Server 及连接状态。"""
    servers = mcp_client.list_servers()
    return {"code": 0, "data": servers, "message": "ok"}


class AddServerRequest(BaseModel):
    name: str
    url: str
    auto_connect: bool = True


@router.post("")
async def add_mcp_server(req: AddServerRequest) -> dict[str, Any]:
    """添加并连接一个新的外部 MCP Server。"""
    if not req.name or not req.name.strip():
        return {"code": 1, "message": "名称不能为空"}
    if not req.url or not req.url.strip():
        return {"code": 1, "message": "URL 不能为空"}
    result = await mcp_client.add_server(req.name.strip(), req.url.strip(), req.auto_connect)
    if "error" in result and "id" not in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


@router.post("/{server_id}/connect")
async def connect_mcp_server(server_id: str) -> dict[str, Any]:
    """连接指定的 MCP Server。"""
    result = await mcp_client.connect_server(server_id)
    if "error" in result and result.get("status") != "error":
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


@router.post("/{server_id}/disconnect")
async def disconnect_mcp_server(server_id: str) -> dict[str, Any]:
    """断开指定的 MCP Server。"""
    result = await mcp_client.disconnect_server(server_id)
    return {"code": 0, "data": result, "message": "ok"}


@router.delete("/{server_id}")
async def remove_mcp_server(server_id: str) -> dict[str, Any]:
    """移除一个 MCP Server 配置。"""
    result = await mcp_client.remove_server(server_id)
    return {"code": 0, "data": result, "message": "ok"}


@router.get("/tools")
async def list_remote_tools() -> dict[str, Any]:
    """获取所有已连接 MCP Server 的工具列表。"""
    tools = mcp_client.get_all_remote_tools()
    return {"code": 0, "data": tools, "message": "ok"}


class CallRemoteToolRequest(BaseModel):
    server_id: str
    tool_name: str
    arguments: dict = {}


@router.post("/call")
async def call_remote_tool(req: CallRemoteToolRequest) -> dict[str, Any]:
    """代理调用远程 MCP Server 上的工具。"""
    result = await mcp_client.call_remote_tool(req.server_id, req.tool_name, req.arguments)
    if "error" in result:
        return {"code": -1, "data": None, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}
