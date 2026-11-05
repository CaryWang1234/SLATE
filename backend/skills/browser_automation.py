"""技能：浏览器自动化（基于 Playwright）。

支持动作：
- launch: 启动浏览器（headless=True/False）
- navigate: 导航到指定 URL
- screenshot: 截取当前页面或指定元素截图
- click: 点击页面元素（CSS 选择器）
- type: 在输入框中输入文字
- get_text: 获取页面/元素的文本内容
- get_html: 获取页面 HTML
- evaluate: 执行 JavaScript 表达式
- scroll: 滚动页面
- wait: 等待元素出现
- close: 关闭浏览器

浏览器实例在多次调用间保持活跃，便于连续操作。

关于「被站点拦下」：过去 navigate 不看 HTTP 状态，403 与 Cloudflare 挑战页也照样回
`status:"ok"`，模型于是拿着一张「Just a moment...」继续 click，表现就是"有时候站点阻止操作"。
现在 navigate 读状态码与页面文本，挑战页先给它几秒自行放行，仍过不去就如实回 blocked
并带上证据；同时启动参数改三处——持久 profile（登录态与 Cookie 留在本机，二次访问不再像新访客）、
UA 用内核真实主版本（原来手写 Chrome/120 而实装 Chrome/151，Sec-CH-UA 与 UA 自相矛盾）、
关掉 AutomationControlled（navigator.webdriver 不再报 true）。
过不去的站要么由用户允许可见窗口重试，要么如实告诉用户需要人工过一次验证——不解验证码，也不做指纹伪装。
"""

from __future__ import annotations

import concurrent.futures
import os
import tempfile
import time
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
# 登录态与 Cookie 落在这里：与 data/ 同源，卸载即随数据目录一起清，不碰系统浏览器 profile
PROFILE_DIR = DATA_DIR / "browser_profile"

# 挑战页给自己几秒自行放行：浏览器脚本跑完常常就跳过去，早一步报 blocked 会把正常页判死
_CHALLENGE_WAIT_MS = 4000
_CHALLENGE_STEP_MS = 500
# 这些状态码不是"页面没找到"，是站点按了门铃不放行
_BLOCK_STATUS = {403, 405, 425, 429, 503}
# (命中的小写串, 给模型看的原因)——标题与正文前段一起查，命中即视为被拦
_BLOCK_MARKS: tuple[tuple[str, str], ...] = (
    ("just a moment", "站点在做浏览器校验"),
    ("checking your browser", "站点在做浏览器校验"),
    ("verify you are human", "站点要求人机验证"),
    ("verifying you are human", "站点要求人机验证"),
    ("unusual traffic", "站点把这次访问判为异常流量"),
    ("access denied", "站点拒绝这次访问"),
    ("enable javascript and cookies", "站点要求浏览器通过它的脚本检查"),
    ("captcha", "站点要求验证码"),
    ("人机验证", "站点要求人机验证"),
    ("安全验证", "站点要求人机验证"),
    ("访问受限", "站点拒绝这次访问"),
)

# ── 模块级浏览器状态（跨调用保持活跃） ──────────────

_context = None       # BrowserContext（持久 profile，句柄就是它，没有独立 Browser）
_page = None          # 当前 Page
_playwright = None    # Playwright 实例
_headless = True

# Playwright 同步 API 禁止在运行中的 asyncio 事件循环线程内调用（MCP/技能主路径都在循环内），
# 所有浏览器操作统一提交到该独立工作线程执行，跨调用状态由该线程保持
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="slate-browser")


def _teardown() -> None:
    """关掉当前实例（含 driver）；profile 里的登录态留在磁盘上，不在这里清。"""
    global _context, _page, _playwright
    for closer in (
        (lambda: _context.close()) if _context is not None else None,
        (lambda: _playwright.stop()) if _playwright is not None else None,
    ):
        if closer is None:
            continue
        try:
            closer()
        except Exception:
            pass
    _context = _page = _playwright = None


def _launch_context(headless: bool, user_agent: str = "") -> Any:
    """起一个带持久 profile 的 context；user_agent 留空则用内核默认。"""
    return _playwright.chromium.launch_persistent_context(
        str(PROFILE_DIR),
        headless=headless,
        viewport={"width": 1280, "height": 800},
        user_agent=user_agent or None,
        args=["--disable-blink-features=AutomationControlled"],
    )


