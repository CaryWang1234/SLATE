"""聊天路由：对话历史管理，上下文压缩，记忆/画像/素材。

优化要点（参考 Agent 工程四层理论）：
- Context Engineering: 高效查询，渐进式加载
- Harness Engineering: 数据库索引，连接池管理
- Loop Engineering: 异步后台任务，非阻塞操作
- Graph Engineering: 知识图谱关联，记忆分类
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend.routers.knowledge import delete_document, upsert_document

router = APIRouter(prefix="/chat", tags=["chat"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
DB_PATH = DATA_DIR / "chat_history.db"
BACKUP_DIR = DATA_DIR / "backups"

# 活跃度热力图回溯窗口：53 周 = 371 天。前端画布周日打头，实际显示 365~371 天，
# 所以窗口只能 ≥ 画布跨度，别为了「对齐」往小改——改小了最早那几天会静默消失。
ACTIVITY_WINDOW_DAYS = 371


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
            project TEXT DEFAULT '',
            project_id TEXT DEFAULT '',
            archived INTEGER DEFAULT 0
        )
    """)
    # 迁移：为已有表添加用量字段
    cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
    for col in ("total_tokens", "prompt_tokens", "completion_tokens", "message_count", "context_tokens"):
        if col not in cols:
            conn.execute(f"ALTER TABLE conversations ADD COLUMN {col} INTEGER DEFAULT 0")
    if "project" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN project TEXT DEFAULT ''")
    # 会话归属从"项目名"换成"项目 id"：改名/重名/目录搬家都不该把历史甩出去。
    # 刻意**不做**回填 UPDATE：67 条历史的名字大多还对得上，读时按名称回落即可
    # （见 list_conversations 的 or project = ?），错了也不会丢数据，
    # 而一次性改写全部历史一旦推错就没有回头路。新会话两个字段都写。
    if "project_id" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT DEFAULT ''")
    # 归档＝从任务栏里收起来，不是删除：会话与消息都还在库里，设置里能恢复也能真删。
    # 默认值 0 让老数据一律按"没归档"处理，升级不会把谁的历史藏起来。
    if "archived" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0")
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
    
    # 性能优化：为高频查询字段创建索引（Harness Engineering: 减少查询延迟）
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC)")
    # 侧栏按项目分组/筛选是每次切项目都要跑的查询，没索引就是全表扫
    conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id)")

    # 按天 token 记账（0.4.2 起）：conversations 只存累计值，热力图要按天看 token
    # 就必须另记一份。每次同步用量时把「相对上次的增量」写到本地当天——
    # 增量口径天然对上「这一轮花了多少」，也不用给 messages 加列。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_usage (
            day TEXT PRIMARY KEY,
            tokens INTEGER DEFAULT 0
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            category TEXT DEFAULT 'general',
            content TEXT DEFAULT '',
            created_at REAL
        )
    """)
    # 记忆查询索引（Context Engineering: 快速检索长期记忆）
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)")
    
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prompt_snippets (
            id TEXT PRIMARY KEY,
            text TEXT DEFAULT '',
            source TEXT DEFAULT '',
            created_at REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snippets_created_at ON prompt_snippets(created_at DESC)")
    
    conn.commit()
    return conn


def _name_fallbacks(project_id: str) -> list[str]:
    """按 id 取该项目可用于"读时回落"的名字串：名称 + 手工归位过的别名。

    为什么需要：老会话只有 project（目录名）这一列，没有 project_id。
    既然刻意没做回填 UPDATE，分组/筛选就得在读的时候把名字对回 id，
    否则一上注册表，全部历史就集体变成"未归类"。
    目录已不在册（被删了/搬家了）也照样返回它的登记名，历史不会因此消失。
    """
    if not project_id:
        return []
    try:
        from backend import project_registry as registry
        entry = registry.entry_of(registry.load_registry(), project_id)
    except Exception:
        return []
    if not entry:
        return []
    names = [str(entry.get("name") or "")]
    names += [str(a) for a in (entry.get("aliases") or [])]
    return [n for n in names if n]


def _usage_by_project(limit: int = 20) -> list[dict[str, Any]]:
    """按项目分摊的会话用量。

    分组口径与侧栏一致：有 project_id 按 id 归；没有的（没回填的老会话）只有当
    它记的名字在册上唯一时才归到那个项目，重名或不在册就归"未归类"——
    宁可少归一个，也不把两个同名项目的 token 加成一堆。
    """
    try:
        from backend import project_registry as registry
        doc = registry.load_registry()
        entries = {str(e.get("id") or ""): e for e in (doc.get("projects") or [])}
    except Exception:
        entries, doc = {}, {"projects": []}
    by_name: dict[str, list[str]] = {}
    for e in (doc.get("projects") or []):
        for n in [str(e.get("name") or ""), *(str(a) for a in (e.get("aliases") or []))]:
            if n:
                by_name.setdefault(n, []).append(str(e.get("id") or ""))
    conn = _get_db()
    rows = conn.execute(
        "SELECT project_id, project, COUNT(*) AS conversations, "
        "COALESCE(SUM(total_tokens), 0) AS total_tokens, "
        "COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, "
        "COALESCE(SUM(completion_tokens), 0) AS completion_tokens "
        "FROM conversations GROUP BY project_id, project"
    ).fetchall()
    conn.close()
    buckets: dict[str, dict[str, Any]] = {}
    for r in rows:
        pid = str(r["project_id"] or "")
        if not pid:
            owners = [x for x in by_name.get(str(r["project"] or ""), []) if x]
            pid = owners[0] if len(set(owners)) == 1 else ""
        name = str((entries.get(pid) or {}).get("name") or "") or str(r["project"] or "") or "未分类"
        b = buckets.setdefault(pid, {
            "project_id": pid, "project": name, "conversations": 0,
            "total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0,
        })
        b["conversations"] += int(r["conversations"] or 0)
        for k in ("total_tokens", "prompt_tokens", "completion_tokens"):
            b[k] += int(r[k] or 0)
    return sorted(buckets.values(), key=lambda b: (-b["total_tokens"], b["project"]))[:limit]


@router.get("/conversations")
async def list_conversations(project_id: str = "", include_unassigned: bool = False,
                             archived: bool = False) -> dict[str, Any]:
    """列出对话。给了 project_id 就只列这个项目的（含按名称回落命中的历史会话）。

    archived 决定这一页看的是哪一批：默认只看没归档的，归档的那批由设置页用
    ?archived=1 单独取。两边必须互斥——同一场同时出现在任务栏和归档列表里，
    "恢复/删除"就会打在用户以为的另一个对象上。
    """
    conn = _get_db()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at, total_tokens, prompt_tokens, "
        "completion_tokens, message_count, context_tokens, project, project_id, archived "
        "FROM conversations ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    conversations = [dict(r) for r in rows]
    conversations = [c for c in conversations if bool(c.get("archived")) is archived]
    if project_id:
        fallback = set(_name_fallbacks(project_id))
        conversations = [
            c for c in conversations
            if c.get("project_id") == project_id
            # 没记 id 的老会话才按名字认；已经归到别的项目的一律不认，
            # 否则"把 A 项目会话改名后再归位"会被名字重新拽回来。
            or ((not c.get("project_id")) and str(c.get("project") or "") in fallback)
        ]
    elif include_unassigned:
        conversations = [c for c in conversations if not c.get("project_id")]
    return {"code": 0, "data": conversations, "message": "ok"}


def estimate_daily_tokens(
    per_conv_days: dict[str, dict[str, int]],
    conv_tokens: dict[str, int],
    window_start: str,
    cutoff_day: str | None,
) -> dict[str, int]:
    """历史 token 估算：把每个对话的累计 token 按它自己在各天的发言条数比例摊到天。

    只输出「窗口内、且早于 cutoff_day」的天——cutoff 是第一条真实记账的日期，
    它之后一律走真实增量，两边不重叠，估算不会和记账互相污染。
    cutoff_day 为 None（一条记账都没有）表示整窗都按估算。
    这些数字只用来给历史填色，与真实日用量对不上，界面必须标注成估算。

    按「全部天」的比例摊、再只取历史段，而不是只在历史段内部分摊：
    后者会把该对话的全部 token 都堆进历史段，等于按段内占比放大一遍。
    """
    out: dict[str, int] = {}
    for conv_id, days in per_conv_days.items():
        total = int(conv_tokens.get(conv_id, 0) or 0)
        all_n = sum(days.values())
        if total <= 0 or all_n <= 0:
            continue
        for day, n in days.items():
            if day < window_start:
                continue
            if cutoff_day is not None and day >= cutoff_day:
                continue
            out[day] = out.get(day, 0) + int(round(total * n / all_n))
    return out


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
    # 活跃度热力图：按本地日聚合的用户发言条数与 token，回溯 53 周。
    # 起点必须是 epoch 数值——created_at 是 REAL，拿日期字符串比较会因
    # SQLite 的类型序（文本恒大于数值）而一行不剩。
    start_day = datetime.now().date() - timedelta(days=ACTIVITY_WINDOW_DAYS - 1)
    window_start = start_day.isoformat()
    start_ts = datetime(start_day.year, start_day.month, start_day.day).timestamp()
    daily_rows = conn.execute(
        "SELECT conversation_id, date(created_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS n "
        "FROM messages WHERE role = 'user' AND created_at >= ? "
        "GROUP BY conversation_id, day ORDER BY day",
        (start_ts,),
    ).fetchall()
    counts: dict[str, int] = {}
    per_conv_days: dict[str, dict[str, int]] = {}
    for r in daily_rows:
        if not r["day"]:
            continue
        day, n = r["day"], int(r["n"])
        counts[day] = counts.get(day, 0) + n
        per_conv_days.setdefault(r["conversation_id"], {})[day] = n
    recorded = {
        r["day"]: int(r["tokens"] or 0)
        for r in conn.execute(
            "SELECT day, tokens FROM daily_usage WHERE day >= ?", (window_start,)
        ).fetchall()
        if r["day"]
    }
    cutoff_row = conn.execute("SELECT MIN(day) AS d FROM daily_usage").fetchone()
    cutoff = cutoff_row["d"] if cutoff_row else None
    conv_tokens = {
        r["id"]: int(r["total_tokens"] or 0)
        for r in conn.execute(
            "SELECT id, total_tokens FROM conversations WHERE total_tokens > 0"
        ).fetchall()
    }
    estimated = estimate_daily_tokens(per_conv_days, conv_tokens, window_start, cutoff)
    conn.close()
    by_project = _usage_by_project()
    # 只回有活动的日子（消息、记账、估算三者的并集），空档交给前端补 0
    days = sorted(set(counts) | set(recorded) | set(estimated))
    return {
        "code": 0,
        "data": {
            "conversation_count": row["conversation_count"],
            "total_tokens": row["total_tokens"],
            "prompt_tokens": row["prompt_tokens"],
            "completion_tokens": row["completion_tokens"],
            "message_count": row["message_count"],
            "top": [dict(r) for r in top_rows],
            "daily": [
                {
                    "date": day,
                    "count": counts.get(day, 0),
                    "tokens": recorded[day] if day in recorded else estimated.get(day, 0),
                    "estimated": day not in recorded and day in estimated,
                }
                for day in days
            ],
            "daily_window": ACTIVITY_WINDOW_DAYS,
            # 第一条真实记账日期；它之前是估算。界面据此标注，null 表示全是估算
            "tokens_recorded_from": cutoff,
            # 按项目分摊的用量：多项目在册后"这个月花了多少"要能分到谁头上
            "by_project": by_project,
        },
        "message": "ok",
    }


@router.post("/conversations")
async def create_conversation(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """创建新对话。"""
    conv_id = str(uuid.uuid4())[:8]
    title = ""
    project = ""
    project_id = ""
    if body:
        title = body.get("title", "")
        project = body.get("project", "") or ""
        project_id = body.get("project_id", "") or ""
    now = time.time()
    conn = _get_db()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, project, project_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (conv_id, title, now, now, project, project_id),
    )
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"id": conv_id, "title": title, "project": project,
                                "project_id": project_id}, "message": "ok"}


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
    # 正文为空的首条消息（只发了文件）不许参与取名：前端建场时写的是文件名，
    # 这里照抄 content 会把它抹成空标题，列表里就多一行没有名字的会话。
    if count == 1 and role == "user" and isinstance(content, str) and content.strip():
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
    has_content = "content" in body
    has_metadata = "metadata" in body
    if not has_content and not has_metadata:
        return {"code": 0, "data": None, "message": "ok"}

    conn = _get_db()
    if has_content and has_metadata:
        metadata = body.get("metadata", {})
        metadata_text = json.dumps(metadata, ensure_ascii=False) if isinstance(metadata, dict) and metadata else ""
        conn.execute(
            "UPDATE messages SET content = ?, metadata = ? WHERE id = ?",
            (body.get("content", ""), metadata_text, msg_id),
        )
    elif has_content:
        conn.execute("UPDATE messages SET content = ? WHERE id = ?", (body.get("content", ""), msg_id))
    else:
        metadata = body.get("metadata", {})
        metadata_text = json.dumps(metadata, ensure_ascii=False) if isinstance(metadata, dict) and metadata else ""
        conn.execute("UPDATE messages SET metadata = ? WHERE id = ?", (metadata_text, msg_id))
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


@router.patch("/conversations/{conv_id}")
async def rename_conversation(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """改会话标题与归档标记（历史管理用）。两个字段各给各的，也允许一起给。"""
    has_title = "title" in body
    has_archived = "archived" in body
    title = str(body.get("title", "")).strip()
    if not has_title and not has_archived:
        return {"code": 1, "message": "没有要改的字段"}
    if has_title and not title:
        return {"code": 1, "message": "标题不能为空"}
    title = title[:60]
    # 归档只认布尔 True：给了 "false" 这种字符串不能被当成真值归档掉
    archived = 1 if body.get("archived") is True else 0
    conn = _get_db()
    if has_title and has_archived:
        conn.execute("UPDATE conversations SET title = ?, archived = ? WHERE id = ?",
                     (title, archived, conv_id))
    elif has_archived:
        conn.execute("UPDATE conversations SET archived = ? WHERE id = ?", (archived, conv_id))
    else:
        conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conv_id))
    conn.commit()
    conn.close()
    data: dict[str, Any] = {"id": conv_id}
    if has_title:
        data["title"] = title
    if has_archived:
        data["archived"] = bool(archived)
    return {"code": 0, "data": data, "message": "ok"}


@router.post("/conversations/batch-delete")
async def batch_delete_conversations(body: dict[str, Any]) -> dict[str, Any]:
    """批量删除会话及其消息；clear_all 为真时清空全部会话。"""
    conn = _get_db()
    if body.get("clear_all"):
        cur = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()
        deleted = cur[0]
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM conversations")
    else:
        ids = [i for i in (body.get("ids") or []) if isinstance(i, str) and i]
        if not ids:
            conn.close()
            return {"code": 0, "data": {"deleted": 0}, "message": "ok"}
        deleted = 0
        for conv_id in ids:
            conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
            cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
            deleted += max(cur.rowcount, 0)
    conn.commit()
    conn.close()
    return {"code": 0, "data": {"deleted": deleted}, "message": "ok"}


@router.delete("/messages/{msg_id}")
async def delete_message(msg_id: str) -> dict[str, Any]:
    """删除单条消息并同步会话消息计数。"""
    conn = _get_db()
    row = conn.execute("SELECT conversation_id FROM messages WHERE id = ?", (msg_id,)).fetchone()
    if row:
        conn.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
        conn.execute(
            "UPDATE conversations SET message_count = MAX(message_count - 1, 0) WHERE id = ?",
            (row["conversation_id"],),
        )
    conn.commit()
    conn.close()
    return {"code": 0, "data": None, "message": "ok"}


@router.get("/search")
async def search_messages(q: str = "", limit: int = 30) -> dict[str, Any]:
    """全文搜索消息内容，返回命中片段与所属会话（历史侧栏内容搜索用）。"""
    keyword = (q or "").strip()
    if not keyword:
        return {"code": 0, "data": [], "message": "ok"}
    limit = max(1, min(100, limit))
    conn = _get_db()
    rows = conn.execute(
        "SELECT m.id AS message_id, m.conversation_id, m.role, m.content, m.created_at, "
        "c.title AS conversation_title "
        "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
        "WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT ?",
        (f"%{keyword}%", limit),
    ).fetchall()
    conn.close()
    hits = []
    for r in rows:
        content = r["content"] or ""
        pos = content.lower().find(keyword.lower())
        start = max(0, pos - 30)
        snippet = content[start:start + 90].replace("\n", " ")
        if start > 0:
            snippet = "…" + snippet
        hits.append({
            "message_id": r["message_id"],
            "conversation_id": r["conversation_id"],
            "conversation_title": r["conversation_title"] or r["conversation_id"],
            "role": r["role"],
            "snippet": snippet,
            "created_at": r["created_at"],
        })
    return {"code": 0, "data": hits, "message": "ok"}


# ── 无限上下文：压掉的历史要还能查回来 ─────────────────────
# 上下文压缩只把旧消息折成一段摘要，库里的行一条没删（/compress 只算保留段，
# 不 DELETE）。缺的不是存储，是**通道**：模型手上没有查回旧原文的入口，摘要写漏的
# 那句「当时你定的第三版配色」就永久丢了。这两个端点就是那条通道：
# /history/search 按关键词找摘录，/history/window 拿摘录那一条前后的原文。
# 刻意不引 FTS5：中文没有内置成词分词，装上分词器要么失效要么多一个依赖，
# 而这里的检索是"几个词都在同一条消息里"，LIKE 就够。

_HISTORY_SCOPES = ("current", "project", "all")
_HISTORY_MAX_TERMS = 8
_HISTORY_MAX_SNIPPET = 320
_HISTORY_MAX_WINDOW = 20


def _like_terms(query: str) -> list[str]:
    """检索词切分：按空白拆开、去重、封顶，并把 LIKE 的通配符转义掉。

    不转义，搜「100%」等于搜任意含 100 的内容；多个词必须同条命中，
    拼成一条 LIKE 就退化成"只要沾上一个词就算"。
    """
    terms: list[str] = []
    for raw in (query or "").split():
        term = raw.strip()
        if not term:
            continue
        key = term.casefold()
        if key in (t.casefold() for t in terms):
            continue
        terms.append(term)
        if len(terms) >= _HISTORY_MAX_TERMS:
            break
    return terms


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _excerpt(content: str, terms: list[str], radius: int) -> tuple[str, bool]:
    """围绕最先命中的那个词取一段摘录；返回 (摘录, 是否截断)。"""
    if not content:
        return "", False
    positions = [content.lower().find(t.lower()) for t in terms]
    positions = [p for p in positions if p >= 0]
    pos = min(positions) if positions else 0
    half = max(40, min(_HISTORY_MAX_SNIPPET, radius)) // 2
    start = max(0, pos - half)
    end = min(len(content), start + half * 2)
    text = content[start:end].replace("\n", " ").strip()
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(content) else ""
    return prefix + text + suffix, bool(prefix or suffix)


def _when(ts: Any) -> str:
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError, OSError):
        return ""


def _int_arg(body: dict[str, Any], key: str, default: int) -> int:
    """取整型参数。写成 body.get(key) or default 会把显式传的 0 吃掉——
    "向前取 0 条"变成"默认取 4 条"，窗口就成了模型没要的东西。"""
    try:
        return int(body.get(key, default))
    except (TypeError, ValueError):
        return default


def _project_scope_ids(conv_id: str) -> tuple[str, list[str]] | None:
    """这一场所属项目 → (project_id, 可按名字回落命中的名称串)；这一场没项目就返回 None。

    与 list_conversations 的项目口径一致：老会话只记了目录名没记 id，
    所以还要拿那个项目的名称与别名去认一次。
    """
    conn = _get_db()
    row = conn.execute("SELECT project_id, project FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    pid = str(row["project_id"] or "")
    if not pid:
        return None
    return pid, _name_fallbacks(pid)


@router.post("/history/search")
async def search_history(body: dict[str, Any]) -> dict[str, Any]:
    """按关键词检索历史消息原文，返回带出处的摘录（模型侧 history_search 工具的后台）。

    scope：current＝只在这一场（默认，压缩压掉的那些就在这条会话的库行里）；
    project＝这一场所属项目的全部会话；all＝所有会话。默认收窄到本场，
    因为"另一场对话里说过什么"通常是用户没授权模型去翻的东西。
    """
    terms = _like_terms(str(body.get("query") or ""))
    if not terms:
        return {"code": -1, "data": None, "message": "query 不能为空（检索词至少一个）"}
    scope = str(body.get("scope") or "current")
    if scope not in _HISTORY_SCOPES:
        return {"code": -1, "data": None,
                "message": f"scope 只认 {'/'.join(_HISTORY_SCOPES)}，收到的是 {scope}"}
    conv_id = str(body.get("conversation_id") or "")
    if scope != "all" and not conv_id:
        return {"code": -1, "data": None, "message": f"scope={scope} 需要 conversation_id"}
    limit = max(1, min(30, _int_arg(body, "limit", 8)))
    radius = max(40, min(_HISTORY_MAX_SNIPPET, _int_arg(body, "snippet_chars", 160)))
    role = str(body.get("role") or "")

    where = " AND ".join("m.content LIKE ? ESCAPE '\\'" for _ in terms)
    args: list[Any] = [f"%{_escape_like(t)}%" for t in terms]
    if scope == "current":
        where += " AND m.conversation_id = ?"
        args.append(conv_id)
    elif scope == "project":
        names = _project_scope_ids(conv_id)
        if names is None:
            return {"code": -1, "data": None,
                    "message": f"这一场（{conv_id}）不在册或没归属项目，改用 scope=current 检索"}
        pid, fallbacks = names
        clause = "c.project_id = ?"
        if fallbacks:
            clause = "(" + " OR ".join([clause] + [f"(COALESCE(c.project_id,'')='' AND c.project = ?)"
                                                   for _ in fallbacks]) + ")"
        where += f" AND {clause}"
        args.append(pid)
        args.extend(fallbacks)
    if role in ("user", "assistant"):
        where += " AND m.role = ?"
        args.append(role)

    conn = _get_db()
    rows = conn.execute(
        f"SELECT m.id AS message_id, m.conversation_id, m.role, m.content, m.created_at, "
        f"c.title AS conversation_title, c.archived AS archived "
        f"FROM messages m JOIN conversations c ON c.id = m.conversation_id "
        f"WHERE {where} ORDER BY m.created_at DESC LIMIT ?",
        (*args, limit + 1),
    ).fetchall()
    conn.close()

    hits = []
    for r in rows[:limit]:
        snippet, cut = _excerpt(r["content"] or "", terms, radius)
        hits.append({
            "message_id": r["message_id"],
            "conversation_id": r["conversation_id"],
            "conversation_title": r["conversation_title"] or r["conversation_id"],
            "archived": bool(r["archived"]),
            "role": r["role"],
            "when": _when(r["created_at"]),
            "chars": len(r["content"] or ""),
            "truncated": cut,
            "snippet": snippet,
        })
    return {
        "code": 0,
        "data": {"hits": hits, "has_more": len(rows) > limit, "scope": scope, "terms": terms},
        "message": "ok",
    }


@router.post("/history/window")
async def read_history_window(body: dict[str, Any]) -> dict[str, Any]:
    """取某条消息前后的原文。摘录只有 ±80 字，模型要看完整上下文时走这一条。"""
    msg_id = str(body.get("message_id") or "")
    if not msg_id:
        return {"code": -1, "data": None, "message": "message_id 不能为空"}
    before = max(0, min(_HISTORY_MAX_WINDOW, _int_arg(body, "before", 4)))
    after = max(0, min(_HISTORY_MAX_WINDOW, _int_arg(body, "after", 4)))
    max_chars = max(200, min(8000, _int_arg(body, "max_chars", 1200)))

    conn = _get_db()
    target = conn.execute(
        "SELECT m.id, m.conversation_id, m.created_at, m.rowid AS rid, c.title AS conversation_title "
        "FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?",
        (msg_id,),
    ).fetchone()
    if target is None:
        conn.close()
        return {"code": -1, "data": None, "message": f"没有这条消息：{msg_id}"}
    # 位置按 (created_at, rowid) 算：同一秒写入的两条只有 rowid 分得出先后，
    # 只按 created_at 排序会让窗口里的两条互换甚至都落空。
    pos = conn.execute(
        "SELECT COUNT(*) FROM messages "
        "WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))",
        (target["conversation_id"], target["created_at"], target["created_at"], target["rid"]),
    ).fetchone()[0]
    # 向前够不满时就按够得到的条数取：拿 before+after+1 当 limit 而 offset 夹到 0，
    # 会把多出来的名额滑到目标之后，"after=0"就变成"后面也带几条"。
    actual_before = min(pos, before)
    rows = conn.execute(
        "SELECT id, role, content, model, created_at FROM messages "
        "WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ? OFFSET ?",
        (target["conversation_id"], actual_before + after + 1, pos - actual_before),
    ).fetchall()
    conn.close()

    items = []
    for r in rows:
        content = r["content"] or ""
        items.append({
            "message_id": r["id"],
            "role": r["role"],
            "model": r["model"] or "",
            "when": _when(r["created_at"]),
            "is_target": r["id"] == msg_id,
            "chars": len(content),
            "truncated": len(content) > max_chars,
            "content": content[:max_chars],
        })
    return {
        "code": 0,
        "data": {
            "conversation_id": target["conversation_id"],
            "conversation_title": target["conversation_title"] or target["conversation_id"],
            "messages": items,
        },
        "message": "ok",
    }


@router.get("/export")
async def export_all() -> dict[str, Any]:
    """导出全部对话、消息、记忆与提示词素材（数据备份用）。"""
    conn = _get_db()
    conversations = [dict(r) for r in conn.execute("SELECT * FROM conversations").fetchall()]
    messages = [dict(r) for r in conn.execute("SELECT * FROM messages").fetchall()]
    memories = [dict(r) for r in conn.execute("SELECT * FROM memories").fetchall()]
    snippets = [dict(r) for r in conn.execute("SELECT * FROM prompt_snippets").fetchall()]
    conn.close()
    return {
        "code": 0,
        "data": {
            "conversations": conversations,
            "messages": messages,
            "memories": memories,
            "snippets": snippets,
        },
        "message": "ok",
    }


@router.post("/import")
async def import_all(body: dict[str, Any]) -> dict[str, Any]:
    """导入备份数据：按 id 合并（已存在的跳过，不覆盖现有内容）。"""
    data = body.get("backend") if isinstance(body.get("backend"), dict) else body
    conversations = data.get("conversations") or []
    messages = data.get("messages") or []
    memories = data.get("memories") or []
    snippets = data.get("snippets") or []
    conn = _get_db()
    stats = {"conversations": 0, "messages": 0, "memories": 0, "snippets": 0}
    for c in conversations:
        if not c.get("id"):
            continue
        cur = conn.execute(
            "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, total_tokens, "
            "prompt_tokens, completion_tokens, message_count, context_tokens, project, project_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (c["id"], c.get("title", ""), c.get("created_at") or time.time(), c.get("updated_at") or time.time(),
             c.get("total_tokens", 0), c.get("prompt_tokens", 0), c.get("completion_tokens", 0),
             c.get("message_count", 0), c.get("context_tokens", 0), c.get("project", ""),
             c.get("project_id", "") or ""),
        )
        stats["conversations"] += cur.rowcount
    for m in messages:
        if not m.get("id") or not m.get("conversation_id"):
            continue
        cur = conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, model, metadata, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (m["id"], m["conversation_id"], m.get("role", "user"), m.get("content", ""),
             m.get("model", ""), m.get("metadata", ""), m.get("created_at") or time.time()),
        )
        stats["messages"] += cur.rowcount
    for mem in memories:
        if not mem.get("id"):
            continue
        content = str(mem.get("content", "")).strip()
        if not content:
            continue
        category = str(mem.get("category") or "general").strip()[:40] or "general"
        cur = conn.execute(
            "INSERT OR IGNORE INTO memories (id, category, content, created_at) VALUES (?, ?, ?, ?)",
            (str(mem["id"])[:80], category, content, mem.get("created_at") or time.time()),
        )
        stats["memories"] += cur.rowcount
        if cur.rowcount:
            upsert_document(
                doc_id=f"memory:{str(mem['id'])[:80]}",
                title=f"长期记忆 · {category}",
                source="long-term-memory",
                kind="memory",
                content=content,
                metadata={"memory_id": str(mem["id"])[:80], "category": category},
            )
    for s in snippets:
        if not s.get("id"):
            continue
        cur = conn.execute(
            "INSERT OR IGNORE INTO prompt_snippets (id, text, source, created_at) VALUES (?, ?, ?, ?)",
            (s["id"], s.get("text", ""), s.get("source", ""), s.get("created_at") or time.time()),
        )
        stats["snippets"] += cur.rowcount
    conn.commit()
    conn.close()
    return {"code": 0, "data": stats, "message": "ok"}


@router.post("/backup-file")
async def save_backup_file(body: dict[str, Any]) -> dict[str, Any]:
    """将前端组装好的完整备份写入本地 data/backups，供桌面环境下载失败时兜底。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
    if not isinstance(payload, dict):
        return {"code": -1, "data": None, "message": "备份内容无效"}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUP_DIR / f"SLATE-backup-{stamp}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"code": 0, "data": {"path": str(path), "file_name": path.name}, "message": "ok"}


