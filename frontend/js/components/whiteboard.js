/**
 * SLATE 白板组件 v2：卡片编辑、颜色标签、AI 整理
 */

import { state, subscribe, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes, getModelKey } from "../store.js?v=20260818-108";
import { streamChat } from "../services/api.js?v=20260818-108";
import { dlgConfirm, dlgToast } from "../services/dialog.js?v=20260818-108";
import { t } from "../services/i18n.js?v=20260818-108";
import { makeId } from "../services/utils.js?v=20260818-108";

let boardCanvas, boardCards, boardEmpty, drawCanvas, drawCtx, notesLayer, mermaidPreview, mermaidCode, mermaidRenderArea, selectionInfo, boardViewPanel;
let cardModal, cardModalTitle, cardInputTitle, cardInputBody, cardInputArrows, cardColorOptions;
let btnCardDelete, btnCardSave, btnCardCancel;
let editingCardId = null;
let selectedColor = "default";
let svgOverlay = null;
let mermaidVisible = false;
let currentBoardView = "canvas";
let currentToolMode = "select";
let connectSourceId = null;
let strokes = [];
let currentStroke = null;
let activeCardDrag = null;
let suppressCardClickUntil = 0;
let selectedCardIds = new Set();

const CARD_LAYOUT = {
  width: 220,
  minGapX: 28,
  gapY: 28,
  startX: 24,
  startY: 24,
};

// 颜色选项
const CARD_COLORS = [
  { id: "default", name: "默认", bg: "var(--bg)", border: "var(--border)" },
  { id: "red", name: "红色", bg: "#fee", border: "#c99" },
  { id: "orange", name: "橙色", bg: "#fef3e2", border: "#f0b87a" },
  { id: "yellow", name: "黄色", bg: "#fffbe6", border: "#ffe58f" },
  { id: "green", name: "绿色", bg: "#f0fff0", border: "#95d475" },
  { id: "blue", name: "蓝色", bg: "#e6f4ff", border: "#91caff" },
  { id: "purple", name: "紫色", bg: "#f5f0ff", border: "#b37feb" },
];

const BOARD_VIEW_LABELS = {
  canvas: "画布",
  git: "Git 树",
  flow: "流程",
  kanban: "看板",
  outline: "纲要",
};

const COLOR_META = {
  default: { label: "未分类", icon: "·" },
  red: { label: "风险", icon: "!" },
  orange: { label: "待处理", icon: "…" },
  yellow: { label: "想法", icon: "*" },
  green: { label: "完成", icon: "✓" },
  blue: { label: "信息", icon: "i" },
  purple: { label: "创意", icon: "◇" },
};

// ── 卡片渲染 ─────────────────────────────────

function getBoardViewportSize() {
  const rect = boardCanvas?.getBoundingClientRect?.();
  return {
    width: Math.max(320, rect?.width || 900),
    height: Math.max(260, rect?.height || 600),
  };
}

function getNextCardPosition(index = state.boardCards.length) {
  const { width } = getBoardViewportSize();
  const columns = Math.max(1, Math.floor((width - CARD_LAYOUT.startX * 2) / (CARD_LAYOUT.width + CARD_LAYOUT.minGapX)));
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: CARD_LAYOUT.startX + col * (CARD_LAYOUT.width + CARD_LAYOUT.minGapX),
    y: CARD_LAYOUT.startY + row * (100 + CARD_LAYOUT.gapY),
  };
}

function normalizeBoardCardsLayout(cards = state.boardCards) {
  let changed = false;
  const normalized = cards.map((card, index) => {
    const hasX = Number.isFinite(Number(card.x));
    const hasY = Number.isFinite(Number(card.y));
    if (hasX && hasY) return card;
    changed = true;
    return { ...card, ...getNextCardPosition(index) };
  });
  if (changed) setBoardCards(normalized);
  return changed ? normalized : cards;
}

function placeNewCard(card, index = state.boardCards.length) {
  const pos = getNextCardPosition(index);
  return {
    ...card,
    x: Number.isFinite(Number(card.x)) ? Number(card.x) : pos.x,
    y: Number.isFinite(Number(card.y)) ? Number(card.y) : pos.y,
  };
}

function updateCardPosition(cardId, x, y) {
  const maxX = Math.max(CARD_LAYOUT.startX, (boardCanvas?.scrollWidth || getBoardViewportSize().width) - 180);
  const maxY = Math.max(CARD_LAYOUT.startY, (boardCanvas?.scrollHeight || getBoardViewportSize().height) - 80);
  const nx = Math.max(0, Math.min(maxX, Math.round(x)));
  const ny = Math.max(0, Math.min(maxY, Math.round(y)));
  const cards = state.boardCards.map(card => (
    card.id === cardId ? { ...card, x: nx, y: ny } : card
  ));
  setBoardCards(cards);
}

function updateCardPositions(updates) {
  const updateMap = new Map(updates.map(item => [item.id, item]));
  const maxX = Math.max(CARD_LAYOUT.startX, (boardCanvas?.scrollWidth || getBoardViewportSize().width) - 180);
  const maxY = Math.max(CARD_LAYOUT.startY, (boardCanvas?.scrollHeight || getBoardViewportSize().height) - 80);
  const cards = state.boardCards.map(card => {
    const next = updateMap.get(card.id);
    if (!next) return card;
    return {
      ...card,
      x: Math.max(0, Math.min(maxX, Math.round(next.x))),
      y: Math.max(0, Math.min(maxY, Math.round(next.y))),
    };
  });
  setBoardCards(cards);
}

function updateBoardLayerSize(cards = state.boardCards) {
  if (!boardCanvas || !boardCards) return;
  const viewport = getBoardViewportSize();
  const maxRight = cards.reduce((max, card) => Math.max(max, (Number(card.x) || 0) + CARD_LAYOUT.width + 80), viewport.width);
  const noteRight = (state.boardNotes || []).reduce((max, note) => Math.max(max, (Number(note.x) || 0) + (Number(note.width) || 180) + 80), viewport.width);
  const noteBottom = (state.boardNotes || []).reduce((max, note) => Math.max(max, (Number(note.y) || 0) + 120), viewport.height);
  const strokeRight = strokes.flatMap(s => s.points || []).reduce((max, p) => Math.max(max, (Number(p.x) || 0) + 80), viewport.width);
  const strokeBottom = strokes.flatMap(s => s.points || []).reduce((max, p) => Math.max(max, (Number(p.y) || 0) + 80), viewport.height);
  const maxBottom = cards.reduce((max, card) => Math.max(max, (Number(card.y) || 0) + 180), viewport.height);
  const width = Math.ceil(maxRight);
  const height = Math.ceil(Math.max(maxBottom, noteBottom, strokeBottom));
  const layerWidth = Math.ceil(Math.max(width, noteRight, strokeRight));
  boardCards.style.width = `${layerWidth}px`;
  boardCards.style.height = `${height}px`;
  if (notesLayer) {
    notesLayer.style.width = `${layerWidth}px`;
    notesLayer.style.height = `${height}px`;
  }
  if (drawCanvas) {
    drawCanvas.style.minWidth = `${layerWidth}px`;
    drawCanvas.style.minHeight = `${height}px`;
  }
  requestAnimationFrame(resizeDrawCanvas);
}