def _ensure_browser(headless: bool | None = None) -> Any:
    """确保浏览器已启动，返回当前 page。"""
    global _context, _page, _playwright, _headless
    if _page is not None:
        return _page
    if headless is None:
        headless = _headless
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError(
            "playwright 未安装，浏览器自动化这项能力当前不可用"
            "（缺的是 SLATE 运行环境的依赖，需要用户在终端里装 playwright 与 chromium）。"
            "请把缺依赖的情况告诉用户，不要自行执行安装命令。"
        )
    _playwright = sync_playwright().start()
    _headless = headless
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    _context = _launch_context(headless)
    # 版本号只有起来之后才拿得到，而它必须与 UA 一致：原来手写 Chrome/120 而实装 Chrome/151，
    # UA 与 Sec-CH-UA 自相矛盾，反倒比不伪装更像自动化。这里用真实主版本重建一次 context。
    try:
        major = ((_context.browser.version if _context.browser else "") or "").split(".")[0]
    except Exception:
        major = ""
    if major:
        ua = (f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              f"(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")
        try:
            rebuilt = _launch_context(headless, ua)
        except Exception:
            rebuilt = None
        if rebuilt is not None:
            # 先起新的再关旧的：反过来一旦第二发炸了，手里就只剩一个已关闭的 context
            try:
                _context.close()
            except Exception:
                pass
            _context = rebuilt
    _page = _context.pages[0] if _context.pages else _context.new_page()
    return _page


def _page_state(page: Any) -> tuple[int | None, str, str]:
    """取「最后一次导航的状态码 + 标题 + 正文前段」，任何一项拿不到都不该让操作整体炸掉。"""
    status = getattr(page, "_slate_last_status", None)
    try:
        title = page.title() or ""
    except Exception:
        title = ""
    try:
        probe = page.evaluate(
            "() => ((document.body && document.body.innerText) || '').slice(0, 2000)") or ""
    except Exception:
        probe = ""
    return status, title, probe


def _blocked_reason(status: int | None, title: str, probe: str) -> str:
    """被拦的证据：状态码先看，标题与正文前段再按特征串对。"""
    if status in _BLOCK_STATUS:
        return f"站点返回 HTTP {status}"
    hay = f"{title}\n{probe}".lower()
    for mark, why in _BLOCK_MARKS:
        if mark in hay:
            return f"{why}（页面出现「{mark}」）"
    return ""


def _screenshot_path(name: str = "") -> str:
    """生成截图保存路径。"""
    tmp = Path(tempfile.gettempdir()) / "slate_browser"
    tmp.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    fname = f"{name or 'screenshot'}_{ts}.png"
    return str(tmp / fname)


def _goto(page: Any, url: str, timeout: int) -> dict[str, Any]:
    """导航 + 等挑战页自行放行，返回 {status,title,probe,reason,waited_ms}。

    状态码记在 page 上：后续 click/get_text 报的是"等不到元素"，模型据此能分清
    到底是选择器不存在，还是这张页面本来就没放行。
    """
    resp = page.goto(url, timeout=timeout, wait_until="domcontentloaded")
    status = resp.status if resp is not None else None
    try:
        page._slate_last_status = status
    except Exception:
        pass
    status_, title, probe = _page_state(page)
    status = status if status is not None else status_
    reason = _blocked_reason(status, title, probe)
    waited = 0
    while reason and waited < _CHALLENGE_WAIT_MS:
        page.wait_for_timeout(_CHALLENGE_STEP_MS)
        waited += _CHALLENGE_STEP_MS
        _, title, probe = _page_state(page)
        reason = _blocked_reason(status, title, probe)
    return {"status": status, "title": title, "probe": probe, "reason": reason, "waited_ms": waited}


def _blocked_message(got: dict[str, Any], retried: str) -> str:
    """被拦时给模型的一句话：说清是谁拦的、证据是什么、下一步该走哪条。

    retried 由调用方按"这一支到底有没有可见窗口可退"给出——三种情况说的话不一样，
    写成一句常量会把"已经是可见窗口"那一支骗成"设置里没允许"。
    """
    return (
        f"站点把这次访问拦下了：{got['reason']}；页面标题「{(got['title'] or '')[:60]}」。"
        f"这不是 SLATE 自己的审批拦截，也不是选择器写错了。{retried}"
        f"下一步二选一：改用 web_fetch 取正文，或把「该站点需要人工验证一次」如实告诉用户；"
        f"在同一张被拦的页面上反复 click/get_text 不会过去。"
    )


