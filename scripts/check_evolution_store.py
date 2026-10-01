# -*- coding: utf-8 -*-
"""自进化产物仓守卫：scripts/check_evolution_store.py

工具工厂让模型自己写 Python 给自己用，"跑不跑得对"就不是措辞问题了：
产物落点、路径围栏、停用/坏掉/被内置顶掉这三种状态到底拦不拦得住、覆盖与撤销留没留底、
回滚之后跑的是不是真就是那一版——这些只能在真实读写里验，静态正则看不见。
浏览器走查也不该负责这些：它只能证明像素，证明不了"模型目录里没有它"。

数据全部落在系统临时目录（SLATE_DATA_DIR），绝不碰仓库 data/。
运行：python scripts/check_evolution_store.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.mkdtemp(prefix="slate_evolution_check_")
os.environ["SLATE_DATA_DIR"] = TMP
sys.path.insert(0, str(ROOT))

from backend import evolution  # noqa: E402
from backend.data_io import atomic_write_text  # noqa: E402
from backend.skills import mcp_factory  # noqa: E402

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, str(detail)))


GOOD_BODY = 'return {"status": "ok", "echoed": text.strip().upper()}'


def module_src(body: str = GOOD_BODY) -> str:
    """把一行逻辑包成"工厂产出的那种模块"（save_tool 只收带 def execute 的整份源码）。"""
    return '"""demo\n\n由工具工厂自动生成。\n"""\n\n\ndef execute(text: str = "") -> dict:\n    ' + body + "\n"


def make(name: str, desc: str = "把文本转成大写", body: str = GOOD_BODY,
         params: list | None = None) -> dict:
    return mcp_factory.execute(tool_name=name, description=desc,
                               params=params if params is not None else
                               [{"name": "text", "type": "str", "required": True, "description": "输入文本"}],
                               body=body, overwrite=True)


# ── 0. 隔离确实生效 ───────────────────────────
ok("产物仓锚在 SLATE_DATA_DIR 下（自检数据不落仓库 data/）",
   evolution.EVOLVED_DIR == Path(TMP) / "evolved", str(evolution.EVOLVED_DIR))

# ── 1. 名字与路径围栏 ─────────────────────────
# clean_name 是裁判不是刷子：带空格、带中文、超长一律拒绝（消毒是工厂那边的事）
for raw, want in [("Echo Upper", ""), ("echo_upper", "echo_upper"), ("a" * 60, ""),
                  ("2bad", ""), ("Bad-Name", ""), ("", "")]:
    ok(f"clean_name({raw[:12]!r}) → {want or '拒绝'}", evolution.clean_name(raw) == want,
       evolution.clean_name(raw))
ok("_tool_path 不许跳出产物目录（../ 一律拒绝）",
   evolution._tool_path(evolution.EVOLVED_DIR, "good") is not None
   and evolution._tool_path(evolution.EVOLVED_DIR, "../outside") is None,
   str(evolution._tool_path(evolution.EVOLVED_DIR, "../outside")))
ok("_history_path 先认时间戳格式再拼路径",
   evolution._history_path(evolution.HISTORY_DIR, "x", "../../etc/passwd", ".py") is None
   and evolution._history_path(evolution.HISTORY_DIR, "x", "20260101T000000", ".py") is not None)

# ── 2. 不执行地判生死 ─────────────────────────
ok("空源码判不可用", evolution.check_source("   ") != "")
ok("语法错误被拦下并带上行号", "语法错误" in evolution.check_source("def execute(:\n  pass\n"),
   evolution.check_source("def execute(:\n  pass\n"))
ok("缺 execute 被拦下（有 execute 才谈得上被模型调用）",
   "缺少 execute" in evolution.check_source("def helper():\n    return 1\n"))
ok("合法源码放行", evolution.check_source(module_src()) == "", evolution.check_source(module_src()))

# ── 3. 工厂创建：坏代码根本不落盘，产物是两份文件 ──────
bad = mcp_factory.execute(tool_name="broken_case", description="x", body="def execute(: pass")
ok("语法不过的生成代码不落盘", "error" in bad
   and not (evolution.EVOLVED_DIR / "broken_case.py").exists(), str(bad))

r = make("echo_upper")
ok("工厂创建成功", r.get("status") == "ok", json.dumps(r, ensure_ascii=False)[:200])
ok("产物落在 data/evolved/ 而不是源码树",
   (evolution.EVOLVED_DIR / "echo_upper.py").is_file()
   and (evolution.EVOLVED_DIR / "echo_upper.json").is_file()
   and not (ROOT / "backend" / "skills" / "echo_upper.py").exists())
ok("创建后能装载并真的跑起来",
   evolution.load_module("echo_upper")[0].execute(text="hi")["echoed"] == "HI")
ok("清单里记的参数会拼进模型目录那一行",
   "text:str" in evolution.catalog().get("echo_upper", ""), evolution.catalog().get("echo_upper"))
clash = mcp_factory.execute(tool_name="terminal", description="x", body="return {}")
ok("工厂拒绝与内置工具同名（那份永远不会被跑到）", "error" in clash, str(clash))

# ── 4. 覆盖留底 + 回滚真的换逻辑 ─────────────────
before_ts = evolution.history_versions("echo_upper")
r2 = make("echo_upper", desc="大写并加感叹号", body='return {"status": "ok", "echoed": text.upper() + "!"}')
ok("覆盖前自动留底", r2.get("backed_up") != "", str(r2))
ok("第一次创建没有留底（没有旧文件可留）", before_ts == [], str(before_ts))
ok("覆盖后跑的是新版", evolution.load_module("echo_upper")[0].execute(text="hi")["echoed"] == "HI!")
versions = evolution.history_versions("echo_upper")
ok("留底清单可按时间戳读到", len(versions) == 1 and versions[0]["has_manifest"], str(versions))
back = evolution.restore_history("echo_upper", versions[0]["ts"])
ok("回滚成功", back["code"] == 0, json.dumps(back, ensure_ascii=False)[:200])
ok("回滚后跑的确实是那一版（装载缓存跟着源码摘要失效）",
   evolution.load_module("echo_upper")[0].execute(text="hi")["echoed"] == "HI")
ok("回滚把说明也一起带回去了",
   evolution.read_manifest("echo_upper")["description"] == "把文本转成大写",
   evolution.read_manifest("echo_upper")["description"])

# ── 5. 停用 / 坏掉 / 被顶掉：三种都不许进模型目录 ──────
ok("停用回码正确", evolution.set_enabled("echo_upper", False)["code"] == 0)
ok("停用后不进模型目录", "echo_upper" not in evolution.catalog())
off = evolution.load_module("echo_upper")
ok("停用后装载被拒（不是'调用时再报错'，而是根本拿不到模块）",
   off[0] is None and "已被停用" in off[1], off[1])
ok("重新启用又回到目录里",
   evolution.set_enabled("echo_upper", True)["code"] == 0 and "echo_upper" in evolution.catalog())

atomic_write_text(evolution.EVOLVED_DIR / "syntax_case.py", "def execute(:\n    pass\n")
atomic_write_text(evolution.EVOLVED_DIR / "syntax_case.json",
                  json.dumps({"name": "syntax_case", "description": "坏掉的", "enabled": True},
                             ensure_ascii=False))
items = {i["name"]: i for i in evolution.list_items()}
ok("坏掉的条目仍在清单里并写明原因（不许凭空消失）",
   items["syntax_case"]["error"] != "" and "语法错误" in items["syntax_case"]["error"],
   items["syntax_case"]["error"])
ok("坏掉的进不了模型目录", "syntax_case" not in evolution.catalog())
ok("坏掉的调用被拒并给出原因", "语法错误" in evolution.load_module("syntax_case")[1])

atomic_write_text(evolution.EVOLVED_DIR / "nomanifest.py", module_src())
items = {i["name"]: i for i in evolution.list_items()}
ok("只有源码没有清单＝清单损坏，同样进不了目录",
   items["nomanifest"]["error"] != "" and "nomanifest" not in evolution.catalog(),
   items["nomanifest"]["error"])

# 升级带来同名内置工具：盘上是自产的那份，运行期内置优先
clash_save = evolution.save_tool("git_tool", "自产的 git 包装", [], module_src())
ok("盘上允许存在与内置同名的自产文件（冲突要看得见，不是写不进去）",
   clash_save["code"] == 0, json.dumps(clash_save, ensure_ascii=False)[:160])
items = {i["name"]: i for i in evolution.list_items()}
ok("与内置同名的那份被标成 shadowed", items["git_tool"]["shadowed"] is True)
ok("被内置顶掉的那份不进模型目录", "git_tool" not in evolution.catalog())
ok("被内置顶掉的那份装载被拒（同名时内置赢，自产那份不许越权）",
   "同名" in evolution.load_module("git_tool")[1])

# ── 6. 撤销：删两份文件但留底还在 ─────────────────
rm = evolution.delete_tool("echo_upper")
ok("撤销成功", rm["code"] == 0 and rm["data"]["backed_up"] != "", json.dumps(rm, ensure_ascii=False)[:160])
ok("撤销把源码与清单都摘掉",
   not (evolution.EVOLVED_DIR / "echo_upper.py").exists()
   and not (evolution.EVOLVED_DIR / "echo_upper.json").exists())
kept = evolution.history_versions("echo_upper")
ok("撤销后留底还在（这就是反悔的出口）", len(kept) >= 1, str(kept))
ok("从撤销留底能读回原文",
   evolution.read_history_source("echo_upper", kept[0]["ts"])["code"] == 0)
ok("不存在的工具撤销会明确报错", evolution.delete_tool("never_existed")["code"] == -1)

# ── 7. 留底数量上限与排序 ───────────────────────────
backup_ts: list[str] = []
for i in range(evolution.HISTORY_KEEP + 3):
    pruned = evolution.save_tool("prune_case", f"第 {i} 版", [], module_src(f'return {{"v": {i}}}'))
    if pruned["data"]["backed_up"]:
        backup_ts.append(pruned["data"]["backed_up"])
versions = evolution.history_versions("prune_case")
kept_ts = [v["ts"] for v in versions]
ok(f"留底最多保留 {evolution.HISTORY_KEEP} 版", len(versions) == evolution.HISTORY_KEEP, str(versions))
# 排序方向单独钉一条：裁剪剪的是清单尾部，清单一旦排成正序，被剪掉的就是"最新那一份"——
# 条数照样对，用户以为留了底，真出事时退回去的却是七天前的旧版。
ok("留底清单按最新在前排，被裁掉的是最旧那几版",
   kept_ts == sorted(kept_ts, reverse=True)
   and len(backup_ts) == evolution.HISTORY_KEEP + 2
   and kept_ts[0] == backup_ts[-1] and kept_ts[-1] == backup_ts[-evolution.HISTORY_KEEP],
   f"留底={kept_ts} 历次={backup_ts}")
# 契约单独测一遍，不掺裁剪算术：覆盖一次，最新那条留底就该是被盖掉的那一版
first_src = module_src('return {"v": 0}')
second_src = module_src('return {"v": 1}')
evolution.save_tool("pair_case", "第一版", [], first_src)
evolution.save_tool("pair_case", "第二版", [], second_src)
pair = evolution.history_versions("pair_case")
ok("最新那条留底就是被上一次覆盖掉的那一版",
   len(pair) == 1 and evolution.read_history_source("pair_case", pair[0]["ts"])["data"]["content"] == first_src,
   f"留底={pair[0]['ts'] if pair else '无'}")

# ── 8. 旧产物迁移：只搬带标记的，绝不碰内置与已存在的 ──────
legacy_dir = Path(TMP) / "fake_skills"
legacy_dir.mkdir(parents=True, exist_ok=True)
(legacy_dir / "__init__.py").write_text("", encoding="utf-8")
(legacy_dir / "demo_old.py").write_text(
    '"""旧版演示工具\n\n由工具工厂自动生成。\n"""\n\nfrom __future__ import annotations\n\n\n'
    'def execute(word: str = "", times: int = 1) -> dict:\n    return {"ok": True}\n',
    encoding="utf-8", newline="\n")
(legacy_dir / "plain_file.py").write_text("def execute():\n    return {}\n", encoding="utf-8", newline="\n")
(legacy_dir / "git_tool.py").write_text(
    '"""内置同名\n\n由工具工厂自动生成。\n"""\n\n'
    'def execute() -> dict:\n    return {}\n', encoding="utf-8", newline="\n")
(legacy_dir / "broken_old.py").write_text(
    '"""坏的\n\n由工具工厂自动生成。\n"""\n\n'
    'def execute(:\n', encoding="utf-8", newline="\n")
moved = evolution.migrate_legacy(legacy_dir)
ok("迁移只搬工厂标记过的那份", moved == ["demo_old"], str(moved))
ok("迁移后能从新址装载", evolution.load_module("demo_old")[0] is not None)
ok("迁移把说明与参数一起带过去",
   evolution.read_manifest("demo_old")["description"] == "旧版演示工具"
   and [p["name"] for p in evolution.read_manifest("demo_old")["params"]] == ["word", "times"],
   json.dumps(evolution.read_manifest("demo_old"), ensure_ascii=False)[:200])
ok("迁移不会覆盖已有条目（重复启动不重搬）", evolution.migrate_legacy(legacy_dir) == [])
ok("迁移不碰没标记的文件与语法不过的旧产物",
   not (evolution.EVOLVED_DIR / "plain_file.py").exists()
   and not (evolution.EVOLVED_DIR / "broken_old.py").exists())
ok("迁移不碰内置同名（那种自产文件搬过来也只是个死文件）",
   evolution.read_manifest("git_tool")["description"] == "自产的 git 包装",
   json.dumps(evolution.read_manifest("git_tool"), ensure_ascii=False)[:160])
ok("旧产物原文没有被删（只复制不剪切：不改程序自己的目录）",
   (legacy_dir / "demo_old.py").is_file())

# ── 9. 模型目录与盘上一致（catalog 是 list_items 的子集） ──────
items = evolution.list_items()
cat = evolution.catalog()
ok("模型目录里的每一条都在盘上", all(name in {i["name"] for i in items} for name in cat), str(cat))
ok("模型目录正好等于「启用 + 没坏 + 没被顶掉」那几条",
   sorted(cat) == sorted(i["name"] for i in items if evolution.usable(i)),
   f"catalog={sorted(cat)}")
ok("停用与坏掉的都不会出现在模型目录",
   not any(i["name"] in cat for i in items if not i["enabled"] or i["error"] or i["shadowed"]))

failed = [name for passed, name, _ in RESULTS if not passed]
for passed, name, detail in RESULTS:
    print(f"{'PASS' if passed else 'FAIL'}  {name}" + (f"  → {detail}" if not passed and detail else ""))
shutil.rmtree(TMP, ignore_errors=True)
print(f"\ncheck_evolution_store: {len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
if failed:
    print("失败：" + "、".join(failed))
sys.exit(1 if failed else 0)