function selectCard(cardId, event = null) {
  if (!cardId) return;
  if (event?.shiftKey || event?.ctrlKey || event?.metaKey) {
    if (selectedCardIds.has(cardId)) selectedCardIds.delete(cardId);
    else selectedCardIds.add(cardId);
  } else if (!selectedCardIds.has(cardId) || selectedCardIds.size > 1) {
    selectedCardIds = new Set([cardId]);
  }
  renderSelection();
}

function clearSelection() {
  if (!selectedCardIds.size) return;
  selectedCardIds.clear();
  renderSelection();
}

function renderSelection() {
  boardCards?.querySelectorAll(".board-card").forEach(el => {
    el.classList.toggle("selected", selectedCardIds.has(el.dataset.cardId));
  });
  if (selectionInfo) {
    selectionInfo.textContent = selectedCardIds.size ? t("已选 {n}", { n: selectedCardIds.size }) : "";
  }
}

function cardByIdMap(cards = state.boardCards) {
  return new Map((cards || []).map(card => [card.id, card]));
}

function buildBoardGraph(cards = state.boardCards) {
  const cardMap = cardByIdMap(cards);
  const incoming = new Map(cards.map(card => [card.id, []]));
  const outgoing = new Map(cards.map(card => [card.id, []]));
  for (const card of cards) {
    for (const targetId of card.arrows || []) {
      if (!cardMap.has(targetId)) continue;
      outgoing.get(card.id).push(targetId);
      incoming.get(targetId).push(card.id);
    }
  }
  const roots = cards.filter(card => (incoming.get(card.id) || []).length === 0);
  return { cardMap, incoming, outgoing, roots: roots.length ? roots : cards.slice(0, 1) };
}

function boardCardSummary(card) {
  const meta = COLOR_META[card.color || "default"] || COLOR_META.default;
  const node = document.createElement("button");
  node.className = `board-view-card board-view-color-${card.color || "default"}`;
  node.type = "button";
  node.dataset.cardId = card.id;
  node.addEventListener("click", () => {
    selectedCardIds = new Set([card.id]);
    setBoardView("canvas");
    requestAnimationFrame(() => {
      const el = boardCards?.querySelector(`[data-card-id="${card.id}"]`);
      if (el) {
        boardCanvas.scrollTo({
          left: Math.max(0, (Number(card.x) || 0) - 80),
          top: Math.max(0, (Number(card.y) || 0) - 80),
          behavior: "smooth",
        });
      }
      renderSelection();
    });
  });
  node.addEventListener("dblclick", () => openCardModal(card));

  const head = document.createElement("span");
  head.className = "board-view-card-head";
  const badge = document.createElement("span");
  badge.className = "board-view-card-badge";
  badge.textContent = meta.icon;
  const title = document.createElement("strong");
  title.textContent = card.title || t("未命名");
  head.append(badge, title);
  node.appendChild(head);

  if (card.body) {
    const body = document.createElement("span");
    body.className = "board-view-card-body";
    body.textContent = card.body;
    node.appendChild(body);
  }
  return node;
}

function renderBoardView() {
  if (!boardViewPanel || currentBoardView === "canvas") return;
  const cards = state.boardCards || [];
  boardViewPanel.innerHTML = "";
  const header = document.createElement("div");
  header.className = "board-view-header";
  const title = document.createElement("strong");
  title.textContent = BOARD_VIEW_LABELS[currentBoardView] || t("视图");
  const meta = document.createElement("span");
  meta.textContent = t("{n} 张卡片", { n: cards.length });
  header.append(title, meta);
  boardViewPanel.appendChild(header);
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "board-view-empty";
    empty.textContent = t("黑板是空的，请先添加卡片");
    boardViewPanel.appendChild(empty);
    return;
  }
  if (currentBoardView === "git") renderGitTreeView(cards);
  else if (currentBoardView === "flow") renderFlowView(cards);
  else if (currentBoardView === "kanban") renderKanbanView(cards);
  else if (currentBoardView === "outline") renderOutlineView(cards);
}

function renderGitTreeView(cards) {
  const { incoming, outgoing, roots } = buildBoardGraph(cards);
  const lanes = [];
  const levels = new Map();
  const queue = roots.map(card => card.id);
  roots.forEach(card => levels.set(card.id, 0));
  while (queue.length) {
    const id = queue.shift();
    const base = levels.get(id) || 0;
    for (const child of outgoing.get(id) || []) {
      const next = Math.max(levels.get(child) || 0, base + 1);
      if (next !== levels.get(child)) {
        levels.set(child, next);
        queue.push(child);
      }
    }
  }
  cards.forEach((card, index) => {
    const level = levels.has(card.id) ? levels.get(card.id) : Math.floor(index / 4);
    if (!lanes[level]) lanes[level] = [];
    lanes[level].push(card);
  });
  const wrap = document.createElement("div");
  wrap.className = "board-git-tree";
  lanes.forEach((laneCards, idx) => {
    const lane = document.createElement("div");
    lane.className = "board-git-lane";
    const laneTitle = document.createElement("div");
    laneTitle.className = "board-git-lane-title";
    laneTitle.textContent = idx === 0 ? t("root") : t("level {n}", { n: idx });
    lane.appendChild(laneTitle);
    laneCards.forEach(card => {
      const item = document.createElement("div");
      item.className = "board-git-node";
      const parents = incoming.get(card.id) || [];
      item.appendChild(boardCardSummary(card));
      if (parents.length) {
        const parentText = document.createElement("div");
        parentText.className = "board-git-parents";
        parentText.textContent = "↤ " + parents.join(", ");
        item.appendChild(parentText);
      }
      lane.appendChild(item);
    });
    wrap.appendChild(lane);
  });
  boardViewPanel.appendChild(wrap);
}

