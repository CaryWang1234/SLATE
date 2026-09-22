"""按天 token 记账与历史估算的契约守卫：scripts/check_daily_usage.py

为什么需要它：热力图现在有两个口径，token 口径的数字来自「两套拼起来的数据」——
新账是真实增量（daily_usage 表），旧账是按对话累计 token 摊出来的估算。
两套数据一旦重叠，同一天会被算两遍；一旦断开，中间会凭空缺一块。
这两种错在界面上都只表现为「某个色块深一点/浅一点」，肉眼根本看不出来，
所以把边界钉在断言里。

顺带钉住记账那半边的两个易错点（源码扫描）：
① 增量必须由「本次 - 上次」算出来，前端发的是该对话的累计值；
② 只记正增量，负数会把当天的数字拉成负的。

用法：python scripts/check_daily_usage.py
"""

import re
import sys
from pathlib import Path

# Windows 控制台按 GBK 编码，中文断言信息直接 UnicodeEncodeError
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.routers.chat import estimate_daily_tokens  # noqa: E402

FAILS: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        FAILS.append(f"{name}\n  期望 {want!r}\n  实际 {got!r}")


def ok(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        FAILS.append(f"{name}{('：' + detail) if detail else ''}")


# ── 1. 有记账起点：只估算起点之前的天，起点当天的真实值归记账那半边 ──
# 分摊按「全部天」的比例：a 一共 10 条发言、1000 token → 每条 100
per_conv = {"a": {"2026-01-01": 1, "2026-01-02": 1, "2026-01-10": 8}}
tokens = {"a": 1000}
check(
    "起点之后的天不得进估算",
    estimate_daily_tokens(per_conv, tokens, "2025-12-01", "2026-01-10"),
    {"2026-01-01": 100, "2026-01-02": 100},
)

# ── 2. 没有起点（一条记账都没有）→ 整窗都按估算，含最新那天 ──
check(
    "无起点时整窗估算",
    estimate_daily_tokens(per_conv, tokens, "2025-12-01", None),
    {"2026-01-01": 100, "2026-01-02": 100, "2026-01-10": 800},
)

# ── 3. 窗口起点之前的发言不摊（不进画布的天不占比例）──
check(
    "窗口外的天不进估算",
    estimate_daily_tokens({"a": {"2025-01-01": 5, "2026-02-01": 5}}, {"a": 200}, "2025-12-01", None),
    {"2026-02-01": 100},
)

# ── 4. 多对话同日相加；没有 token 或没有发言的对话直接跳过 ──
mixed = {"a": {"2026-03-01": 1}, "b": {"2026-03-01": 1}, "c": {"2026-03-01": 1}, "d": {"2026-03-02": 4}}
mixed_tokens = {"a": 100, "b": 50, "c": 0, "d": 400}
check(
    "多对话同日相加、零 token 跳过",
    estimate_daily_tokens(mixed, mixed_tokens, "2026-01-01", None),
    {"2026-03-01": 150, "2026-03-02": 400},
)

# ── 5. 全空输入不能炸，也不能算出负数 ──
check("空输入得空结果", estimate_daily_tokens({}, {}, "2025-12-01", None), {})
check("窗口起点等于当天", estimate_daily_tokens(per_conv, tokens, "2026-01-02", "2026-01-10"),
      {"2026-01-02": 100})
for day, value in estimate_daily_tokens(per_conv, tokens, "2025-12-01", None).items():
    ok(f"{day} 的估算值不得为负", value >= 0, f"实际 {value}")

# ── 6. 源码侧：记账必须用增量，且只记正数 ──
src = (Path(__file__).resolve().parent.parent / "backend" / "routers" / "chat.py").read_text(encoding="utf-8")
ok("记账要拿本次减上次算增量", re.search(r"delta\s*=\s*total\s*-\s*prev_total", src) is not None)
ok("只记正增量", re.search(r"if\s+delta\s*>\s*0\s*:", src) is not None)
ok(
    "记账得 upsert 累加到当天",
    re.search(r"ON CONFLICT\(day\)\s+DO UPDATE SET tokens\s*=\s*tokens\s*\+\s*excluded\.tokens", src) is not None,
)
ok("daily_usage 表要建出来", re.search(r"CREATE TABLE IF NOT EXISTS daily_usage", src) is not None)
ok(
    "估算与记账的边界取自第一条记账日",
    re.search(r"SELECT MIN\(day\) AS d FROM daily_usage", src) is not None,
)
ok(
    "summary 每天要回 estimated 标记",
    re.search(r'"estimated":\s*day not in recorded and day in estimated', src) is not None,
)

if FAILS:
    print("按天 token 记账与估算契约：失败")
    for item in FAILS:
        print(f"- {item}")
    sys.exit(1)

print("按天 token 记账与估算契约：通过")
