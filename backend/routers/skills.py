"""技能路由：统一挂载 Skill 调用入口，支持内置与自定义技能。"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, UploadFile, File

router = APIRouter(prefix="/skills", tags=["skills"])

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
USER_SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "skills"

# 内置技能注册表
BUILTIN_SKILLS: dict[str, str] = {
    "file_tree": "扫描目录树（仅第一层）",
    "file_peek": "读取文件前 N 行（≤50行）",
    "terminal": "受限终端执行（指定目录沙箱）",
    "html_render": "生成纯黑白 HTML 骨架",
    "css_color": "基于描述生成 CSS 配色方案（支持暖色/冷色/自然/深色等多种风格）",
    "doc_write": "生成 Markdown 格式技术文档或需求说明",
    "file_edit": "基于 diff 精确编辑文件（只改指定内容）",
    "file_create": "创建新文件（预览后确认写入）",
}


@router.get("")
async def list_skills() -> dict[str, Any]:
    """列出所有可用技能（内置 + 自定义）。"""
    custom_skills: dict[str, str] = {}
    if USER_SKILLS_DIR.is_dir():
        for skill_md in USER_SKILLS_DIR.glob("*/SKILL.md"):
            skill_name = skill_md.parent.name
            text = skill_md.read_text(encoding="utf-8")
            # 提取第一行 # 标题后的描述
            desc = skill_name
            for line in text.split("\n"):
                stripped = line.strip()
                if stripped.startswith("description:"):
                    desc = stripped.split(":", 1)[1].strip()
                    break
            custom_skills[skill_name] = desc

    return {
        "code": 0,
        "data": {
            "builtin": BUILTIN_SKILLS,
            "custom": custom_skills,
        },
        "message": "ok",
    }


@router.post("/execute")
async def execute_skill(body: dict[str, Any]) -> dict[str, Any]:
    """执行指定技能。"""
    skill_name = body.get("skill", "")
    params = body.get("params", {})

    # 查找内置技能
    if skill_name in BUILTIN_SKILLS:
        try:
            module = importlib.import_module(f"backend.skills.{skill_name}")
        except ImportError:
            return {"code": -1, "data": None, "message": f"技能模块 {skill_name} 加载失败"}

        if not hasattr(module, "execute"):
            return {"code": -1, "data": None, "message": f"技能 {skill_name} 缺少 execute 函数"}

        try:
            result = module.execute(**params)
            return {"code": 0, "data": result, "message": "ok"}
        except Exception as e:
            return {"code": -1, "data": None, "message": f"技能执行失败: {e}"}

    # 查找自定义技能
    custom_skill_dir = USER_SKILLS_DIR / skill_name
    if custom_skill_dir.is_dir():
        skill_md = custom_skill_dir / "SKILL.md"
        if skill_md.is_file():
            content = skill_md.read_text(encoding="utf-8")
            return {
                "code": 0,
                "data": {"type": "custom_skill", "content": content},
                "message": "ok",
            }

    return {"code": -1, "data": None, "message": f"未知技能: {skill_name}"}


@router.post("/upload")
async def upload_skill(
    files: list[UploadFile] = File(...),
    skill_name: str = "",
    skill_desc: str = "",
) -> dict[str, Any]:
    """上传自定义技能文件。"""
    if not skill_name:
        return {"code": -1, "data": None, "message": "技能名称不能为空"}

    skill_dir = USER_SKILLS_DIR / skill_name
    skill_dir.mkdir(parents=True, exist_ok=True)

    saved_files = []
    for f in files:
        dest = skill_dir / f.filename
        content = await f.read()
        dest.write_bytes(content)
        saved_files.append(f.filename)

    # 如果没有 SKILL.md，自动生成一个
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        skill_md.write_text(
            f"# {skill_name}\n\ndescription: {skill_desc or skill_name}\n",
            encoding="utf-8",
        )

    return {
        "code": 0,
        "data": {"skill": skill_name, "files": saved_files},
        "message": "ok",
    }
