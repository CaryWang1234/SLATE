# -*- coding: utf-8 -*-
"""局域网遥控：在 0.0.0.0 上共享主应用，供局域网设备用浏览器遥控 SLATE。

实现要点：
- 与主服务共享同一个 FastAPI app 实例（UI 与能力完全一致），
  副服务在守护线程中运行 uvicorn.Server，lifespan="off" 避免重复触发启动事件；
- 默认端口 8001，被占用时向上扫描，实际端口经 /info 返回；
- /info 返回局域网地址供前端醒目展示，/qrcode 生成地址二维码。
"""

from __future__ import annotations

import socket
import secrets
import threading
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

router = APIRouter(prefix="/lan", tags=["lan"])

PREFERRED_PORT = 8001
PORT_SCAN_RANGE = 20  # 8001 被占用时最多向上尝试的端口数

TOKEN_QUERY = "slate_lan_token"
TOKEN_COOKIE = "slate_lan_auth"
TOKEN_HEADER = "x-slate-lan-token"

_state: dict[str, Any] = {"port": None, "error": "", "thread": None, "token": secrets.token_urlsafe(24)}
_lock = threading.Lock()


def _port_free(port: int) -> bool:
    """检测 0.0.0.0 上的端口是否可用。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _pick_port() -> int | None:
    """优先 8001，其次向上扫描，最后交给系统分配。"""
    for port in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN_RANGE):
        if _port_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", 0))
            return s.getsockname()[1]
        except OSError:
            return None


def get_lan_ip() -> str:
    """获取本机局域网 IP（UDP 连接探测，无需真正发包）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


def _remote_url(ip: str, port: int) -> str:
    """生成带鉴权 token 的局域网访问地址。"""
    return f"http://{ip}:{port}/?{TOKEN_QUERY}={_state['token']}"


def _host_port(request: Request) -> int | None:
    host = request.headers.get("host", "")
    if host.startswith("["):
        # IPv6 host like [::1]:8001
        _, _, tail = host.rpartition("]:")
        host = tail
    elif ":" in host:
        host = host.rsplit(":", 1)[1]
    else:
        return None
    try:
        return int(host)
    except ValueError:
        return None


def is_lan_request(request: Request) -> bool:
    """是否来自局域网副服务端口。主 127.0.0.1 端口不走此鉴权。"""
    port = _state.get("port")
    return bool(port and _host_port(request) == port)


def _authorized(request: Request) -> bool:
    expected = str(_state.get("token") or "")
    if not expected:
        return False
    candidates = (
        request.query_params.get(TOKEN_QUERY, ""),
        request.cookies.get(TOKEN_COOKIE, ""),
        request.headers.get(TOKEN_HEADER, ""),
    )
    return any(secrets.compare_digest(str(item), expected) for item in candidates if item)


def _auth_page() -> HTMLResponse:
    return HTMLResponse(
        status_code=401,
        content="""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SLATE 局域网遥控需要授权</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f3;color:#202124}
    main{width:min(520px,calc(100vw - 40px));border:1px solid #d8d8d2;background:#fff;padding:28px}
    h1{font-size:20px;margin:0 0 12px} p{line-height:1.7;color:#555;margin:0 0 12px} code{background:#f0f0ec;padding:2px 6px}
  </style>
</head>
<body>
  <main>
    <h1>局域网遥控需要授权</h1>
    <p>请在运行 SLATE 的主电脑上打开「设置 → 局域网遥控」，复制带授权码的遥控地址，或扫码进入。</p>
    <p>为安全起见，未带授权码的局域网访问已被拦截。</p>
  </main>
</body>
</html>""",
    )


async def enforce_lan_auth(request: Request, call_next):
    """FastAPI middleware：仅保护局域网副端口。"""
    if not is_lan_request(request):
        return await call_next(request)
    if not _authorized(request):
        return _auth_page()
    response = await call_next(request)
    if request.query_params.get(TOKEN_QUERY):
        response.set_cookie(
            TOKEN_COOKIE,
            str(_state["token"]),
            httponly=True,
            samesite="lax",
            max_age=60 * 60 * 24 * 30,
        )
    return response


def start_lan_server(app: Any) -> None:
    """启动局域网副服务（幂等）。由主应用 startup 事件调用。"""
    with _lock:
        thread = _state["thread"]
        if thread is not None and thread.is_alive():
            return
        port = _pick_port()
        if port is None:
            _state["error"] = "未找到可用端口，局域网遥控未启动"
            return
        try:
            import uvicorn
            config = uvicorn.Config(
                app, host="0.0.0.0", port=port,
                log_level="warning", lifespan="off",
            )
            server = uvicorn.Server(config)
        except Exception as e:  # pragma: no cover
            _state["error"] = f"副服务初始化失败: {e}"
            return

        def _run() -> None:
            try:
                server.run()
            except Exception as e:
                _state["error"] = f"局域网服务异常退出: {e}"

        t = threading.Thread(target=_run, daemon=True, name="slate-lan")
        t.start()
        _state["port"] = port
        _state["error"] = ""
        _state["thread"] = t


@router.get("/info")
async def lan_info() -> dict[str, Any]:
    """返回局域网遥控地址（前端设置页醒目展示）。"""
    port = _state["port"]
    ip = get_lan_ip()
    urls = [f"http://{ip}:{port}"] if port else []
    auth_urls = [_remote_url(ip, port)] if port else []
    return {
        "code": 0,
        "data": {
            "enabled": port is not None,
            "port": port,
            "ip": ip,
            "urls": auth_urls,
            "plainUrls": urls,
            "auth": {
                "enabled": True,
                "query": TOKEN_QUERY,
            },
            "error": _state["error"],
        },
        "message": "ok",
    }


@router.get("/qrcode")
async def lan_qrcode() -> Response:
    """生成局域网遥控地址的 SVG 二维码。"""
    port = _state["port"]
    if not port:
        return Response(content="", status_code=503, media_type="text/plain")
    url = _remote_url(get_lan_ip(), port)
    try:
        import qrcode
        import qrcode.image.svg
        qr = qrcode.QRCode(
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10, border=2,
            image_factory=qrcode.image.svg.SvgPathImage,
        )
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#1a1d23", back_color="#ffffff")
        svg = img.to_string().decode("utf-8")
        return Response(content=svg, media_type="image/svg+xml")
    except ImportError:
        return Response(content="qrcode 库未安装", status_code=500, media_type="text/plain")
