"""聊天路由：对话历史管理，上下文压缩，记忆/画像/素材。"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend.routers.knowledge import delete_document, upsert_document

router = APIRouter(prefix="/chat", tags=["chat"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
DB_PATH = DATA_DIR / "chat_history.db"


def _get_db() -> sqlite3.Connection:
    """获取 SQLite 连接，自动建表。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
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
            context_tokens INTEGER DEFAULT 0,
            project TEXT DEFAULT ''
        )
    """)
    # 迁移：为已有表添加用量字段
    cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
    for col in ("total_tokens", "prompt_tokens", "completion_tokens", "message_count", "context_tokens"):
        if col not in cols:
            conn.execute(f"ALTER TABLE conversations ADD COLUMN {col} INTEGER DEFAULT 0")
    if "project" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN project TEXT DEFAULT ''")
    conn.commit()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            role TEXT,
            content TEXT,
            model TEXT DEFAULT '',
            metadata TEXT DEFAULT '',
            created_at REAL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    """)
    msg_cols = [r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()]
    if "metadata" not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT ''")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            category TEXT DEFAULT 'general',
            content TEXT DEFAULT '',
            created_at REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prompt_snippets (
            id TEXT PRIMARY KEY,
            text TEXT DEFAULT '',
            source TEXT DEFAULT '',
            created_at REAL
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
        "completion_tokens, message_count, context_tokens, project "
        "FROM conversations ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    conversations = [dict(r) for r in rows]
    return {"code": 0, "data": conversations, "message": "ok"}


@router.get("/usage/summary")
async def usage_summary() -> dict[str, Any]:
    """全部对话的累计用量汇总（设置页统计用）。"""
    conn = _get_db()
    row = conn.execute(
        "SELECT COUNT(*) AS conversation_count, "
        "COALESCE(SUM(total_tokens), 0) AS total_tokens, "
        "COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, "
        "COALESCE(SUM(completion_tokens), 0) AS completion_tokens, "
        "COALESCE(SUM(message_count), 0) AS message_count "
        "FROM conversations"
    ).fetchone()
    top_rows = conn.execute(
        "SELECT id, title, total_tokens, message_count FROM conversations "
        "WHERE total_tokens > 0 ORDER BY total_tokens DESC LIMIT 5"
    ).fetchall()
    conn.close()
    return {
        "code": 0,
        "data": {
            "conversation_count": row["conversation_count"],
            "total_tokens": row["total_tokens"],
            "prompt_tokens": row["prompt_tokens"],
            "completion_tokens": row["completion_tokens"],
            "message_count": row["message_count"],
            "top": [dict(r) for r in top_rows],
        },
        "message": "ok",
    }


@router.post("/conversations")
async def create_conversation(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """创建新对话。"""
    conv_id = str(uuid.uuid4())[:8]
    title = ""
    project = ""
    if body:
        title = body.get("title", "")
        project = body.get("project", "") or ""
    now = time.time()
    conn = _get_db()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, project) VALUES (?, ?, ?, ?, ?)",
        (conv_id, title, now, now, project),
    )
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"id": conv_id, "title": title, "project": project}, "message": "ok"}


@router.get("/conversations/{conv_id}/messages")
async def get_messages(conv_id: str) -> dict[str, Any]:
    """获取对话的所有消息。"""
    conn = _get_db()
    rows = conn.execute(
        "SELECT id, role, content, model, metadata, created_at FROM messages "
        "WHERE conversation_id = ? ORDER BY created_at ASC",
        (conv_id,),
    ).fetchall()
    conn.close()
    messages = []
    for row in rows:
        msg = dict(row)
        raw_metadata = msg.pop("metadata", "") or ""
        if raw_metadata:
            try:
                metadata = json.loads(raw_metadata)
                if isinstance(metadata, dict):
                    msg.update(metadata)
            except json.JSONDecodeError:
                pass
        messages.append(msg)
    return {"code": 0, "data": messages, "message": "ok"}


