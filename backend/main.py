"""SLATE 后端入口：挂载静态目录，注册路由。"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.routers import chat, constitution, files, proxy, projects, settings, skills

PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))

app = FastAPI(title="SLATE", version="0.1.0")

# CORS：开发阶段允许全部来源
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
app.include_router(files.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(settings.router, prefix="/api")

# 挂载前端静态文件
frontend_dir = PROJECT_ROOT / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
