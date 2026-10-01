/**
 * macOS 适配守卫：装机态数据目录、渲染器选择、更新包挑选、⌘ 快捷键、字体栈、Mac 打包清单。
 *
 * 这一轮的改动有个共同点：没有一条能在开发机（Windows）上"跑出来看看"。所以判据分成两类：
 *   ① 能被执行的那部分（纯函数、正则词表）交给 scripts/check_macos_platform.py，把 "darwin"
 *      当参数喂进去真跑一遍；
 *   ② 只能读源码的那部分（.app 里的落点、spec 的 hiddenimports、shell 脚本）在这里钉死写法。
 * 两类合起来守的是同一件事：**别为了 Mac 把 Windows 那条已经跑通的路改坏**，所以每张判据
 * 都同时钉两侧——数据目录既要 Mac 搬家，也要 Windows 一步不动。
 *
 * 顺带钉一处真会丢数据的：装机版 Mac 如果把 data/ 留在 .app 里，升级是整包覆盖，
 * API Key 和聊天记录会跟着下一次拖拽一起没了。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const PLAT = read("desktop_platform.py");
const DESK = read("desktop.py");
const UPD = read("backend/routers/update.py");
const TERM = read("backend/skills/terminal.py");
const RISK = read("frontend/js/services/riskguard.js");
const APP = read("frontend/js/app.js");
const CSS = read("frontend/css/style.css");
const DICT = read("frontend/js/services/i18n_dict.js");
const SPEC = read("SLATE_macos.spec");
const SH = read("build_macos.sh");
const RELEASE = read(".github/workflows/release.yml");

const problems = [];
const must = (cond, msg, detail = "") => { if (!cond) problems.push(`${msg}${detail ? ` → ${detail}` : ""}`); };

/** 取 Python 顶层函数体（这些文件里的函数都是顶格 def，下一个顶格 def/装饰器就是终点）。 */
function pyFn(src, name) {
  const at = src.search(new RegExp(`^def ${name}\\(`, "m"));
  if (at < 0) return "";
  const rest = src.slice(at + 1);
  const end = rest.search(/^def |^@|^class /m);
  return end < 0 ? src.slice(at) : src.slice(at + 1, at + 1 + end);
}

/** 取 Python 列表字面量那一段（词表逐条比对时按块比，不被同文件另一处的同名行借分）。 */
function pyList(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return "";
  const open = src.indexOf("[", at);
  const close = src.indexOf("\n]", open);
  return close < 0 ? src.slice(open) : src.slice(open, close + 2);
}

const PURE = pyFn(PLAT, "_pure");
const BUNDLE = pyFn(PLAT, "bundle_paths");
const GUI = pyFn(PLAT, "webview_gui");
const PICK = pyFn(UPD, "pick_asset_url");
const DL = pyFn(UPD, "download_url_for");
const HIDDEN = pyList(SPEC, "hiddenimports =");
const EXCLUDES = pyList(SPEC, "excludes =");
const MAIN_FN = DESK.slice(DESK.indexOf("def main():"));
const KEYS = APP.slice(APP.indexOf("function initKeyboardShortcuts()"));

// ── ① 平台助手：路径语义按目标平台走 ────────────────────────
must(/PurePosixPath, PureWindowsPath/.test(PLAT) && /return PureWindowsPath if platform_name == WINDOWS else PurePosixPath/.test(PURE),
  "bundle_paths 用 os.path 拼路径（在 Windows 上验 Mac 分支会拼出反斜杠，判据读到的就不是 Mac 的约定）");
must(/MAC_APP_SUPPORT = \("Library", "Application Support", "SLATE"\)/.test(PLAT),
  "Mac 的每用户数据目录不再是 ~/Library/Application Support/SLATE（那是系统约定的位置，自己造一个就没人找得到）");