@router.post("/conversations/{conv_id}/messages")
async def add_message(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """添加消息到对话。"""
    msg_id = str(uuid.uuid4())[:12]
    role = body.get("role", "user")
    content = body.get("content", "")
    model = body.get("model", "")
    metadata = body.get("metadata", {})
    metadata_text = json.dumps(metadata, ensure_ascii=False) if isinstance(metadata, dict) and metadata else ""
    now = time.time()

    conn = _get_db()
    # 插入消息
    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, model, metadata, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (msg_id, conv_id, role, content, model, metadata_text, now),
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


@router.patch("/messages/{msg_id}")
async def update_message(msg_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """更新单条消息内容或渲染元数据。"""
    fields: list[str] = []
    values: list[Any] = []

    if "content" in body:
        fields.append("content = ?")
        values.append(body.get("content", ""))
    if "metadata" in body:
        metadata = body.get("metadata", {})
        metadata_text = json.dumps(metadata, ensure_ascii=False) if isinstance(metadata, dict) and metadata else ""
        fields.append("metadata = ?")
        values.append(metadata_text)

    if not fields:
        return {"code": 0, "data": None, "message": "ok"}

    values.append(msg_id)
    conn = _get_db()
    conn.execute(f"UPDATE messages SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    conn.close()
    return {"code": 0, "data": None, "message": "ok"}


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


# ── 记忆 CRUD ─────────────────────────────────

@router.get("/memories")
async def list_memories() -> dict[str, Any]:
    conn = _get_db()
    rows = conn.execute("SELECT id, category, content, created_at FROM memories ORDER BY created_at DESC").fetchall()
    conn.close()
    return {"code": 0, "data": [dict(r) for r in rows], "message": "ok"}


@router.post("/memories")
async def create_memory(body: dict[str, Any]) -> dict[str, Any]:
    mem_id = body.get("id", str(uuid.uuid4())[:8])
    category = body.get("category", "general")
    content = body.get("content", "")
    now = time.time()
    conn = _get_db()
    conn.execute("INSERT INTO memories (id, category, content, created_at) VALUES (?, ?, ?, ?)",
                 (mem_id, category, content, now))
    conn.commit()
    conn.close()
    if content:
        upsert_document(
            doc_id=f"memory:{mem_id}",
            title=f"长期记忆 · {category}",
            source="long-term-memory",
            kind="memory",
            content=content,
            metadata={"memory_id": mem_id, "category": category},
        )
    return {"code": 0, "data": {"id": mem_id}, "message": "ok"}


@router.patch("/memories/{mem_id}")
async def update_memory(mem_id: str, body: dict[str, Any]) -> dict[str, Any]:
    category = body.get("category")
    content = body.get("content")
    conn = _get_db()
    if category is not None:
        conn.execute("UPDATE memories SET category=? WHERE id=?", (category, mem_id))
    if content is not None:
        conn.execute("UPDATE memories SET content=? WHERE id=?", (content, mem_id))
    conn.commit()
    row = conn.execute("SELECT id, category, content FROM memories WHERE id=?", (mem_id,)).fetchone()
    conn.close()
    if row and row["content"]:
        upsert_document(
            doc_id=f"memory:{mem_id}",
            title=f"长期记忆 · {row['category']}",
            source="long-term-memory",
            kind="memory",
            content=row["content"],
            metadata={"memory_id": mem_id, "category": row["category"]},
        )
    return {"code": 0, "data": None, "message": "ok"}


@router.delete("/memories/{mem_id}")
async def delete_memory(mem_id: str) -> dict[str, Any]:
    conn = _get_db()
    conn.execute("DELETE FROM memories WHERE id=?", (mem_id,))
    conn.commit()
    conn.close()
    delete_document(f"memory:{mem_id}")
    return {"code": 0, "data": None, "message": "ok"}


# ── 提示词素材 CRUD ───────────────────────────

@router.get("/snippets")
async def list_snippets() -> dict[str, Any]:
    conn = _get_db()
    rows = conn.execute("SELECT id, text, source, created_at FROM prompt_snippets ORDER BY created_at DESC").fetchall()
    conn.close()
    return {"code": 0, "data": [dict(r) for r in rows], "message": "ok"}


@router.post("/snippets")
async def create_snippet(body: dict[str, Any]) -> dict[str, Any]:
    snip_id = body.get("id", str(uuid.uuid4())[:8])
    text = body.get("text", "")
    source = body.get("source", "")
    now = time.time()
    conn = _get_db()
    conn.execute("INSERT INTO prompt_snippets (id, text, source, created_at) VALUES (?, ?, ?, ?)",
                 (snip_id, text, source, now))
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"id": snip_id}, "message": "ok"}


@router.delete("/snippets/{snip_id}")
async def delete_snippet(snip_id: str) -> dict[str, Any]:
    conn = _get_db()
    conn.execute("DELETE FROM prompt_snippets WHERE id=?", (snip_id,))
    conn.commit()
    conn.close()
    return {"code": 0, "data": None, "message": "ok"}


# ── 记忆提取（AI 自动识别） ───────────────

@router.post("/extract-memories")
async def extract_memories(body: dict[str, Any]) -> dict[str, Any]:
    """
    提供一段对话文本，返回建议提取的记忆条目。
    实际提取由前端调用 LLM 完成，此端点构建提示词。
    """
    text = body.get("text", "")
    existing = body.get("existing_memories", [])
    prompt = (
        "分析以下对话，提取值得长期记忆的关键信息（用户偏好、重要决策、项目背景、常用术语等）。\n"
        "以 JSON 数组格式输出，每项包含 category 和 content 字段。\n"
        "category 可选: preference, decision, project, term, fact, other。\n"
        "只输出 JSON，不要其他文字。如果没有值得记忆的内容，输出空数组 []。\n\n"
    )
    if existing:
        prompt += f"已有记忆（避免重复）:\n" + "\n".join(f"- [{m.get('category','')}] {m.get('content','')}" for m in existing[:20]) + "\n\n"
    prompt += f"对话内容:\n{text[:6000]}"
    return {"code": 0, "data": {"prompt": prompt}, "message": "ok"}


# ── 手动压缩（支持级别） ───────────────────

@router.post("/compress-manual")
async def compress_manual(body: dict[str, Any]) -> dict[str, Any]:
    """
    手动上下文压缩，支持 level: light / heavy。
    light: 保留关键细节，约 50% 压缩。
    heavy: 仅保留摘要，约 80% 压缩。
    """
    messages = body.get("messages", [])
    level = body.get("level", "light")
    keep_rounds = body.get("keep_recent_rounds", 2)

    user_msg_indices = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if len(user_msg_indices) <= keep_rounds:
        return {"code": 0, "data": {"need_compress": False}, "message": "ok"}

    split_point = user_msg_indices[-keep_rounds]
    to_compress = messages[:split_point]
    to_keep = messages[split_point:]

    if level == "heavy":
        instruction = "将以下对话压缩为极简摘要，仅保留核心结论和关键决策，不超过 200 字。"
    else:
        instruction = "将以下对话压缩为摘要，保留关键细节、重要结论和核心上下文，不超过 500 字。"

    compress_prompt = instruction + "\n\n"
    for m in to_compress:
        role_label = "用户" if m["role"] == "user" else "助手"
        compress_prompt += f"[{role_label}]: {m['content']}\n"

    return {
        "code": 0,
        "data": {
            "need_compress": True,
            "compress_prompt": compress_prompt,
            "keep_messages": to_keep,
            "compress_count": len(to_compress),
            "level": level,
        },
        "message": "ok",
    }
