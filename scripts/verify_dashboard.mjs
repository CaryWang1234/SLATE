/**
 * SLATE 验证看板：一张表看完全部检查，边跑边看，先给预估。
 *
 * 三层与 scripts/verify.mjs 同源——静态守卫 `scripts/check_*`、真浏览器走查 `.qoder/walk_*.py`、
 * 变异取证 `.qoder/mutate_*.py`——区别只在「看得见」：
 *   ① 开跑前先按历史耗时算出预计总时长与每层预算；没跑过的项按种子估值，并在表里标出来；
 *   ② 跑动时实时刷新：总进度条、已用/剩余、每层 ✓/✗/▶/○ 计数、当前在跑的项与耗时；
 *   ③ 每项跑完把真实耗时写回 `.diag/verify/timings.json`，下次预估就越来越准；
 *   ④ 可选 `--html` 生成一张自刷新的网页快照，真正的「可视化观看」。
 *
 * 口径（与 verify.mjs 一致，别改）：
 *   · 判绿**只看退出码**——断言失败会把源码整段打出来，里面的「通过/ok」字样会骗过按文本判绿；
 *   · 静态层可并行（默认 2，实测最快）；**走查与变异一律串行**——两套 harness 并行会互相抢
 *     浏览器与端口，`networkidle` 撞超时变成假红（见记忆 verification-cost-baseline）；
 *   · 单项超时：静态 3min、走查 / 变异 15min；超时记红但**继续跑完**，最后一起报；
 *   · 每项完整输出仍落 `.diag/verify/<name>.log`，终端只留结论。
 *
 * 用法：
 *   node scripts/verify_dashboard.mjs                   三层全跑（静态 → 走查 → 变异）
 *   node scripts/verify_dashboard.mjs --estimate        只出预估表，不跑
 *   node scripts/verify_dashboard.mjs --layer static    只跑一层（逗号分隔多层）
 *   node scripts/verify_dashboard.mjs --only mode,theme 子串点名
 *   node scripts/verify_dashboard.mjs --html            跑的同时写 `.diag/verify/dashboard.html`
 *   node scripts/verify_dashboard.mjs --plain           不做实时刷新，逐条打印（适合重定向到日志）
 *   可选：--jobs 2（只作用于静态层）· --tail 8（终端每层留几条已完成的）
 *         --html-file <path>（自定义网页快照落点）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIAG = path.join(ROOT, ".diag", "verify");
const TIMINGS = path.join(DIAG, "timings.json");
const PY = process.env.SLATE_PYTHON || "python";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const KINDS = ["static", "walk", "mutate"];
const KIND_LABEL = { static: "静态守卫", walk: "真浏览器走查", mutate: "变异取证" };
const SEED = { static: 800, walk: 30000, mutate: 60000 };      // 无历史时的种子估值（ms）
const CAP = { static: 3 * 60_000, walk: 15 * 60_000, mutate: 15 * 60_000 };
const JOBS = Math.max(1, Number(opt("jobs", "2")) || 2);
const TAIL = Math.max(0, Number(opt("tail", "8")) || 0);
// --plain 强制逐条打印；--ui 强制实时界面（便于把界面重定向进文件排查）
const PLAIN = has("plain") ? true : (has("ui") ? false : !process.stdout.isTTY);
const COLOR = !PLAIN && !process.env.NO_COLOR;
const HTML_FILE = has("html")
  ? path.resolve(ROOT, opt("html-file", path.join(".diag", "verify", "dashboard.html")))
  : null;
const ESTIMATE_ONLY = has("estimate");

/* ── 颜色 ───────────────────────────────────────────────── */
const wrap = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => wrap("2", s);
const bold = (s) => wrap("1", s);
const green = (s) => wrap("32", s);
const red = (s) => wrap("31", s);
const yellow = (s) => wrap("33", s);
const cyan = (s) => wrap("36", s);

/* ── 历史耗时 ───────────────────────────────────────────── */
function loadTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS, "utf8"));
  } catch {
    return {};
  }
}
const timings = loadTimings();
function saveTimings() {
  fs.mkdirSync(DIAG, { recursive: true });
  fs.writeFileSync(TIMINGS, JSON.stringify(timings, null, 2));
}

/* ── 发现任务 ───────────────────────────────────────────── */
const listDir = (dir, re) => {
  const abs = path.join(ROOT, dir);
  return fs.existsSync(abs)
    ? fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f))
    : [];
};
const FILES = {
  static: [...listDir("scripts", /^check_.*\.mjs$/), ...listDir("scripts", /^check_.*\.py$/)],
  walk: listDir(".qoder", /^walk_.*\.py$/),
  mutate: listDir(".qoder", /^mutate_.*\.py$/),
};

