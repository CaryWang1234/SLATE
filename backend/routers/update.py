"""更新检查路由：启动时查询 GitHub 最新 Release，提示用户下载新版安装包。

版本号唯一事实源：APP_VERSION（需与 SLATE_InnoSetup.iss 的 MyAppVersion 保持同步）。
"""

from __future__ import annotations

import re
import webbrowser

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/update", tags=["update"])

# 与 SLATE_InnoSetup.iss 的 MyAppVersion 保持同步
APP_VERSION = "0.3.3"

REPO = "CaryWang1234/SLATE"
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
# 安装包命名规则：SLATE-Setup-{版本}.exe（与 build_installer.bat 产物一致）
DOWNLOAD_URL = "https://github.com/{repo}/releases/download/{tag}/SLATE-Setup-{ver}.exe"
RELEASE_PAGE = "https://github.com/{repo}/releases/tag/{tag}"
# 允许用系统浏览器打开的链接前缀：本仓库 GitHub 页 + 官网
ALLOWED_PREFIXES = (
    f"https://github.com/{REPO}",
    "https://carywang1234.github.io/SLATE",
)


def _parse_version(tag: str) -> tuple[int, ...]:
    """把 v0.2.7 / 0.2.7 / v0.2.7-beta 之类的 tag 解析为可比较的数字元组。"""
    nums = re.findall(r"\d+", tag or "")
    return tuple(int(n) for n in nums[:3]) if nums else (0,)


@router.get("/check")
async def check_update():
    """查询最新 Release。网络失败静默返回 hasUpdate=false，绝不阻塞启动。"""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                API_URL,
                headers={"User-Agent": "SLATE", "Accept": "application/vnd.github+json"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return {
            "code": 0,
            "data": {"current": APP_VERSION, "hasUpdate": False, "checked": False},
            "message": "更新检查失败（网络不可用），已跳过",
        }

    tag = str(data.get("tag_name") or "").strip()
    latest = tag.lstrip("vV")
    has_update = bool(tag) and _parse_version(latest) > _parse_version(APP_VERSION)

    # 优先取 Release 资产里的 .exe 直链，取不到再按命名规则拼接
    asset_url = ""
    for asset in data.get("assets") or []:
        if str(asset.get("name") or "").lower().endswith(".exe"):
            asset_url = str(asset.get("browser_download_url") or "")
            break

    return {
        "code": 0,
        "data": {
            "current": APP_VERSION,
            "latest": latest,
            "hasUpdate": has_update,
            "checked": True,
            "downloadUrl": asset_url or DOWNLOAD_URL.format(repo=REPO, tag=tag, ver=latest),
            "releaseUrl": RELEASE_PAGE.format(repo=REPO, tag=tag),
            "notes": str(data.get("body") or "")[:500],
        },
        "message": "ok",
    }


class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
async def open_url(req: OpenUrlRequest):
    """用系统浏览器打开项目链接（webview 内 window.open 不可靠）。

    白名单限制：仅允许本仓库 GitHub 页与官网链接，防止被当作通用跳板。
    """
    url = (req.url or "").strip()
    if not any(url.startswith(p) for p in ALLOWED_PREFIXES):
        return {"code": 1, "message": "仅允许打开本项目的 GitHub / 官网链接"}
    try:
        webbrowser.open(url)
        return {"code": 0, "data": None, "message": "ok"}
    except Exception as e:
        return {"code": 1, "message": f"打开链接失败: {e}"}