must(/if is_macos\(platform_name\) and frozen:/.test(BUNDLE),
  "Mac 改道不再只认装机态（源码态也会搬到用户目录，Mac 开发者会以为自己的改动没生效）");
must(/data = base \/ "data"/.test(BUNDLE),
  "非 Mac 与源码态不再把数据贴在程序目录（Windows 装机版的数据目录口径一变，README 和 RULES 都跟着漂）");
must(/log = data \/ "desktop_backend\.log"/.test(BUNDLE) && /log = base \/ "desktop_backend\.log"/.test(BUNDLE),
  "Mac 的日志不再跟着数据目录走（.app 里写不下日志，第一行 log() 就把启动炸掉）");
must(/"storage_path": str\(data \/ "webview_profile"\)/.test(BUNDLE),
  "storage_path 不再由数据目录派生（浏览器档案会落回 bundle 里）");
must(/return "edgechromium"/.test(GUI) && /return "cocoa"/.test(GUI) && /return None/.test(GUI),
  "webview_gui 的三个平台分支不再齐全（Mac 拿不到 cocoa 这个名字，Linux 会被钉上一个不存在的渲染器）");

// ── ② desktop.py 接线 ──────────────────────────────────────
must(DESK.includes("\nimport desktop_platform\n"),
  "desktop.py 没有顶层 import desktop_platform（PyInstaller 跟不到它，装机版一启动就 ImportError）");
must(/_PATHS = desktop_platform\.bundle_paths\(BASE_DIR, os\.path\.expanduser\('~'\), sys\.platform, FROZEN\)/.test(DESK),
  "三个路径不再由 bundle_paths 现算（写回 os.path.join(BASE_DIR, ...) 就等于把 Mac 那一支摘掉）");
