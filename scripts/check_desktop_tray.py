# -*- coding: utf-8 -*-
"""系统托盘守卫：scripts/check_desktop_tray.py

需求是"关掉窗口别停机"：点 X 之后应用缩进系统通知区域继续跑，双击/右键菜单能找回窗口，
退出只能走托盘菜单。桌面外壳先只做 Windows。

这条链路最容易坏在四个地方，而且症状都不是"报错"而是"用不起来"：
① 关窗分支判错——托盘没起来还硬缩，用户看到的就是"窗口没了、进程还在、再也找不回来"；
   反过来"退出"若没先立 quitting 牌，destroy 会再被 closing 拦一次，永远退不掉；
② 原生调用把句柄按 32 位截了（x64 上没设 restype 的 HWND 会被砍），或 WNDPROC 闭包被
   GC 掉——前者图标时隐时现，后者直接闪退；
③ 退出时没摘图标，通知区域留一个按不动的死图标；
④ 打包后 .ico 不在包里（EXE 的 icon= 只画 exe 文件图标，不进 _internal），托盘退成通用图标。

所以这里三条线一起钉：纯函数（跨平台）、原生冒烟（真挂一个图标再摘掉）、源码契约
（desktop.py 的接线顺序与 spec 的 datas）。原生冒烟在"这个会话根本没有通知区域"时算跳过
（CI 的 headless session 就是这种），但跳过时仍要求 stop() 能把线程收干净。

运行：python scripts/check_desktop_tray.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 托盘模块被人顺手塞进第三方依赖（pystray/Pillow 这类）时，裸 import 会让守卫直接 traceback，
# 一条判据都读不到，看不出"违反了哪条契约"。先接住，再用一条具名判据报出来。
try:
    import desktop_tray  # noqa: E402
    LOAD_ERR = ""
except Exception as exc:
    desktop_tray = None
    LOAD_ERR = repr(exc)

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, detail))


def src(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def between(text: str, start: str, end: str, label: str = "") -> str:
    """截出一段函数体：整段比较顺序，别让判据被同文件另一处同名行借走。"""
    i = text.find(start)
    if i < 0:
        return f"<找不到 {label or start} 起点>"
    j = text.find(end, i + len(start))
    return text[i:] if j < 0 else text[i:j]


# ── 1. 纯函数：平台判定、文案、语言、关窗决策 ─────────────────
ok("desktop_tray 只用标准库就导得进来（引第三方库会把这一整段判据炸成 traceback）",
   not LOAD_ERR, LOAD_ERR)

if desktop_tray is None:
    print("    · 模块导不进来：纯函数段跳过（上一条已记红），源码契约两段仍要过")
else:
    ok("available() 与 sys.platform 一致",
       desktop_tray.available() == (sys.platform == "win32"), f"本机 {sys.platform}")
    for lang in ("zh", "en"):
        lab = desktop_tray.labels(lang)
        ok(f"labels({lang}) 五把键齐全",
           set(lab) == {"tooltip", "show", "quit", "hint_title", "hint_text"}, str(sorted(lab)))
    ok("中英文案不是同一串",
       desktop_tray.labels("zh")["quit"] != desktop_tray.labels("en")["quit"])
    ok("labels() 返回副本（调用方改不动全局文案）",
       (lambda d: (d.update({"quit": "X"}), desktop_tray.labels("zh")["quit"] != "X"))(
           desktop_tray.labels("zh"))[1])
    ok("未知语言回落中文",
       desktop_tray.labels("fr")["show"] == desktop_tray.labels("zh")["show"])

    with tempfile.TemporaryDirectory() as tmp:
        ok("没有 language.txt 时按 zh", desktop_tray.read_lang(tmp) == "zh")
        (Path(tmp) / "language.txt").write_text("", encoding="utf-8")
        ok("空文件按 zh", desktop_tray.read_lang(tmp) == "zh")
        (Path(tmp) / "language.txt").write_text(" en \n", encoding="utf-8")
        ok("带空白的 en 认得", desktop_tray.read_lang(tmp).strip().lower() == "en")
        ok("read_lang 的结果能直接喂给 labels",
           desktop_tray.labels(desktop_tray.read_lang(tmp))["quit"] == "Quit SLATE")

    ok("关窗决策真值表：quitting 一律 exit",
       desktop_tray.close_action(True, True) == "exit"
       and desktop_tray.close_action(True, False) == "exit")
    ok("关窗决策真值表：托盘没起来必须 exit（否则窗口关不掉）",
       desktop_tray.close_action(False, False) == "exit")
    ok("关窗决策真值表：托盘在位才缩进托盘", desktop_tray.close_action(False, True) == "hide")

# ── 2. 原生冒烟：真挂一个图标，再摘干净 ──────────────────────
# SLATE_GUARD_SKIP_NATIVE=1 只跳过"往通知区域挂图标"这一段（变异 harness 会连跑二十次守卫，
# 每次都闪一个图标没意义）。纯函数与源码契约两条线不受这个开关影响。
if desktop_tray is None:
    pass  # 上一条判据已记红
elif desktop_tray.available() and os.environ.get("SLATE_GUARD_SKIP_NATIVE") == "1":
    print("    · 按开关跳过原生冒烟（SLATE_GUARD_SKIP_NATIVE=1）")
elif desktop_tray.available():
    shown: list[int] = []
    tray = desktop_tray.Tray(icon_path=None, on_show=lambda: shown.append(1),
                             on_quit=lambda: shown.append(0))
    started = False
    err = ""
    try:
        started = tray.start(timeout=8.0)
    except Exception as exc:  # 起托盘炸了就是缺陷，不许当成"这个会话没通知区域"
        err = repr(exc)
    ok("start() 不抛异常", not err, err)
    # 只有"Shell 拒了 NIM_ADD"才可能是这个会话根本没有通知区域（CI headless 就是这样）；
    # 其它失败原因（注册类、建窗口、加载库）都是我们自己的缺陷，不许混进"跳过"里
    ok("起不来的原因只可能是通知区域本身（不是我们调用错）",
       tray.added() or "NIM_ADD" in tray.fail_reason,
       tray.fail_reason or "无原因且未挂载")
    if tray.added():
        ok("图标已挂上时消息循环线程活着", tray.loop_alive())
        ok("托盘菜单两项 + 一条分隔线", tray.menu_items == 3, f"实测 {tray.menu_items}")
        ok("气泡提示调用不炸", tray.hint() is True)
        ok("同一实例二次 start() 不再挂第二个图标", tray.start() is False)
    else:
        print(f"    · 原生挂载跳过：{tray.fail_reason[:120]}")
    tray.stop()
    ok("stop() 之后消息循环线程已退出", not tray.loop_alive())
    if tray.added():
        ok("退出时把图标从通知区域摘掉", tray.delete_called)
    ok("stop() 幂等（再调一次不炸）", (tray.stop(), True)[1])
else:
    print("    · 非 Windows：原生冒烟跳过（源码契约仍要过）")

# ── 3. 接线契约：desktop.py ──────────────────────────────────
DESK = src("desktop.py")
ok("顶层 import desktop_tray（PyInstaller 才跟得到这个模块）",
   "\nimport desktop_tray\n" in DESK)
ok("图标路径会看 sys._MEIPASS（打包后 .ico 在 _internal 根）",
   "_MEIPASS" in DESK and "app.ico" in DESK)
ok("只有 Windows 才建托盘", "desktop_tray.available()" in DESK)
ok("托盘起不来时明说并退回老行为",
   "tray unavailable" in DESK and "handle.tray = tray" in DESK)

CLOSING = between(DESK, "def on_closing(self):", "\n    def shutdown")
ok("关窗分支交给 close_action 判（不自己写条件）", "close_action(" in CLOSING)
ok("该退的那条路不返回 False（返回 False＝取消关闭＝关不掉）",
   "== 'exit'" in CLOSING and "return True" in CLOSING.split("window.hide()")[0])
ok("缩托盘那条路先 hide 再返回 False",
   "window.hide()" in CLOSING and CLOSING.rstrip().endswith("return False"))
ok("hide 真失败时放行关闭（不许把窗口卡成找不回来）",
   "return True  # 藏不起来" in CLOSING)
ok("气泡只在第一次缩起来时弹（hint 必须被 hinted 闸门挡在后面）",
   0 <= CLOSING.find("not self.hinted.is_set()") < CLOSING.find("tray.hint()"), CLOSING[:220])
ok("tray_ready 读的是 added()（不是 start() 的返回值）",
   "self.tray.added()" in CLOSING and "self.quitting.is_set()" in CLOSING)

QUIT = between(DESK, "def request_quit(self):", "\n    def on_closing")
ok("退出先立 quitting 牌再 destroy（反了就是永远退不掉）",
   0 <= QUIT.find("quitting.set()") < QUIT.find("window.destroy()"), QUIT[:200])
SHOW = between(DESK, "def show(self):", "\n    def request_quit")
ok("恢复窗口同时 restore（最小化过只 Show 会留在任务栏下面）",
   0 <= SHOW.find("window.show()") < SHOW.find("window.restore()"), SHOW[:200])
ok("托盘回调里的异常不外溢（两条回调各包一次）",
   SHOW.count("except Exception") == 1 and QUIT.count("except Exception") == 1)

ok("closing 处理器真的挂上了", "events.closing += handle.on_closing" in DESK)
AFTER = DESK[DESK.find("webview.start("):]
ok("事件循环返回后先摘托盘再停后端",
   0 <= AFTER.find("tray_handle.shutdown()") < AFTER.find("stop_process(uvicorn_process)"),
   AFTER[:300])
ok("shutdown 把 tray 引用一起清掉（别留个已摘图标的空壳）",
   between(DESK, "def shutdown(self):", "\n\n\ndef attach_tray").count("self.tray = None") == 1)

# ── 4. 托盘模块自身的原生调用契约 + 打包 ─────────────────────
TRAY = src("desktop_tray.py")
SPEC = src("SLATE.spec")
DATAS = SPEC[SPEC.find("datas = ["):SPEC.find("] + _clr_data")]
ok("SLATE.spec 的 datas 带 app.ico", "('app.ico', '.')" in DATAS, DATAS[:200])
ok("图标注释写明 icon= 只画 exe 图标（别被误删）", "只画 exe" in DATAS)
ok("托盘不引第三方依赖（requirements.txt 里不许出现托盘库/Win32 绑定）",
   not [d for d in ("pystray", "pypiwin32", "pywin32", "wxPython", "plyer")
        if d.lower() in src("requirements.txt").lower()],
   "requirements.txt 出现了托盘依赖")
ok("托盘模块自身只用 ctypes（引了第三方库会让守卫 import 就崩，等于自毁）",
   not [ln for ln in TRAY.splitlines()
        if ln.startswith(("import ", "from ")) and any(
            d in ln for d in ("pystray", "PIL", "win32gui", "win32api", "wx"))])
ok("GetModuleHandleW 走 kernel32（user32 没这个导出，取错只会得到一个被吞掉的 AttributeError）",
   "self._kernel32.GetModuleHandleW" in TRAY and "user32.GetModuleHandleW" not in TRAY)
ok("起不来的每一步都留下原因（fail_reason 不许只是静默 False）",
   TRAY.count("self.fail_reason = ") >= 7 and 'self.fail_reason = ""' in TRAY,
   f"实测 {TRAY.count('self.fail_reason = ')} 处赋值（1 处初始化 + 6 处失败点）")
ok("窗口过程返回值用指针宽度的整数（3.14 的 wintypes 没有 LRESULT）",
   "wt.LRESULT" not in TRAY and "ct.WINFUNCTYPE(wt.LPARAM" in TRAY)
ok("x64 句柄不截断：CreateWindowExW 设了 restype",
   "u.CreateWindowExW.restype = wt.HWND" in TRAY)
ok("CreateWindowExW 设了 argtypes（不设的话 hInstance 会被当 c_int，64 位直接 OverflowError）",
   "u.CreateWindowExW.argtypes" in TRAY)
ok("GetModuleHandleW 设了 restype（拿回来的 HINSTANCE 要再传进 CreateWindowExW）",
   "k.GetModuleHandleW.restype = wt.HINSTANCE" in TRAY)
ok("WNDPROC 造出来就存到实例上（只留局部引用＝回调被 GC 掉就闪退）",
   "self._wndproc_ref = ct.WINFUNCTYPE(" in TRAY)
ok("NOTIFYICONDATA 的 cbSize 按结构体实际大小填", "nid.cbSize = ct.sizeof(NID)" in TRAY)
ok("TrackPopupMenu 后补一发 WM_NULL（否则点别处菜单不消失）",
   "u.PostMessageW(self._hwnd, WM_NULL, 0, 0)" in TRAY)

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\n系统托盘守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:200]}")
sys.exit(1 if failed else 0)
