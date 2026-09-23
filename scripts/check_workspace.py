# -*- coding: utf-8 -*-
"""工作区守卫：scripts/check_workspace.py

工作区 = 一种"宿主目录存配置、成员是若干彼此无关的文件夹"的项目。定下的口径是
任何时刻只有一个"当前根"，且 path 就等于它：文件、Git、终端工作目录全都沿用单根语义，
不另发明一套多根路径。这个口径一旦走偏（比如刷新时去开当前根而不是宿主目录），
工作区就会静默降级成普通单目录项目。所以这里既真跑路由，也钉住前端消费点。

盯的契约：
① 建/切/加/减都在真实文件系统上生效，成员去重、失效当前根能回落；
② 当前根换了，browse 读的就是新根；非成员目录切不进去，目录穿越仍被拦；
③ 配置只写宿主目录，成员仓库里不该多出 .slate；
④ 同名再建是补成员，不吃已有的宪法与当前根；
⑤ 单目录项目语义一字不变（kind=folder、roots 只有自己、不能切根）；
⑥ 前端把宿主目录当"重开地址"（刷新/持久化），成员切换与增删有入口。

运行：python scripts/check_workspace.py
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, detail))


def src(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def dd(res: dict) -> dict:
    """取 data 字段；路由报错时返回 {}，让判据逐项报红而不是整条守卫崩掉"""
    return res.get("data") or {}


def behavior_checks() -> None:
    """真跑路由：临时数据目录 + 临时成员文件夹，不碰仓库里的 data/"""
    import shutil

    tmp = Path(tempfile.mkdtemp(prefix="slate-ws-guard-"))
    os.environ["SLATE_DATA_DIR"] = str(tmp / "data")
    for mod in [m for m in sys.modules if m.startswith("backend")]:
        del sys.modules[mod]
    P = importlib.import_module("backend.routers.projects")
    call = asyncio.run

    a, b = tmp / "repo-a", tmp / "repo-b"
    for d in (a, b):
        (d / "src").mkdir(parents=True)
    c = tmp / "repo-c"
    c.mkdir()
    A, B = str(a.resolve()), str(b.resolve())

    res = call(P.create_workspace(P.CreateWorkspaceRequest(name="my app", folders=[A, B, A])))
    ok("建工作区返回 kind=workspace", res["code"] == 0 and dd(res)["kind"] == "workspace", res.get("message", ""))
    proj = dd(res)
    ok("成员去重后只剩两个", len(proj.get("roots") or []) == 2, str(proj.get("roots")))
    ok("当前根=第一个成员", proj.get("path") == A, str(proj.get("path")))
    ok("宿主落在 data/workspaces/<name>",
       proj.get("workspace_dir") == str(tmp / "data" / "workspaces" / "my app"), str(proj.get("workspace_dir")))
    ok("名称带路径分隔符被拒",
       call(P.create_workspace(P.CreateWorkspaceRequest(name="a/b", folders=[A])))["code"] == 1)
    ok("不存在的文件夹被拒",
       call(P.create_workspace(P.CreateWorkspaceRequest(name="ok", folders=[str(tmp / "nope")])))["code"] == 1)

    res = call(P.switch_project_root(P.SwitchRootRequest(path=B)))
    ok("切根后 path 就是新根", res["code"] == 0 and dd(res).get("path") == B, res.get("message", ""))
    listed = call(P.browse_files(P.BrowseRequest(path="")))
    ok("browse 读的是新根",
       listed["code"] == 0 and [e["name"] for e in (dd(listed).get("entries") or [])] == ["src"], str(listed))
    ok("非成员目录切不进去",
       call(P.switch_project_root(P.SwitchRootRequest(path=str(tmp))))["code"] == 1)
    ok("切根后目录穿越仍被拦", call(P.browse_files(P.BrowseRequest(path="../../etc")))["code"] == 1)

    add = P.edit_workspace_folders
    res = call(add(P.WorkspaceFoldersRequest(action="add", path=str(c))))
    ok("加成员成功且不换根",
       res["code"] == 0 and len(dd(res).get("roots") or []) == 3 and dd(res).get("path") == B, res.get("message", ""))
    res = call(add(P.WorkspaceFoldersRequest(action="remove", path=str(c))))
    ok("减非当前根的成员不换根",
       res["code"] == 0 and len(dd(res).get("roots") or []) == 2 and dd(res).get("path") == B, str(res))
    res = call(add(P.WorkspaceFoldersRequest(action="remove", path=B)))
    ok("减掉当前根后回落到首成员",
       res["code"] == 0 and dd(res).get("path") == A, str(res))
    ok("最后一个成员不让减",
       call(add(P.WorkspaceFoldersRequest(action="remove", path=A)))["code"] == 1)
    ok("未知操作被拒", call(add(P.WorkspaceFoldersRequest(action="drop", path=B)))["code"] == 1)

    cfg = dict(dd(res).get("config") or {})
    cfg["constitution"] = {"rules": ["别用 npm"]}
    res = call(P.update_project_config(P.UpdateConfigRequest(config=cfg)))
    ok("PUT /config 写到宿主目录",
       res["code"] == 0 and (Path(proj["workspace_dir"]) / ".slate" / "config.json").exists())
    ok("成员仓库里没被塞进 .slate", not (a / ".slate").exists() and not (b / ".slate").exists())

    res = call(P.create_workspace(P.CreateWorkspaceRequest(name="my app", folders=[B])))
    data = dd(res)
    ok("同名再建是补成员", res["code"] == 0 and len(data.get("roots") or []) == 2, str(data.get("roots")))
    ok("同名再建保住已有宪法", bool(data.get("config", {}).get("constitution")), str(data.get("config")))
    again = call(P.open_project(P.OpenProjectRequest(path=proj["workspace_dir"])))
    ok("重开宿主目录仍认得工作区", dd(again).get("kind") == "workspace", str(again))
    ok("当前根随配置还原", dd(again).get("path") == data.get("path"), f'{dd(again).get("path")} vs {data.get("path")}')

    # 成员目录被人删了：配置里记着的当前根必须回落，不能把 path 指到空气上
    ok("切到第二个成员并记下", call(P.switch_project_root(P.SwitchRootRequest(path=B)))["code"] == 0)
    shutil.rmtree(b)
    gone = call(P.switch_project_root(P.SwitchRootRequest(path=B)))
    ok("已删除的成员切不进去", gone["code"] == 1, str(gone))
    reopened = dd(call(P.open_project(P.OpenProjectRequest(path=proj["workspace_dir"]))))
    ok("成员目录被删后当前根自动回落", reopened.get("path") == A, str(reopened.get("path")))
    ok("失效成员不再出现在 roots 里", reopened.get("roots") == [A], str(reopened.get("roots")))

    single = dd(call(P.open_project(P.OpenProjectRequest(path=A))))
    ok("单目录项目 kind=folder", single.get("kind") == "folder", str(single))
    ok("单目录项目 roots 只有自己", single.get("roots") == [A], str(single.get("roots")))
    ok("单目录项目不带 workspace_dir", "workspace_dir" not in single)
    ok("单目录项目不能切根", call(P.switch_project_root(P.SwitchRootRequest(path=B)))["code"] == 1)
    call(P.close_project())
    ok("关项目后切根被拒", call(P.switch_project_root(P.SwitchRootRequest(path=B)))["code"] == 1)
    ok("宿主配置是合法 JSON",
       json.loads((Path(proj["workspace_dir"]) / ".slate" / "config.json").read_text(encoding="utf-8"))["kind"]
       == "workspace")


def static_checks() -> None:
    proj = src("backend/routers/projects.py")
    ok("路由挂了三件套",
       '@router.post("/root")' in proj and '@router.post("/workspace")' in proj
       and '@router.post("/workspace/folders")' in proj)
    ok("宿主目录固定在数据目录下", 'WORKSPACE_DIR = DATA_DIR / "workspaces"' in proj)
    ok("_project_info 交出 kind/roots", '"kind": "workspace" if is_workspace else "folder"' in proj)
    ok("失效当前根会回落", "roots[0] if roots else" in proj)
    ok("写 .slate 一律带 parents",
       ".mkdir(parents=True, exist_ok=True)" in proj and ".mkdir(exist_ok=True)" not in proj)

    store = src("frontend/js/store.js")
    ok("持久化记的是宿主目录", "state.project?.workspace_dir || state.project?.path" in store)
    bar = src("frontend/js/components/project_bar.js")
    ok("刷新重开的是宿主目录", "state.project.workspace_dir || state.project.path" in bar)
    ok("成员切换走 /projects/root", "await switchProjectRoot(rootPath)" in bar)
    ok("成员增删走 /projects/workspace/folders",
       'editWorkspaceFolders("add"' in bar and 'editWorkspaceFolders("remove"' in bar)
    ok("成员行只在 workspace 项目渲染",
       'proj.kind !== "workspace"' in bar and "renderWorkspaceRoots" in bar)
    ok("移除成员要先确认", "dlgConfirm(t(" in bar and "磁盘上的文件不会被删除" in bar)
    # 数组自带 .entries 方法：判空必须按类型判，否则关项目后 renderFileTree 会把函数当列表去遍历
    ok("文件树判空按类型", "Array.isArray(state.projectFileTree?.entries)" in bar
       and "Array.isArray(data?.entries)" in bar)
    api = src("frontend/js/services/project.js")
    exported = api.split("export {", 1)[-1] if "export {" in api else ""
    ok("服务层导出三个新接口",
       all(x in exported for x in ["createWorkspace", "switchProjectRoot", "editWorkspaceFolders"]), exported[:80])
    html = src("frontend/index.html")
    ok("弹窗里有新建工作区的输入",
       'id="workspace-name-input"' in html and 'id="workspace-folders-input"' in html
       and 'id="btn-create-workspace"' in html)
    tools = src("frontend/js/services/tools.js")
    ok("提示词告诉模型其他成员要绝对路径",
       "除当前根外还含" in tools and "{otherRoots.join" in tools and "绝对路径" in tools)
    css = src("frontend/css/style.css")
    ok("成员行有样式", ".workspace-roots" in css and ".workspace-root-chip.active" in css)
    dict_ = src("frontend/js/services/i18n_dict.js")
    for key in ["工作区", "新建工作区", "或新建工作区", "当前工作文件夹", "从工作区移除",
                "该目录不在工作区内", "工作区至少要留一个文件夹"]:
        ok(f"词条 {key}", f'"{key}":' in dict_)


behavior_checks()
static_checks()

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\n工作区守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:200]}")
sys.exit(1 if failed else 0)
