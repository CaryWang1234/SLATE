"""聊天路由：对话历史管理，上下文压缩。"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/chat", tags=["chat"])

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "chat_history.db"


def _get_db() -> sqlite3.Connection:
    """获取 SQLite 连接，自动建表。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            created_at REAL,
            updated_at REAL,
            total_tokens INTEGER DEFAULT 0,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            context_tokens INTEGER DEFAULT 0
        )
    """)
    # 迁移：为已有表添加用量字段
    cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
    for col in ("total_tokens", "prompt_tokens", "completion_tokens", "message_count", "context_tokens"):
        if col not in cols:
            conn.execute(f"ALTER TABLE conversations ADD COLUMN {col} INTEGER DEFAULT 0")
    conn.commit()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            role TEXT,
            content TEXT,
            model TEXT DEFAULT '',
            created_at REAL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    """)
    conn.commit()
    return conn


@router.get("/conversations")
async def list_conversations() -> dict[str, Any]:
    """列出所有对话。"""
    conn = _get_db()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at, total_tokens, prompt_tokens, "
        "completion_tokens, message_count, context_tokens "
        "FROM conversations ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    conversations = [dict(r) for r in rows]
    return {"code": 0, "data": conversations, "message": "ok"}


@router.post("/conversations")
async def create_conversation(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """创建新对话。"""
    conv_id = str(uuid.uuid4())[:8]
    title = ""
    if body:
        title = body.get("title", "")
    now = time.time()
    conn = _get_db()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (conv_id, title, now, now),
    )
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"id": conv_id, "title": title}, "message": "ok"}


@router.get("/conversations/{conv_id}/messages")
async def get_messages(conv_id: str) -> dict[str, Any]:
    """获取对话的所有消息。"""
    conn = _get_db()
    rows = conn.execute(
        "SELECT id, role, content, model, created_at FROM messages "
        "WHERE conversation_id = ? ORDER BY created_at ASC",
        (conv_id,),
    ).fetchall()
    conn.close()
    messages = [dict(r) for r in rows]
    return {"code": 0, "data": messages, "message": "ok"}


@router.post("/conversations/{conv_id}/messages")
async def add_message(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """添加消息到对话。"""
    msg_id = str(uuid.uuid4())[:12]
    role = body.get("role", "user")
    content = body.get("content", "")
    model = body.get("model", "")
    now = time.time()

    conn = _get_db()
    # 插入消息
    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, model, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (msg_id, conv_id, role, content, model, now),
    )
    # 更新对话时间戳
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (now, conv_id),
    )
    # 如果是第一条用户消息，自动设为标题
    count = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role = 'user'",
        (conv_id,),
    ).fetchone()[0]
    if count == 1 and role == "user":
        title = content[:30] + ("..." if len(content) > 30 else "")
        conn.execute(
            "UPDATE conversations SET title = ? WHERE id = ?",
            (title, conv_id),
        )
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"id": msg_id}, "message": "ok"}


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str) -> dict[str, Any]:
    """删除对话及其消息。"""
    conn = _get_db()
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
    conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    conn.commit()
    conn.close()
    return {"code": 0, "data": None, "message": "ok"}


@router.patch("/conversations/{conv_id}/usage")
async def update_usage(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """更新对话的用量统计。"""
    total = body.get("total_tokens", 0)
    prompt = body.get("prompt_tokens", 0)
    completion = body.get("completion_tokens", 0)
    msg_count = body.get("message_count", 0)
    ctx = body.get("context_tokens", 0)

    conn = _get_db()
    conn.execute(
        "UPDATE conversations SET total_tokens=?, prompt_tokens=?, completion_tokens=?, "
        "message_count=?, context_tokens=? WHERE id=?",
        (total, prompt, completion, msg_count, ctx, conv_id),
    )
    conn.commit()
    conn.close()
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/compress")
async def compress_context(body: dict[str, Any]) -> dict[str, Any]:
    """
    上下文压缩：保留最新 N 轮完整对话，历史部分生成摘要。
    实际压缩由前端调用 LLM 完成，此端点仅提供压缩建议。
    """
    messages = body.get("messages", [])
    keep_rounds = body.get("keep_recent_rounds", 2)
    max_tokens = body.get("max_tokens", 64000)

    # 粗略估算 token 数（中文约 1.5 字符/token，英文约 4 字符/token）
    total_chars = sum(len(m.get("content", "")) for m in messages)
    estimated_tokens = int(total_chars / 2.5)

    if estimated_tokens <= max_tokens * 0.85:
        return {
            "code": 0,
            "data": {"need_compress": False, "estimated_tokens": estimated_tokens},
            "message": "ok",
        }

    # 分离保留消息和待压缩消息
    user_msg_indices = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if len(user_msg_indices) <= keep_rounds:
        return {
            "code": 0,
            "data": {"need_compress": False, "estimated_tokens": estimated_tokens},
            "message": "ok",
        }

    split_point = user_msg_indices[-keep_rounds]
    to_compress = messages[:split_point]
    to_keep = messages[split_point:]

    # 构建待压缩文本供前端发送给 LLM
    compress_prompt = (
        "请将以下对话历史压缩为简洁摘要，保留关键决策、重要结论和核心上下文，"
        "去除冗余细节。输出纯文本摘要，不超过 500 字。\n\n"
    )
    for m in to_compress:
        role_label = "用户" if m["role"] == "user" else "助手"
        compress_prompt += f"[{role_label}]: {m['content']}\n"

    return {
        "code": 0,
        "data": {
            "need_compress": True,
            "estimated_tokens": estimated_tokens,
            "compress_prompt": compress_prompt,
            "keep_messages": to_keep,
            "compress_count": len(to_compress),
        },
        "message": "ok",
    }