function renderFlowView(cards) {
  const { incoming, outgoing, roots, cardMap } = buildBoardGraph(cards);
  const wrap = document.createElement("div");
  wrap.className = "board-flow-view";
  const seen = new Set();
  const visit = (card, depth = 0) => {
    if (!card || seen.has(card.id)) return;
    seen.add(card.id);
    const row = document.createElement("div");
    row.className = "board-flow-row";
    row.style.marginLeft = `${depth * 24}px`;
    row.appendChild(boardCardSummary(card));
    const children = outgoing.get(card.id) || [];
    if (children.length) {
      const arrow = document.createElement("span");
      arrow.className = "board-flow-arrow";
      arrow.textContent = "→";
      row.appendChild(arrow);
    }
    wrap.appendChild(row);
    children.forEach(child => visit(cardMap.get(child), depth + 1));
  };
  roots.forEach(root => visit(root));
  cards.filter(card => !seen.has(card.id)).forEach(card => visit(card));
  if ([...incoming.values()].some(list => list.length > 1)) {
    const hint = document.createElement("div");
    hint.className = "board-view-hint";
    hint.textContent = t("存在合流节点，双击卡片可编辑连接关系。");
    wrap.appendChild(hint);
  }
  boardViewPanel.appendChild(wrap);
}

function renderKanbanView(cards) {
  const wrap = document.createElement("div");
  wrap.className = "board-kanban-view";
  for (const color of ["red", "orange", "yellow", "blue", "purple", "green", "default"]) {
    const colCards = cards.filter(card => (card.color || "default") === color);
    const col = document.createElement("div");
    col.className = `board-kanban-col board-view-color-${color}`;
    const head = document.createElement("div");
    head.className = "board-kanban-head";
    head.textContent = `${COLOR_META[color].label} (${colCards.length})`;
    col.appendChild(head);
    colCards.forEach(card => col.appendChild(boardCardSummary(card)));
    wrap.appendChild(col);
  }
  boardViewPanel.appendChild(wrap);
}

function renderOutlineView(cards) {
  const { outgoing, roots, cardMap } = buildBoardGraph(cards);
  const seen = new Set();
  const makeList = (items, depth = 0) => {
    const ul = document.createElement("ul");
    ul.className = depth === 0 ? "board-outline-root" : "board-outline-children";
    for (const card of items) {
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      const li = document.createElement("li");
      li.appendChild(boardCardSummary(card));
      const children = (outgoing.get(card.id) || []).map(id => cardMap.get(id)).filter(Boolean);
      if (children.length) li.appendChild(makeList(children, depth + 1));
      ul.appendChild(li);
    }
    return ul;
  };
  boardViewPanel.appendChild(makeList(roots));
  const orphans = cards.filter(card => !seen.has(card.id));
  if (orphans.length) {
    const h = document.createElement("div");
    h.className = "board-view-hint";
    h.textContent = t("未连接卡片");
    boardViewPanel.appendChild(h);
    boardViewPanel.appendChild(makeList(orphans));
  }
}

