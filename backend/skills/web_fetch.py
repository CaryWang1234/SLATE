"""MCP 工具：获取网页内容。抓取 URL 并提取标题/描述/正文纯文本。

参数:
- url       : 完整的 http(s) URL
- mode      : text（默认，提取纯文本正文）/ html（返回原始 HTML）
- max_chars : 内容截断长度（默认 8000，上限 30000）

实现：httpx 直连抓取，零第三方解析依赖；HTML 通过正则去除脚本样式并压缩空白。
与 web_search 的 fetch 模式的区别：本工具额外提取页面标题与 meta 描述，
支持返回原始 HTML，且截断长度可调，适合精读指定网页。
"""

from __future__ import annotations

import html as html_mod
import re
from typing import Any

import httpx

DEFAULT_MAX_CHARS = 8000
MAX_CHARS_LIMIT = 30000
TIMEOUT = 20.0
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def execute(url: str = "", mode: str = "text", max_chars: int = DEFAULT_MAX_CHARS, **_: Any) -> dict[str, Any]:
    """抓取网页并返回标题/描述/正文。"""
    url = (url or "").strip()
    if not url:
        return {"error": "url 不能为空"}
    if not re.match(r"^https?://", url, re.I):
        return {"error": "需要完整的 http(s) URL"}

    try:
        limit = max(500, min(int(max_chars or DEFAULT_MAX_CHARS), MAX_CHARS_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_MAX_CHARS

    try:
        resp = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"抓取失败: {e}"}

    content_type = resp.headers.get("content-type", "")
    is_html = "html" in content_type or "xml" in content_type or resp.text.lstrip().lower().startswith("<!doctype html")

    if not is_html:
        # 纯文本 / JSON 等非 HTML 内容直接返回
        truncated = len(resp.text) > limit
        return {
            "url": str(resp.url),
            "title": "",
            "truncated": truncated,
            "content": resp.text[:limit],
        }

    title = _extract_title(resp.text)
    description = _extract_meta_description(resp.text)

    if mode == "html":
        body = resp.text
    else:
        body = _html_to_text(resp.text)

    truncated = len(body) > limit
    return {
        "url": str(resp.url),
        "title": title,
        "description": description,
        "truncated": truncated,
        "content": body[:limit],
    }


# ── 提取 ──────────────────────────────────────


def _extract_title(html: str) -> str:
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    return _clean_text(m.group(1)) if m else ""


def _extract_meta_description(html: str) -> str:
    m = re.search(
        r'(?is)<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']',
        html,
    ) or re.search(
        r'(?is)<meta[^>]*content=["\'](.*?)["\'][^>]*name=["\']description["\']',
        html,
    ) or re.search(
        r'(?is)<meta[^>]*property=["\']og:description["\'][^>]*content=["\'](.*?)["\']',
        html,
    )
    return _clean_text(m.group(1)) if m else ""


def _html_to_text(html: str) -> str:
    """HTML → 纯文本：移除脚本样式与标签，保留段落结构，压缩空白。"""
    html = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>|</section>|</article>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = html_mod.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _clean_text(raw: str) -> str:
    return html_mod.unescape(re.sub(r"(?s)<[^>]+>", "", raw or "")).strip()
