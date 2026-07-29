/**
 * SLATE 白板组件：Mermaid 渲染、卡片拖拽
 */

import { state, subscribe, setBoardCards, addBoardCard } from "../store.js";

let boardCards, boardEmpty, mermaidPreview, mermaidCode;

// ── 卡片渲染 ─────────────────────────────────

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "board-card";
  el.draggable = true;
  el.dataset.cardId = card.id;

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

  // 拖拽事件
  el.addEventListener("dragstart", (e) => {
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
  if (state.boardCards.length === 0) {
    boardEmpty.style.display = "";
    return;
  }
  boardEmpty.style.display = "none";
  for (const card of state.boardCards) {
    boardCards.appendChild(renderCard(card));
  }
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

    // 找到放置位置
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

// ── Mermaid 渲染 ─────────────────────────────

/**
 * 将卡片数据转换为 Mermaid flowchart
 */
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

async function renderMermaid() {
  const code = cardsToMermaid(state.boardCards);
  if (!code) {
    mermaidPreview.classList.add("hidden");
    return;
  }

  mermaidCode.textContent = code;
  mermaidPreview.classList.remove("hidden");

  // 渲染 Mermaid 图表
  try {
    if (window.mermaid) {
      const container = mermaidPreview;
      // 清除之前的渲染
      const oldSvg = container.querySelector("svg");
      if (oldSvg) oldSvg.remove();
      const oldError = container.querySelector(".mermaid-error");
      if (oldError) oldError.remove();

      mermaidCode.style.display = "block";
      await mermaid.run({ nodes: [mermaidCode] });
      mermaidCode.style.display = "none";
    }
  } catch (e) {
    const errEl = document.createElement("div");
    errEl.className = "mermaid-error";
    errEl.textContent = `Mermaid 渲染失败: ${e.message}`;
    errEl.style.cssText = "color:#999;font-size:11px;padding:8px;";
    mermaidPreview.appendChild(errEl);
  }
}

// ── 添加卡片 ─────────────────────────────────

function showAddCardDialog() {
  const title = prompt("卡片标题：");
  if (!title) return;
  const body = prompt("卡片描述（可选）：") || "";
  const arrowsStr = prompt("箭头指向（输入目标卡片 ID，多个用逗号分隔，可留空）：") || "";
  const arrows = arrowsStr ? arrowsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

  const card = {
    id: `c${Date.now().toString(36)}`,
    title,
    body,
    arrows,
  };
  addBoardCard(card);
}

/**
 * 从 LLM 输出解析卡片数据
 */
function parseCardsFromLLM(text) {
  const cards = [];
  // 尝试解析 JSON 格式的卡片
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
          });
        }
      }
    } catch (e) { /* 非 JSON */ }
  }
  return cards;
}

// ── 初始化 ───────────────────────────────────

function initWhiteboard() {
  boardCards = document.getElementById("board-cards");
  boardEmpty = document.getElementById("board-empty");
  mermaidPreview = document.getElementById("mermaid-preview");
  mermaidCode = document.getElementById("mermaid-code");

  document.getElementById("btn-add-card").addEventListener("click", showAddCardDialog);
  document.getElementById("btn-clear-board").addEventListener("click", () => {
    if (confirm("确认清空黑板？")) setBoardCards([]);
  });

  setupDragDrop();

  // 初始化 Mermaid（根据当前主题）
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

  // 主题切换时重新初始化 Mermaid 并重渲染
  subscribe("theme", () => {
    initMermaidTheme();
    if (state.boardCards.length > 0) renderMermaid();
  });

  subscribe("boardCards", () => {
    renderAllCards();
    renderMermaid();
  });

  // 初始渲染
  renderAllCards();
}

export { initWhiteboard, parseCardsFromLLM, cardsToMermaid };
