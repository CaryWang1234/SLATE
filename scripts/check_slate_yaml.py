# -*- coding: utf-8 -*-
"""SAY-1 解析守卫：scripts/check_slate_yaml.py

Action 用 YAML 书写，但项目不依赖 PyYAML，也不打算为了这一个功能引入它——
所以 backend/slate_yaml.py 自研了一个刻意残缺的子集（SAY-1）。
它一旦松手就会变成两种事故：要么把用户写坏的文件悄悄读成别的意思（模型照着
错误流程执行），要么严格到连正常写法都报错（用户放弃这个功能）。
正反用例都得钉住，且禁止构造必须带行号报错。

运行：python scripts/check_slate_yaml.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.slate_yaml import SayError, load_action, parse  # noqa: E402

GOOD = """
# 整行注释要能吃掉
name: 生成发布说明
description: 从 git log 归纳中英双语 Release Notes 并落到 CHANGELOG
when: 用户说"发版/写 release notes/出更新日志"时
inputs:
  - key: tag
    label: 目标版本号
    type: text
    required: true
  - key: audience
    label: 读者
    type: select
    options:
      - 终端用户
      - 开发者
steps:
  - title: 取变更清单
    tool: git_tool
    detail: |
      第一行

      中间有空行
      git log <上个 tag>..HEAD --oneline --no-merges
    check: 每条 commit 都能被归入某个分类
  - title: 归类
    detail: |
      按 feature / fix / breaking 归并；
      breaking 置顶。
  - title: 双语输出
    tool: file_create
output:
  format: markdown
  destination: file
  path: CHANGELOG.md
tags:
  - release
  - docs