function setBoardView(view) {
  currentBoardView = view || "canvas";
  const canvasMode = currentBoardView === "canvas";
  boardCanvas?.classList.toggle("hidden", !canvasMode);
  boardViewPanel?.classList.toggle("hidden", canvasMode);
  document.querySelectorAll(".board-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === currentBoardView);
  });
  document.querySelectorAll(".board-tool-btn, #btn-undo-stroke, #btn-clear-strokes").forEach(el => {
    el.disabled = !canvasMode;
  });
  if (canvasMode) {
    renderAllCards();
    renderNotes();
    redrawStrokes();
  } else {
    clearSelection();
    renderBoardView();
  }
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "board-card";
  if (selectedCardIds.has(card.id)) el.classList.add("selected");
  el.draggable = false;
  el.dataset.cardId = card.id;
  el.style.left = `${Number(card.x) || 0}px`;
  el.style.top = `${Number(card.y) || 0}px`;

  // 应用颜色
  const color = CARD_COLORS.find(c => c.id === card.color) || CARD_COLORS[0];
  el.style.background = color.bg;
  el.style.borderColor = color.border;

  const title = document.createElement("div");
  title.className = "board-card-title";
  title.textContent = card.title;
  el.appendChild(title);

  if (card.body) {
    const body = document.createElement("div");
    body.className = "board-card-body";
    body.textContent = card.body;
    el.appendChild(body);
  }

  if (card.arrows && card.arrows.length > 0) {
    const arrow = document.createElement("div");
    arrow.className = "board-card-arrow";
    arrow.textContent = `${card.arrows.join(", ")}`;
    el.appendChild(arrow);
  }

  // 删除按钮
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "board-card-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = t("删除卡片");
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await dlgConfirm(t('删除卡片 "{title}"？', { title: card.title }), { danger: true, okText: "删除" })) {
      const cards = state.boardCards.filter(c => c.id !== card.id);
      setBoardCards(cards);
    }
  });
  el.appendChild(deleteBtn);

  el.addEventListener("click", (e) => {
    if (currentToolMode !== "connect") return;
    e.stopPropagation();
    handleConnectCard(card.id);
  });

  // 双击编辑
  el.addEventListener("dblclick", () => {
    if (currentToolMode === "select") openCardModal(card);
  });

  el.addEventListener("pointerdown", (e) => {
    if (currentToolMode !== "select") return;
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    selectCard(card.id, e);
    const dragIds = selectedCardIds.has(card.id) ? [...selectedCardIds] : [card.id];
    const starts = new Map(state.boardCards
      .filter(c => dragIds.includes(c.id))
      .map(c => [c.id, { x: Number(c.x) || 0, y: Number(c.y) || 0 }]));
    activeCardDrag = {
      id: card.id,
      ids: dragIds,
      starts,
      startX: Number(card.x) || 0,
      startY: Number(card.y) || 0,
      pointerX: e.clientX,
      pointerY: e.clientY,
      moved: false,
    };
    el.classList.add("dragging");
    for (const id of dragIds) {
      boardCards.querySelector(`[data-card-id="${id}"]`)?.classList.add("dragging");
    }
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!activeCardDrag || activeCardDrag.id !== card.id) return;
    e.preventDefault();
    const dx = e.clientX - activeCardDrag.pointerX;
    const dy = e.clientY - activeCardDrag.pointerY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) activeCardDrag.moved = true;
    for (const id of activeCardDrag.ids || [card.id]) {
      const start = activeCardDrag.starts?.get(id) || { x: activeCardDrag.startX, y: activeCardDrag.startY };
      const node = boardCards.querySelector(`[data-card-id="${id}"]`);
      if (!node) continue;
      node.style.left = `${Math.max(0, Math.round(start.x + dx))}px`;
      node.style.top = `${Math.max(0, Math.round(start.y + dy))}px`;
    }
    drawArrows();
  });

  const finishDrag = (e) => {
    if (!activeCardDrag || activeCardDrag.id !== card.id) return;
    const drag = activeCardDrag;
    activeCardDrag = null;
    boardCards.querySelectorAll(".board-card.dragging").forEach(node => node.classList.remove("dragging"));
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!drag.moved) return;
    suppressCardClickUntil = Date.now() + 250;
    const updates = (drag.ids || [card.id]).map(id => {
      const node = boardCards.querySelector(`[data-card-id="${id}"]`);
      return { id, x: parseFloat(node?.style.left) || 0, y: parseFloat(node?.style.top) || 0 };
    });
    updateCardPositions(updates);
  };
  el.addEventListener("pointerup", finishDrag);
  el.addEventListener("pointercancel", finishDrag);
  el.addEventListener("click", (e) => {
    if (Date.now() < suppressCardClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  return el;
}

function renderAllCards() {
  const cards = normalizeBoardCardsLayout();
  if (cards !== state.boardCards) return;
  updateBoardLayerSize(cards);
  boardCards.innerHTML = "";
  svgOverlay = null;
  if (cards.length === 0) {
    boardEmpty.style.display = "";
    return;
  }
  boardEmpty.style.display = "none";
  for (const card of cards) {
    boardCards.appendChild(renderCard(card));
  }
  renderSelection();
  // 绘制箭头（延迟确定DOM 已更新）
  setTimeout(drawArrows, 50);
}

// ─ SVG 箭头绘制 ─────────────────────────────

function initSvgOverlay() {
  if (svgOverlay) return;
  svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgOverlay.setAttribute("class", "board-svg-layer board-svg-overlay");
  boardCards.insertBefore(svgOverlay, boardCards.firstChild);
}

function drawArrows() {
  if (!svgOverlay) initSvgOverlay();
  if (!svgOverlay) return;

  // 清空旧箭头
  svgOverlay.innerHTML = "";


  const containerRect = boardCards.getBoundingClientRect();
  const cards = state.boardCards;

  for (const card of cards) {
    if (!card.arrows || card.arrows.length === 0) continue;

    const fromEl = boardCards.querySelector(`[data-card-id="${card.id}"]`);
    if (!fromEl) continue;

    for (const targetId of card.arrows) {
      const toEl = boardCards.querySelector(`[data-card-id="${targetId}"]`);
      if (!toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      // 计算连接点（从卡片右侧中心到目标卡片左侧中心）
      const x1 = fromRect.right - containerRect.left;

      const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
      const x2 = toRect.left - containerRect.left;
      const y2 = toRect.top + toRect.height / 2 - containerRect.top;

      // 绘制贝塞尔曲线
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "var(--text-muted)");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("marker-end", "url(#arrowhead)");
      svgOverlay.appendChild(path);
    }
  }

  // 添加箭头标记定义
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-muted)" />
    </marker>
  `;
  svgOverlay.insertBefore(defs, svgOverlay.firstChild);
}

// ── 工具模式 ───────────────────────────────────

function setToolMode(mode) {
  currentToolMode = mode || "select";
  connectSourceId = null;
  document.querySelectorAll(".board-tool-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === currentToolMode);
  });
  if (boardCanvas) {
    boardCanvas.classList.remove("mode-select", "mode-connect", "mode-draw", "mode-text");
    boardCanvas.classList.add(`mode-${currentToolMode}`);
  }
  if (drawCanvas) {
    drawCanvas.classList.toggle("drawing", currentToolMode === "draw");
  }
  renderAllCards();
}

function getBoardPoint(e, target = boardCanvas) {
  const rect = target.getBoundingClientRect();
  return {
    x: e.clientX - rect.left + (target === boardCanvas ? boardCanvas.scrollLeft : 0),
    y: e.clientY - rect.top + (target === boardCanvas ? boardCanvas.scrollTop : 0),
  };
}

function setupBoardTools() {
  document.querySelectorAll(".board-tool-btn").forEach(btn => {
    btn.addEventListener("click", () => setToolMode(btn.dataset.mode || "select"));
  });
  document.getElementById("btn-undo-stroke")?.addEventListener("click", undoStroke);
  document.getElementById("btn-clear-strokes")?.addEventListener("click", clearStrokesAndNotes);
  setToolMode(currentToolMode);
}

function handleConnectCard(cardId) {
  if (!connectSourceId) {
    connectSourceId = cardId;
    boardCards.querySelectorAll(".board-card").forEach(el => {
      el.classList.toggle("connect-source", el.dataset.cardId === cardId);
    });
    return;
  }
  if (connectSourceId === cardId) {
    connectSourceId = null;
    renderAllCards();
    return;
  }
  const cards = state.boardCards.map(card => {
    if (card.id !== connectSourceId) return card;
    const arrows = Array.isArray(card.arrows) ? [...card.arrows] : [];
    if (!arrows.includes(cardId)) arrows.push(cardId);
    return { ...card, arrows };
  });
  connectSourceId = null;
  setBoardCards(cards);
}

function resizeDrawCanvas() {
  if (!drawCanvas || !boardCanvas) return;
  const rect = boardCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const cssWidth = Math.max(rect.width, boardCanvas.scrollWidth || rect.width);
  const cssHeight = Math.max(rect.height, boardCanvas.scrollHeight || rect.height);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  if (drawCanvas.width !== width || drawCanvas.height !== height) {
    drawCanvas.width = width;
    drawCanvas.height = height;
    drawCanvas.style.width = `${cssWidth}px`;
    drawCanvas.style.height = `${cssHeight}px`;
  }
  drawCtx = drawCanvas.getContext("2d");
  drawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  redrawStrokes();
}

function redrawStrokes() {
  if (!drawCtx || !drawCanvas) return;
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  for (const stroke of strokes) drawStroke(stroke);
  if (currentStroke) drawStroke(currentStroke);
}

function drawStroke(stroke) {
  if (!drawCtx || !stroke?.points?.length) return;
  drawCtx.save();
  drawCtx.strokeStyle = stroke.color || "#1A1A1A";
  drawCtx.lineWidth = stroke.width || 2;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.beginPath();
  stroke.points.forEach((point, index) => {
    if (index === 0) drawCtx.moveTo(point.x, point.y);
    else drawCtx.lineTo(point.x, point.y);
  });
  drawCtx.stroke();
  drawCtx.restore();
}

function setupDrawing() {
  if (!drawCanvas) return;
  drawCanvas.addEventListener("pointerdown", (e) => {
    if (currentToolMode !== "draw") return;
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    currentStroke = {
      color: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1A1A1A",
      width: 2,
      points: [getBoardPoint(e, drawCanvas)],
    };
    redrawStrokes();
  });
  drawCanvas.addEventListener("pointermove", (e) => {
    if (!currentStroke) return;
    currentStroke.points.push(getBoardPoint(e, drawCanvas));
    redrawStrokes();
  });
  const endStroke = (e) => {
    if (!currentStroke) return;
    if (currentStroke.points.length > 1) {
      strokes.push(currentStroke);
      setBoardStrokes(strokes);
    }
    currentStroke = null;
    try { drawCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    redrawStrokes();
  };
  drawCanvas.addEventListener("pointerup", endStroke);
  drawCanvas.addEventListener("pointercancel", endStroke);
}

function undoStroke() {
  if (strokes.length > 0) {
    strokes.pop();
    setBoardStrokes(strokes);
    redrawStrokes();
  }
}

function clearStrokesAndNotes() {
  strokes = [];
  currentStroke = null;
  setBoardStrokes([]);
  setBoardNotes([]);
  redrawStrokes();
}

function renderNotes() {
  if (!notesLayer) return;
  notesLayer.innerHTML = "";
  for (const note of state.boardNotes || []) {
    const wrap = document.createElement("div");
    wrap.className = "board-note-wrap";
    wrap.dataset.noteId = note.id;
    wrap.style.left = `${Number(note.x) || 0}px`;
    wrap.style.top = `${Number(note.y) || 0}px`;
    wrap.style.width = `${Math.max(90, Number(note.width) || 180)}px`;

    const textarea = document.createElement("textarea");
    textarea.className = "board-note";
    textarea.value = note.text || "";
    textarea.rows = 1;
    textarea.placeholder = t("输入文字");
    const autosize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(28, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener("input", () => {
      autosize();
      updateNote(note.id, { text: textarea.value }, { silent: true });
    });
    textarea.addEventListener("blur", () => {
      if (!textarea.value.trim()) removeNote(note.id);
      else updateNote(note.id, { text: textarea.value });
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") textarea.blur();
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") textarea.blur();
    });
    wrap.appendChild(textarea);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "board-note-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = t("删除");
    deleteBtn.addEventListener("click", () => removeNote(note.id));
    wrap.appendChild(deleteBtn);

    let drag = null;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target === textarea || e.target.closest("button")) return;
      e.preventDefault();
      drag = {
        pointerId: e.pointerId,
        startX: Number(note.x) || 0,
        startY: Number(note.y) || 0,
        pointerX: e.clientX,
        pointerY: e.clientY,
      };
      wrap.classList.add("dragging");
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.round(drag.startX + e.clientX - drag.pointerX));
      const y = Math.max(0, Math.round(drag.startY + e.clientY - drag.pointerY));
      wrap.style.left = `${x}px`;
      wrap.style.top = `${y}px`;
    });
    const finish = (e) => {
      if (!drag) return;
      drag = null;
      wrap.classList.remove("dragging");
      try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
      updateNote(note.id, { x: parseFloat(wrap.style.left) || 0, y: parseFloat(wrap.style.top) || 0 });
    };
    wrap.addEventListener("pointerup", finish);
    wrap.addEventListener("pointercancel", finish);

    notesLayer.appendChild(wrap);
    requestAnimationFrame(autosize);
  }
  updateBoardLayerSize();
}

function updateNote(id, patch, options = {}) {
  const notes = (state.boardNotes || []).map(note => note.id === id ? { ...note, ...patch } : note);
  if (options.silent) {
    state.boardNotes = notes;
    return;
  }
  setBoardNotes(notes);
}

function removeNote(id) {
  setBoardNotes((state.boardNotes || []).filter(note => note.id !== id));
}

function addNoteAt(x, y) {
  const note = {
    id: makeId("note_"),
    text: "",
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: 190,
  };
  setBoardNotes([...(state.boardNotes || []), note]);
  requestAnimationFrame(() => {
    const node = notesLayer?.querySelector(`[data-note-id="${note.id}"] textarea`);
    node?.focus();
  });
}

function setupTextNotes() {
  if (!boardCanvas || !notesLayer) return;
  boardCanvas.addEventListener("click", (e) => {
    if (currentToolMode !== "text") return;
    if (e.target.closest(".board-card, .board-note-wrap, .board-note, button")) return;
    const point = getBoardPoint(e);
    addNoteAt(point.x, point.y);
  });
}

// ── 拖拽排序 ─────────────────────────────────

function setupDragDrop() {
  boardCards.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  boardCards.addEventListener("drop", (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    const cards = [...state.boardCards];
    const dragIdx = cards.findIndex(c => c.id === draggedId);
    if (dragIdx === -1) return;

    const target = e.target.closest(".board-card");
    const [dragged] = cards.splice(dragIdx, 1);

    if (target && target.dataset.cardId !== draggedId) {
      const targetIdx = cards.findIndex(c => c.id === target.dataset.cardId);
      cards.splice(targetIdx, 0, dragged);
    } else {
      cards.push(dragged);
    }

    setBoardCards(cards);
  });
}

// ── 卡片模态框 ───────────────────────────────

function openCardModal(card = null) {
  editingCardId = card?.id || null;
  cardModalTitle.textContent = card ? t("编辑卡片") : t("添加卡片");
  cardInputTitle.value = card?.title || "";
  cardInputBody.value = card?.body || "";
  cardInputArrows.value = card?.arrows?.join(", ") || "";
  selectedColor = card?.color || "default";
  renderColorOptions();

  // 删除按钮只在编辑时显示
  btnCardDelete.style.display = card ? "" : "none";

  cardModal.classList.remove("hidden");
  cardInputTitle.focus();
}

function closeCardModal() {
  cardModal.classList.add("hidden");
  editingCardId = null;
}

function saveCard() {
  const title = cardInputTitle.value.trim();
  if (!title) {
    dlgToast(t("请输入标题"));
    return;
  }

  const body = cardInputBody.value.trim();
  const arrowsStr = cardInputArrows.value.trim();
  const arrows = arrowsStr ? arrowsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

  if (editingCardId) {
    // 更新现有卡片
    const cards = state.boardCards.map(c =>
      c.id === editingCardId
        ? { ...c, title, body, arrows, color: selectedColor }
        : c
    );
    setBoardCards(cards);
  } else {
    // 添加新卡片
    const card = placeNewCard({

      id: `c${Date.now().toString(36)}`,
      title,
      body,
      arrows,
      color: selectedColor,
    });
    addBoardCard(card);
  }

  closeCardModal();
}

async function deleteCard() {
  if (!editingCardId) return;
  if (!await dlgConfirm(t("确认删除此卡片？"), { danger: true, okText: t("删除") })) return;

  const cards = state.boardCards.filter(c => c.id !== editingCardId);
  setBoardCards(cards);
  closeCardModal();
}

function deleteSelectedCards() {
  if (!selectedCardIds.size) return false;
  const selected = new Set(selectedCardIds);
  const cards = state.boardCards
    .filter(card => !selected.has(card.id))
    .map(card => ({ ...card, arrows: (card.arrows || []).filter(id => !selected.has(id)) }));
  selectedCardIds.clear();
  setBoardCards(cards);
  return true;
}

function duplicateSelectedCards() {
  if (!selectedCardIds.size) return false;
  const selected = state.boardCards.filter(card => selectedCardIds.has(card.id));
  if (!selected.length) return false;
  const idMap = new Map(selected.map(card => [card.id, makeId("c")]));
  const clones = selected.map((card, index) => ({
    ...card,
    id: idMap.get(card.id),
    title: `${card.title || t("未命名")} 副本`,
    x: (Number(card.x) || 0) + 32 + index * 8,
    y: (Number(card.y) || 0) + 32 + index * 8,
    arrows: (card.arrows || []).map(id => idMap.get(id) || id),
    _isToolStep: false,
  }));
  selectedCardIds = new Set(clones.map(card => card.id));
  setBoardCards([...state.boardCards, ...clones]);
  return true;
}

function autoLayoutCards() {
  const cards = state.boardCards || [];
  if (!cards.length) return;
  const indegree = new Map(cards.map(card => [card.id, 0]));
  const outgoing = new Map(cards.map(card => [card.id, []]));
  for (const card of cards) {
    for (const target of card.arrows || []) {
      if (!indegree.has(target)) continue;
      indegree.set(target, indegree.get(target) + 1);
      outgoing.get(card.id).push(target);
    }
  }
  const level = new Map();
  const queue = cards.filter(card => (indegree.get(card.id) || 0) === 0).map(card => card.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    const base = level.get(id) || 0;
    for (const target of outgoing.get(id) || []) {
      const next = Math.max(level.get(target) || 0, base + 1);
      if (next !== level.get(target)) {
        level.set(target, next);
        queue.push(target);
      }
    }
  }
  cards.forEach((card, index) => {
    if (!level.has(card.id)) level.set(card.id, Math.floor(index / 4));
  });
  const groups = new Map();
  for (const card of cards) {
    const l = level.get(card.id) || 0;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(card);
  }
  const laidOut = cards.map(card => {
    const l = level.get(card.id) || 0;
    const group = groups.get(l) || [];
    const row = group.findIndex(item => item.id === card.id);
    return {
      ...card,
      x: CARD_LAYOUT.startX + l * (CARD_LAYOUT.width + 90),
      y: CARD_LAYOUT.startY + row * (118 + CARD_LAYOUT.gapY),
    };
  });
  setBoardCards(laidOut);
  requestAnimationFrame(focusBoardContent);
}

function focusBoardContent() {
  if (!boardCanvas) return;
  const cards = state.boardCards || [];
  if (!cards.length && !(state.boardNotes || []).length && !strokes.length) {
    boardCanvas.scrollTo({ left: 0, top: 0, behavior: "smooth" });
    return;
  }
  const xs = [
    ...cards.map(card => Number(card.x) || 0),
    ...(state.boardNotes || []).map(note => Number(note.x) || 0),
    ...strokes.flatMap(stroke => (stroke.points || []).map(p => Number(p.x) || 0)),
  ];
  const ys = [
    ...cards.map(card => Number(card.y) || 0),
    ...(state.boardNotes || []).map(note => Number(note.y) || 0),
    ...strokes.flatMap(stroke => (stroke.points || []).map(p => Number(p.y) || 0)),
  ];
  boardCanvas.scrollTo({
    left: Math.max(0, Math.min(...xs) - 40),
    top: Math.max(0, Math.min(...ys) - 40),
    behavior: "smooth",
  });
}

function setupBoardShortcuts() {
  if (!boardCanvas) return;
  boardCanvas.tabIndex = 0;
  boardCanvas.addEventListener("click", (e) => {
    if (currentToolMode === "select" && !e.target.closest(".board-card, .board-note-wrap, button")) {
      clearSelection();
    }
  });
  boardCanvas.addEventListener("keydown", async (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") {
      clearSelection();
      setToolMode("select");
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedCardIds.size) {
      e.preventDefault();
      if (await dlgConfirm(t("删除选中的 {n} 张卡片？", { n: selectedCardIds.size }), { danger: true, okText: t("删除") })) {
        deleteSelectedCards();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelectedCards();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      autoLayoutCards();
    }
  });
}

function renderColorOptions() {
  cardColorOptions.innerHTML = "";
  for (const color of CARD_COLORS) {
    const btn = document.createElement("button");
    btn.className = "card-color-btn" + (selectedColor === color.id ? " active" : "");
    btn.style.background = color.bg;
    btn.style.borderColor = color.border;
    btn.title = color.name;
    btn.addEventListener("click", () => {
      selectedColor = color.id;
      renderColorOptions();
    });
    cardColorOptions.appendChild(btn);
  }
}

// ── Mermaid 渲染 ─────────────────────────────

function cardsToMermaid(cards) {
  if (cards.length === 0) return "";
  const lines = ["flowchart LR"];

  for (const card of cards) {
    const safeTitle = card.title.replace(/"/g, '#quot;');
    lines.push(`  ${card.id}["${safeTitle}"]`);
  }

  for (const card of cards) {
    if (card.arrows) {
      for (const target of card.arrows) {
        lines.push(`  ${card.id} --> ${target}`);
      }
    }
  }

  return lines.join("\n");
}

function exportBoard() {
  const cards = state.boardCards || [];
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    "# " + t("SLATE 黑板导出"),
    "",
    `${t("导出时间")}: ${new Date().toLocaleString()}`,
    `${t("卡片数量")}: ${cards.length}`,
    "",
    `## ${t("卡片")}`,
    "",
  ];

  if (cards.length === 0) {
    lines.push(t("暂无卡片。"), "");
  } else {
    for (const card of cards) {
      lines.push(`### ${card.id} · ${card.title || t("未命名")}`);
      if (card.body) lines.push("", card.body);
      if (card.arrows?.length) lines.push("", `${t("关联")}: ${card.arrows.join(", ")}`);
      if (card.color && card.color !== "default") lines.push("", `${t("颜色")}: ${card.color}`);
      lines.push("");
    }
  }

  const mermaid = cardsToMermaid(cards);
  if (mermaid) {
    lines.push("## Mermaid", "", "```mermaid", mermaid, "```", "");
  }

  lines.push("## JSON", "", "```json", JSON.stringify(cards, null, 2), "```", "");
  if ((state.boardNotes || []).length) {
    lines.push("## Notes", "");
    for (const note of state.boardNotes) {
      if (note.text?.trim()) lines.push(`- ${note.text.trim()}`);
    }
    lines.push("");
  }
  if ((state.boardStrokes || []).length) {
    lines.push("## Drawing", "", `${t("笔画数量")}: ${state.boardStrokes.length}`, "");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slate-board-${date}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function renderMermaid() {
  const code = cardsToMermaid(state.boardCards);
  if (!code) {
    mermaidPreview.classList.add("hidden");
    return;
  }

  mermaidCode.textContent = code;

  if (!mermaidVisible) return;

  mermaidPreview.classList.remove("hidden");
  mermaidRenderArea.innerHTML = "";

  try {
    if (window.mermaid) {
      const { svg } = await mermaid.render("mermaid-svg-" + Date.now(), code);
      mermaidRenderArea.innerHTML = svg;
    }
  } catch (e) {
    mermaidRenderArea.innerHTML = `<div style="color:#999;font-size:11px;padding:8px;">${t("Mermaid 渲染失败：{msg}", { msg: e.message })}</div>`;
  }
}

function toggleMermaid() {
  mermaidVisible = !mermaidVisible;
  if (mermaidVisible) {
    mermaidPreview.classList.remove("hidden");
    renderMermaid();
  } else {
    mermaidPreview.classList.add("hidden");
  }
}

// ── AI 整理 ──────────────────────────────────

async function aiOrganize() {
  if (state.boardCards.length === 0) {
    dlgToast(t("黑板是空的，请先添加卡片"));
    return;
  }

  const modelId = state.currentModel?.id;
  if (!modelId) {
    dlgToast(t("请先选择模型"));
    return;
  }

  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    dlgToast(t("请先配置模型 API Key"));
    return;
  }

  // 构建卡片信息（含颜色）
  const cardsInfo = state.boardCards.map(c => {

    let info = `- [${c.id}] ${c.title}`;
    if (c.body) info += `: ${c.body}`;
    if (c.color && c.color !== "default") info += ` (颜色: ${c.color})`;
    return info;
  }).join("\n");

  const prompt = `你是一个结构化思维专家。请分析以下黑板卡片，进行整体重构优化。
当前卡片${cardsInfo}

请完成以下工作：
1. 优化卡片标题，使其简洁明确（不超过 10 字）
2. 补充/精炼卡片详情（不超过 3 行）
3. 根据逻辑关系建立 arrows 连接（指向目标卡片 ID）
4. 按语义分配颜色：
   - red = 问题/风险/阻塞
   - orange = 进行中/待处理
   - yellow = 想法/待讨论
   - green = 已完成/通过
   - blue = 信息/数据/资源
   - purple = 创意/设计
   - default = 未分类

只输出 JSON 数组，不要 Markdown，不要解释。每项包含 id、title、body、arrows、color。保持原有卡片 ID 不变。
示例：[{"id":"c1","title":"需求分析","body":"收集并整理用户需求","arrows":["c2"],"color":"blue"}]`;

  const messages = [{ role: "user", content: prompt }];
  let response = "";

  try {
    for await (const chunk of streamChat({
      model: modelId,
      messages,
      api_key: apiKey,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    })) {
      response += chunk;
    }

    // 解析 JSON
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      dlgToast(t("AI 返回格式错误，请重试"));
      return;
    }

    const newCards = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(newCards)) {
      dlgToast(t("AI 返回格式错误，请重试"));
      return;
    }

    const VALID_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];

    // 全量更新：保留原 ID 匹配，应用 title/body/arrows/color 全部字段
    const updatedCards = state.boardCards.map(card => {
      const aiCard = newCards.find(c => c.id === card.id);
      if (!aiCard) return card;
      return {
        ...card,
        title: aiCard.title || card.title,
        body: aiCard.body ?? card.body,
        arrows: Array.isArray(aiCard.arrows) ? aiCard.arrows : (card.arrows || []),
        color: VALID_COLORS.includes(aiCard.color) ? aiCard.color : card.color,
      };
    });

    setBoardCards(updatedCards);
    requestAnimationFrame(autoLayoutCards);
    dlgToast(t("AI 重构完成"));
  } catch (e) {
    dlgToast(t("AI 整理失败：{msg}", { msg: e.message }));
  }
}

