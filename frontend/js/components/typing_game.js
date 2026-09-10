/**
 * 设置页打字小游戏：一段 ASCII 文本，逐字符比对，算 WPM 与准确率。
 *
 * 语料只放英文与符号：中文要走输入法，组合期的 input 事件是半截文本，
 * 计时和准确率都会被输入法节奏带偏，不如不做。
 * 准确率按「首次敲对的字符 / 总按键数」算，退格重敲会摊薄它，才像手速；
 * 一次事件塞进多个字符视为粘贴，成绩照算但不进最佳纪录。
 */

import { t } from "../services/i18n.js?v=20260910-004";

const CORPUS = [
  "git commit -m 'feat: ship the thing'",
  "const sum = arr.reduce((a, b) => a + b, 0);",
  "python -m uvicorn backend.main:app --reload",
  "if (!response.ok) throw new Error(response.statusText);",
  "SELECT id, name FROM users WHERE active = 1 ORDER BY id;",
  "npm install --save-dev && npm run build -- --minify",
  "for (const [key, value] of Object.entries(map)) console.log(key, value);",
  "curl -sS -X POST http://127.0.0.1:8000/api/health -d '{}'",
  "The quick brown fox jumps over the lazy dog 0123456789",
  "docker compose up -d --build && docker compose logs -f app",
  "export PATH=\"$HOME/.local/bin:$PATH\" && source ~/.bashrc",
  "assert len(chunks) > 0, 'stream produced no chunks'",
];

const BEST_KEY = "slate_typing_best";

let targetEl, inputEl, timeEl, wpmEl, accEl, bestEl, resultEl, nextBtn;
let target = "";
let prevLen = 0;
let keys = 0;
let correctKeys = 0;
let startedAt = 0;
let finished = false;
let pasted = false;
let timer = 0;

function span(cls, text) {
  const node = document.createElement("span");
  if (cls) node.className = cls;
  node.textContent = text;
  return node;
}

function paint(typed) {
  const nodes = targetEl.children;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].className = "tc" + (i < typed.length
      ? (typed[i] === target[i] ? " ok" : " bad")
      : (i === typed.length ? " cur" : ""));
  }
}

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function writeBest(wpm) {
  try { localStorage.setItem(BEST_KEY, String(Math.round(wpm))); } catch {}
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = 0; }
}

function elapsedSec() {
  return startedAt ? (performance.now() - startedAt) / 1000 : 0;
}

function currentWpm() {
  const sec = elapsedSec();
  return sec ? (correctKeys / 5) / (sec / 60) : 0;
}

function accuracy() {
  return keys ? Math.round((correctKeys / keys) * 100) : 100;
}

function refreshStats() {
  const sec = elapsedSec();
  timeEl.textContent = `${sec.toFixed(1)}s`;
  wpmEl.textContent = sec >= 1 ? String(Math.round(currentWpm())) : "0";
  accEl.textContent = `${accuracy()}%`;
}

function finish() {
  finished = true;
  stopTimer();
  refreshStats();
  const wpm = Math.round(currentWpm());
  const best = readBest();
  const record = !pasted && wpm > best;
  if (record) writeBest(wpm);
  bestEl.textContent = String(readBest());
  resultEl.textContent = record
    ? t("本局 {wpm} WPM · 准确率 {acc}% · 新纪录！", { wpm, acc: accuracy() })
    : (pasted
      ? t("本局 准确率 {acc}%（粘贴不计纪录）", { acc: accuracy() })
      : t("本局 {wpm} WPM · 准确率 {acc}% · 最佳 {best} WPM", { wpm, acc: accuracy(), best: Math.max(best, wpm) }));
  resultEl.classList.add("show");
  inputEl.readOnly = true;
}

function nextRound() {
  stopTimer();
  let pick = target;
  while (CORPUS.length > 1 && pick === target) pick = CORPUS[Math.floor(Math.random() * CORPUS.length)];
  target = pick;
  prevLen = 0;
  keys = 0;
  correctKeys = 0;
  startedAt = 0;
  finished = false;
  pasted = false;
  inputEl.readOnly = false;
  inputEl.value = "";
  bestEl.textContent = String(readBest());
  resultEl.textContent = "";
  resultEl.classList.remove("show");
  targetEl.textContent = "";
  for (const ch of target) targetEl.append(span("tc", ch));
  refreshStats();
  paint("");
}

function onInput() {
  if (finished) return;
  const typed = inputEl.value;
  if (typed.length > prevLen) {
    if (typed.length - prevLen > 1) pasted = true;
    for (let i = prevLen; i < typed.length; i++) {
      keys += 1;
      if (typed[i] === target[i]) correctKeys += 1;
    }
    if (!startedAt) {
      startedAt = performance.now();
      timer = setInterval(refreshStats, 200);
    }
  }
  prevLen = typed.length;
  paint(typed);
  refreshStats();
  if (typed === target) finish();
}

export function initTypingGame() {
  targetEl = document.getElementById("typing-target");
  inputEl = document.getElementById("typing-input");
  timeEl = document.getElementById("typing-time");
  wpmEl = document.getElementById("typing-wpm");
  accEl = document.getElementById("typing-acc");
  bestEl = document.getElementById("typing-best");
  resultEl = document.getElementById("typing-result");
  nextBtn = document.getElementById("btn-typing-next");
  if (!targetEl || !inputEl || !resultEl) return;

  nextRound();
  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextRound(); inputEl.focus(); }
  });
  nextBtn.addEventListener("click", () => { nextRound(); inputEl.focus(); });
}