def _execute_sync(
    action: str = "",
    url: str = "",
    selector: str = "",
    text: str = "",
    expression: str = "",
    headless: bool = True,
    screenshot_name: str = "",
    full_page: bool = False,
    timeout: int = 30000,
    allow_headed: bool = False,
    **_kw: Any,
) -> dict[str, Any]:
    """浏览器自动化实际实现（在独立工作线程内执行，规避同步 Playwright 与 asyncio 冲突）。

    Args:
        action: 操作类型 - launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close
        url: 导航目标 URL（action=navigate 时必填）
        selector: CSS 选择器（click/type/get_text/wait 时使用）
        text: 输入文字（action=type 时必填）
        expression: JavaScript 表达式（action=evaluate 时必填）
        headless: 是否无头模式（action=launch 时生效，默认 True）
        screenshot_name: 截图文件名前缀（可选）
        full_page: 是否全页截图（默认 False，只截可视区域）
        timeout: 操作超时毫秒数（默认 30000）
        allow_headed: 被站点拦下时允许改开可见窗口重试一次（只由前端按用户设置注入，默认 False）

    Returns:
        dict: 操作结果。
    """
    global _headless

    if not action:
        return {"error": "action 不能为空，可选: launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close"}

    # ── launch: 启动/重启浏览器 ──────────────────────
    if action == "launch":
        _teardown()
        _headless = headless
        page = _ensure_browser()
        return {
            "status": "ok",
            "message": f"浏览器已启动（headless={headless}，profile={PROFILE_DIR.name}）",
            "url": page.url,
        }

    # ── close: 关闭浏览器 ──────────────────────────
    if action == "close":
        _teardown()
        return {"status": "ok", "message": "浏览器已关闭"}

    # ── 以下操作需要浏览器已启动 ──────────────────────
    try:
        page = _ensure_browser()
    except RuntimeError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"浏览器启动失败: {e}"}

    try:
        # ── navigate ─────────────────────────────────
        if action == "navigate":
            if not url:
                return {"error": "navigate 操作需要提供 url 参数"}
            got = _goto(page, url, timeout)
            if not got["reason"]:
                return {
                    "status": "ok",
                    "url": page.url,
                    "title": got["title"],
                    "http_status": got["status"],
                }
            if allow_headed and _headless:
                # 只有用户在本机设置里点过"允许可见窗口"才会走到这里：弹他的桌面不由模型决定
                _teardown()
                page = _ensure_browser(headless=False)
                got = _goto(page, url, timeout)
                if not got["reason"]:
                    return {
                        "status": "ok",
                        "url": page.url,
                        "title": got["title"],
                        "http_status": got["status"],
                        "headed_retry": True,
                    }
                return {
                    "error": _blocked_message(got, "已经换成可见窗口重试过一次，仍未放行。"),
                    "status": "blocked",
                    "url": page.url,
                    "http_status": got["status"],
                    "title": got["title"],
                    "page_text": got["probe"][:400],
                }
            retried = ("现在已经是可见窗口，没有更宽松的形态可退。" if allow_headed
                       else "浏览器被拦时打开可见窗口的重试是关闭的（用户可在设置里允许）。")
            return {
                "error": _blocked_message(got, retried),
                "status": "blocked",
                "url": page.url,
                "http_status": got["status"],
                "title": got["title"],
                "page_text": got["probe"][:400],
            }

        # ── screenshot ───────────────────────────────
        if action == "screenshot":
            path = _screenshot_path(screenshot_name)
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                el.screenshot(path=path)
            else:
                page.screenshot(path=path, full_page=full_page)
            # 生成合法的 file URL（Windows 路径需转换为正斜杠）
            preview_url = Path(path).as_uri()
            return {
                "status": "ok",
                "screenshot_path": path,
                "preview_url": preview_url,
            }

        # ── click ────────────────────────────────────
        if action == "click":
            if not selector:
                return {"error": "click 操作需要提供 selector 参数"}
            page.click(selector, timeout=timeout)
            return {"status": "ok", "message": f"已点击: {selector}"}

        # ── type ─────────────────────────────────────
        if action == "type":
            if not selector:
                return {"error": "type 操作需要提供 selector 参数"}
            if not text:
                return {"error": "type 操作需要提供 text 参数"}
            page.fill(selector, text, timeout=timeout)
            return {"status": "ok", "message": f"已输入文字到: {selector}"}

        # ── get_text ─────────────────────────────────
        if action == "get_text":
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                txt = el.inner_text()
            else:
                txt = page.inner_text("body")
            return {"status": "ok", "text": txt[:5000] if txt else ""}

        # ── get_html ─────────────────────────────────
        if action == "get_html":
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                html = el.inner_html()
            else:
                html = page.content()
            return {"status": "ok", "html": html[:20000] if html else ""}

        # ── evaluate ─────────────────────────────────
        if action == "evaluate":
            if not expression:
                return {"error": "evaluate 操作需要提供 expression 参数"}
            result = page.evaluate(expression)
            return {"status": "ok", "result": result}

        # ── scroll ───────────────────────────────────
        if action == "scroll":
            # 默认向下滚动 500px
            delta = int(text) if text else 500
            page.mouse.wheel(0, delta)
            return {"status": "ok", "message": f"已滚动 {delta}px"}

        # ── wait ─────────────────────────────────────
        if action == "wait":
            if not selector:
                return {"error": "wait 操作需要提供 selector 参数"}
            page.wait_for_selector(selector, timeout=timeout, state="visible")
            return {"status": "ok", "message": f"元素已出现: {selector}"}

        return {"error": f"未知操作: {action}，可选: launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close"}

    except Exception as e:
        return {"error": _explain(action, e)}


