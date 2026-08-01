/**
 * SLATE 白板组件 v2：卡片编辑、颜色标签、AI 整理
 */

import { state, subscribe, setBoardCards, addBoardCard, getModelKey } from "../store.js?v=20260801-04";
import { streamChat } from "../services/api.js?v=20260801-04";

let boardCanvas, boardCards, boardEmpty, drawCanvas, drawCtx, notesLayer, mermaidPreview, mermaidCode, mermaidRenderArea;
let cardModal, cardModalTitle, cardInputTitle, cardInputBody, cardInputArrows, cardColorOptions;
let btnCardDelete, btnCardSave, btnCardCancel;
let editingCardId = null;
let selectedColor = "default";
let svgOverlay = null;
let mermaidVisible = false;
let currentToolMode = "select";
let connectSourceId = null;
let strokes = [];
let currentStroke = null;

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

// ── 卡片渲染 ─────────────────────────────────

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "board-card";
  el.draggable = currentToolMode === "select";
  el.dataset.cardId = card.id;

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
    arrow.textContent = `→ ${card.arrows.join(", ")}`;
    el.appendChild(arrow);
  }

  // 删除按钮
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "board-card-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = "删除卡片";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`删除卡片"${card.title}"？`)) {
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

  // 拖拽事件
  el.addEventListener("dragstart", (e) => {
    if (currentToolMode !== "select") {
      e.preventDefault();
      return;
    }
    el.classList.add("dragging");
    e.dataTransfer.setData("text/plain", card.id);
    e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
  });

  return el;
}

function renderAllCards() {
  boardCards.innerHTML = "";
  svgOverlay = null;
  if (state.boardCards.length === 0) {
    boardEmpty.style.display = "";
    return;
  }
  boardEmpty.style.display = "none";
  for (const card of state.boardCards) {
    boardCards.appendChild(renderCard(card));
  }
  // 绘制箭头（延迟确保 DOM 已更新）
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

function getCanvasPoint(e) {
  const rect = drawCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function resizeDrawCanvas() {
  if (!drawCanvas || !boardCanvas) return;
  const rect = boardCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (drawCanvas.width !== width || drawCanvas.height !== height) {
    drawCanvas.width = width;
    drawCanvas.height = height;
    drawCanvas.style.width = `${rect.width}px`;
    drawCanvas.style.height = `${rect.height}px`;
  }
  drawCtx = drawCanvas.getContext("2d");
  drawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  redrawStrokes();
}

function redrawStrokes() {
  if (!drawCtx || !drawCanvas) return;
  const rect = drawCanvas.getBoundingClientRect();
  drawCtx.clearRect(0, 0, rect.width, rect.height);
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
      points: [getCanvasPoint(e)],
    };
    redrawStrokes();
  });
  drawCanvas.addEventListener("pointermove", (e) => {
    if (!currentStroke) return;
    currentStroke.points.push(getCanvasPoint(e));
    redrawStrokes();
  });
  const endStroke = (e) => {
    if (!currentStroke) return;
    if (currentStroke.points.length > 1) strokes.push(currentStroke);
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
    redrawStrokes();
  }
}

function clearStrokesAndNotes() {
  strokes = [];
  currentStroke = null;
  if (notesLayer) notesLayer.innerHTML = "";
  redrawStrokes();
}

