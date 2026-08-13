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
import threading
from typing import Any

from fastapi import APIRouter
from fastapi.responses import Response

router = APIRouter(prefix="/lan", tags=["lan"])

PREFERRED_PORT = 8001
PORT_SCAN_RANGE = 20  # 8001 被占用时最多向上尝试的端口数

_state: dict[str, Any] = {"port": None, "error": "", "thread": None}
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
    return {
        "code": 0,
        "data": {
            "enabled": port is not None,
            "port": port,
            "ip": ip,
            "urls": urls,
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
    url = f"http://{get_lan_ip()}:{port}"
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