// ── LLM 输出解析卡片 ───────────────────────

function parseCardsFromLLM(text) {
  const cards = [];
  const jsonMatch = text.match(/\[.*\]/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          cards.push({
            id: item.id || `c${Date.now().toString(36)}_${cards.length}`,
            title: item.title || item.name || t("未命名"),
            body: item.body || item.description || "",
            arrows: item.arrows || item.depends || [],
            color: item.color || "default",
          });
        }
      }
    } catch (e) { /* ignore invalid JSON */ }
  }
  return cards;
}

// ── 初始化 ──────────────────────────────────

function initWhiteboard() {
  boardCanvas = document.getElementById("whiteboard-canvas");
  boardCards = document.getElementById("board-cards");
  boardEmpty = document.getElementById("board-empty");
  drawCanvas = document.getElementById("board-draw-canvas");
  notesLayer = document.getElementById("board-notes");
  selectionInfo = document.getElementById("board-selection-info");
  boardViewPanel = document.getElementById("board-view-panel");
  mermaidPreview = document.getElementById("mermaid-preview");
  mermaidCode = document.getElementById("mermaid-code");
  mermaidRenderArea = document.getElementById("mermaid-render-area");

  // 卡片模态框
  cardModal = document.getElementById("card-modal");
  cardModalTitle = document.getElementById("card-modal-title");
  cardInputTitle = document.getElementById("card-input-title");
  cardInputBody = document.getElementById("card-input-body");
  cardInputArrows = document.getElementById("card-input-arrows");
  cardColorOptions = document.getElementById("card-color-options");
  btnCardDelete = document.getElementById("btn-card-delete");
  btnCardSave = document.getElementById("btn-card-save");
  btnCardCancel = document.getElementById("btn-card-cancel");

  // 添加卡片按钮
  document.getElementById("btn-add-card").addEventListener("click", () => openCardModal());
  document.getElementById("btn-layout-board")?.addEventListener("click", autoLayoutCards);
  document.getElementById("btn-focus-board")?.addEventListener("click", focusBoardContent);

  // AI 整理按钮
  document.getElementById("btn-ai-organize").addEventListener("click", aiOrganize);

  // Mermaid 切换按钮
  document.getElementById("btn-toggle-mermaid").addEventListener("click", toggleMermaid);
  document.getElementById("btn-export-board")?.addEventListener("click", exportBoard);
  document.getElementById("btn-close-mermaid").addEventListener("click", () => {
    mermaidVisible = false;
    mermaidPreview.classList.add("hidden");
  });

  // 清空黑板
  document.getElementById("btn-clear-board").addEventListener("click", async () => {
    if (await dlgConfirm(t("确认清空黑板？"), { danger: true, okText: t("清空") })) {
      selectedCardIds.clear();
      setBoardCards([]);
      setBoardNotes([]);
      setBoardStrokes([]);
    }
  });

  // 模态框按钮
  btnCardSave.addEventListener("click", saveCard);
  btnCardCancel.addEventListener("click", closeCardModal);
  btnCardDelete.addEventListener("click", deleteCard);

  // 关闭模态框
  cardModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeCardModal);
  });

  // Enter 保存
  cardInputTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCard();
  });

  setupDragDrop();
  setupBoardTools();
  document.querySelectorAll(".board-view-btn").forEach(btn => {
    btn.addEventListener("click", () => setBoardView(btn.dataset.view || "canvas"));
  });
  setupDrawing();
  setupTextNotes();
  setupBoardShortcuts();
  strokes = Array.isArray(state.boardStrokes) ? [...state.boardStrokes] : [];
  resizeDrawCanvas();
  if (window.ResizeObserver && boardCanvas) {
    new ResizeObserver(resizeDrawCanvas).observe(boardCanvas);
  } else {
    window.addEventListener("resize", resizeDrawCanvas);
  }

  // 初始化 Mermaid
  function initMermaidTheme() {
    if (window.mermaid) {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "neutral",
        flowchart: { curve: "basis", padding: 12 },
        themeVariables: isDark
          ? { primaryColor: "#1E1E1E", primaryTextColor: "#E0E0E0", primaryBorderColor: "#2A2A2A", lineColor: "#555", secondaryColor: "#161616" }
          : {},
      });
    }
  }
  initMermaidTheme();

  subscribe("theme", () => {
    initMermaidTheme();
    redrawStrokes();
    if (state.boardCards.length > 0) renderMermaid();
  });

  subscribe("boardCards", () => {
    renderAllCards();
    renderMermaid();
    renderBoardView();
  });
  subscribe("boardNotes", renderNotes);
  subscribe("boardStrokes", (next) => {
    strokes = Array.isArray(next) ? [...next] : [];
    redrawStrokes();
  });

  renderAllCards();
  renderNotes();
  redrawStrokes();
  setBoardView(currentBoardView);
}

