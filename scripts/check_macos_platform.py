"""macOS 适配的执行层守卫：把平台字符串当参数喂进去，在 Windows 上真跑一遍 Mac 那条分支。

scripts/check_macos_desktop.mjs 钉的是写法（读源码），这一支钉的是**结果**：
① desktop_platform.bundle_paths 在 darwin/win32/linux × 装机/源码 六种组合下的落点；
② backend/routers/update.py 的装机包挑选（同一份 Release 资产清单，Mac 拿 .dmg、
   Windows 拿 .exe、Linux 谁都不许拿）；
③ terminal 的高危判定真的认得 diskutil 抹盘，而且不顺手误杀 `diskutil list`；
④ 前后端两份高危清单的条数与包含关系（RULES 7.5：新增规则不许只改一侧）。

运行：python scripts/check_macos_platform.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 守卫不该因为第三方依赖出问题时变成一条 traceback（那样一句判据都读不到）。
try:
    import desktop_platform
    LOAD_ERR = ""
except Exception as exc:  # noqa: BLE001
    desktop_platform = None
    LOAD_ERR = repr(exc)

try:
    from backend.routers import update as update_router
except Exception as exc:  # noqa: BLE001
    update_router = None
    LOAD_ERR = LOAD_ERR or repr(exc)

try:
    from backend.skills import terminal as terminal_skill
except Exception as exc:  # noqa: BLE001
    terminal_skill = None
    LOAD_ERR = LOAD_ERR or repr(exc)

RESULTS: list[tuple[bool, str, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((bool(passed), name, detail))


def src(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


BUNDLE_BASE = "/Applications/SLATE 砚.app/Contents/MacOS"
WIN_BASE = r"C:\Program Files\SLATE"
MAC_HOME = "/Users/cary"

ok("三个被测模块都导得进来（导不进来后面的判据全是空的）",
   desktop_platform is not None and update_router is not None and terminal_skill is not None,
   LOAD_ERR)

# ── 1. 数据目录：Mac 装机搬家，其余一步不动 ──────────────────
if desktop_platform is not None:
    mac = desktop_platform.bundle_paths(BUNDLE_BASE, MAC_HOME, "darwin", True)
    ok("Mac 装机版的数据目录落在 ~/Library/Application Support/SLATE",
       mac["data_dir"] == f"{MAC_HOME}/Library/Application Support/SLATE", mac["data_dir"])
    ok("Mac 装机版的日志不再留在 .app 里（那里普通用户写不进，日志一开就抛）",
       BUNDLE_BASE not in mac["log_path"] and mac["log_path"].endswith("/SLATE/desktop_backend.log"),
       mac["log_path"])
    ok("Mac 装机版的浏览器档案也在用户目录（.app 里那份会被升级覆盖）",
       BUNDLE_BASE not in mac["storage_path"] and mac["storage_path"].endswith("/SLATE/webview_profile"),
       mac["storage_path"])

    mac_src = desktop_platform.bundle_paths("/Users/cary/codes/SLATE", MAC_HOME, "darwin", False)
    ok("Mac 源码态仍贴着仓库走（开发者看的就是 data/，搬到用户目录会让人以为改动没生效）",
       mac_src["data_dir"] == "/Users/cary/codes/SLATE/data", mac_src["data_dir"])

    win = desktop_platform.bundle_paths(WIN_BASE, r"C:\Users\cary", "win32", True)
    ok("Windows 装机版口径一步没动：数据在安装目录的 data/",
       win["data_dir"] == WIN_BASE + "\\data" and win["log_path"] == WIN_BASE + "\\desktop_backend.log",
       str(win))
    ok("Windows 装机版的 webview 档案也在安装目录的 data/ 下（README 与 RULES 都是这么写的）",
       win["storage_path"] == WIN_BASE + "\\data\\webview_profile", win["storage_path"])

    linux = desktop_platform.bundle_paths("/opt/slate", "/home/cary", "linux", True)
    ok("Linux 没有装机包，走源码态口径（不跟着 Mac 搬去用户目录）",
       linux["data_dir"] == "/opt/slate/data", linux["data_dir"])

    ok("路径按目标平台拼，不受本机分隔符影响（在 Windows 上验 Mac 拿到的是正斜杠，验 Windows 拿到的是反斜杠）",
       "/" in mac["data_dir"] and "\\" not in mac["data_dir"]
       and "/" not in win["data_dir"] and "\\" in win["data_dir"],
       f"mac={mac['data_dir']} win={win['data_dir']}")

    ok("webview 渲染器按平台挑：Mac=cocoa / Windows=edgechromium / 其余交给 pywebview 自选",
       desktop_platform.webview_gui("darwin") == "cocoa"
       and desktop_platform.webview_gui("win32") == "edgechromium"
       and desktop_platform.webview_gui("linux") is None,
       f"{desktop_platform.webview_gui('darwin')} / {desktop_platform.webview_gui('win32')} / {desktop_platform.webview_gui('linux')}")

# ── 2. 更新包挑选 ──────────────────────────────────────────
# 校验文件排在安装包**前面**：GitHub 的 assets 是上传顺序，sha256 紧跟在包后面，两种都可能先出现。
# 反过来若把 .dmg 摆在第一位，"名字里包含后缀"这种错法也能挑对，判据就成了没牙的（实测漏过一次）。
ASSETS = [
    {"name": "SLATE-Setup-0.5.0.dmg.sha256", "browser_download_url": "https://gh/d.sha256"},
    {"name": "SLATE-Setup-0.5.0.dmg", "browser_download_url": "https://gh/d.dmg"},
    {"name": "SLATE-Setup-0.5.0.exe.sha256", "browser_download_url": "https://gh/e.sha256"},
    {"name": "SLATE-Setup-0.5.0.exe", "browser_download_url": "https://gh/e.exe"},
]
if update_router is not None:
    ok("Mac 拿到 .dmg 而不是 .exe（旧实现写死 .exe，Mac 用户的「更新」会装上一个 Windows 包）",
       update_router.download_url_for(ASSETS, "R", "v0.5.0", "0.5.0", "darwin") == "https://gh/d.dmg",
       update_router.download_url_for(ASSETS, "R", "v0.5.0", "0.5.0", "darwin"))
    ok("Windows 仍拿 .exe（这一侧的既有行为不许被 Mac 的改动带跑）",
       update_router.download_url_for(ASSETS, "R", "v0.5.0", "0.5.0", "win32") == "https://gh/e.exe")
    ok("校验文件不会被当成安装包（.dmg.sha256 的名字里也带着 .dmg）",
       all(".sha256" not in update_router.pick_asset_url(ASSETS, ext)
           for ext in (".dmg", ".exe")))
    ok("Linux 谁都不许拿：没有打包产物时回落到 Release 页",
       update_router.download_url_for(ASSETS, "R", "v0.5.0", "0.5.0", "linux") == "https://github.com/R/releases/tag/v0.5.0",
       update_router.download_url_for(ASSETS, "R", "v0.5.0", "0.5.0", "linux"))
    ok("资产清单里没有本机那一格式时按命名规则拼（拼出来的后缀跟着平台走）",
       update_router.download_url_for([], "R", "v0.5.0", "0.5.0", "darwin")
       == "https://github.com/R/releases/download/v0.5.0/SLATE-Setup-0.5.0.dmg",
       update_router.download_url_for([], "R", "v0.5.0", "0.5.0", "darwin"))
    ok("未知平台拼不出直链时不许留下空串（前端那颗「下载」按钮点了没反应）",
       update_router.download_url_for([], "R", "v0.5.0", "0.5.0", "sunos")
       == "https://github.com/R/releases/tag/v0.5.0")

# ── 3. 高危判定：diskutil 有牙，又不误杀 ─────────────────────
if terminal_skill is not None:
    reason = terminal_skill.check_high_risk("diskutil eraseDisk JHFS+ Data /dev/disk4")
    ok("diskutil 抹盘被判高危（不认它就得靠用户自己拦）",
       "diskutil" in reason, reason)
    ok("diskutil list 不误判（只读的状态查询也要问一次，用户很快就会开始无脑点批准）",
       terminal_skill.check_high_risk("diskutil list") == "",
       terminal_skill.check_high_risk("diskutil list"))
    ok("命令链里的那一段也被分段判出",
       terminal_skill.check_high_risk("mount && diskutil partitionDisk /dev/disk2 1 GPT") != "")
    ok("家目录抹除在灾难级前缀里（无条件硬拦，任何审批档都放不过去）",
       any(p == "rm -rf ~" for p in terminal_skill.BLOCKED_PREFIXES),
       str(terminal_skill.BLOCKED_PREFIXES))

# ── 4. 前后端两份高危清单同源（RULES 7.5）───────────────────
BE = src("backend/skills/terminal.py")
FE = src("frontend/js/services/riskguard.js")
be_body = BE[BE.index("HIGH_RISK_PATTERNS"):]
be_body = be_body[:be_body.index("\n]")]
fe_body = FE[FE.index("const HIGH_RISK_PATTERNS = ["):]
fe_body = fe_body[:fe_body.index("\n];")]
# 逐行抽，而且只抽"正则字面量本身"：Python 那条 `(re.compile(X), "理由")` 若把 flags 一起
# 抽走，`(.*?)` 会一路吞到 `", re.I` 才撞到 `),\s*"`——两侧比的就不是同一层东西了。
def py_rule(line: str):
    pat = re.search(r're\.compile\((r?"(?:[^"\\]|\\.)*")', line)
    reason = re.search(r',\s*"([^"]+)"\),?\s*$', line)
    return (pat.group(1), reason.group(1)) if pat and reason else None


def js_rule(line: str):
    m = re.search(r'\{ re: (/\S.*?/i{0,2}), reason: "(.*?)" \}', line)
    return (m.group(1), m.group(2)) if m else None


be_rules = [r for r in (py_rule(line) for line in be_body.splitlines()) if r]
fe_rules = [r for r in (js_rule(line) for line in fe_body.splitlines()) if r]
be_map = {reason: pattern for pattern, reason in be_rules}
fe_map = {reason: pattern for pattern, reason in fe_rules}


def _core(literal: str, kind: str) -> str:
    """只比正则本体，不比两门语言的写法：Python 是 r"..."，JS 是 /.../i。
    整串拿来直接比的话两侧永远不相等，这条判据就变成一张永远红或者永远绿的假牙。"""
    if kind == "py":
        return re.sub(r"^r?[\"']|[\"']$", "", literal)
    return re.sub(r"^/|/[a-z]*$", "", literal)


ok("高危判定的规则条数读得出来（读成 0 条说明这条判据本身空过了）",
   len(be_rules) >= 20 and len(fe_rules) >= 20, f"后端 {len(be_rules)} 条 / 前端 {len(fe_rules)} 条")
missing = [reason for reason in fe_map if reason not in be_map]
ok("前端每一条高危理由后端都有（前端拦得比后端松，等于批准后后端再拒绝一次）",
   not missing, f"后端缺：{missing}")
ok("Mac 那条 diskutil 规则两侧都在（只写一侧就是两份清单漂移）",
   "抹掉/重分区磁盘卷（macOS diskutil）" in be_map and "抹掉/重分区磁盘卷（macOS diskutil）" in fe_map)
drift = [reason for reason in fe_map
         if reason in be_map and _core(fe_map[reason], "js") != _core(be_map[reason], "py")]
ok("两侧同名的规则用的是同一条正则（弹窗说的规则和实际拦的对不上，用户就是在盲批）",
   not drift, f"漂移：{drift}")

failed = [name for passed, name, _ in RESULTS if not passed]
print(f"\nmacOS 适配执行层守卫：共 {len(RESULTS)} 项，失败 {len(failed)}"
      + ("".join(f"\n  x {n}" for n in failed) if failed else " —— 通过"))
for passed, name, detail in RESULTS:
    if not passed and detail:
        print(f"    · {name} → {detail[:200]}")
sys.exit(1 if failed else 0)
