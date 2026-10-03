# -*- coding: utf-8 -*-
"""单实例闸门守卫：scripts/check_desktop_instance.py

需求是"只能开一个 SLATE 窗口"：托盘常驻之后，再双击一次图标就是再起一个进程——
两个窗口、两份后端、同一个 SQLite 两个写者。闸门要在**清日志与起后端之前**判掉。

这一层最容易坏在五个地方，症状都不是"报错"而是"没生效"：
① try_acquire 的返回值没被活着的东西接住——局部变量一出作用域句柄就关，等于没装锁；
② CreateMutexW 之后用裸 GetLastError() 读错码——ctypes 在两次调用之间自己会调 API，
   读到的是别人的错码，"已有实例"被读成"没有"；
③ 唤回窗口只按标题找——装机版与源码态的标题都是「SLATE 砚」，会顶到另一份安装的头上去；
④ 用 OpenFileMappingW 读那块 pid 共享内存——这台 Windows 上它对同名对象回 ERROR_DENIED，
   教科书写法在这里就是读不到（实测），必须走 CreateFileMappingW 同名取回；
⑤ 闸门排在 open(LOG_PATH,'w') 之后——第二份已经清掉了主实例正在写的日志。

所以三条线一起钉：纯函数（跨平台）、内核对象冒烟（真建真抢真读 pid）、源码契约
（desktop.py 的接线顺序与模块自身的原生调用写法）。

运行：python scripts/check_desktop_instance.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 被人顺手塞进第三方依赖时，裸 import 会让守卫直接 traceback、一条判据都读不到。
# 先接住，再用一条具名判据报出来。
try:
    import desktop_instance  # noqa: E402
    LOAD_ERR = ""
except Exception as exc:
    desktop_instance = None
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


# ── 1. 纯函数：平台判定、对象命名、错码真值表 ─────────────────
ok("desktop_instance 只用标准库就导得进来（引第三方库会把整段判据炸成 traceback）",
   not LOAD_ERR, LOAD_ERR)

if desktop_instance is None:
    print("    · 模块导不进来：纯函数与冒烟段跳过（上一条已记红），源码契约仍要过")
else:
    ok("available() 与 sys.platform 一致",
       desktop_instance.available() == (sys.platform == "win32"), f"本机 {sys.platform}")

    a = desktop_instance.lock_name(r"C:\Program Files\SLATE")
    b = desktop_instance.lock_name("C:/Program Files/SLATE/")
    c = desktop_instance.lock_name(r"c:\program files\slate\\")
    ok("同一目录的写法差异（大小写／正斜杠／尾分隔符）派生同一把锁", a == b == c, f"{a} {b} {c}")
    ok("锁名保持 ASCII 且带 Local\\ 前缀（会话内可见，不串到别的登录会话）",
       a.startswith("Local\\SLATE-desktop-") and a.isascii(), a)
    ok("不同安装目录派生不同锁名（源码态与装机版各管各的）",
       desktop_instance.lock_name(r"C:\A\SLATE") != desktop_instance.lock_name(r"C:\B\SLATE"))
    ok("pid 块与锁同名根、不同对象（不是一把锁的别名）",
       desktop_instance.pid_name(r"C:\A\SLATE") != desktop_instance.lock_name(r"C:\A\SLATE")
       and desktop_instance.pid_name(r"C:\A\SLATE").startswith("Local\\SLATE-desktop-pid-"))
    ok("空目录参数不炸（退到当前目录派生）",
       desktop_instance.lock_name("").startswith("Local\\SLATE-desktop-"))

    ok("错码真值表：183 才是『已有人在跑』",
       desktop_instance.already_running(183) is True
       and desktop_instance.already_running(0) is False
       and desktop_instance.already_running(5) is False)

    # ── 2. 内核对象冒烟：真抢、真读、真放 ────────────────────
    if desktop_instance.available():
        with tempfile.TemporaryDirectory() as tmp:
            held = desktop_instance.try_acquire(tmp)
            ok("第一次 try_acquire 拿到锁", held is not None and held.held)
            ok("抢锁的进程把 pid 写进了共享内存（跨进程读得回来）",
               desktop_instance.read_pid(desktop_instance.pid_name(tmp)) == os.getpid(),
               f"读回 {desktop_instance.read_pid(desktop_instance.pid_name(tmp))} 期望 {os.getpid()}")
            second = desktop_instance.try_acquire(tmp)
            ok("第二次 try_acquire 判定『已有实例』（返回 None，不是抛异常）", second is None)
            if held is not None:
                held.release()
            again = desktop_instance.try_acquire(tmp)
            ok("release() 之后能重新拿到（不留死锁）", again is not None)
            if again is not None:
                again.release()
            ok("release() 幂等（再调一次不炸）",
               (again is not None and (again.release(), True)[1]) is True)
            ok("锁对象丢了引用也不会解锁：没有 __del__ 那条暗路（见第 4 段源码契约）",
               not hasattr(desktop_instance.InstanceLock, "__del__"))
    else:
        print("    · 非 Windows：内核对象冒烟跳过（源码契约仍要过）")

# ── 3. 接线契约：desktop.py 的闸门必须排在破坏性动作之前 ─────
DESK = src("desktop.py")
ok("顶层 import desktop_instance（PyInstaller 才跟得到这个模块）",
   "\nimport desktop_instance\n" in DESK)
ok("窗口标题提成常量（守卫、走查、handoff 三处共用同一个串）",
   "WINDOW_TITLE = 'SLATE 砚'" in DESK and DESK.count("title=WINDOW_TITLE") == 2)
ok("handoff 传的是安装目录（不传就只能按标题猜，会顶到另一份安装）",
   "handoff(WINDOW_TITLE, BASE_DIR)" in DESK)
ok("唤没唤回窗口如实回话（不许双击完像什么都没发生）",
   "surfaced = desktop_instance.handoff(" in DESK and "已在运行" in DESK)

MAIN = between(DESK, "def main():", "\nif __name__")
ok("锁交给活着的全局格子（局部变量一出作用域就是没装锁）",
   "global _instance_lock" in MAIN and "_instance_lock = desktop_instance.try_acquire(BASE_DIR)" in MAIN)
GATE_AT = MAIN.find("_instance_lock = desktop_instance.try_acquire(BASE_DIR)")
ok("闸门排在清空 desktop_backend.log 之前",
   0 <= GATE_AT < MAIN.find("open(LOG_PATH"), MAIN[:200])
BACKEND_ATS = [i for i in (MAIN.find("start_uvicorn(port)"), MAIN.find("start_embedded_uvicorn(port)")) if i >= 0]
ok("闸门排在起后端之前（晚一步就多出第二个 SQLite 写者）",
   BACKEND_ATS and 0 <= GATE_AT < min(BACKEND_ATS), f"闸门 @{GATE_AT} 起后端 @{BACKEND_ATS[:2]}")
GATE_BRANCH = between(MAIN, "if _instance_lock is None:", "# 1. 启动 uvicorn")
ok("判定已有实例那条路先交棒再 return（不 return 就是继续往下起服务）",
   0 <= GATE_BRANCH.find("surfaced =") < GATE_BRANCH.find("return"), GATE_BRANCH[:260])
ok("后端起不来那张失败页把异常文本转义过（不转义＝最重要的那句原因被当标签吞掉）",
   "from html import escape as html_escape" in DESK and "{html_escape(str(error))}" in DESK,
   "异常里带 < 时整页 HTML 结构会被吃掉，用户看到的是半截空白窗")

# ── 4. 闸门模块自身的原生调用契约 ────────────────────────────
INST = src("desktop_instance.py")
ok("闸门模块只用 ctypes（引 pystray/pywin32 会把桌面外壳拖重）",
   not [ln for ln in INST.splitlines()
        if ln.startswith(("import ", "from ")) and any(
            d in ln for d in ("pystray", "PIL", "win32gui", "win32api", "pythoncom", "wx"))])
ok("CreateMutexW 走 use_last_error=True 的实例（裸 windll + GetLastError 会读到别人的错码）",
   'WinDLL("kernel32", use_last_error=True)' in INST and "ctypes.get_last_error()" in INST)
ok("kernel32 只在导入时装载一次（__del__ 里再 WinDLL 会撞上解释器卸载模块）",
   INST.count("ctypes.WinDLL(") == 1 and "_K32 = _make_kernel32()" in INST)
ok("InstanceLock 不写 __del__（有它就把『返回值没接住』变成一次静默解锁）",
   "def __del__" not in INST)
ok("CreateFileMappingW 设了 restype=HANDLE（默认按 c_int 会把 64 位句柄砍断）",
   "k.CreateFileMappingW.restype = wintypes.HANDLE" in INST)
ok("pid 用 CreateFileMappingW 同名取回，不调 OpenFileMappingW（这台机器上后者一律 ERROR_ACCESS_DENIED）",
   ".OpenFileMappingW(" not in INST and INST.count("k.CreateFileMappingW(INVALID_HANDLE_VALUE") == 2)
ok("INVALID_HANDLE_VALUE 按指针宽度传（写成 -1 会被当 c_int）",
   "INVALID_HANDLE_VALUE = ctypes.c_void_p(-1)" in INST)
ok("read_pid 任何一步失败都回 0，不外溢异常",
   between(INST, "def read_pid(", "\n\nclass InstanceLock").count("except Exception") == 1)
ok("找窗口按持有者 pid 收窄（owner_pid == 0 才是兜底那条路）",
   "pid == owner_pid" in INST and "owner_pid == 0" in INST)
ok("只认没有 owner 的顶层窗口（模态框标题带正文，顶它是把对话框糊到用户脸上）",
   "not u.GetWindow(hwnd, GW_OWNER)" in INST)
ok("EnumWindows 的回调在枚举期间持有引用（只留局部＝原生栈上崩）",
   "ref = cb_type(cb)" in INST and "u.EnumWindows(ref, 0)" in INST)
ok("surface 先看窗口还在不在，再以 IsWindowVisible 为判据（不读自述）",
   "if not u.IsWindow(hwnd):" in between(INST, "def surface(", "\n\ndef handoff(")
   and "if not u.IsWindowVisible(hwnd):" in between(INST, "def surface(", "\n\ndef handoff("))
HANDOFF = INST[INST.find("def handoff("):]  # 它是文件最后一个函数
ok("handoff 有界重试且真的等（找一次就退＝第一份还在开窗口时白退）",
   "deadline" in HANDOFF and "time.sleep(" in HANDOFF and "return False" in HANDOFF)
ok("非 Windows 上 handoff 直接 False（不许在没有内核对象的平台上空转）",
   "if not available():" in between(INST, "def handoff(", "\n    u = _user32()"))

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\n单实例闸门守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:200]}")
sys.exit(1 if failed else 0)