// ── 自动记录：工具执行步骤可视化 ─────────────────────────────────

/** 工具执行时自动创建步骤卡片，形成逻辑链 */
function addToolStepCard(toolName, params, status = "running") {
  // 生成步骤编号
  const stepCards = state.boardCards.filter(c => c._isToolStep);
  const stepNum = stepCards.length + 1;
  
  // 工具图标映射
  const toolIcons = {
    file_tree: "📁", file_peek: "👀", file_edit: "✏️", file_create: "📄",
    terminal: "💻", code_scan: "🔍", todo_scan: "✓", board_add: "🗒",
    board_update: "🗒", board_batch: "🗒", board_read: "🗒",
    knowledge_search: "🔎", knowledge_add: "📚", memory_manage: "🧠",
  };
  const icon = toolIcons[toolName] || "⚙️";
  
  // 工具描述映射
  const toolDescs = {
    file_tree: "查看目录结构", file_peek: "读取文件内容", file_edit: "编辑文件",
    file_create: "创建文件", terminal: "执行命令", code_scan: "代码扫描",
    todo_scan: "任务扫描", board_add: "添加卡片", board_update: "更新卡片",
    board_batch: "批量操作", board_read: "读取黑板", knowledge_search: "搜索知识",
    knowledge_add: "添加知识", memory_manage: "管理记忆",
  };
  const desc = toolDescs[toolName] || toolName;
  
  // 提取关键参数作为摘要
  let summary = "";
  if (params.path) summary = params.path;
  else if (params.command) summary = params.command.slice(0, 40);
  else if (params.query) summary = params.query;
  else if (params.title) summary = params.title;
  else if (params.directory) summary = params.directory;
  
  // 状态颜色：running=yellow, done=green, error=red
  const statusColors = { running: "yellow", done: "green", error: "red" };
  const color = statusColors[status] || "default";
  
  // 创建步骤卡片
  const card = placeNewCard({
    id: makeId("step_"),
    title: `${icon} 步骤 ${stepNum}: ${desc}`,
    body: summary || "(无参数)",
    color,
    arrows: [],
    _isToolStep: true,
    _toolName: toolName,
    _stepNum: stepNum,
    _status: status,
    _timestamp: Date.now(),
  });
  
  // 连接到上一步
  if (stepCards.length > 0) {
    const prevCard = stepCards[stepCards.length - 1];
    card.arrows = [prevCard.id];
  }
  
  addBoardCard(card);
  return card.id;
}

/** 更新步骤卡片状态 */
function updateToolStepCard(cardId, status, result = "") {
  const card = state.boardCards.find(c => c.id === cardId);
  if (!card || !card._isToolStep) return;
  
  const statusColors = { running: "yellow", done: "green", error: "red" };
  card.color = statusColors[status] || card.color;
  card._status = status;
  
  // 更新 body 显示结果摘要
  if (result && status === "done") {
    const maxLen = 100;
    card.body = result.length > maxLen ? result.slice(0, maxLen) + "..." : result;
  } else if (status === "error") {
    card.body = "❌ " + (result || "执行失败");
  }
  
  // 触发更新
  setBoardCards([...state.boardCards]);
}

/** 清除所有步骤卡片 */
function clearToolStepCards() {
  const nonStepCards = state.boardCards.filter(c => !c._isToolStep);
  setBoardCards(nonStepCards);
}

export { initWhiteboard, parseCardsFromLLM, cardsToMermaid, addToolStepCard, updateToolStepCard, clearToolStepCards };