must(!/LOG_PATH = os\.path\.join\(BASE_DIR/.test(DESK) && !/DATA_DIR = os\.path\.join\(BASE_DIR/.test(DESK),
  "desktop.py 里还留着硬拼接的 DATA_DIR/LOG_PATH（平台分支被绕过，装机版 Mac 又写进 .app）");
const MKDIR_AT = DESK.indexOf("os.makedirs(DATA_DIR, exist_ok=True)");
must(MKDIR_AT > 0 && MKDIR_AT < DESK.indexOf("def main():"),
  "DATA_DIR 不在 main() 之前建好（Mac 首启：目录还不存在就 open(LOG_PATH,'w')，FileNotFoundError 起不了窗）");
must(/os\.environ\['SLATE_DATA_DIR'\] = DATA_DIR/.test(DESK),
  "内嵌后端不再吃同一个 DATA_DIR（两边各算各的，Mac 装机版会分裂出两份数据目录）");
must(/gui=desktop_platform\.webview_gui\(sys\.platform\)/.test(DESK) && !/gui='edgechromium'/.test(DESK),
  "webview.start 的 gui 又是写死的 edgechromium（那是 Windows 专有的渲染器名）");
must(MAIN_FN.indexOf("_instance_lock = desktop_instance.try_acquire(BASE_DIR)") >= 0
  && MAIN_FN.indexOf("_instance_lock = desktop_instance.try_acquire(BASE_DIR)") < MAIN_FN.indexOf("open(LOG_PATH"),
  "单实例闸门不再排在清空日志之前（第二份会把主实例正在写的日志截断）");

// ── ③ 更新包按平台挑 ───────────────────────────────────────
must(/INSTALLER_EXT = \{"win32": "\.exe", "darwin": "\.dmg"\}/.test(UPD),
  "INSTALLER_EXT 不再是 win32=.exe / darwin=.dmg（Mac 用户会被指到 Windows 安装包）");
must(/DOWNLOAD_URL = "https:\/\/github\.com\/\{repo\}\/releases\/download\/\{tag\}\/SLATE-Setup-\{ver\}\{ext\}"/.test(UPD),
  "DOWNLOAD_URL 又硬编码了 .exe 结尾（拼出来的 Mac 直链指向一个不存在的文件）");
must(/if not ext:\s*\n\s*return ""/.test(PICK),
  "pick_asset_url 不再对空后缀返回空串（Linux 没有打包产物，也会被指到一个 .exe 上）");
must(/\.lower\(\)\.endswith\(ext\)/.test(PICK),
  "资产匹配不再按后缀收尾（只有 endswith 排得掉 SLATE-Setup-x.dmg.sha256 那种校验文件）");
must(DL.indexOf("asset_url") >= 0 && DL.indexOf("asset_url") < DL.indexOf("DOWNLOAD_URL.format")
  && DL.indexOf("DOWNLOAD_URL.format") < DL.indexOf("RELEASE_PAGE.format"),
  "download_url_for 的三级出口顺序变了（资产直链 → 按命名拼 → Release 页）");
must(/downloadUrl": download_url_for\(data\.get\("assets"\), REPO, tag, latest, sys\.platform\)/.test(UPD),
  "check_update 不再按当前平台挑下载链（读的是写死的那一份）");

// ── ④ 高危词表：前后端同步（RULES 7.5）─────────────────────
// 按源码里那串字面量比，不按"能跑的正则"比：文件里写的是 `\bdiskutil\s+...`，前面那个
// 反斜杠+b 会让 /\bdiskutil/ 这种"重打一遍正则"的写法永远匹配不上（b 是单词字符，边界不成立）。
const DISKUTIL = String.raw`diskutil\s+(erase|reformat|partitionDisk|secureErase)`;
const DISKUTIL_REASON = "抹掉/重分区磁盘卷（macOS diskutil）";
must(TERM.includes(DISKUTIL), "后端 terminal.py 没有 diskutil 抹盘的规则（Mac 上抹掉整块卷不会问人）");
must(RISK.includes(DISKUTIL), "前端 riskguard.js 没有同一条 diskutil 规则（前后端两份清单漂移了）");
must(TERM.includes(DISKUTIL_REASON) && RISK.includes(DISKUTIL_REASON),
  "diskutil 那条的触发理由两侧不一致（用户在弹窗里看到的规则名与后端拦的不是同一条）");
must(DICT.includes(`"${DISKUTIL_REASON}": `),
  "diskutil 的理由没进 i18n 词典（英文界面里会漏出一句中文）");
must(/BLOCKED_PREFIXES = \([^)]*"rm -rf ~"/.test(TERM),
  "灾难级前缀没收 rm -rf ~（Mac/Linux 上抹家目录就是换个写法绕过 rm -rf /）");

// ── ⑤ 前端：⌘ 快捷键与 Mac 字体栈 ─────────────────────────
must(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.defaultPrevented && e\.key === "n"\)/.test(KEYS),
  "新建对话不认 ⌘N（或者又抢在白板的 ⌘ 组合键前面办事）");
must(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.defaultPrevented && e\.key === "d"\)/.test(KEYS),
  "切主题不认 ⌘D（或者与白板的 ⌘D 复制卡片叠成一次按键两个动作）");
const FONT_MAIN = (CSS.match(/--font-main:([^;]+);/) || ["", ""])[1];
const FONT_CODE = (CSS.match(/--font-code:([^;]+);/) || ["", ""])[1];
must(FONT_MAIN.includes("PingFang SC") && FONT_MAIN.includes("Microsoft YaHei")
  && FONT_MAIN.indexOf("PingFang SC") < FONT_MAIN.indexOf("Microsoft YaHei"),
  "--font-main 里苹方没排在微软雅黑之前（Mac 上正文会掉到 sans-serif 兜底，字重层次没了）");