const layers = (opt("layer", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const only = (opt("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

function buildJobs() {
  const out = [];
  for (const kind of KINDS) {
    if (layers.length && !layers.includes(kind)) continue;
    for (const file of FILES[kind]) {
      const name = path.basename(file);
      if (only.length && !only.some((k) => name.includes(k))) continue;
      const isPy = file.endsWith(".py");
      out.push({
        name,
        kind,
        file,
        cmd: isPy ? [PY, file] : [process.execPath, file],
        est: Number(timings[name]?.ms) || SEED[kind],
        hasHistory: Number.isFinite(timings[name]?.ms),
        state: "pending",        // pending | run | ok | fail
        ms: 0,
        code: null,
        startedAt: 0,
        timedOut: false,
      });
    }
  }
  return out;
}

/* ── 时间格式 ───────────────────────────────────────────── */
const t = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};
const msLabel = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${Math.round(ms)}ms`);
const clock = () => new Date().toTimeString().slice(0, 8);

/* ── 进度模型 ───────────────────────────────────────────── */
function snapshot(jobs, t0) {
  const elapsed = t0 ? Date.now() - t0 : 0;
  const done = jobs.filter((j) => j.state === "ok" || j.state === "fail");
  const running = jobs.filter((j) => j.state === "run");
  const pending = jobs.filter((j) => j.state === "pending");
  const weightDone = done.reduce((n, j) => n + (j.ms || j.est), 0);
  const weightRunning = running.reduce((n, j) => n + Math.max(0, j.est - (Date.now() - j.startedAt)), 0);
  const weightPending = pending.reduce((n, j) => n + j.est, 0);
  const remaining = weightRunning + weightPending;
  const totalEst = weightDone + remaining;
  const frac = totalEst > 0 ? weightDone / totalEst : 1;
  const ok = jobs.filter((j) => j.state === "ok").length;
  const fail = jobs.filter((j) => j.state === "fail").length;
  return { elapsed, remaining, totalEst, frac, ok, fail, run: running.length, pending: pending.length, done: done.length };
}

function kindSnapshot(jobs, kind, t0) {
  const sub = jobs.filter((j) => j.kind === kind);
  const remaining = sub.reduce((n, j) => {
    if (j.state === "ok" || j.state === "fail") return n;
    if (j.state === "run") return n + Math.max(0, j.est - (Date.now() - j.startedAt));
    return n + j.est;
  }, 0);
  return {
    total: sub.length,
    ok: sub.filter((j) => j.state === "ok").length,
    fail: sub.filter((j) => j.state === "fail").length,
    run: sub.filter((j) => j.state === "run").length,
    pending: sub.filter((j) => j.state === "pending").length,
    remaining,
  };
}

/* ── 执行 ───────────────────────────────────────────────── */
const children = new Set();
const SPIN = ["|", "/", "-", "\\"];
let spinTick = 0;

function startJob(j) {
  j.state = "run";
  j.startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(j.cmd[0], j.cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    children.add(child);
    let out = "";
    let settled = false;
    const cap = setTimeout(() => {
      j.timedOut = true;
      try { child.kill(); } catch { /* 已经退出了 */ }
    }, CAP[j.kind]);
    const onData = (d) => { out += d.toString("utf8"); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      children.delete(child);
      j.ms = Date.now() - j.startedAt;
      j.code = code === null || code === undefined ? -1 : code;
      j.state = j.code === 0 && !j.timedOut ? "ok" : "fail";
      j.out = out;
      fs.mkdirSync(DIAG, { recursive: true });
      fs.writeFileSync(path.join(DIAG, `${j.name}.log`), out || "(no output)");
      timings[j.name] = { ms: j.ms, ok: j.state === "ok", kind: j.kind, at: new Date().toISOString() };
      saveTimings();
      if (PLAIN) {
        const tag = j.state === "ok" ? "·" : "✗";
        console.log(`${tag} ${j.name.padEnd(34)} ${String(j.ms).padStart(6)}ms${j.state === "ok" ? "" : "  ← " + path.join(".diag", "verify", j.name + ".log")}`);
      }
      resolve();
    };
    child.on("close", finish);
    child.on("error", (err) => {
      out += `\n[runner] ${err.message}\n`;
      finish(-1);
    });
  });
}

async function pool(jobs, concurrency) {
  let cursor = 0;
  let active = 0;
  await new Promise((resolve) => {
    const next = () => {
      while (active < concurrency && cursor < jobs.length) {
        const j = jobs[cursor++];
        active++;
        startJob(j).then(() => { active--; next(); });
      }
      if (active === 0 && cursor >= jobs.length) resolve();
    };
    next();
  });
}

/* ── 终端渲染 ───────────────────────────────────────────── */
function bar(frac, width) {
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function statusGlyph(j, now) {
  if (j.state === "ok") return green("✓");
  if (j.state === "fail") return red("✗");
  if (j.state === "run") return yellow(SPIN[spinTick % SPIN.length]);
  return dim("○");
}

function renderTerminal(jobs, t0) {
  const s = snapshot(jobs, t0);
  const lines = [];
  lines.push(bold(`SLATE 验证看板`) + dim(`  ${clock()}  ·  ${s.done}/${jobs.length} 完成`));
  lines.push(`${cyan(bar(s.frac, 28))} ${String(Math.round(s.frac * 100)).padStart(3)}%  ` +
    green(`✓${s.ok}`) + " " + (s.fail ? red(`✗${s.fail}`) : dim("✗0")) + " " +
    (s.run ? yellow(`▶${s.run}`) : dim("▶0")) + " " + dim(`○${s.pending}`));
  lines.push(dim("已用 ") + t(s.elapsed) + dim("  ·  剩余 ") + t(s.remaining) + dim("  ·  预计总时长 ") + bold(t(s.elapsed + s.remaining)));
  lines.push("");

  for (const kind of KINDS) {
    const sub = jobs.filter((j) => j.kind === kind);
    if (!sub.length) continue;
    const k = kindSnapshot(jobs, kind, t0);
    const head = `── ${KIND_LABEL[kind]} (${k.ok + k.fail}/${k.total})`;
    lines.push(bold(head) + dim(`  ·  剩余 ~${t(k.remaining)}`) +
      (k.fail ? red(`  ✗${k.fail}`) : ""));
    const running = sub.filter((j) => j.state === "run");
    for (const j of running) {
      const el = Date.now() - j.startedAt;
      lines.push(`${statusGlyph(j)} ${j.name.padEnd(36)} ${dim(`~${msLabel(j.est)}`)} ${yellow(t(el))} …`);
    }
    const finished = sub.filter((j) => j.state === "ok" || j.state === "fail").slice(-TAIL);
    for (const j of finished) {
      const delta = j.hasHistory ? j.ms - j.est : null;
      const dTxt = delta === null ? dim("  (首跑)") : dim(`  ${delta >= 0 ? "+" : ""}${msLabel(Math.abs(delta))}`);
      lines.push(`${statusGlyph(j)} ${j.name.padEnd(36)} ${String(j.ms).padStart(6)}ms${dTxt}`);
    }
    const hiddenDone = (k.ok + k.fail) - finished.length;
    const pend = sub.filter((j) => j.state === "pending");
    if (hiddenDone > 0 || pend.length) {
      const names = pend.slice(0, 3).map((j) => j.name).join(", ");
      lines.push(dim(`   … ${hiddenDone > 0 ? `另有 ${hiddenDone} 项已完成 · ` : ""}待跑 ${pend.length}${names ? `（${names}${pend.length > 3 ? ", …" : ""}）` : ""}`));
    }
    lines.push("");
  }
  if (s.fail) lines.push(red(`已有 ${s.fail} 项红——完整输出见 .diag/verify/<name>.log`));
  else lines.push(dim("全部输出落 .diag/verify/<name>.log；跑完汇总与退出码在最后"));
  return lines;
}

let renderedLines = 0;
function paint(lines) {
  if (PLAIN) return;
  const out = ["\x1b[H"];
  for (const l of lines) out.push(l + "\x1b[K\n");
  for (let i = lines.length; i < renderedLines; i++) out.push("\x1b[K\n");
  renderedLines = lines.length;
  process.stdout.write(out.join(""));
}

/* ── 网页快照 ───────────────────────────────────────────── */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function renderHtml(jobs, t0, finishedAll) {
  const s = snapshot(jobs, t0);
  const row = (j) => {
    const glyph = { ok: "✓", fail: "✗", run: "▶", pending: "○" }[j.state];
    const cls = j.state;
    const live = j.state === "run" ? `<span class="ms">${t(Date.now() - j.startedAt)}…</span>` : (j.ms ? `<span class="ms">${msLabel(j.ms)}</span>` : "");
    const est = `<span class="est">~${msLabel(j.est)}${j.hasHistory ? "" : "*"}</span>`;
    const delta = j.state === "ok" || j.state === "fail"
      ? (j.hasHistory ? `<span class="d">${j.ms - j.est >= 0 ? "+" : ""}${msLabel(Math.abs(j.ms - j.est))}</span>` : `<span class="d">首跑</span>`)
      : "";
    return `<tr class="${cls}"><td class="g">${glyph}</td><td class="n">${esc(j.name)}</td><td>${live}</td><td>${est}</td><td>${delta}</td></tr>`;
  };
  const section = (kind) => {
    const sub = jobs.filter((j) => j.kind === kind);
    if (!sub.length) return "";
    const k = kindSnapshot(jobs, kind, t0);
    return `<section><h2>${KIND_LABEL[kind]} <span class="cnt">${k.ok + k.fail}/${k.total}</span>
      <span class="eta">剩余 ~${t(k.remaining)}</span></h2>
      <table><thead><tr><th></th><th>项</th><th>耗时</th><th>预估</th><th>Δ</th></tr></thead>
      <tbody>${sub.map(row).join("")}</tbody></table></section>`;
  };
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
${finishedAll ? "" : `<meta http-equiv="refresh" content="2">`}
<title>SLATE 验证看板</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:28px 32px;background:#0e0f12;color:#d6d8de;font:13px/1.6 ui-monospace,Menlo,Consolas,"Courier New",monospace}
h1{font-size:16px;margin:0 0 14px;font-weight:600;letter-spacing:.02em}
.bar{height:14px;border-radius:7px;background:#1c1f26;overflow:hidden;margin:0 0 10px;max-width:760px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#2fd4c4,#3fb950);transition:width .3s}
.meta{color:#9aa4b2;margin-bottom:22px}
.meta b{color:#e8eaef}
section{margin-bottom:26px}
h2{font-size:13px;margin:0 0 8px;color:#e8eaef;font-weight:600}
.cnt{color:#9aa4b2;font-weight:400}.eta{color:#9aa4b2;font-weight:400;margin-left:10px}
table{border-collapse:collapse;width:100%;max-width:760px}
th,td{text-align:left;padding:3px 10px 3px 0;border-bottom:1px solid #1a1d23}
th{color:#6b7484;font-weight:400;font-size:12px}
td.g{width:20px}
td.n{color:#c9cdd6}
.ms,.est,.d{color:#9aa4b2}
.est{color:#5c6577}
tr.ok td.g{color:#3fb950}tr.fail td.g{color:#f85149}tr.run td.g{color:#d29922}tr.pending td.g{color:#4a5160}
tr.fail td.n{color:#f0877d}
tr.pending{opacity:.55}
</style></head><body>
<h1>SLATE 验证看板</h1>
<div class="bar"><i style="width:${Math.round(s.frac * 100)}%"></i></div>
<div class="meta">${clock()} · ${s.done}/${jobs.length} 完成 · ✓${s.ok} ✗${s.fail} ▶${s.run} ○${s.pending} ·
  已用 <b>${t(s.elapsed)}</b> · 剩余 <b>${t(s.remaining)}</b> · 预计总时长 <b>${t(s.elapsed + s.remaining)}</b><br>
  <span style="color:#5c6577">预估带 * 的是种子值（该项还没有历史耗时）；Δ 为本次与上次的差</span></div>
${KINDS.map(section).join("")}
</body></html>`;
}
let lastHtml = 0;
function maybeHtml(jobs, t0, finishedAll) {
  if (!HTML_FILE) return;
  const now = Date.now();
  if (!finishedAll && now - lastHtml < 1000) return;
  lastHtml = now;
  fs.mkdirSync(path.dirname(HTML_FILE), { recursive: true });
  fs.writeFileSync(HTML_FILE, renderHtml(jobs, t0, finishedAll));
}

/* ── 预估表（不跑） ─────────────────────────────────────── */
function printEstimate(jobs) {
  const unknown = jobs.filter((j) => !j.hasHistory).length;
  console.log(bold("SLATE 验证预估") + dim("   （历史来自 .diag/verify/timings.json）\n"));
  let grand = 0;
  for (const kind of KINDS) {
    const sub = jobs.filter((j) => j.kind === kind);
    if (!sub.length) continue;
    const sum = sub.reduce((n, j) => n + j.est, 0);
    grand += sum;
    console.log(`${bold(KIND_LABEL[kind])}  ${sub.length} 项 · 预计 ${t(sum)}` +
      (kind === "static" ? dim(`（并行 ${JOBS}）`) : dim("（串行）")));
    for (const j of sub) {
      console.log(`  ${j.name.padEnd(38)} ~${msLabel(j.est)}${j.hasHistory ? "" : dim("  * 种子")}`);
    }
    console.log("");
  }
  console.log(bold(`合计预计 ${t(grand)}`) + (unknown ? dim(`   ·  其中 ${unknown} 项无历史、按种子估值`) : ""));
}

/* ── 主流程 ─────────────────────────────────────────────── */
const jobs = buildJobs();
if (!jobs.length) {
  console.log("没有匹配的检查项（--layer / --only 过滤太窄？）");
  process.exit(0);
}

if (ESTIMATE_ONLY) {
  printEstimate(jobs);
  process.exit(0);
}

/* ── 运行锁：不许两套 harness 同时跑 ──────────────────────
   走查与变异各自会起浏览器、改源码再还原；两套同时跑会互相抢端口/带宽，
   变异还会把源码的毒态暴露给另一套的判据（假红），最坏是还原被中断留下毒。
   scripts/verify.mjs 靠"人记得别并行"，这里给一条机器能兜住的线。 */
const LOCK = path.join(DIAG, "dashboard.lock");
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function acquireLock() {
  fs.mkdirSync(DIAG, { recursive: true });
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (cur && alive(cur.pid)) {
      console.log(red(`已在运行：pid ${cur.pid}（${cur.at || "?"}${cur.cmd ? " · " + cur.cmd : ""}）`));
      console.log(dim("两套 harness 并行会互相抢端口与源码——等它跑完，或用 --force 强行接管（会作废它的锁）。"));
      if (!has("force")) process.exit(2);
      console.log(yellow("--force：接管旧的锁，旧的进程仍在跑，两个一起跑出的红一概不可信。"));
    }
  } catch { /* 没锁或锁坏了，直接写新的 */ }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: clock(), cmd: argv.join(" ") }));
}
function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK);
  } catch { /* 已经没了 */ }
}
acquireLock();

