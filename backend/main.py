"""SLATE 后端入口：挂载静态目录，注册路由。"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routers import chat, constitution, experts, files, grind, i18n, knowledge, lan, mcp, mcp_servers, proxy, projects, scheduler, settings, skills, update, vault, workflows
from backend import mcp_client

# system_info 需要 psutil，可能不在所有环境中可用
try:
    from backend.routers import system_info
    HAS_SYSTEM_INFO = True
except ImportError as e:
    import logging
    logging.warning(f"[system_info] 路由导入失败: {e}")
    HAS_SYSTEM_INFO = False

PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))

app = FastAPI(title="SLATE", version="20260803-1")

# CORS：仅允许本机来源（桌面应用同源加载，不受影响）；跨源恶意网页一律拒绝
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],  # file:// 直接打开时的 origin
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 最大请求体大小 (20MB)
MAX_REQUEST_BODY_SIZE = 20 * 1024 * 1024


@app.middleware("http")
async def check_request_size(request: Request, call_next):
    """拦截超大请求体，防止内存溢出攻击。"""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BODY_SIZE:
                return JSONResponse(
                    status_code=413,
                    content={"code": -1, "data": None, "message": f"请求体过大（最大 {MAX_REQUEST_BODY_SIZE // 1024 // 1024}MB）"},
                )
        except ValueError:
            pass
    return await call_next(request)


@app.middleware("http")
async def check_lan_auth(request: Request, call_next):
    """局域网副端口访问必须带授权 token；本机主端口不受影响。"""
    return await lan.enforce_lan_auth(request, call_next)


@app.middleware("http")
async def add_dev_cache_headers(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# 注册 API 路由
app.include_router(proxy.router, prefix="/api")
app.include_router(constitution.router, prefix="/api")
app.include_router(skills.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(grind.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(update.router, prefix="/api")
app.include_router(knowledge.router, prefix="/api")
app.include_router(experts.router, prefix="/api")
app.include_router(scheduler.router, prefix="/api")
app.include_router(workflows.router, prefix="/api")
app.include_router(lan.router, prefix="/api")
app.include_router(i18n.router, prefix="/api")
app.include_router(vault.router, prefix="/api")
app.include_router(mcp.router, prefix="/api")
app.include_router(mcp_servers.router, prefix="/api")

# system_info 路由（需要 psutil，可能不可用）
if HAS_SYSTEM_INFO:
    app.include_router(system_info.router, prefix="/api")


@app.on_event("startup")
async def _start_schedule_loop():
    """启动定时任务后台循环。"""
    scheduler.start_scheduler()


@app.on_event("startup")
async def _start_lan_remote():
    """启动局域网遥控副服务（0.0.0.0:8001，共享本 app）。"""
    lan.start_lan_server(app)


@app.on_event("startup")
async def _start_mcp_clients():
    """启动时自动连接已配置的外部 MCP Server。"""
    asyncio.create_task(mcp_client.startup_connect_all())


@app.on_event("shutdown")
async def _shutdown_mcp_clients():
    """关闭时断开所有 MCP Server 连接。"""
    await mcp_client.shutdown_disconnect_all()

# 挂载前端静态文件
frontend_dir = PROJECT_ROOT / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