@router.patch("/conversations/{conv_id}/usage")
async def update_usage(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """更新对话的用量统计，并把本轮 token 增量记到当天。"""
    total = int(body.get("total_tokens", 0) or 0)
    prompt = int(body.get("prompt_tokens", 0) or 0)
    completion = int(body.get("completion_tokens", 0) or 0)
    msg_count = int(body.get("message_count", 0) or 0)
    ctx = int(body.get("context_tokens", 0) or 0)

    conn = _get_db()
    prev = conn.execute(
        "SELECT total_tokens FROM conversations WHERE id = ?", (conv_id,)
    ).fetchone()
    prev_total = int(prev["total_tokens"] or 0) if prev else 0
    conn.execute(
        "UPDATE conversations SET total_tokens=?, prompt_tokens=?, completion_tokens=?, "
        "message_count=?, context_tokens=? WHERE id=?",
        (total, prompt, completion, msg_count, ctx, conv_id),
    )
    # 前端每次同步的是该对话的累计值，所以增量 = 本次 - 上次。只记正增量：
    # 负数来自删对话/重置之类的回退，记进去会把当天的数字拉成负的。
    delta = total - prev_total
    if delta > 0:
        conn.execute(
            "INSERT INTO daily_usage (day, tokens) VALUES (?, ?) "
            "ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens",
            (datetime.now().strftime("%Y-%m-%d"), delta),
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
        "请将以下对话历史压缩为简洁摘要。按四部分组织："
        "① 核心话题与目标 ② 关键决策与结论 ③ 待办与未完成事项 ④ 重要约束与上下文。"
        "保留文件路径、名称、数值等后续可能引用的事实，去除寒暄与冗余细节。"
        "输出纯文本摘要，不超过 500 字。\n\n"
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
    mem_id = str(body.get("id") or str(uuid.uuid4())[:8]).strip()[:80]
    category = str(body.get("category") or "general").strip()[:40] or "general"
    content = str(body.get("content") or "").strip()
    if not content:
        return {"code": 1, "message": "记忆内容不能为空"}
    now = time.time()
    conn = _get_db()
    conn.execute(
        """
        INSERT INTO memories (id, category, content, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            category=excluded.category,
            content=excluded.content
        """,
        (mem_id, category, content, now),
    )
    conn.commit()
    conn.close()
    upsert_document(
        doc_id=f"memory:{mem_id}",
        title=f"长期记忆 · {category}",
        source="long-term-memory",
        kind="memory",
        content=content,
        metadata={"memory_id": mem_id, "category": category},
    )
    return {"code": 0, "data": {"id": mem_id, "category": category, "content": content, "created_at": now}, "message": "ok"}


@router.patch("/memories/{mem_id}")
async def update_memory(mem_id: str, body: dict[str, Any]) -> dict[str, Any]:
    category = body.get("category")
    content = body.get("content")
    if category is not None:
        category = str(category).strip()[:40] or "general"
    if content is not None:
        content = str(content).strip()
    conn = _get_db()
    exists = conn.execute("SELECT id FROM memories WHERE id=?", (mem_id,)).fetchone()
    if not exists:
        conn.close()
        return {"code": 1, "message": "记忆不存在"}
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
    else:
        delete_document(f"memory:{mem_id}")
    return {"code": 0, "data": dict(row) if row else None, "message": "ok"}


@router.delete("/memories/{mem_id}")
async def delete_memory(mem_id: str) -> dict[str, Any]:
    conn = _get_db()
    cur = conn.execute("DELETE FROM memories WHERE id=?", (mem_id,))
    conn.commit()
    conn.close()
    delete_document(f"memory:{mem_id}")
    return {"code": 0, "data": {"deleted": cur.rowcount}, "message": "ok"}


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
    try:
        conn.execute("INSERT INTO prompt_snippets (id, text, source, created_at) VALUES (?, ?, ?, ?)",
                     (snip_id, text, source, now))
        conn.commit()
    except sqlite3.IntegrityError:
        # ID 已存在时静默忽略（前端可能重发）
        pass
    finally:
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
        "分析以下对话，提取值得长期记忆的关键信息。\n"
        "筛选标准：只记录跨对话仍然有用的稳定信息（用户偏好、重要决策、项目背景、常用术语），"
        "不记录一次性任务细节或临时状态。\n"
        "以 JSON 数组格式输出，每项包含 action 字段：\n"
        '- action: "add" 表示新增记忆，需包含 category 和 content\n'
        '- action: "overwrite" 表示覆盖已有记忆，需包含 target_id（对应已有记忆的编号）、category 和 content\n'
        '- action: "delete" 表示删除过时记忆，需包含 target_id 和 reason\n'
        "category 可选: preference, decision, project, term, fact, other。\n"
        "如果对话中用户明确修正或推翻了某条已有记忆，请用 overwrite 动作更新它。\n"
        "如果某条已有记忆已被对话内容否定，请用 delete 动作删除它。\n"
        "只输出 JSON，不要其他文字。如果没有值得记忆的内容，输出空数组 []。\n\n"
    )
    if existing:
        prompt += "已有记忆（编号可用于 target_id）:\n" + "\n".join(
            f"#{i+1} (id:{m.get('id','')}) [{m.get('category','')}] {m.get('content','')}"
            for i, m in enumerate(existing[:30])
        ) + "\n\n"
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
        instruction = "将以下对话压缩为极简摘要：仅保留核心结论、关键决策和明确的待办事项，不超过 200 字。"
    else:
        instruction = (
            "将以下对话压缩为摘要：按「核心话题 / 关键决策 / 待办事项 / 重要约束」组织，"
            "保留文件路径、名称、数值等后续可能引用的事实，不超过 500 字。"
        )

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