def _explain(action: str, e: Exception) -> str:
    """把 Playwright 的报错分成三类：被站点拦着、选择器没命中、真的超时了。

    模型的下一步完全依赖这句分辨：一句"浏览器操作失败"它只会原地重试同一笔调用。
    读的是模块级当前 page——被拦后开过可见窗口会换掉一个 page 对象，抓住旧的那个读不到状态码。
    """
    raw = str(e).strip()
    low = raw.lower()
    status = getattr(_page, "_slate_last_status", None)
    if "timeout" in low or "timed out" in low:
        if status in _BLOCK_STATUS:
            return (f"上一次导航被站点拦下了（HTTP {status}），所以等不到元素。"
                    f"先按 navigate 返回的 blocked 处理，不要改写选择器再试。原始报错：{raw[:200]}")
        return (f"{action} 等待超时：目标没有在该页出现，或页面还在加载。"
                f"先用 get_html 或 screenshot 看现状再决定选择器。原始报错：{raw[:200]}")
    if "no element found" in low or "waiting for selector" in low or "not found" in low:
        return (f"{action} 的选择器没有命中页面元素。先 get_html 看清结构，"
                f"或用 screenshot 取一张现状；同一张页面上换个写法再试一次比反复试同一条有效。"
                f"原始报错：{raw[:200]}")
    return f"浏览器操作失败 ({action}): {raw[:300]}"


def execute(
    action: str = "",
    url: str = "",
    selector: str = "",
    text: str = "",
    expression: str = "",
    headless: bool = True,
    screenshot_name: str = "",
    full_page: bool = False,
    timeout: int = 30000,
    allow_headed: bool = False,
    **_kw: Any,
) -> dict[str, Any]:
    """浏览器自动化工具（入口）。通过 Playwright 控制 Chromium 浏览器。

    实际操作提交到独立工作线程执行：同步 Playwright 在运行中的 asyncio 事件循环
    线程内直接调用会抛异常，而 MCP/技能主调用路径均在循环内。

    Args:
        action: 操作类型 - launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close
        url: 导航目标 URL（action=navigate 时必填）
        selector: CSS 选择器（click/type/get_text/wait 时使用）
        text: 输入文字（action=type 时必填）
        expression: JavaScript 表达式（action=evaluate 时必填）
        headless: 是否无头模式（action=launch 时生效，默认 True）
        screenshot_name: 截图文件名前缀（可选）
        full_page: 是否全页截图（默认 False，只截可视区域）
        timeout: 操作超时毫秒数（默认 30000）
        allow_headed: 被拦时允许开可见窗口重试一次（由前端按用户设置注入）

    Returns:
        dict: 操作结果。
    """
    wait_s = max(90, timeout / 1000 + 60)
    try:
        return _executor.submit(
            _execute_sync, action=action, url=url, selector=selector, text=text,
            expression=expression, headless=headless, screenshot_name=screenshot_name,
            full_page=full_page, timeout=timeout, allow_headed=allow_headed, **_kw,
        ).result(timeout=wait_s)
    except concurrent.futures.TimeoutError:
        return {"error": "浏览器操作超时（执行线程仍在后台运行，稍后重试一次比连续重试有效）"}
    except Exception as e:
        return {"error": f"浏览器操作失败: {e}"}
