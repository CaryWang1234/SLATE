"""技能：桌面自动化 / Computer Use（基于 pyautogui + Pillow）。

支持动作：
- screenshot: 截取全屏或指定区域截图
- click: 鼠标点击指定坐标
- double_click: 双击
- right_click: 右键点击
- type: 输入文字（支持英文，中文使用剪贴板粘贴）
- hotkey: 按下组合键（如 ctrl+c, alt+tab）
- scroll: 鼠标滚轮滚动
- move: 移动鼠标到指定坐标
- drag: 拖拽到指定坐标
- position: 获取当前鼠标位置
- screen_size: 获取屏幕分辨率
- locate: 在屏幕上查找图片位置（图像识别，需要参考图片）

适用于自动化桌面操作、UI 测试、屏幕截图等场景。
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Any

# ── 安全设置 ──────────────────────────────────────

# pyautogui 安全配置
_FAILSAFE = True      # 鼠标移到左上角时中止
_PAUSE = 0.1          # 每次操作后暂停 0.1 秒


def _get_pyautogui():
    """延迟导入并配置 pyautogui。"""
    try:
        import pyautogui
    except ImportError:
        raise RuntimeError("pyautogui 未安装。请执行: pip install pyautogui")
    pyautogui.FAILSAFE = _FAILSAFE
    pyautogui.PAUSE = _PAUSE
    return pyautogui


def _screenshot_path(name: str = "") -> str:
    """生成截图保存路径。"""
    tmp = Path(tempfile.gettempdir()) / "slate_desktop"
    tmp.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    fname = f"{name or 'screenshot'}_{ts}.png"
    return str(tmp / fname)


def _parse_coords(x: Any, y: Any) -> tuple[int, int] | None:
    """解析坐标参数，返回 (x, y) 或 None。"""
    if x is None or y is None:
        return None
    try:
        return int(x), int(y)
    except (ValueError, TypeError):
        return None


def execute(
    action: str = "",
    x: int | str = 0,
    y: int | str = 0,
    text: str = "",
    keys: str = "",
    clicks: int = 1,
    interval: float = 0.0,
    duration: float = 0.25,
    button: str = "left",
    region: str = "",
    screenshot_name: str = "",
    image_path: str = "",
    confidence: float = 0.8,
    scroll_amount: int = 3,
    **_kw: Any,
) -> dict[str, Any]:
    """桌面自动化工具。通过 pyautogui 控制鼠标键盘并截取屏幕。

    Args:
        action: 操作类型 - screenshot/click/double_click/right_click/type/hotkey/scroll/move/drag/position/screen_size/locate
        x: X 坐标（click/move/drag/type 时使用）
        y: Y 坐标（click/move/drag/type 时使用）
        text: 输入文字（action=type 时使用）
        keys: 组合键（action=hotkey 时使用，逗号分隔如 "ctrl,c"）
        clicks: 点击次数（默认 1）
        interval: 多次点击间隔秒数（默认 0）
        duration: 鼠标移动耗时秒数（默认 0.25）
        button: 鼠标按键 - left/right/middle（默认 left）
        region: 截图区域 "x,y,w,h"（可选，默认全屏）
        screenshot_name: 截图文件名前缀（可选）
        image_path: 参考图片路径（action=locate 时必填）
        confidence: 图像匹配置信度 0-1（默认 0.8）
        scroll_amount: 滚动格数（正数向上，负数向下，默认 3）

    Returns:
        dict: 操作结果。
    """
    if not action:
        return {"error": "action 不能为空，可选: screenshot/click/double_click/right_click/type/hotkey/scroll/move/drag/position/screen_size/locate"}

    try:
        pag = _get_pyautogui()
    except RuntimeError as e:
        return {"error": str(e)}

    try:
        # ── screenshot ───────────────────────────────
        if action == "screenshot":
            path = _screenshot_path(screenshot_name)
            if region:
                parts = [int(p.strip()) for p in region.split(",")]
                if len(parts) != 4:
                    return {"error": "region 格式应为 'x,y,w,h'"}
                img = pag.screenshot(region=tuple(parts))
            else:
                img = pag.screenshot()
            img.save(path)
            return {
                "status": "ok",
                "screenshot_path": path,
                "preview_url": f"file://{path}",
                "size": img.size,
            }

        # ── click ────────────────────────────────────
        if action == "click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "click 操作需要有效的 x, y 坐标"}
            pag.click(coords[0], coords[1], clicks=clicks, interval=interval, button=button)
            return {"status": "ok", "message": f"已点击 ({coords[0]}, {coords[1]}) button={button} clicks={clicks}"}

        # ── double_click ─────────────────────────────
        if action == "double_click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "double_click 操作需要有效的 x, y 坐标"}
            pag.doubleClick(coords[0], coords[1])
            return {"status": "ok", "message": f"已双击 ({coords[0]}, {coords[1]})"}

        # ── right_click ──────────────────────────────
        if action == "right_click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "right_click 操作需要有效的 x, y 坐标"}
            pag.rightClick(coords[0], coords[1])
            return {"status": "ok", "message": f"已右键点击 ({coords[0]}, {coords[1]})"}

        # ── type ─────────────────────────────────────
        if action == "type":
            if not text:
                return {"error": "type 操作需要提供 text 参数"}
            # 如果有坐标，先点击该位置
            coords = _parse_coords(x, y)
            if coords:
                pag.click(coords[0], coords[1])
                time.sleep(0.1)
            # 检测是否包含中文字符，中文使用剪贴板粘贴
            if any('\u4e00' <= c <= '\u9fff' for c in text):
                import pyperclip
                pyperclip.copy(text)
                pag.hotkey('ctrl', 'v')
                return {"status": "ok", "message": f"已通过剪贴板粘贴中文文字 ({len(text)} 字符)"}
            else:
                pag.typewrite(text, interval=0.05)
                return {"status": "ok", "message": f"已输入文字 ({len(text)} 字符)"}

        # ── hotkey ───────────────────────────────────
        if action == "hotkey":
            if not keys:
                return {"error": "hotkey 操作需要提供 keys 参数（逗号分隔，如 'ctrl,c'）"}
            key_list = [k.strip() for k in keys.split(",") if k.strip()]
            if not key_list:
                return {"error": "keys 不能为空"}
            pag.hotkey(*key_list)
            return {"status": "ok", "message": f"已按下组合键: {'+'.join(key_list)}"}

        # ── scroll ───────────────────────────────────
        if action == "scroll":
            coords = _parse_coords(x, y)
            if coords:
                pag.scroll(scroll_amount, x=coords[0], y=coords[1])
            else:
                pag.scroll(scroll_amount)
            direction = "向上" if scroll_amount > 0 else "向下"
            return {"status": "ok", "message": f"已滚动 {direction} {abs(scroll_amount)} 格"}

        # ── move ─────────────────────────────────────
        if action == "move":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "move 操作需要有效的 x, y 坐标"}
            pag.moveTo(coords[0], coords[1], duration=duration)
            return {"status": "ok", "message": f"已移动鼠标到 ({coords[0]}, {coords[1]})"}

        # ── drag ─────────────────────────────────────
        if action == "drag":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "drag 操作需要有效的 x, y 坐标"}
            pag.dragTo(coords[0], coords[1], duration=duration, button=button)
            return {"status": "ok", "message": f"已拖拽到 ({coords[0]}, {coords[1]})"}

        # ── position ─────────────────────────────────
        if action == "position":
            pos = pag.position()
            return {"status": "ok", "x": pos.x, "y": pos.y}

        # ── screen_size ──────────────────────────────
        if action == "screen_size":
            size = pag.size()
            return {"status": "ok", "width": size.width, "height": size.height}

        # ── locate（图像识别定位） ────────────────────
        if action == "locate":
            if not image_path:
                return {"error": "locate 操作需要提供 image_path 参数（参考图片路径）"}
            if not Path(image_path).is_file():
                return {"error": f"参考图片不存在: {image_path}"}
            try:
                location = pag.locateOnScreen(image_path, confidence=confidence)
            except TypeError:
                return {"error": "图像定位需要安装 opencv：pip install opencv-python"}
            if location is None:
                return {"status": "not_found", "message": "未在屏幕上找到匹配的图片"}
            center = pag.center(location)
            return {
                "status": "ok",
                "x": center.x,
                "y": center.y,
                "width": location.width,
                "height": location.height,
                "message": f"已定位到 ({center.x}, {center.y})",
            }

        return {"error": f"未知操作: {action}，可选: screenshot/click/double_click/right_click/type/hotkey/scroll/move/drag/position/screen_size/locate"}

    except Exception as e:
        return {"error": f"桌面操作失败 ({action}): {e}"}
