"""工具：网络搜索与网页抓取（DuckDuckGo，免 API Key），让模型获取实时数据。

mode:
- search：关键词搜索，返回标题/链接/摘要
- fetch ：抓取 query 指定的 URL 正文（纯文本，截断至 8000 字符）

实现：优先使用 ddgs 库；未安装时降级为 httpx 直连 DuckDuckGo HTML 端点解析。
"""

from __future__ import annotations

import html as html_mod
import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx

DEFAULT_RESULTS = 5
MAX_RESULTS = 10
FETCH_MAX_CHARS = 8000
TIMEOUT = 15.0
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def execute(query: str = "", mode: str = "search", max_results: int = DEFAULT_RESULTS, **_: Any) -> dict[str, Any]:
    """执行网络搜索或网页抓取。"""
    query = (query or "").strip()
    if not query:
        return {"error": "query 不能为空"}

    if mode == "fetch":
        return _fetch(query)

    try:
        limit = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
    except (TypeError, ValueError):
        limit = DEFAULT_RESULTS
    return _search(query, limit)


# ── 搜索 ──────────────────────────────────────


def _search(query: str, limit: int) -> dict[str, Any]:
    results = _search_via_ddgs(query, limit)
    engine = "ddgs"
    if not results:
        results = _search_via_http(query, limit)
        engine = "http-fallback"
    if not results:
        return {"error": "未获得搜索结果（网络异常或请求被限流），请稍后重试"}
    return {"query": query, "engine": engine, "count": len(results), "results": results}


def _search_via_ddgs(query: str, limit: int) -> list[dict[str, str]]:
    """优先用 ddgs 库（兼容旧包名 duckduckgo_search）。"""
    ddgs_cls = None
    try:
        from ddgs import DDGS as ddgs_cls  # type: ignore
    except ImportError:
        try:
            from duckduckgo_search import DDGS as ddgs_cls  # type: ignore
        except ImportError:
            return []
    try:
        with ddgs_cls(headers=HEADERS) as ddgs:
            raw = list(ddgs.text(query, max_results=limit))
    except Exception:
        return []
    results = []
    for item in raw:
        url = item.get("href") or item.get("url") or ""
        if not url:
            continue
        results.append({
            "title": _clean_text(item.get("title", "")),
            "url": url,
            "snippet": _clean_text(item.get("body") or item.get("snippet", "")),
        })
    return results


def _search_via_http(query: str, limit: int) -> list[dict[str, str]]:
    """降级方案：直连 DuckDuckGo HTML 端点解析结果。"""
    try:
        resp = httpx.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers=HEADERS,
            timeout=TIMEOUT,
            follow_redirects=True,
        )
        resp.raise_for_status()
    except Exception:
        return []

    results = []
    # 标题链接与摘要分开提取，再按出现顺序配对（两者之间隔着多层 div）
    anchors = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        resp.text,
        re.S,
    )
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', resp.text, re.S)
    for i, (href, title) in enumerate(anchors):
        url = _normalize_ddg_url(href)
        if not url:
            continue
        results.append({
            "title": _clean_text(title),
            "url": url,
            "snippet": _clean_text(snippets[i]) if i < len(snippets) else "",
        })
        if len(results) >= limit:
            break
    return results


def _normalize_ddg_url(href: str) -> str:
    """DDG 结果链接多为跳转形式，解出真实 URL。"""
    href = html_mod.unescape(href).strip()
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        uddg = parse_qs(parsed.query).get("uddg", [""])[0]
        if uddg:
            return unquote(uddg)
    return href


# ── 网页抓取 ──────────────────────────────────


def _fetch(url: str) -> dict[str, Any]:
    if not re.match(r"^https?://", url, re.I):
        return {"error": "fetch 模式需要完整的 http(s) URL"}
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"抓取失败: {e}"}

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type and "text" not in content_type:
        return {"error": f"不支持的内容类型: {content_type or '未知'}"}

    text = _html_to_text(resp.text)
    truncated = len(text) > FETCH_MAX_CHARS
    return {
        "url": str(resp.url),
        "truncated": truncated,
        "content": text[:FETCH_MAX_CHARS],
    }


def _html_to_text(html: str) -> str:
    """HTML → 纯文本：移除脚本样式与标签，压缩空白。"""
    html = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = html_mod.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _clean_text(raw: str) -> str:
    return html_mod.unescape(re.sub(r"(?s)<[^>]+>", "", raw or "")).strip()
