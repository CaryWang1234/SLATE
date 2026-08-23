"""工具工厂：让 SLATE 自生产适配自身的工具。

根据描述自动生成符合 SLATE 工具规范的 Python 模块，
保存到 backend/skills/ 并动态注册到工具列表。
标准 MCP 协议端点见 backend/routers/mcp.py。
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path
from typing import Any

# 工具模块存放目录
SKILLS_DIR = Path(__file__).resolve().parent

# 工具模板
TOOL_TEMPLATE = '''"""{description}

由工具工厂自动生成。
"""

from __future__ import annotations

from typing import Any


def execute({params}) -> dict[str, Any]:
    """执行工具逻辑。

    Args:
{param_docs}
    Returns:
        dict: 执行结果。
    """
    # ── 参数校验 ──
{validations}

    # ── 核心逻辑 ──
{body}

    return {{"status": "ok", "message": "工具执行成功"}}
'''


def _sanitize_name(name: str) -> str:
    """清理工具名称，只保留安全字符。"""
    cleaned = re.sub(r"[^\w]", "_", name.strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned[:64]


def _generate_params(param_specs: list[dict]) -> tuple[str, str, str]:
    """根据参数规格生成函数签名、文档和校验代码。

    Returns:
        (params_str, param_docs, validations)
    """
    params = []
    docs = []
    validations = []

    for spec in param_specs:
        name = _sanitize_name(spec.get("name", ""))
        if not name:
            continue

        ptype = spec.get("type", "str")
        required = spec.get("required", True)
        default = spec.get("default", "")
        desc = spec.get("description", "")

        # 函数签名
        if ptype == "int":
            params.append(f"{name}: int = {default or 0}")
        elif ptype == "float":
            params.append(f"{name}: float = {default or 0.0}")
        elif ptype == "bool":
            params.append(f"{name}: bool = {str(default or False)}")
        elif ptype == "list":
            params.append(f"{name}: list = None")
        elif ptype == "dict":
            params.append(f"{name}: dict = None")
        else:
            params.append(f'{name}: str = "{default}"' if default else f"{name}: str = ''")

        # 文档
        type_desc = f"({ptype})" if ptype else ""
        req_desc = "[必填]" if required else "[可选]"
        docs.append(f"        {name} {type_desc}: {desc} {req_desc}")

        # 校验
        if required and ptype == "str":
            validations.append(f'    if not {name}:')
            validations.append(f'        return {{"error": "参数 {name} 不能为空"}}')
        elif required and ptype in ("list", "dict"):
            validations.append(f'    if {name} is None:')
            validations.append(f'        return {{"error": "参数 {name} 不能为空"}}')

    return ", ".join(params), "\n".join(docs), "\n".join(validations)


def execute(
    tool_name: str = "",
    description: str = "",
    params: list = None,
    body: str = "",
    overwrite: bool = False,
    **_kw: Any,
) -> dict[str, Any]:
    """创建新的工具。

    Args:
        tool_name: 工具名称（英文，将作为模块名）
        description: 工具功能描述
        params: 参数规格列表，每项包含 name/type/required/default/description
        body: 工具核心逻辑代码（Python 代码字符串）
        overwrite: 是否覆盖已存在的工具

    Returns:
        dict: 包含 tool_name, file_path, description 等信息
    """
    # 参数校验
    name = _sanitize_name(tool_name)
    if not name:
        return {"error": "tool_name 不能为空，且只能包含字母数字下划线"}

    if not description:
        return {"error": "description 不能为空"}

    if not body or not body.strip():
        return {"error": "body 不能为空，请提供工具的核心逻辑代码"}

    # 检查是否已存在
    target_path = SKILLS_DIR / f"{name}.py"
    if target_path.exists() and not overwrite:
        return {
            "error": f"工具 {name} 已存在，设置 overwrite=true 可覆盖",
            "existing_path": str(target_path),
        }

    # 生成参数
    param_list = params or []
    params_str, param_docs, validations = _generate_params(param_list)

    # 处理 body
    if not body:
        body = '    result = {"message": "请实现具体逻辑"}'
    else:
        # 确保 body 有正确的缩进
        body_lines = body.strip().split("\n")
        body = "\n".join("    " + line if line.strip() else "" for line in body_lines)

    # 生成代码
    code = TOOL_TEMPLATE.format(
        description=description,
        params=params_str,
        param_docs=param_docs or "        无参数",
        validations=validations or "    # 无需校验",
        body=body,
    )

    # 写入文件
    try:
        target_path.write_text(code, encoding="utf-8")
    except OSError as e:
        return {"error": f"写入文件失败: {e}"}

    # 动态注册到 BUILTIN_SKILLS
    try:
        # 导入 skills 路由模块以访问 BUILTIN_SKILLS
        from backend.routers.skills import BUILTIN_SKILLS
        BUILTIN_SKILLS[name] = description
    except ImportError:
        pass  # 如果导入失败，工具仍然可以通过模块直接调用

    # 尝试导入验证
    try:
        # 清除可能的缓存
        module_name = f"backend.skills.{name}"
        if module_name in sys.modules:
            del sys.modules[module_name]
        importlib.import_module(module_name)
    except Exception as e:
        return {
            "warning": f"工具已创建但导入验证失败: {e}",
            "tool_name": name,
            "file_path": str(target_path),
            "description": description,
        }

    return {
        "status": "ok",
        "tool_name": name,
        "file_path": str(target_path),
        "description": description,
        "params_count": len(param_list),
        "message": f"工具 {name} 创建成功，已注册到工具列表",
    }
