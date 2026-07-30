"""文件路由：多模态文件上传与解析。"""

from __future__ import annotations

import base64
import csv
import io
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, UploadFile

router = APIRouter(prefix="/files", tags=["files"])

# 支持的文本文件扩展名
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".html", ".htm", ".css",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h",
    ".json", ".yaml", ".yml", ".toml", ".xml", ".sql",
    ".sh", ".bat", ".ps1", ".rb", ".go", ".rs", ".php",
    ".csv", ".tsv", ".log", ".ini", ".cfg", ".conf",
}

# 支持的图片扩展名
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}

# 最大文件大小 (10MB)
MAX_FILE_SIZE = 10 * 1024 * 1024


@router.post("/upload")
async def upload_file(file: UploadFile) -> dict[str, Any]:
    """
    上传并解析文件。
    文本文件：提取内容文本。
    CSV：解析为结构化数据。
    图片：转为 base64 供多模态模型使用。
    """
    if not file.filename:
        return {"code": -1, "data": None, "message": "未提供文件名"}

    filename = file.filename
    ext = Path(filename).suffix.lower()
    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        return {"code": -1, "data": None, "message": f"文件过大（最大 {MAX_FILE_SIZE // 1024 // 1024}MB）"}

    # 文本文件
    if ext in TEXT_EXTENSIONS:
        return _parse_text_file(filename, ext, content)

    # 图片文件
    if ext in IMAGE_EXTENSIONS:
        return _parse_image_file(filename, ext, content)

    # 其他文件：尝试作为文本读取
    try:
        text = content.decode("utf-8")
        return {
            "code": 0,
            "data": {
                "filename": filename,
                "type": "text",
                "content": text[:50000],
                "size": len(content),
                "truncated": len(content) > 50000,
            },
            "message": "ok",
        }
    except UnicodeDecodeError:
        return {"code": -1, "data": None, "message": f"不支持的文件类型: {ext}"}


def _parse_text_file(filename: str, ext: str, content: bytes) -> dict[str, Any]:
    """解析文本类文件。"""
    text = content.decode("utf-8", errors="replace")

    # CSV 特殊处理：解析为结构化数据
    if ext in (".csv", ".tsv"):
        return _parse_csv(filename, text, ext)

    return {
        "code": 0,
        "data": {
            "filename": filename,
            "type": "text",
            "content": text[:50000],
            "size": len(content),
            "line_count": text.count("\n") + 1,
            "truncated": len(text) > 50000,
        },
        "message": "ok",
    }


def _parse_csv(filename: str, text: str, ext: str) -> dict[str, Any]:
    """解析 CSV/TSV 文件。"""
    delimiter = "\t" if ext == ".tsv" else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)

    if not rows:
        return {
            "code": 0,
            "data": {"filename": filename, "type": "csv", "headers": [], "rows": [], "row_count": 0},
            "message": "ok",
        }

    headers = rows[0]
    data_rows = rows[1:101]  # 最多返回 100 行数据

    return {
        "code": 0,
        "data": {
            "filename": filename,
            "type": "csv",
            "headers": headers,
            "rows": data_rows,
            "row_count": len(rows) - 1,
            "truncated": len(rows) > 101,
        },
        "message": "ok",
    }


def _parse_image_file(filename: str, ext: str, content: bytes) -> dict[str, Any]:
    """解析图片文件，转为 base64。"""
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp", ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    }
    mime_type = mime_map.get(ext, "image/png")
    b64 = base64.b64encode(content).decode("ascii")

    return {
        "code": 0,
        "data": {
            "filename": filename,
            "type": "image",
            "mime_type": mime_type,
            "base64": b64,
            "size": len(content),
        },
        "message": "ok",
    }
