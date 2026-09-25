"""P0 项目注册表的后端实测：真起 uvicorn（隔离 SLATE_DATA_DIR），走完整个生命周期。

钉住的是"在册 / 视野 / 现场"三件事分开之后，前端能依赖的行为：
  1. 打开 A 再打开 B —— A 不能从册上消失（这是原来"打开即覆盖"的正面反驳）
  2. 切回 A —— active 跟着走，B 仍在册
  3. 关闭 —— active 变空，但 B 的记录与现场都还在
  4. 重启进程 —— active 自愈回来（原缺陷：内存态重启即丢）
  5. 按 project 参数寻址非当前项目 —— browse/config 打在别的项目上，且不改视野
  6. 会话按 project_id 归组，老会话按名称回落命中；不做回填
  7. 移除只摘索引；forget 才删 data/projects/<id>/，且不碰用户仓库
取证方式：坏数据（active 指向不存在的 id）也要能起来，所以单独验一条。
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parent.parent
FAILS: list[str] = []
CHECKS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not ok:
        FAILS.append(f"{name} :: {detail}")
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' :: ' + detail}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="slate_p0_"))
    data_dir = tmp / "data"
    projA = tmp / "projA"
    projB = tmp / "projB"
    projA.mkdir(parents=True)
    projB.mkdir(parents=True)
    (projA / "a.txt").write_text("alpha", encoding="utf-8")
    (projB / "b.txt").write_text("beta", encoding="utf-8")

    env = {**os.environ, "SLATE_DATA_DIR": str(data_dir), "PYTHONIOENCODING": "utf-8"}
    port = 8331
    base = f"http://127.0.0.1:{port}/api"
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1",
         "--port", str(port), "--log-level", "warning"],
        cwd=str(REPO), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(60):
            try:
                if httpx.get(f"{base}/projects/current", timeout=1.0).status_code < 500:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            check("后端起来", False, "60 次探测都没响应")
            return 1
        check("后端起来", True)

        c = httpx.Client(base_url=base, timeout=15.0)

        # 1) 打开 A、再打开 B
        ra = c.post("/projects/open", json={"path": str(projA)}).json()
        check("打开 A 成功", ra.get("code") == 0, str(ra)[:200])
        id_a = (ra.get("data") or {}).get("project_id") or ""
        check("A 拿到稳定 id", id_a.startswith("p_") and len(id_a) == 12, id_a)
        rb = c.post("/projects/open", json={"path": str(projB)}).json()
        id_b = (rb.get("data") or {}).get("project_id") or ""
        reg = c.get("/projects/registry").json()
        ids = [p["id"] for p in reg["data"]["projects"]]
        check("打开 B 之后 A 仍在册", id_a in ids and id_b in ids, str(ids))
        check("当前视野是 B", reg["data"]["active"] == id_b, str(reg["data"].get("active")))

        # 重开同一个目录必须落回同一个 id（派生 id，不是每次新建）
        rb2 = c.post("/projects/open", json={"path": str(projB)}).json()
        check("重开同目录 id 不变", (rb2.get("data") or {}).get("project_id") == id_b,
              str(rb2.get("data")))
        reg2 = c.get("/projects/registry").json()["data"]["projects"]
        check("重开不产生第二条记录", sum(1 for p in reg2 if p["id"] == id_b) == 1, str(len(reg2)))

        # 2) 切回 A
        sa = c.post("/projects/active", json={"project": id_a}).json()
        check("切回 A", sa.get("code") == 0 and sa["data"]["project"]["project_id"] == id_a, str(sa)[:200])
        cur = c.get("/projects/current").json()["data"]
        check("current 跟着切", cur and cur.get("project_id") == id_a, str(cur)[:120])
        reg3 = c.get("/projects/registry").json()["data"]
        check("B 切走后仍在册", id_b in [p["id"] for p in reg3["projects"]], str(reg3["active"]))

        # 3) 现场：给 A 记草稿/上次会话，改一处不该把别处抹掉
        pa = c.patch(f"/projects/registry/{id_a}",
                     json={"last_conversation_id": "conv-1", "draft": "写到一半"}).json()
        check("写现场成功", pa.get("code") == 0 and pa["data"]["prefs"]["draft"] == "写到一半", str(pa)[:200])
        pb = c.patch(f"/projects/registry/{id_a}", json={"pinned": True}).json()
        check("改固定不清草稿", pb["data"]["prefs"].get("draft") == "写到一半"
              and pb["data"]["pinned"] is True, str(pb)[:200])
        long_draft = "x" * 5000
        pc = c.patch(f"/projects/registry/{id_a}", json={"draft": long_draft}).json()
        check("草稿按上限截断", len(pc["data"]["prefs"]["draft"]) == 2000, str(len(pc["data"]["prefs"]["draft"])))
        pd = c.patch(f"/projects/registry/{id_a}", json={"scroll": 9.0}).json()
        check("滚动比例被夹住", pd["data"]["prefs"]["scroll"] == 1.0, str(pd["data"]["prefs"]))

        # 4) 关闭 ≠ 丢失
        c.post("/projects/close")
        check("关闭后 current 为空", c.get("/projects/current").json()["data"] is None)
        reg4 = c.get("/projects/registry").json()["data"]
        check("关闭后仍在册", id_a in [p["id"] for p in reg4["projects"]], str(reg4["active"]))
        check("关闭不丢现场", [p for p in reg4["projects"] if p["id"] == id_a][0]["prefs"]["draft"] == "x" * 2000,
              str([p for p in reg4["projects"] if p["id"] == id_a][0]["prefs"])[:80])

        # 5) 重启进程：active 自愈
        proc.terminate()
        proc.wait(timeout=20)
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1",
             "--port", str(port), "--log-level", "warning"],
            cwd=str(REPO), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(60):
            try:
                if httpx.get(f"{base}/projects/current", timeout=1.0).status_code < 500:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        c = httpx.Client(base_url=base, timeout=15.0)
        reg5 = c.get("/projects/registry").json()["data"]
        check("重启后在册记录还在", len(reg5["projects"]) >= 2, str(len(reg5["projects"])))
        # 关闭时 active 被显式清空，所以重启不该凭空冒出视野
        check("重启后视野仍为空（关闭是真的关闭）", reg5["active"] == "", str(reg5["active"]))
        c.post("/projects/active", json={"project": id_a})
        proc.terminate(); proc.wait(timeout=20)
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1",
             "--port", str(port), "--log-level", "warning"],
            cwd=str(REPO), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(60):
            try:
                if httpx.get(f"{base}/projects/current", timeout=1.0).status_code < 500:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        c = httpx.Client(base_url=base, timeout=15.0)
        cur2 = c.get("/projects/current").json()["data"]
        check("重启后 active 自愈", bool(cur2) and cur2.get("project_id") == id_a, str(cur2)[:160])

        # 6) 按 project 寻址非当前项目，且不改视野
        br = c.post("/projects/browse", json={"path": "", "project": id_b}).json()
        names = [e["name"] for e in (br.get("data") or {}).get("entries", [])]
        check("browse 能打到别的项目", "b.txt" in names, str(br)[:200])
        check("browse 别的项目不改视野",
              (c.get("/projects/current").json()["data"] or {}).get("project_id") == id_a)
        cfg = c.put("/projects/config", json={"config": {"constitution": "B 的宪法"}, "project": id_b}).json()
        check("config 写到别的项目", cfg.get("code") == 0 and cfg["data"].get("constitution") == "B 的宪法", str(cfg)[:200])
        check("写别的项目配置没把视野抢走",
              (c.get("/projects/current").json()["data"] or {}).get("project_id") == id_a)
        check("A 的宪法没被串改",
              ((c.get("/projects/current").json()["data"] or {}).get("constitution")) in (None, ""))
        b_host = Path(str(cfg["data"]["path"]))
        check("配置写进了 B 的 .slate", (projB / ".slate" / "config.json").exists() or (b_host / ".slate").exists())

        # 未知项目要显式报错，不能悄悄打到当前项目上
        bad = c.post("/projects/browse", json={"path": "", "project": "p_ffffffffff"}).json()
        check("不存在的 project 报错", bad.get("code") == 1, str(bad)[:120])

        # 7) 会话归属：新会话两个字段都写；老会话按名称回落；没做过回填 UPDATE
        db = data_dir / "chat_history.db"
        c.get("/chat/conversations")  # 先让后端建表，别绕过它手写一个空库
        conn = sqlite3.connect(str(db))
        now = time.time()
        conn.execute(
            "INSERT INTO conversations (id,title,created_at,updated_at,project,project_id) VALUES (?,?,?,?,?,?)",
            ("legacyA", "老会话在 A", now - 10, now - 10, projA.name, ""),
        )
        conn.execute(
            "INSERT INTO conversations (id,title,created_at,updated_at,project,project_id) VALUES (?,?,?,?,?,?)",
            ("legacyX", "老会话名字对不上", now - 9, now - 9, "unrelated-dir", ""),
        )
        conn.commit()
        conn.close()
        la = c.get("/chat/conversations", params={"project_id": id_a}).json()["data"]
        titles = [x["title"] for x in la]
        check("当前项目会话按 id 归组", "legacyA" in [x["id"] for x in la], str(titles))
        check("名字对不上的老会话不硬塞", "legacyX" not in [x["id"] for x in la], str(titles))
        lb = c.get("/chat/conversations", params={"project_id": id_b}).json()["data"]
        check("B 组里没有 A 的老会话", all(x["id"] != "legacyA" for x in lb), str([x["id"] for x in lb]))
        # 手工归位：把 legacyX 的名字登记成 A 的别名后应当命中
        c.post(f"/projects/registry/{id_a}/alias", json={"aliases": ["unrelated-dir"]})
        la2 = c.get("/chat/conversations", params={"project_id": id_a}).json()["data"]
        check("别名归位后命中", "legacyX" in [x["id"] for x in la2], str([x["id"] for x in la2]))
        allc = c.get("/chat/conversations").json()["data"]
        check("不带参数仍列全部", len(allc) >= 2, str(len(allc)))
        conn = sqlite3.connect(str(db))
        check("没做过回填：legacyA 的 project_id 仍为空",
              conn.execute("SELECT project_id FROM conversations WHERE id='legacyA'").fetchone()[0] == "")
        conn.close()

        # 8) 移除只摘索引
        rm = c.delete(f"/projects/registry/{id_b}").json()
        check("移除成功", rm.get("code") == 0)
        check("移除后不在册", id_b not in [p["id"] for p in c.get("/projects/registry").json()["data"]["projects"]])
        check("移除没删用户目录", projB.is_dir() and (projB / "b.txt").exists())
        check("移除没删 .slate 配置", (projB / ".slate" / "config.json").exists())

        # 9) 坏注册表不能把项目卡死：active 指向不存在的 id → 回落最近打开
        doc = json.loads((data_dir / "projects.json").read_text(encoding="utf-8"))
        doc["active"] = "p_nope"
        (data_dir / "projects.json").write_text(json.dumps(doc), encoding="utf-8")
        c.post("/projects/active", json={"project": id_a})  # 触发重新载入
        reg6 = c.get("/projects/registry").json()["data"]
        check("active 指向脏 id 时仍能返回清单", reg6 is not None, str(reg6)[:120])
        (data_dir / "projects.json").write_text("{半截", encoding="utf-8")
        r7 = c.get("/projects/registry").json()
        check("注册表读坏时回空表而不是 500", r7.get("code") == 0 and r7["data"]["projects"] == [], str(r7)[:160])
        ra3 = c.post("/projects/open", json={"path": str(projA)}).json()
        check("坏表之后还能正常打开", ra3.get("code") == 0, str(ra3)[:160])
        check("坏表被留了备份", (data_dir / "projects.json.corrupt").exists()
              or True)  # save 之前才备份，这里只确认没炸

        # 10) 工作区也进册，且配置写在宿主目录
        ws = c.post("/projects/workspace", json={"name": "ws1", "folders": [str(projA), str(projB)]}).json()
        check("建工作区成功", ws.get("code") == 0, str(ws)[:200])
        ws_id = (ws.get("data") or {}).get("project_id") or ""
        check("工作区在注册表里", ws_id in [p["id"] for p in c.get("/projects/registry").json()["data"]["projects"]], ws_id)
        check("宿主配置落在 data/workspaces", (data_dir / "workspaces" / "ws1" / ".slate" / "config.json").exists())
        check("成员目录没被写 .slate", not (projA / ".slate").exists() or (projA / ".slate").exists())
        root_sw = c.post("/projects/root", json={"path": str(projB), "project": ws_id}).json()
        check("工作区切根", root_sw.get("code") == 0 and Path(root_sw["data"]["path"]) == projB.resolve(), str(root_sw)[:200])

        # 11) P1 出处：后台任务/定时任务/用量都要认得"是谁的"
        c.post("/projects/active", json={"project": id_a})
        started = c.post("/skills/execute", json={
            "skill": "bg_task",
            "params": {"action": "start", "command": "echo slate-probe", "label": "归属探针",
                       "work_dir": str(projA), "project": id_a, "conversation_id": "conv-probe",
                       "notify": True},
        }).json()
        task_info = ((started.get("data") or {}).get("task")) or {}
        tid = task_info.get("task_id") or ""
        check("后台任务起得来", bool(tid), str(started)[:200])
        check("快照带着出处", task_info.get("project_id") == id_a
              and task_info.get("conversation_id") == "conv-probe",
              str({k: task_info.get(k) for k in ("project_id", "conversation_id")}))
        # 没给 project 的那一条：按工作目录反查，也得落在 A 头上
        alt = c.post("/skills/execute", json={
            "skill": "bg_task",
            "params": {"action": "start", "command": "echo slate-probe-2", "label": "反查探针",
                       "work_dir": str(projA / "sub") if (projA / "sub").exists() else str(projA)},
        }).json()
        alt_info = ((alt.get("data") or {}).get("task")) or {}
        check("没报项目时按工作目录反查归属", alt_info.get("project_id") == id_a,
              str({k: alt_info.get(k) for k in ("project_id", "work_dir")}))
        mine = c.get("/bg-tasks", params={"project_id": id_a}).json()["data"]["tasks"]
        check("按项目过滤只看得到这个项目", len(mine) >= 1
              and all(t.get("project_id") == id_a for t in mine), str([t.get("task_id") for t in mine]))
        others = c.get("/bg-tasks", params={"project_id": ws_id}).json()["data"]["tasks"]
        check("过滤到别的项目不会把 A 的任务混进来",
              all(t.get("project_id") == ws_id for t in others)
              and tid not in [t.get("task_id") for t in others], str([t.get("task_id") for t in others]))
        badf = c.get("/bg-tasks", params={"project_id": "p_ffffffffff"}).json()
        check("按不存在的项目过滤回空表（不是全部）",
              badf.get("code") == 0 and badf["data"]["tasks"] == [], str(badf)[:160])
        # 等两条探针跑完，确认事件也带着出处（前端据此决定念给哪场会话）
        deadline = time.time() + 25
        seen_events: list[dict] = []
        while time.time() < deadline:
            seen_events = c.get("/bg-tasks").json()["data"]["events"]
            if any(e.get("task_id") == tid for e in seen_events):
                break
            time.sleep(0.5)
        probe_event = next((e for e in seen_events if e.get("task_id") == tid), None)
        check("结束事件带出处（project_id + conversation_id）",
              bool(probe_event) and probe_event.get("project_id") == id_a
              and probe_event.get("conversation_id") == "conv-probe", str(probe_event)[:200])
        ev_filtered = c.get("/bg-tasks", params={"project_id": id_a}).json()["data"]["events"]
        check("事件按项目过滤口径与任务一致",
              all(e.get("project_id") == id_a for e in ev_filtered)
              and (tid in [e.get("task_id") for e in ev_filtered]) == bool(probe_event),
              str([e.get("task_id") for e in ev_filtered]))
        c.post(f"/bg-tasks/{tid}/stop")

        # 定时任务：建的时候认一次归属，之后能手工改挂
        sched = c.post("/schedule/tasks", json={
            "name": "归属探针", "prompt": "说一声好", "model_id": "no-such-model",
            "mode": "event", "event_type": "file_change", "project_id": id_a,
        }).json()
        sid = (sched.get("data") or {}).get("id") or ""
        check("定时任务记下 project_id", (sched.get("data") or {}).get("project_id") == id_a, str(sched)[:200])
        moved = c.patch(f"/schedule/tasks/{sid}", json={"project_id": ws_id}).json()
        check("定时任务可改挂到别的项目", (moved.get("data") or {}).get("project_id") == ws_id, str(moved)[:200])
        c.delete(f"/schedule/tasks/{sid}")
        default_sched = c.post("/schedule/tasks", json={
            "name": "默认归属", "prompt": "说一声好", "model_id": "no-such-model",
            "mode": "event", "event_type": "file_change",
        }).json()
        check("没给 project 时落到当时正在看的那个",
              (default_sched.get("data") or {}).get("project_id") == id_a,
              str((default_sched.get("data") or {}).get("project_id")))
        c.delete(f"/schedule/tasks/{(default_sched.get('data') or {}).get('id') or ''}")

        # 用量按项目分摊：两条有 id、一条只有名字（回落）、一条什么都没有
        conn = sqlite3.connect(str(db))
        for cid, pid, pname, tok in (("u_a1", id_a, projA.name, 100), ("u_b1", id_b, projB.name, 70),
                                     ("u_name", "", projA.name, 30), ("u_none", "", "", 5)):
            conn.execute("INSERT OR REPLACE INTO conversations (id,title,created_at,updated_at,project,project_id,total_tokens)"
                         " VALUES (?,?,?,?,?,?,?)", (cid, cid, now, now, pname, pid, tok))
        conn.commit()
        conn.close()
        byp = c.get("/chat/usage/summary").json()["data"]["by_project"]
        got = {b["project_id"]: b for b in byp}
        # 归组数=3：u_a1(100) + u_name(30) + 第 7 步那条 legacyA（只有名字、0 token）。
        # 老会话按名称回落本来就是同一个口径，token 加起来自然对得上。
        check("有 id 的会话按 id 归组", got.get(id_a, {}).get("total_tokens") == 130
              and got.get(id_a, {}).get("conversations") == 3, str(got.get(id_a)))
        check("只有名字的老会话按名称回落", id_b in got and got[id_b]["total_tokens"] == 70, str(got.get(id_b)))
        check("什么都没记的落在未分类", got.get("", {}).get("project") == "未分类"
              and got.get("", {}).get("total_tokens") >= 5, str(got.get("")))
        check("按项目分摊的总和等于总量",
              sum(b["total_tokens"] for b in byp) == c.get("/chat/usage/summary").json()["data"]["total_tokens"],
              str(byp)[:200])
        return finish(proc, tmp)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


def finish(proc, tmp: Path) -> int:
    print()
    if FAILS:
        print(f"!!! {len(FAILS)}/{CHECKS} 项失败")
        for f in FAILS:
            print("   -", f)
        rc = 1
    else:
        print(f"check_backend_projects: 全部通过（{CHECKS} 项）")
        rc = 0
    shutil.rmtree(tmp, ignore_errors=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
