"""技能路由：MCP 内置工具 + SKILL.md 技能，支持执行、上传与本地导入。

通用插件适配：支持 SKILL.md 开放标准（Codex CLI / Claude Code / Cursor 等）。
"""

from __future__ import annotations

import importlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, UploadFile, File
from pydantic import BaseModel

from backend.skills import plugin_adapter
from backend.skills.sandbox import validate_skill_params, sanitize_param, MAX_PARAM_LENGTH

router = APIRouter(prefix="/skills", tags=["skills"])

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
USER_SKILLS_DIR = DATA_DIR / "skills"

# MCP 内置工具注册表（原“内置技能”，现统一称 MCP 工具）
BUILTIN_SKILLS: dict[str, str] = {
    "file_tree": "扫描目录树（仅第一层）",
    "file_peek": "读取文件前 N 行（≤50行）",
    "terminal": "受限终端执行（指定目录沙箱，支持后台执行）",
    "html_render": "生成纯黑白 HTML 骨架",
    "css_color": "基于描述生成 CSS 配色方案（支持暖色/冷色/自然/深色等多种风格）",
    "doc_write": "生成 Markdown 格式技术文档或需求说明",
    "ppt_create": "生成 .pptx 演示文稿（标题页+内容页，支持主题大纲与自定义配色）",
    "word_create": "生成 .docx Word 文档（标题层级、段落、列表排版）",
    "file_edit": "基于 diff 精确编辑文件（只改指定内容）",
    "file_create": "创建新文件（预览后确认写入）",
    "text_summarize": "文本摘要与关键词提取",
    "json_tool": "JSON 校验、格式化、压缩与路径读取",
    "regex_test": "正则表达式测试与匹配结果预览",
    "repo_stats": "项目文件类型、体积与数量统计",
    "todo_scan": "扫描项目中的 TODO/FIXME/待办标记",
    "web_search": "网络搜索/网页抓取，获取实时信息（免 Key，DuckDuckGo）",
    "web_fetch": "获取指定网页内容：提取标题/描述/正文纯文本，支持返回原始 HTML（免 Key 直连）",
    "chart_create": "生成 SVG 图表（柱状/条形/折线/饼图），零依赖纯 Python，返回文件路径与预览链接",
    "qrcode_create": "生成 SVG 二维码（文本或 URL），返回文件路径与预览链接",
    "python_api_extract": "提取 Python 库/模块的公共 API 文档（函数签名、类方法、属性），输出 JSON/Markdown",
    "html_bundle": "将 html 及相对路径的 css/js 内联合并为单个 html 文件（便携分发）",
    "code_scan": "代码安全扫描（检测硬编码密钥/SQL注入/XSS/弱加密/调试残留等）",
    "mcp_factory": "MCP 工厂：根据描述自动生成新的 MCP 工具，让 SLATE 自生产适配自身的工具",
    "browser_automation": "浏览器自动化：基于 Playwright 控制 Chromium 浏览器（导航/截图/点击/输入/执行JS）",
    "computer_use": "桌面自动化：基于 pyautogui 控制鼠标键盘（截图/点击/输入/组合键/图像定位）",
}


def _list_md_skills() -> dict[str, str]:
    """扫描 SKILL.md 组成的自定义技能。"""
    custom_skills: dict[str, str] = {}
    if USER_SKILLS_DIR.is_dir():
        for skill_md in USER_SKILLS_DIR.glob("*/SKILL.md"):
            skill_name = skill_md.parent.name
            try:
                text = skill_md.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                text = ""
            # 提取 description 字段作为描述
            desc = skill_name
            for line in text.split("\n"):
                stripped = line.strip()
                if stripped.startswith("description:"):
                    desc = stripped.split(":", 1)[1].strip()
                    break
            custom_skills[skill_name] = desc
    return custom_skills


@router.get("")
async def list_skills() -> dict[str, Any]:
    """列出所有可用能力：MCP 内置工具 + SKILL.md 技能。"""
    return {
        "code": 0,
        "data": {
            "mcp": BUILTIN_SKILLS,
            "skills": _list_md_skills(),
        },
        "message": "ok",
    }