const t0 = Date.now();
let stop = false;
const onSigint = () => {
  stop = true;
  for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
  releaseLock();
  if (!PLAIN) process.stdout.write("\x1b[?25h\n");
  console.log("\n已中断：子进程已终止，已完成项的耗时已写入 timings.json。");
  process.exit(130);
};
process.on("SIGINT", onSigint);

if (!PLAIN) process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");   // 隐藏光标 + 清屏一次
const timer = PLAIN ? null : setInterval(() => {
  spinTick++;
  paint(renderTerminal(jobs, t0));
  maybeHtml(jobs, t0, false);
}, 150);
if (!PLAIN) paint(renderTerminal(jobs, t0));

(async () => {
  for (const kind of KINDS) {
    const sub = jobs.filter((j) => j.kind === kind);
    if (!sub.length || stop) continue;
    // 静态层可并行；走查与变异串行——两套 harness 并行会抢浏览器与端口导致假红
    await pool(sub, kind === "static" ? JOBS : 1);
  }
  if (timer) clearInterval(timer);
  if (!PLAIN) process.stdout.write("\x1b[?25h");

  const s = snapshot(jobs, t0);
  maybeHtml(jobs, t0, true);

  if (PLAIN) {
    console.log(`\n${KIND_LABEL.static} ${jobs.filter((j) => j.kind === "static").length} 项` +
      (jobs.some((j) => j.kind === "walk") ? ` · 走查 ${jobs.filter((j) => j.kind === "walk").length} 项` : "") +
      (jobs.some((j) => j.kind === "mutate") ? ` · 变异 ${jobs.filter((j) => j.kind === "mutate").length} 项` : ""));
  } else {
    paint(renderTerminal(jobs, t0));
  }
  console.log(`\n完成：✓${s.ok} ✗${s.fail} · 实际总时长 ${t(s.elapsed)}（预估 ${t(s.totalEst)}）` +
    (HTML_FILE ? dim(` · 网页快照 ${path.relative(ROOT, HTML_FILE)}`) : ""));
  const failed = jobs.filter((j) => j.state === "fail");
  if (failed.length) {
    console.log(`\n${failed.length} 项红：`);
    for (const j of failed) {
      const tail = (j.out || "").trimEnd().split(/\r?\n/).slice(-8).map((l) => "   " + l).join("\n");
      console.log(`\n── ${j.name} (exit ${j.code}${j.timedOut ? ", 超时" : ""})\n${tail}`);
    }
    releaseLock();
    process.exit(1);
  }
  releaseLock();
  console.log("\n全部绿。");
})();
