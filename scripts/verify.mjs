/**
 * 一条命令跑完该跑的检查，并把"跑了什么、多久、哪些跳过"全报出来。
 *
 * 为什么要它：36 个静态守卫各自 0.1–3.5 秒，逐个手跑要人记着跑过没有；24 个真浏览器走查
 * 更没人每轮都跑，于是走查悄悄烂掉（实测：walk_mcp_logos / walk_heatmap 今天就是红的，
 * 而两套都早已不在每期收口的射程里）。慢的部分不该由人脑做增量。
 *
 * 口径：
 *   ① 判绿**只看退出码**——断言失败时会把源码整段打出来，里面的"通过/ok"字样会骗过按文本判绿；
 *   ② 静态层永远全量并行（8.1s 串行 → 并行约 4s），不做缓存：缓存会掩盖"新判据其实从没咬过"；
 *   ③ 走查层按 .qoder/walk_*.py 里的 `# verify: src=` 清单选跑；清单没覆盖到的改动一律回退全量
 *      （宁可多跑，也不给漏登记的走查留假绿）；
 *   ④ 任何"跳过"必须打印条数；每一项的完整输出落到 .diag/verify/<name>.log，终端只留结论。
 *
 * 用法：
 *   node scripts/verify.mjs                 静态层全量
 *   node scripts/verify.mjs --walks         静态层 + 走查层全量
 *   node scripts/verify.mjs --changed       静态层全量 + 只跑受本次改动影响的走查
 *   node scripts/verify.mjs --only round,task_list   点名走查（子串匹配）
 *   node scripts/verify.mjs --jobs 2        并发度（默认 2；实测再高反而慢）
 *
 * 两条实测过的事实，别再走回头路：
 *   ① 并行不省钱：静态层 36 项串行 24.5s，jobs=2 是 22.1s，jobs=4/8 变成 28/30s——
 *      瓶颈是 Python 解释器 + FastAPI 冷启动（check_backend_projects 一项 11.8s，它要起三次
 *      uvicorn 证明"重启自愈"，那三次都是判据，不能省）。真正省的是**少跑**，不是并行跑。
 *   ② 走查清单没法自动推：从 harness 源码里抓 repo 路径当依赖，24 个走查有 21 个只抓到
 *      `frontend/js/store.js`（那只是它 import 的路径，不是它测的东西）。所以 src= 只能人写，
 *      没写的就走全量——绝不让"清单没登记"变成假绿。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, ".diag", "verify");
const PY = process.env.SLATE_PYTHON || "python";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const JOBS = Number(opt("jobs", "2")) || 1;   // 实测：静态层 jobs=2 最快（22.1s），4/8 反而更慢（28/30s）
const TERM_KEEP = Number(opt("tail", "6"));   // 失败项在终端上留几行

function run(cmd, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.error) return { code: -1, ms: Date.now() - t0, out: out + `\n[runner] ${r.error.message}\n` };
  return { code: r.status === null ? -1 : r.status, ms: Date.now() - t0, out, signal: r.signal };
}

const listDir = (dir, re) => fs.readdirSync(path.join(ROOT, dir))
  .filter(f => re.test(f)).map(f => path.join(dir, f)).sort();

// ── 静态层：全量并行 ─────────────────────────────────────
const staticJobs = [...listDir("scripts", /^check_.*\.mjs$/), ...listDir("scripts", /^check_.*\.py$/)]
  .map(f => ({ name: path.basename(f), cmd: f.endsWith(".py") ? [PY, f] : [process.execPath, f], kind: "static" }));

// ── 走查层：按清单选跑 ───────────────────────────────────
function manifest(file) {
  const head = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/, 60).join("\n");
  const m = head.match(/^#\s*verify:\s*src=(.*)$/m);
  return m ? m[1].split(",").map(s => s.trim()).filter(Boolean) : null;
}

function changedFiles() {
  const r = run(["git", "status", "--porcelain", "--untracked-files=normal"], 30_000);
  if (r.code !== 0) return null;      // 拿不到 diff 就别装聪明，回退全量
  const set = new Set();
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p = line.slice(3).replace(/^.*-> /, "").replace(/^"|"$/g, "").trim();
    if (p) set.add(p.replace(/\\/g, "/"));
  }
  return set;
}

let walkJobs = [];
let walkSkipNote = "";
if (flag("walks") || flag("changed") || flag("only") || flag("release")) {
  const all = listDir(".qoder", /^walk_.*\.py$/).map(f => ({ name: path.basename(f), cmd: [PY, f], kind: "walk" }));
  const only = opt("only", "");
  let picked = all;
  if (only) {
    const keys = only.split(",").map(s => s.trim()).filter(Boolean);
    picked = all.filter(j => keys.some(k => j.name.includes(k)));
  } else if (flag("changed")) {
    const changed = changedFiles();
    const missing = all.filter(j => !manifest(j.cmd[1]));
    if (!changed || missing.length) {
      walkSkipNote = !changed
        ? "git status 不可用 → 走查全量"
        : `${missing.length} 个走查没有 verify:src 清单 → 走查全量（宁可多跑）`;
    } else {
      const hit = new Set();
      for (const j of all) {
        for (const src of manifest(j.cmd[1]) || []) {
          if (changed.has(src) || [...changed].some(c => c === src || c.startsWith(src + "/"))) hit.add(j.name);
        }
      }
      picked = all.filter(j => hit.has(j.name));
      walkSkipNote = `受影响走查 ${picked.length}/${all.length}`;
    }
  }
  walkJobs = picked;
}

const jobs = [...staticJobs, ...walkJobs];
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = new Map();
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= jobs.length) return;
    const j = jobs[i];
    const cap = j.kind === "walk" ? 15 * 60_000 : 3 * 60_000;
    const r = run(j.cmd, cap);
    r.timedOut = r.code === -1 && !r.out.trim().endsWith("]");
    results.set(j.name, r);
    fs.writeFileSync(path.join(OUT_DIR, `${j.name}.log`), r.out || "(no output)");
    const ok = r.code === 0;
    console.log(`${ok ? "·" : "✗"} ${j.name.padEnd(34)} ${String(r.ms).padStart(6)}ms${ok ? "" : "  ← " + path.join(".diag", "verify", j.name + ".log")}`);
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, worker));

const failed = jobs.filter(j => results.get(j.name).code !== 0);
const byKind = k => jobs.filter(j => j.kind === k);
const sumMs = k => byKind(k).reduce((n, j) => n + results.get(j.name).ms, 0);
console.log(`\n静态 ${byKind("static").length} 项（合计 ${sumMs("static")}ms）` +
  (byKind("walk").length ? ` · 走查 ${byKind("walk").length} 项（合计 ${sumMs("walk")}ms，并发 ${JOBS}）` : "") +
  (walkSkipNote ? ` · ${walkSkipNote}` : ""));
if (failed.length) {
  console.log(`\n${failed.length} 项红：`);
  for (const j of failed) {
    const r = results.get(j.name);
    console.log(`\n── ${j.name} (exit ${r.code})`);
    console.log(r.out.trimEnd().split(/\r?\n/).slice(-TERM_KEEP).map(l => "   " + l).join("\n"));
  }
  process.exit(1);
}
console.log("\n全部绿。");