author: user
"""

MINIMAL = "name: a\ndescription: b\nsteps:\n  - title: t\n"

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, cond: object, detail: str = "") -> None:
    passed = bool(cond)
    RESULTS.append((passed, name, detail))
    print(("  OK   " if passed else "  FAIL ") + name + (f"  <- {detail}" if detail and not passed else ""))


def rejected(name: str, text: str, want_in_reason: str = "") -> SayError | None:
    """禁止构造必须被拒；want_in_reason 钉住原因文案，防止换了个不相干的错蒙过去。"""
    try:
        load_action(text)
    except SayError as err:
        hit = (not want_in_reason) or (want_in_reason in err.reason)
        ok(name, hit, f"reason={err.reason!r} line={err.line}")
        return err
    ok(name, False, "居然解析通过了")
    return None


# ── 正例：字段逐个钉住 ──────────────────────────

spec, warnings = load_action(GOOD, action_id="release-notes")
ok("正例解析成功", isinstance(spec, dict))
ok("id 用传入的 action_id", spec["id"] == "release-notes", spec["id"])
ok("description 原样", spec["description"].startswith("从 git log"), spec["description"])
ok("字面块保留内部空行", "\n\n中间有空行" in spec["steps"][0]["detail"], repr(spec["steps"][0]["detail"]))
ok("字面块剥掉尾部空行", not spec["steps"][0]["detail"].endswith("\n"), repr(spec["steps"][0]["detail"][-12:]))
ok("块数组的对象元素", spec["steps"][1]["title"] == "归类", str(spec["steps"][1]))
ok("required 布尔为 True", spec["inputs"][0]["required"] is True, repr(spec["inputs"][0]["required"]))
ok("未写 required 默认 False", spec["inputs"][1]["required"] is False, repr(spec["inputs"][1]["required"]))
ok("select 带 options", spec["inputs"][1]["options"] == ["终端用户", "开发者"], str(spec["inputs"][1]["options"]))
ok("detail 允许为空", spec["steps"][2]["detail"] == "", repr(spec["steps"][2]["detail"]))
ok("tool 缺省为空串", spec["steps"][1]["tool"] == "", repr(spec["steps"][1]["tool"]))
ok("output.path 原样", spec["output"]["path"] == "CHANGELOG.md", spec["output"]["path"])
ok("tags 两块都在", spec["tags"] == ["release", "docs"], str(spec["tags"]))
ok("规范写法零告警", warnings == [], str(warnings))

# ── 禁止构造：SAY-1 刻意不支持的东西 ────────────

rejected("Tab 缩进", 'name: a\n\tdescription: b\n', "Tab")
rejected("流式数组 []", 'name: a\ndescription: b\ntags: [x, y]\n', "流式")
rejected("折叠标量 >", 'name: a\ndescription: b\nsteps:\n  - title: t\n    detail: >\n      x\n', "折叠")
rejected("锚点 &", 'name: a\ndescription: b\nsteps: &s\n  - title: t\n', "锚点")
rejected("多文档 ---", '---\nname: a\ndescription: b\n', "---")
rejected("yes 不当布尔", 'name: a\ndescription: b\ninputs:\n  - key: k\n    required: yes\n' + "steps:\n  - title: t\n", "true / false")
rejected("引号未闭合", 'name: "a\ndescription: b\n', "闭合")
rejected("键缺冒号", 'name a\ndescription: b\n', "键: 值")
rejected("顶层键缩进", '  name: a\ndescription: b\n', "顶层键不能缩进")
rejected("同层缩进不齐", 'name: a\ndescription: b\nsteps:\n  - title: t\n    detail: d\n      - x\n')

# ── 语义与上限 ─────────────────────────────────

rejected("缺 name", 'description: b\nsteps:\n  - title: t\n', "name")
rejected("缺 steps", 'name: a\ndescription: b\n', "steps")
rejected("description 超长", 'name: a\ndescription: ' + "字" * 121 + "\nsteps:\n  - title: t\n", "120")
rejected("steps 超上限", 'name: a\ndescription: b\nsteps:\n' + "".join(f"  - title: s{i}\n" for i in range(25)), "24")
rejected("inputs 超上限", 'name: a\ndescription: b\ninputs:\n' + "".join(f"  - key: k{i}\n" for i in range(9)) + "steps:\n  - title: t\n", "8")
rejected("select 无 options", 'name: a\ndescription: b\ninputs:\n  - key: k\n    type: select\nsteps:\n  - title: t\n', "options")
rejected("input key 非法", 'name: a\ndescription: b\ninputs:\n  - key: Bad-Key\nsteps:\n  - title: t\n', "a-z0-9_")
rejected("未知 destination", MINIMAL + "output:\n  destination: ftp\n", "destination")
rejected("destination=file 无 path", MINIMAL + "output:\n  destination: file\n", "output.path")
rejected("author 非法", 'name: a\ndescription: b\nsteps:\n  - title: t\nauthor: admin\n', "author")
rejected("id 非法", 'name: a\ndescription: b\nsteps:\n  - title: t\nid: Bad_Name\n', "a-z0-9")
rejected("单文件超体积", 'name: a\ndescription: b\nsteps:\n  - title: t\n    detail: ' + "x" * 70_000 + "\n", "64000")

no_id, warn_id = load_action(MINIMAL)
ok("缺 id 只告警不失败", no_id["id"] == "" and any("未写 id" in w for w in warn_id), str(warn_id))
ok("显式 action_id 覆盖", load_action(MINIMAL, action_id="x1")[0]["id"] == "x1")

# ── 宽松项：这些不该炸 ──────────────────────────

_, warn_unknown = load_action(MINIMAL + "custom_field: zz\n")
ok("未知字段只告警", warn_unknown and "custom_field" in warn_unknown[0], str(warn_unknown))
ok("值内冒号归值",
   load_action('name: a\ndescription: 值里有冒号: 也值\nsteps:\n  - title: t\n')[0]["description"] == "值里有冒号: 也值")
ok("行尾 # 属于值",
   load_action('name: a\ndescription: b # 这不是注释\nsteps:\n  - title: t\n')[0]["description"] == "b # 这不是注释")
ok("只有注释的文本读成空映射", parse("# 只有注释\n") == {}, str(parse("# 只有注释\n")))
ok("步骤可写成纯字符串", load_action('name: a\ndescription: b\nsteps:\n  - 只有一句话\n')[0]["steps"][0]["title"] == "只有一句话")
ok("空值字段当未填", load_action('name: a\ndescription: b\nwhen:\nsteps:\n  - title: t\n')[0]["when"] == "")

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\nSAY-1 解析守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + (f"：{'、'.join(failed)}" if failed else " —— 通过"))
sys.exit(1 if failed else 0)
