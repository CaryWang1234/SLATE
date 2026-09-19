/**
 * 2048 小游戏：藏在设置页「用量统计」的热力图里（双击任一格子打开）。
 *
 * 纯逻辑（moveLine/move/spawn/isOver）与渲染分开导出，供
 * scripts/check_usage_heatmap.mjs 在 node 里直接断言——合并规则写错
 * （一格一次移动里被合两回）肉眼很难看出来，只有断言钉得住。
 *
 * 棋盘留在模块变量里：设置页每次打开都会重画用量统计，不留着的话
 * 关个设置就丢一局。最高分只落 localStorage（与打字小游戏同套路），
 * 不进后端设置项，免得为一局小游戏做三处联动。
 */

import { t } from "../services/i18n.js?v=20260919-002";

const BEST_KEY = "slate_2048_best";
const SIZE = 4;
const WIN_TILE = 2048;

const CODE_KEYS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
};

let savedBoard = null;
let savedScore = 0;

export function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

/** 向索引 0 一侧推挤并合并：相邻同值合成一格，一格一次移动里只合一回 */
export function moveLine(line) {
  const vals = line.filter(v => v);
  const out = [];
  let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
      const merged = vals[i] * 2;
      out.push(merged);
      gained += merged;
      i += 1;
    } else {
      out.push(vals[i]);
    }
  }
  while (out.length < line.length) out.push(0);
  return { line: out, gained };
}

/** (方向, 第几条轨道, 轨道内序号) → 格子坐标；序号从「推进的尽头」起算 */
function cellAt(dir, lane, pos) {
  if (dir === "left") return [lane, pos];
  if (dir === "right") return [lane, SIZE - 1 - pos];
  if (dir === "up") return [pos, lane];
  return [SIZE - 1 - pos, lane];
}

export function move(board, dir) {
  const next = emptyBoard();
  let gained = 0;
  for (let lane = 0; lane < SIZE; lane++) {
    const line = [];
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      line.push(board[r][c]);
    }
    const moved = moveLine(line);
    gained += moved.gained;
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      next[r][c] = moved.line[pos];
    }
  }
  return { board: next, gained, moved: !sameBoard(board, next) };
}

/** 空格里补一颗新方块：先抽位置再抽点数，各花一次 rng，方便测试复现 */
export function spawn(board, rng = Math.random) {
  const free = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (!board[r][c]) free.push([r, c]);
  }
  const next = board.map(row => [...row]);
  if (!free.length) return next;
  const [r, c] = free[Math.floor(rng() * free.length) % free.length];
  next[r][c] = rng() < 0.9 ? 2 : 4;
  return next;
}

export function isOver(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) return false;
      if (c + 1 < SIZE && board[r][c] === board[r][c + 1]) return false;
      if (r + 1 < SIZE && board[r][c] === board[r + 1][c]) return false;
    }
  }
  return true;
}

export function maxTile(board) {
  let top = 0;
  for (const row of board) for (const v of row) if (v > top) top = v;
  return top;
}

function sameBoard(a, b) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(Math.round(v))); } catch {}
}

function el(cls, text) {
  const node = document.createElement(cls === "button" ? "button" : "div");
  node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** 挂载一副牌到 host；返回 destroy() 解绑全局按键 */
export function mount2048(host, { onClose } = {}) {
  host.innerHTML = "";

  let board = savedBoard ? savedBoard.map(row => [...row]) : null;
  let score = savedBoard ? savedScore : 0;
  let won = false;
  let destroyed = false;

  const wrap = el("t2048");

  const head = el("t2048-head");
  const title = el("t2048-title", "2048");
  head.append(title);

  const scoreBox = el("t2048-score");
  scoreBox.append(el("t2048-score-key", t("分数")));
  const scoreNum = el("t2048-score-num", "0");
  scoreBox.append(scoreNum);

  const bestBox = el("t2048-score");
  bestBox.append(el("t2048-score-key", t("最高分")));
  const bestNum = el("t2048-score-num", String(readBest()));
  bestBox.append(bestNum);
  head.append(scoreBox, bestBox);

  const btnNew = el("button", t("新游戏"));
  btnNew.className = "send-btn send-btn-sm";
  btnNew.type = "button";
  const btnClose = el("button", t("返回热力图"));
  btnClose.className = "send-btn send-btn-sm";
  btnClose.type = "button";
  head.append(btnNew, btnClose);
  wrap.append(head);

  const boardEl = el("t2048-board");
  const cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = el("t2048-cell");
    cells.push(cell);
    boardEl.append(cell);
  }
  wrap.append(boardEl);

  const hint = el("t2048-hint", t("方向键或 WASD 移动方块，合出 2048"));
  wrap.append(hint);
  host.append(wrap);

  function paint() {
    let i = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++, i++) {
        const v = board[r][c];
        const cell = cells[i];
        const cls = v ? `t2048-cell tv${v}` : "t2048-cell";
        const text = v ? String(v) : "";
        if (cell.className !== cls || cell.textContent !== text) {
          cell.className = cls + " pop";
          cell.textContent = text;
        }
      }
    }
    scoreNum.textContent = String(score);
    bestNum.textContent = String(readBest());
  }

  function commit(next, gained) {
    board = next;
    score += gained;
    if (score > readBest()) writeBest(score);
    if (!won && maxTile(board) >= WIN_TILE) {
      won = true;
      hint.textContent = t("合出 2048 了！可以接着往上刷");
    }
    savedBoard = board.map(row => [...row]);
    savedScore = score;
  }

  function restart() {
    board = spawn(spawn(emptyBoard()));
    score = 0;
    won = false;
    hint.textContent = t("方向键或 WASD 移动方块，合出 2048");
    savedBoard = null;
    savedScore = 0;
    paint();
  }

  function push(dir) {
    if (isOver(board)) return;
    const res = move(board, dir);
    if (!res.moved) return;
    commit(spawn(res.board), res.gained);
    paint();
    if (isOver(board)) hint.textContent = t("无步可走，点「新游戏」再来一局");
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = CODE_KEYS[e.code];
    if (!dir) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    push(dir);
  }

  if (!board) {
    board = spawn(spawn(emptyBoard()));
    savedBoard = board.map(row => [...row]);
    savedScore = score;
  }
  paint();

  btnNew.addEventListener("click", restart);
  btnClose.addEventListener("click", () => { if (onClose) onClose(); });
  window.addEventListener("keydown", onKey);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("keydown", onKey);
      host.innerHTML = "";
    },
  };
}
