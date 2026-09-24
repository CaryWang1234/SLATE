# -*- coding: utf-8 -*-
"""终端外壳守卫：scripts/check_terminal_shell.py

模型反馈"命令被 PowerShell 吞掉"，实测有四类根因（修复前逐条录过证据）：多行块停在
交互式续行模式不执行、脏管道把常驻 shell 钉死后续命令一起没了、5.1 不认 && 却回
exit_code=0、以及 PowerShell 把自身错误流用 CLIXML 吐到重定向的 stderr（中文错误还乱码）。
修法是把 Windows 侧改成"一条命令一个 powershell 进程 + 命令主体从 stdin 送 + 状态由脚本
尾部回报"。这套结构里任何一环被"顺手简化"回去，症状都会重新出现，而走查只在 Windows 上
跑得动 —— 所以这里用纯函数 + 源码契约两条线，在任何平台都能把结构钉住。

盯的契约：
① &&/|| 翻译只在顶层、只在 5.1、只处理单行命令（here-string 里的 && 不能拆）；
② 命令主体绝不拼进 -EncodedCommand 的脚本文本（拼回去 = 解析错误重新变成 CLIXML）；
③ 外壳脚本自带 UTF-8 管道、进度静音、2>&1 合流、状态回报，且回报行不会漏进用户输出；
④ 一次性子进程的 stdin 写完就关、超时/取消杀整棵树、退出码要收割到；
⑤ 原生命令直连只认带参数的（裸 python 是 REPL，直连会挂到超时）；
⑥ 高危拦截仍按 && / || / ; / | 分段判；模型可见描述与实际语义同源。

运行：python scripts/check_terminal_shell.py
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.skills.terminal import (  # noqa: E402
    STATE_TRAILER_PREFIX, check_high_risk, is_windows_native_command,
    powershell_command_body, powershell_wrapper_script, translate_shell_chain,
    _powershell_argv, _split_top_level, _take_state_trailer,
)

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, detail))


def src(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


TERM = src("backend/skills/terminal.py")
WRAP = powershell_wrapper_script()
CHAIN = translate_shell_chain  # 显式传 ps7，守卫不依赖本机装没装 PowerShell
MULTI_AMP = "python setup.py\n&& Write-Output done"   # && 落在第二行：仍然不译

# ── 1. &&/|| 翻译：顶层才翻、5.1 才翻、多行不翻 ─────────────────
ok("顶层 && 译成 if ($?) 嵌套",
   "if ($?) {" in CHAIN("git add . && git commit -m x", ps7=False)
   and CHAIN("git add . && git commit -m x", ps7=False).count("if (") == 1)
ok("顶层 || 译成 if (-not $?)",
   "if (-not $?) {" in CHAIN("test-path a || mkdir a", ps7=False))
ok("三段串联按左结合嵌套",
   CHAIN("A && B || C", ps7=False).count("if (") == 2, CHAIN("A && B || C", ps7=False))
ok("PS7 原样返回（它自己认 &&）", CHAIN("A && B", ps7=True) == "A && B")
ok("没有串联时逐字不动", CHAIN("Get-ChildItem -Recurse", ps7=False) == "Get-ChildItem -Recurse")
ok("引号里的 && 不算运算符",
   CHAIN('Write-Output "a && b"', ps7=False) == 'Write-Output "a && b"')
ok("花括号里的 && 不在顶层，不拆",
   CHAIN("foreach ($i in 1..2) { A && B }", ps7=False).find("\nif (") < 0,
   CHAIN("foreach ($i in 1..2) { A && B }", ps7=False))
ok("多行命令不翻译（here-string 里的 && 认不出来，一律交回 shell）",
   CHAIN('$t = @"\nline && keep\n"@\nWrite-Output $t', ps7=False).find("if (") < 0)
ok("多行命令即使 && 在顶层也不改写（宁可 5.1 报错，不猜意图）",
   CHAIN("python setup.py && make\nWrite-Output done", ps7=False) == "python setup.py && make\nWrite-Output done")
ok("括号不闭合时宁可不译（拆了就没法还原）", _split_top_level("Write-Output \"a && b")[1] == [])
ok("未翻译结果仍原样送进主体", powershell_command_body("Get-Location").strip() == "Get-Location")

# ── 2. 命令主体与外壳脚本分离 ────────────────────────────────
ok("外壳里没有模型命令的插值位",
   "command" not in WRAP and "$__slateCode" in WRAP, WRAP[:120])
ok("主体从 stdin 读入并运行时解析",
   "[Console]::In.ReadToEnd()" in WRAP and "[ScriptBlock]::Create($__slateCode)" in WRAP)
ok("首 token 是引号路径时回退到调用运算符 & 再解析一次",
   "[ScriptBlock]::Create('& ' + $__slateCode)" in WRAP
   and 'Write-Output ("[PARSE_ERROR] " + $__slateParseErr)' in WRAP
   and "$__slateParseErr = $_.Exception.Message" in WRAP,
   "找不到 '& ' 回退链，或首个错误被第二次解析的错误顶掉")
ok("外壳经 -EncodedCommand 传入（不过任何 shell 解析）",
   _powershell_argv(WRAP)[1:5] == ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"],
   str(_powershell_argv(WRAP)[:6]))
ok("EncodedCommand 的载荷能解回同一份外壳脚本（UTF-16LE）",
   base64.b64decode(_powershell_argv(WRAP)[-1]).decode("utf-16-le") == WRAP)

ok("旧的『把命令拼进脚本』helper 已不存在", "_powershell_script(" not in TERM)
ok("外壳脚本每次一致（可缓存、不随命令变化）", powershell_wrapper_script() == WRAP)
ok("argv 只有一个调用点，且喂的是外壳脚本",
   TERM.count("_powershell_argv(") == 2 and TERM.count("_powershell_argv(powershell_wrapper_script())") == 1,
   str(TERM.count("_powershell_argv(")))

# ── 3. 输出通道：编码、进度、错误流、状态回报 ───────────────────
ok("管道三处编码全设 UTF-8",
   WRAP.count("System.Text.UTF8Encoding") >= 3 and "chcp.com 65001" in WRAP)
ok("进度记录静音（否则 stderr 全是 CLIXML 进度）",
   "$ProgressPreference = 'SilentlyContinue'" in WRAP)
ok("错误流并进成功流（自身错误不再走 CLIXML 通道）", "& $__slateSb 2>&1" in WRAP)
ok("子进程 stderr 不会被误判成命令失败",
   "NativeCommandError" in WRAP and "$__slateSt.errs" in WRAP)
ok("环境变量增量与 cwd 一起回报",
   "$__slateBase" in WRAP and "$__slateDiff" in WRAP and "Get-Location" in WRAP)
ok("回报行带固定前缀", STATE_TRAILER_PREFIX in WRAP and STATE_TRAILER_PREFIX == "__SLATE_STATE__")

STATE = {"cwd": "C:\\repo\\sub", "exit": 7, "env": {"SLATE_X": "1", "SLATE_GONE": None}}
B64 = base64.b64encode(json.dumps(STATE).encode("utf-8")).decode("ascii")
clean, parsed = _take_state_trailer(f"line1\n{STATE_TRAILER_PREFIX}{B64}\n")
ok("回报行从输出里摘干净", clean == "line1" and parsed.get("exit") == 7, clean)
glued, parsed2 = _take_state_trailer(f"tail-no-newline{STATE_TRAILER_PREFIX}{B64}")
ok("命令末尾没有换行也能摘出回报（cwd 不会悄悄退回）",
   glued == "tail-no-newline" and parsed2.get("cwd") == "C:\\repo\\sub", glued)
none_clean, none_state = _take_state_trailer("普通输出")
ok("没有回报行时原样返回", none_clean == "普通输出" and none_state == {})
bad_clean, bad_state = _take_state_trailer(f"x\n{STATE_TRAILER_PREFIX}@@@not-base64@@@\n")
ok("回报行坏了就放弃状态（退回进程退出码，不猜）",
   bad_clean == "x" and bad_state == {}, bad_clean)
ok("cd 要先确认目录存在（不存在的目录不得改成会话工作目录）",
   "if resolved.is_dir():\n                    self.cwd = resolved" in TERM)
ok("脚本没跑到尾部回报时不得谎报成功（退回进程退出码）",
   'if exit_code is None:\n                exit_code = run["returncode"]' in TERM)
ok("Windows 分派不再预先应用 cd（预先算会 double 成 backend\\backend）",
   "self._apply_cd(command)" in TERM and TERM.index("self._apply_cd(command)") > TERM.index("if sys.platform == \"win32\":\n            # Windows 一律一次性进程"))
ok("常驻 shell 只在 POSIX 路径启动",
   "if sys.platform == \"win32\":\n            return\n        if self.process and self.process.poll() is None:" in TERM)

# ── 4. 一次性子进程：stdin 关掉、超时杀树、退出码收割 ────────────
ok("给了主体才开 stdin 管道，否则 DEVNULL",
   "stdin=(subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL)" in TERM)
ok("写完主体立刻关 stdin（交互式程序拿 EOF 即退）", "proc.stdin.close()" in TERM)
ok("主体在独立线程写（大命令不会和读线程互堵）",
   "def feed() -> None:" in TERM and "threading.Thread(target=feed, daemon=True).start()" in TERM)
ok("超时/取消都杀整棵进程树", "_kill_process_tree(proc)" in TERM)
ok("杀完收割退出码（不 wait 时 returncode 还是 None，失败会被报成成功）",
   TERM.count("proc.wait(timeout=") >= 2,
   str(TERM.count("proc.wait(timeout=")))
ok("先杀树再收码（顺序反了就收不到被杀进程的码）",
   'if cancelled or timed_out:\n            _kill_process_tree(proc)' in TERM)
ok("Windows 读到进程结束才收工（不再有抢跑的完成标记）", "while proc.poll() is None:" in TERM)
ok("完成标记只剩 POSIX 常驻 shell 一个调用点", TERM.count("_command_with_marker(") == 2,
   str(TERM.count("_command_with_marker(")))

# ── 5. 原生命令直连判据 ─────────────────────────────────────
ok("带参数的原生命令走直连", is_windows_native_command("git status --short"))
ok("裸 python 不走直连（REPL 会挂到超时）", not is_windows_native_command("python"))
ok("裸 node 不走直连", not is_windows_native_command("node"))
ok("PowerShell 语句不走直连", not is_windows_native_command("Get-ChildItem | Select-Object -First 1"))
ok("多行命令不走直连", not is_windows_native_command("python a.py\ngit status"))
ok("未登记的程序名不走直连", not is_windows_native_command("some-tool --run"))
ok("带引号的程序名仍认得", is_windows_native_command('"python" -c "print(1)"'))

# ── 6. 高危拦截与模型可见描述 ───────────────────────────────
ok("串联里的高危段仍被分段判出", bool(check_high_risk("python install.py && Remove-Item -Recurse C:\\x")))
ok("普通命令不误判高危", check_high_risk("git status --short") == "", check_high_risk("git status --short"))
SKILLS = src("backend/routers/skills.py")
TOOLS = src("frontend/js/services/tools.js")
ok("后端工具目录描述了新的 Windows 语义",
   "每条命令一个 PowerShell 进程" in SKILLS and "持久化终端会话" not in SKILLS)
ok("前端 skill_run 描述与后端同源",
   TOOLS.count("每条命令一个 PowerShell 进程") == 1 and "cd/$env: 跨命令保持" in TOOLS)
ok("描述里点明交互式 REPL 不该用", "交互式 REPL" in TOOLS)

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\n终端外壳守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:200]}")
sys.exit(1 if failed else 0)