@router.post("/execute")
async def execute_skill(body: dict[str, Any]) -> dict[str, Any]:
    """执行指定技能。"""
    skill_name = body.get("skill", "")
    params = body.get("params", {})

    # 参数大小限制（防止恶意超大参数撑爆内存）
    param_error = validate_skill_params(params)
    if param_error:
        return {"code": -1, "data": None, "message": param_error}

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
        # 文件名消毒：去除路径分隔符和特殊字符
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', f.filename or 'unnamed')
        safe_name = safe_name.strip('. ')  # 去除首尾点和空格
        if not safe_name:
            safe_name = 'unnamed'
        dest = skill_dir / safe_name
        content = await f.read()
        # 上传文件大小限制（5MB）
        if len(content) > 5 * 1024 * 1024:
            return {"code": -1, "data": None, "message": f"文件 {safe_name} 过大（最大 5MB）"}
        dest.write_bytes(content)
        saved_files.append(safe_name)

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


class ImportSkillRequest(BaseModel):
    path: str
    name: str = ""


def _sanitize_skill_name(name: str) -> str:
    """技能名只保留安全字符，防止路径穿越。"""
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", name.strip()).strip(".")
    return cleaned[:64]


@router.post("/import")
async def import_skill(req: ImportSkillRequest) -> dict[str, Any]:
    """从本地路径导入 SKILL.md 技能。

    支持两种形式：
    1. 目录：目录内必须包含 SKILL.md，整个目录被复制导入
    2. 单个 .md 文件：以文件名（或指定 name）建立技能目录
    """
    src = Path(os.path.expanduser(req.path.strip()))
    if not src.exists():
        return {"code": 1, "message": f"路径不存在: {req.path}"}

    try:
        if src.is_dir():
            skill_md = src / "SKILL.md"
            if not skill_md.is_file():
                return {"code": 1, "message": "目录中未找到 SKILL.md，无法导入"}
            skill_name = _sanitize_skill_name(req.name or src.name)
            if not skill_name:
                return {"code": 1, "message": "无效的技能名称"}
            dest = USER_SKILLS_DIR / skill_name
            USER_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src.resolve(), dest)
            file_count = sum(1 for _ in dest.rglob("*") if _.is_file())
        else:
            if src.suffix.lower() not in (".md", ".markdown"):
                return {"code": 1, "message": "单文件导入仅支持 .md 文件"}
            default_name = src.stem if src.name.lower() != "skill.md" else src.parent.name
            skill_name = _sanitize_skill_name(req.name or default_name)
            if not skill_name:
                return {"code": 1, "message": "无效的技能名称"}
            dest = USER_SKILLS_DIR / skill_name
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src.resolve(), dest / "SKILL.md")
            file_count = 1
    except OSError as e:
        return {"code": 1, "message": f"导入失败: {e}"}

    return {
        "code": 0,
        "data": {"skill": skill_name, "files": file_count, "path": str(dest)},
        "message": "ok",
    }


@router.delete("/{skill_name}")
async def delete_skill(skill_name: str) -> dict[str, Any]:
    """删除自定义 SKILL.md 技能（不影响 MCP 内置工具）。"""
    clean = _sanitize_skill_name(skill_name)
    if clean != skill_name or not clean:
        return {"code": 1, "message": "无效的技能名称"}
    target = USER_SKILLS_DIR / clean
    if not target.is_dir():
        return {"code": 1, "message": f"技能不存在: {skill_name}"}
    try:
        shutil.rmtree(target)
    except OSError as e:
        return {"code": 1, "message": f"删除失败: {e}"}
    return {"code": 0, "data": None, "message": "ok"}


# ── 通用插件适配接口 ─────────────────────────────────

@router.get("/sources")
async def list_sources() -> dict[str, Any]:
    """列出所有可用的技能来源（本地已安装 + Codex 插件）。"""
    sources = plugin_adapter.list_available_sources()
    return {"code": 0, "data": sources, "message": "ok"}


class ImportFromPathRequest(BaseModel):
    path: str
    name: str = ""


@router.post("/import-path")
async def import_from_path(req: ImportFromPathRequest) -> dict[str, Any]:
    """从本地路径导入技能（支持 SKILL.md 或 Codex 插件格式）。"""
    result = plugin_adapter.import_from_path(req.path, USER_SKILLS_DIR, req.name)
    if "error" in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


class ImportFromGithubRequest(BaseModel):
    url: str
    subpath: str = ""


@router.post("/import-github")
async def import_from_github(req: ImportFromGithubRequest) -> dict[str, Any]:
    """从 GitHub 仓库导入技能。"""
    result = plugin_adapter.import_from_github(req.url, USER_SKILLS_DIR, req.subpath)
    if "error" in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}