function setupTextNotes() {
  if (!boardCanvas || !notesLayer) return;
  boardCanvas.addEventListener("click", (e) => {
    if (currentToolMode !== "text") return;
    if (e.target.closest(".board-card, .board-note, button")) return;
    const rect = boardCanvas.getBoundingClientRect();
    const note = document.createElement("textarea");
    note.className = "board-note";
    note.value = "";
    note.style.left = `${e.clientX - rect.left + boardCanvas.scrollLeft}px`;
    note.style.top = `${e.clientY - rect.top + boardCanvas.scrollTop}px`;
    note.rows = 1;
    note.addEventListener("input", () => {
      note.style.height = "auto";
      note.style.height = `${Math.max(24, note.scrollHeight)}px`;
    });
    note.addEventListener("keydown", (event) => {
      if (event.key === "Escape") note.blur();
    });
    notesLayer.appendChild(note);
    note.focus();
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
  cardModalTitle.textContent = card ? "编辑卡片" : "添加卡片";
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
    alert("请输入标题");
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
    const card = {
      id: `c${Date.now().toString(36)}`,
      title,
      body,
      arrows,
      color: selectedColor,
    };
    addBoardCard(card);
  }

  closeCardModal();
}

function deleteCard() {
  if (!editingCardId) return;
  if (!confirm("确认删除此卡片？")) return;

  const cards = state.boardCards.filter(c => c.id !== editingCardId);
  setBoardCards(cards);
  closeCardModal();
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
    "# SLATE 黑板导出",
    "",
    `导出时间: ${new Date().toLocaleString()}`,
    `卡片数量: ${cards.length}`,
    "",
    "## 卡片",
    "",
  ];

  if (cards.length === 0) {
    lines.push("暂无卡片。", "");
  } else {
    for (const card of cards) {
      lines.push(`### ${card.id} · ${card.title || "未命名"}`);
      if (card.body) lines.push("", card.body);
      if (card.arrows?.length) lines.push("", `关联: ${card.arrows.join(", ")}`);
      if (card.color && card.color !== "default") lines.push("", `颜色: ${card.color}`);
      lines.push("");
    }
  }

  const mermaid = cardsToMermaid(cards);
  if (mermaid) {
    lines.push("## Mermaid", "", "```mermaid", mermaid, "```", "");
  }

  lines.push("## JSON", "", "```json", JSON.stringify(cards, null, 2), "```", "");

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
    mermaidRenderArea.innerHTML = `<div style="color:#999;font-size:11px;padding:8px;">Mermaid 渲染失败：${e.message}</div>`;
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
    alert("黑板是空的，请先添加卡片");
    return;
  }

  const modelId = state.currentModel?.id;
  if (!modelId) {
    alert("请先选择模型");
    return;
  }

  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    alert("请先配置模型 API Key");
    return;
  }

  // 构建提示词
  const cardsInfo = state.boardCards.map(c =>
    `- [${c.id}] ${c.title}${c.body ? ": " + c.body : ""}`
  ).join("\n");

  const prompt = `请将以下卡片整理成合理的流程图结构，输出 JSON 数组格式，每个卡片包含 id、title、body、arrows（指向其他卡片 ID 的数组）。

当前卡片：
${cardsInfo}

要求：
1. 保持原有卡片 ID 不变
2. 根据逻辑关系添加 arrows 字段建立连接
3. 输出纯 JSON，不要其他文字

输出格式示例：
[{"id":"c1","title":"开始","body":"","arrows":["c2"]},{"id":"c2","title":"结束","body":"","arrows":[]}]`;

  // 调用 AI
  const messages = [{ role: "user", content: prompt }];
  let response = "";

  try {
    for await (const chunk of streamChat({
      model: modelId,
      messages,
      api_key: apiKey,
      temperature: 0.3,
      max_tokens: 2048,
      stream: true,
    })) {
      response += chunk;
    }

    // 解析 JSON
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      alert("AI 返回格式错误，请重试");
      return;
    }

    const newCards = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(newCards)) {
      alert("AI 返回格式错误，请重试");
      return;
    }

    // 更新卡片（保留原有内容，只更新 arrows）
    const updatedCards = state.boardCards.map(card => {
      const aiCard = newCards.find(c => c.id === card.id);
      return aiCard ? { ...card, arrows: aiCard.arrows || [] } : card;
    });

    setBoardCards(updatedCards);
    alert("AI 整理完成！");
  } catch (e) {
    alert(`AI 整理失败：${e.message}`);
  }
}

// ── 从 LLM 输出解析卡片 ─────────────────────

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
            title: item.title || item.name || "未命名",
            body: item.body || item.description || "",
            arrows: item.arrows || item.depends || [],
            color: item.color || "default",
          });
        }
      }
    } catch (e) { /* 非 JSON */ }
  }
  return cards;
}

// ── 初始化 ───────────────────────────────────

function initWhiteboard() {
  boardCanvas = document.getElementById("whiteboard-canvas");
  boardCards = document.getElementById("board-cards");
  boardEmpty = document.getElementById("board-empty");
  drawCanvas = document.getElementById("board-draw-canvas");
  notesLayer = document.getElementById("board-notes");
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
  document.getElementById("btn-clear-board").addEventListener("click", () => {
    if (confirm("确认清空黑板？")) setBoardCards([]);
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
  setupDrawing();
  setupTextNotes();
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
  });

  renderAllCards();
}

export { initWhiteboard, parseCardsFromLLM, cardsToMermaid };
