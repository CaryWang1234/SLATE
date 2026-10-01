# -*- coding: utf-8 -*-
"""自定义主题的背景图存取。

配色与字体本身是几个字符串，直接进 desktop_state.json 的 customTheme 键；
背景图是几百 KB 的二进制，不能塞进状态文件（localStorage 有配额，且每次 savePersistent
都会整份重写）。所以这里只存文件，状态里存"有没有背景图"这一个标记 + 缓存串。

上传走 JSON + base64 而不是 multipart：api.js 的 upload() 不带局域网鉴权头，
手机遥控时会被 401 挡掉；post() 走的是那条带鉴权的通道。
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter(prefix="/theme", tags=["theme"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
THEME_DIR = DATA_DIR / "theme"

# 4MB 上限：背景图铺满屏幕用不了更多，也让一次误选视频不至于把 data/ 撑爆
MAX_BACKGROUND_BYTES = 4 * 1024 * 1024

# 认内容不认扩展名：前 12 字节的魔数 → (扩展名, MIME)
_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
)

_B64_RE = re.compile(r"^[A-Za-z0-9+/=\s]+$")


class BackgroundRequest(BaseModel):
    data: str = ""


def _sniff(raw: bytes) -> tuple[str, str]:
    """返回 (扩展名, MIME)。认不出来的直接拒：这张图会被 CSS 当背景反复请求，别留活口。"""
    for magic, ext, mime in _MAGIC:
        if raw.startswith(magic):
            return ext, mime
    # WebP: "RIFF"...."WEBP"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp", "image/webp"
    raise HTTPException(status_code=400, detail="只支持 PNG / JPG / GIF / WebP 背景图")


def _current_file() -> Path | None:
    """data/theme/ 里唯一那张背景图（历史上换过格式会留下旧文件，取最新的一张）。

    排除 background.tmp*：那是写一半的临时名，断电之类留下的残骸不该被当成图发出去。
    """
    if not THEME_DIR.is_dir():
        return None
    files = [p for p in THEME_DIR.glob("background.*")
             if p.is_file() and not p.name.startswith("background.tmp")]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _drop_others(keep: Path) -> None:
    # 连 background.tmp* 残骸一起收：那是上次写一半断掉的，留着只会占地方
    for p in THEME_DIR.glob("background.*"):
        if p != keep:
            try:
                p.unlink()
            except OSError:
                pass


@router.get("/background/status")
async def background_status():
    """前端每次生效主题前先问一句「这台机器上到底有没有那张图」。

    不直接靠 GET /background 的 404 判断：那条路会把图片本身下载一遍，
    而且 404 会在控制台里留一条难看红色的请求。
    """
    path = _current_file()
    stat = path.stat() if path else None
    return {
        "code": 0,
        "data": {
            "exists": bool(path),
            "stamp": int(stat.st_mtime * 1000) if stat else 0,
            # 设置页那行说明要报"这张图多大"，让用户在换图后知道自己塞进去的是什么
            "bytes": stat.st_size if stat else 0,
        },
        "message": "ok",
    }


@router.get("/background")
async def get_background():
    """没有背景图时返回 404：前端把这张图当 CSS url() 用，404 就是"不画"，不需要额外协议。"""
    path = _current_file()
    if not path:
        raise HTTPException(status_code=404, detail="没有背景图")
    ext = path.suffix.lower()
    mime = "image/png" if ext == ".png" else {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    }.get(ext, "application/octet-stream")
    # no-store：换图后同名文件被覆盖，靠缓存串会看到上一张
    return FileResponse(str(path), media_type=mime, headers={"Cache-Control": "no-store"})


@router.post("/background")
async def save_background(req: BackgroundRequest):
    raw_b64 = (req.data or "").strip()
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    if not raw_b64 or not _B64_RE.match(raw_b64):
        raise HTTPException(status_code=400, detail="背景图内容不是有效的 base64")
    try:
        raw = base64.b64decode(raw_b64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"背景图解码失败: {exc}")
    if not raw:
        raise HTTPException(status_code=400, detail="背景图是空的")
    if len(raw) > MAX_BACKGROUND_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"背景图超过 {MAX_BACKGROUND_BYTES // 1024 // 1024}MB，换一张小一点的")
    ext, _mime = _sniff(raw)
    THEME_DIR.mkdir(parents=True, exist_ok=True)
    target = THEME_DIR / f"background{ext}"
    # 先写临时名再换：直接覆盖的话，写到一半断电会留下半张图，CSS 会反复请求它
    tmp = THEME_DIR / f"background.tmp{ext}"
    tmp.write_bytes(raw)
    tmp.replace(target)
    _drop_others(target)
    return {"code": 0, "data": {"bytes": len(raw), "ext": ext,
                               # 缓存串用文件 mtime：同一 URL 换图后浏览器不会拿旧的那张
                               "stamp": int(target.stat().st_mtime * 1000)},
            "message": "ok"}


@router.delete("/background")
async def delete_background():
    removed = 0
    if THEME_DIR.is_dir():
        for p in THEME_DIR.glob("background.*"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return {"code": 0, "data": {"removed": removed}, "message": "ok"}