must(/-apple-system/.test(FONT_MAIN), "--font-main 不含 -apple-system（Mac 的拉丁字母不走系统字体，和窗口其他部分不一致）");
must(/SF Mono/.test(FONT_CODE) && /Menlo/.test(FONT_CODE) && FONT_CODE.trim().startsWith("Consolas"),
  "--font-code 缺 SF Mono/Menlo，或 Consolas 不再排第一（前者 Mac 落到 Courier New，后者动到 Windows 的既有观感）");
must(!/font-family:\s*Consolas,/.test(CSS),
  "style.css 里还有裸的 Consolas 字体栈（绕开 --font-code，Mac 上那两处不跟着换）");

// ── ⑥ Mac 打包清单 ────────────────────────────────────────
must(/"webview\.platforms\.cocoa"/.test(HIDDEN),
  "spec 没把 webview.platforms.cocoa 列进 hiddenimports（pywebview 到函数体里才 import 它，静态扫不到，打出来的 .app 一启动就报 PyObjC 装不上）");
for (const mod of ["AppKit", "Foundation", "WebKit", "objc", "PyObjCTools.AppHelper"]) {
  must(HIDDEN.includes(`"${mod}"`), `spec 的 hiddenimports 少了 ${mod}（cocoa.py 顶部真读的名字）`);
}
must(!HIDDEN.includes("pythonnet"), "spec 还在 hiddenimports 里点名 pythonnet（那是 Windows 后端的 .NET 互操作层）");
for (const mod of ["pythonnet", "clr", "clr_loader"]) {
  must(EXCLUDES.includes(`"${mod}"`), `spec 没把 ${mod} 放进 excludes（Windows 的互操作层会作为候选被拖进 Mac 包）`);
}
must(/upx=False/.test(SPEC) && !/upx=True/.test(SPEC),
  "spec 又开了 UPX（压缩会重写 Mach-O 段表，签名跟着失效，Gatekeeper 直接报「已损坏」）");
must(/"NSAppleEventsUsageDescription"/.test(SPEC) && /"NSAccessibilityUsageDescription"/.test(SPEC),
  "info_plist 没有权限用途说明（授权框只剩一句「SLATE 想控制这台电脑」，用户不知道是为谁开的）");
must(/"CFBundleVersion": app_build_version/.test(SPEC) && /app_build_version = app_version\.partition\("-"\)\[0\]/.test(SPEC),
  "CFBundleVersion 不再只放数字段（带 -rc1 的预发布串会让 LaunchServices 的升级比较失灵）");

must(!/check_command create-dmg/.test(SH),
  "build_macos.sh 用 check_command 卡可选依赖（缺 create-dmg 会在依赖检查那一步 exit 1，备好的 hdiutil 兜底分支一辈子走不到）");
must(/command -v create-dmg/.test(SH),
  "create-dmg 的可选性检查整个没了（下面那条 if 分支需要的是探测，不是必选）");
must(!/cd \.\.\/\.\./.test(SH),
  "build_macos.sh 里还有 cd ../..（从 <repo>/dist 退到仓库上一层，之后所有相对路径都不在仓库里）");
must(/DMG_FILENAME="SLATE-Setup-\$\{VERSION\}\.dmg"/.test(SH),
  "DMG 命名规则变了而 update.py 的模板还写着 SLATE-Setup-{ver}.dmg（取不到资产直链时，Mac 用户点的是一条 404）");
must(/dist\/SLATE-Setup-\*\.dmg/.test(RELEASE)
  && /artifacts\/SLATE-macOS-\$\{\{ steps\.version\.outputs\.version \}\}\/\*\.dmg/.test(RELEASE),
  "release 工作流不再把 .dmg 交出去（构建产物进不了 Release，后端按 .dmg 挑资产只能回退到拼出来的直链，那条链没人验证过）");

if (problems.length) {
  console.error(`✗ check_macos_desktop：${problems.length} 项不合`);
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}
console.log("✓ check_macos_desktop：装机数据目录/渲染器/更新包挑选/diskutil 词表/⌘ 快捷键/字体栈/Mac 打包清单 一致");
