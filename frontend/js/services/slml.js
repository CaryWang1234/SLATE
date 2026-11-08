/**
 * SLML — SLATE Layout Markup Language v1
 *
 * 一块黑板一个文档：显式标题、卡片/文字/笔迹、坐标与颜色、视图偏好。
 * 三条硬约束：
 * 1. 严格：未知指令/字段/版本一律带行号报错，绝不静默丢弃——丢字段比拒绝打开更糟。
 * 2. 无损：parse → serialize → parse 必须深相等；工具步骤卡属于运行现场，默认不写。
 * 3. 纯文本：不 eval、不拼 HTML，所有正文都只当字符串。
 */

export const SLML_VERSION = 1;

export const SLML_LIMITS = {
  bytes: 8 * 1024 * 1024,
  line: 16 * 1024,
  cards: 2000,
  notes: 2000,
  strokes: 20000,
  points: 200000,
};

const BOARD_VIEWS = ["git", "flow", "kanban", "outline", "workflow"];
const CARD_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i;

function fail(line, message) {
  const err = new Error(`第 ${line} 行：${message}`);
  err.name = "SlmlError";
  err.line = line;
  throw err;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unquote(raw, line) {
  const s = raw.trim();
  if (!s.startsWith('"')) return s;
  if (!s.endsWith('"') || s.length < 2) fail(line, "引号没有闭合");
  let out = "";
  for (let i = 1; i < s.length - 1; i += 1) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) fail(line, "反斜杠没有转义对象");
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 1;
    } else if (ch === '"') {
      fail(line, "引号内出现未转义的引号");
    } else {
      out += ch;
    }
  }
  return out;
}

function quote(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

function parseInt10(raw, line, label, min, max) {
  if (!/^[-+]?\d+$/.test(String(raw).trim())) fail(line, `${label} 必须是整数`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) fail(line, `${label} 超出范围 ${min}..${max}`);
  return n;
}

function parseCoord(raw, line, label) {
  return parseInt10(raw, line, label, 0, 100000);
}

function parsePoint(raw, line) {
  const m = /^([-+]?\d+(?:\.\d{1,2})?)\s*,\s*([-+]?\d+(?:\.\d{1,2})?)$/.exec(raw.trim());
  if (!m) fail(line, "点坐标应为 x,y（最多两位小数）");
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail(line, "点坐标不是有效数字");
  if (x < 0 || x > 100000 || y < 0 || y > 100000) fail(line, "点坐标超出范围 0..100000");
  return { x, y };
}

function normalizeHex(raw, line) {
  if (!HEX_RE.test(raw)) fail(line, `颜色应为 #RGB 或 #RRGGBB：${raw}`);
  const hex = raw.slice(1);
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return `#${full.toUpperCase()}`;
}

function toHexColor(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (HEX_RE.test(raw)) {
    const hex = raw.slice(1);
    return `#${(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex).toUpperCase()}`;
  }
  const m = RGB_RE.exec(raw);
  if (!m) return "";
  const parts = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Number(n))));
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function parseAttrs(rest, line) {
  const attrs = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i += 1;
    if (i >= rest.length) break;
    const keyStart = i;
    while (i < rest.length && /[A-Za-z0-9_-]/.test(rest[i])) i += 1;
    const key = rest.slice(keyStart, i);
    if (!key) fail(line, "属性格式错误");
    if (rest[i] !== "=") fail(line, `属性 ${key} 缺少 =`);
    i += 1;
    if (i >= rest.length) fail(line, `属性 ${key} 没有值`);
    let value;
    if (rest[i] === '"') {
      let out = "";
      let closed = false;
      i += 1;
      while (i < rest.length) {
        const ch = rest[i];
        if (ch === "\\") {
          const next = rest[i + 1];
          if (next === undefined) fail(line, "引号没有闭合");
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        if (ch === '"') { closed = true; i += 1; break; }
        out += ch;
        i += 1;
      }
      if (!closed) fail(line, "引号没有闭合");
      value = out;
    } else {
      const valueStart = i;
      while (i < rest.length && !/\s/.test(rest[i])) i += 1;
      value = rest.slice(valueStart, i);
      if (!value) fail(line, `属性 ${key} 没有值`);
    }
    if (Object.prototype.hasOwnProperty.call(attrs, key)) fail(line, `属性 ${key} 重复`);
    attrs[key] = value;
  }
  return attrs;
}

function assertKnownAttrs(attrs, allowed, line, kind) {
  for (const key of Object.keys(attrs)) {
    if (!allowed.includes(key)) fail(line, `${kind} 不认识属性 ${key}`);
  }
}

function parseCardAttrs(attrs, line) {
  assertKnownAttrs(attrs, ["x", "y", "color"], line, "卡片");
  const card = {
    x: parseCoord(attrs.x, line, "x"),
    y: parseCoord(attrs.y, line, "y"),
    color: "default",
  };
  if (attrs.color !== undefined) {
    const color = String(attrs.color).toLowerCase();
    if (!CARD_COLORS.includes(color)) fail(line, `卡片颜色应为 ${CARD_COLORS.join("/")}`);
    card.color = color;
  }
  return card;
}

function parseNoteAttrs(attrs, line) {
  assertKnownAttrs(attrs, ["x", "y", "w"], line, "文字");
  const note = {
    x: parseCoord(attrs.x, line, "x"),
    y: parseCoord(attrs.y, line, "y"),
    width: 180,
  };
  if (attrs.w !== undefined) note.width = parseInt10(attrs.w, line, "w", 90, 2000);
  return note;
}

function parseStrokeAttrs(attrs, line) {
  assertKnownAttrs(attrs, ["color", "width"], line, "笔迹");
  const stroke = {
    color: "#1A1A1A",
    width: 2,
    points: [],
  };
  if (attrs.color !== undefined) stroke.color = normalizeHex(attrs.color, line);
  if (attrs.width !== undefined) {
    const width = Number(attrs.width);
    if (!Number.isFinite(width) || width < 1 || width > 24) fail(line, "笔宽超出范围 1..24");
    stroke.width = Math.round(width * 100) / 100;
  }
  return stroke;
}

function parseFieldLine(raw, line, item) {
  if (!raw.startsWith("  ")) fail(line, "块内字段需缩进 2 个空格");
  if (raw.startsWith("   ")) fail(line, "块内字段只缩进 2 个空格");
  const content = raw.slice(2);
  if (!content.trim()) return false;
  if (content.trimStart().startsWith("#")) return false;
  const m = /^([a-z][a-z0-9-]*):(.*)$/.exec(content);
  if (!m) fail(line, "字段格式应为 key: value");
  const key = m[1];
  const value = m[2].trim();

  if (key === "body" || key === "text") {
    if (item.kind !== "card" && item.kind !== "note") fail(line, `${key} 不能出现在 ${item.kind} 块里`);
    if (item.fields[key] !== undefined) fail(line, `${key} 重复`);
    item.fields[key] = "";
    if (value === "|") {
      item.literalKey = key;
      return true;
    }
    item.fields[key] = unquote(value, line);
    return false;
  }

  if (key === "title") {
    if (item.kind !== "card") fail(line, "title 只属于卡片");
    if (item.fields.title !== undefined) fail(line, "title 重复");
    item.fields.title = unquote(value, line);
    return false;
  }

  if (key === "link") {
    if (item.kind !== "card") fail(line, "link 只属于卡片");
    if (item.fields.link !== undefined) fail(line, "link 重复");
    const ids = value.split(/[,\s]+/).filter(Boolean);
    for (const id of ids) {
      if (!ID_RE.test(id)) fail(line, `link 里的 ID 不合法：${id}`);
    }
    item.fields.link = ids;
    return false;
  }

  if (key === "p") {
    if (item.kind !== "stroke") fail(line, "p 只属于笔迹");
    item.fields.points.push(parsePoint(value, line));
    return false;
  }

  fail(line, `${item.kind} 块不认识字段 ${key}`);
  return false;
}

/**
 * 解析一份 .slml 文档。
 * @returns {{board: object, version: number}}
 */
export function parseSlml(text, options = {}) {
  const limits = { ...SLML_LIMITS, ...(options.limits || {}) };
  const source = String(text ?? "");
  if (source.length > limits.bytes) fail(0, `文件超过 ${Math.round(limits.bytes / 1024 / 1024)}MB 上限`);

  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  let i = 0;
  let version = 0;
  let board = null;
  let item = null;
  let literal = null;
  let totalPoints = 0;
  const cardLines = new Map();

  const head = () => {
    if (!board) fail(i + 1, "缺少 @board 指令");
    return board;
  };

  const finishLiteral = () => {
    if (!literal) return;
    if (item) item.fields[item.literalKey] = literal.lines.join("\n");
    else fail(literal.line, "原文块没有归属");
    literal = null;
  };

  const finishItem = () => {
    finishLiteral();
    const b = head();
    if (item.kind === "card") {
      if (!item.fields.title) item.fields.title = "未命名";
      b.cards.push({
        id: item.id,
        title: item.fields.title,
        body: item.fields.body || "",
        arrows: item.fields.link || [],
        color: item.attrs.color,
        x: item.attrs.x,
        y: item.attrs.y,
      });
      cardLines.set(item.id, item.line);
    } else if (item.kind === "note") {
      b.notes.push({
        id: item.id,
        text: item.fields.text || "",
        x: item.attrs.x,
        y: item.attrs.y,
        width: item.attrs.width,
      });
    } else {
      if (!item.fields.points.length) fail(item.line, "笔迹至少要有一个 p: 点");
      totalPoints += item.fields.points.length;
      if (totalPoints > limits.points) fail(item.line, `笔迹点总数超过 ${limits.points} 上限`);
      b.strokes.push({
        id: item.id,
        color: item.attrs.color,
        width: item.attrs.width,
        points: item.fields.points,
      });
    }
    item = null;
  };

  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.length > limits.line) fail(lineNo, `单行超过 ${limits.line} 字符上限`);
    const trimmed = raw.trim();

    if (!version) {
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = /^@slml\s+(\d+)$/.exec(trimmed);
      if (!m) fail(lineNo, "首条指令必须是 @slml <版本>");
      version = Number(m[1]);
      if (version !== SLML_VERSION) fail(lineNo, `不支持的版本 ${version}（本机只认 ${SLML_VERSION}）`);
      continue;
    }

    if (item) {
      if (raw === "@end") {
        finishItem();
        continue;
      }
      if (raw.startsWith("@")) fail(lineNo, "块内不能出现指令行，先用 @end 收块");

      if (literal) {
        if (raw === "") {
          literal.lines.push("");
          continue;
        }
        if (raw.startsWith("    ")) {
          literal.lines.push(raw.slice(4));
          continue;
        }
        finishLiteral();
      }

      if (!trimmed) continue;
      if (trimmed.startsWith("#")) continue;
      if (parseFieldLine(raw, lineNo, item)) literal = { line: lineNo, lines: [] };
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("@board")) {
      if (board) fail(lineNo, "@board 只能出现一次");
      const m = /^@board\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s+("(?:[^"\\]|\\.)*"))?(.*)$/.exec(trimmed);
      if (!m) fail(lineNo, "@board 格式应为：@board <id> \"标题\" [view=...] [steps=...]");
      const attrs = parseAttrs(m[3] || "", lineNo);
      assertKnownAttrs(attrs, ["view", "steps"], lineNo, "黑板");
      let view = "kanban";
      if (attrs.view !== undefined) {
        if (attrs.view === "none" || attrs.view === "") view = "";
        else if (!BOARD_VIEWS.includes(attrs.view)) fail(lineNo, `视图应为 ${BOARD_VIEWS.join("/")} 或 none`);
        else view = attrs.view;
      }
      let showSteps = false;
      if (attrs.steps !== undefined) {
        if (attrs.steps !== "0" && attrs.steps !== "1") fail(lineNo, "steps 只能是 0 或 1");
        showSteps = attrs.steps === "1";
      }
      board = {
        id: m[1],
        title: m[2] ? unquote(m[2], lineNo) : "黑板",
        view,
        showSteps,
        cards: [],
        notes: [],
        strokes: [],
      };
      continue;
    }

    const m = /^@(card|note|stroke)\s+(.*)$/.exec(trimmed);
    if (!m) fail(lineNo, `未知指令 ${trimmed.split(/\s+/)[0]}`);
    const kind = m[1];
    const rest = m[2];
    const idMatch = /^(\S+)(.*)$/.exec(rest);
    if (!idMatch) fail(lineNo, `@${kind} 缺少 ID`);
    const id = idMatch[1];
    if (!ID_RE.test(id)) fail(lineNo, `ID 不合法：${id}`);
    if (!board) fail(lineNo, "@card/@note/@stroke 必须写在 @board 之后");

    const seen = board.cards.some((c) => c.id === id)
      || board.notes.some((n) => n.id === id)
      || board.strokes.some((s) => s.id === id);
    if (seen) fail(lineNo, `ID 重复：${id}`);

    const attrs = parseAttrs(idMatch[2] || "", lineNo);
    if (kind === "card") {
      if (board.cards.length >= limits.cards) fail(lineNo, `卡片超过 ${limits.cards} 上限`);
      item = { kind, id, line: lineNo, attrs: parseCardAttrs(attrs, lineNo), fields: {}, literalKey: "" };
    } else if (kind === "note") {
      if (board.notes.length >= limits.notes) fail(lineNo, `文字块超过 ${limits.notes} 上限`);
      item = { kind, id, line: lineNo, attrs: parseNoteAttrs(attrs, lineNo), fields: {}, literalKey: "" };
    } else {
      if (board.strokes.length >= limits.strokes) fail(lineNo, `笔迹超过 ${limits.strokes} 上限`);
      item = { kind, id, line: lineNo, attrs: parseStrokeAttrs(attrs, lineNo), fields: { points: [] }, literalKey: "" };
    }
  }

  if (item) fail(item.line, `@${item.kind} ${item.id} 没有 @end`);
  if (literal) fail(literal.line, "原文块没有闭合");
  if (!version) fail(1, "空文档：首条指令必须是 @slml 1");
  if (!board) fail(1, "缺少 @board 指令");

  const cardIds = new Set(board.cards.map((c) => c.id));
  for (const card of board.cards) {
    for (const target of card.arrows) {
      if (target === card.id) fail(cardLines.get(card.id) || 0, `卡片 ${card.id} 指向自己`);
      if (!cardIds.has(target)) fail(cardLines.get(card.id) || 0, `卡片 ${card.id} 的 link 指向不存在的 ${target}`);
    }
  }

  return { board, version };
}

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

function fmtCoord(value) {
  return String(Math.max(0, Math.round(Number(value) || 0)));
}

/**
 * 序列化一块黑板。工具步骤卡属于运行现场，默认跳过。
 */
export function boardToSlml(board, options = {}) {
  if (!isPlainObject(board)) throw new Error("boardToSlml 需要一块黑板对象");
  const includeRuntime = options.includeRuntime === true;
  const lines = ["# SLATE Layout Markup Language", `@slml ${SLML_VERSION}`];

  const boardId = ID_RE.test(String(board.id || "")) ? String(board.id) : "brd_main";
  const view = board.view === "" || board.view === null ? "none"
    : board.view === undefined ? "kanban" : String(board.view);
  if (view !== "none" && !BOARD_VIEWS.includes(view)) throw new Error(`未知视图：${view}`);
  lines.push(`@board ${boardId} ${quote(board.title || "黑板")} view=${view} steps=${board.showSteps ? 1 : 0}`);
  lines.push("");

  for (const card of Array.isArray(board.cards) ? board.cards : []) {
    if (!card || typeof card !== "object") continue;
    if (!includeRuntime && card._isToolStep) continue;
    if (!ID_RE.test(String(card.id || ""))) throw new Error(`卡片 ID 不合法：${card.id}`);
    const color = CARD_COLORS.includes(String(card.color || "").toLowerCase()) ? String(card.color).toLowerCase() : "default";
    const attrs = [`x=${fmtCoord(card.x)}`, `y=${fmtCoord(card.y)}`];
    if (color !== "default") attrs.push(`color=${color}`);
    lines.push(`@card ${card.id} ${attrs.join(" ")}`);
    lines.push(`  title: ${quote(card.title || "未命名")}`);
    const arrows = Array.isArray(card.arrows) ? card.arrows : [];
    for (const arrow of arrows) {
      if (!ID_RE.test(String(arrow))) throw new Error(`卡片 ${card.id} 的 link 不合法：${arrow}`);
    }
    if (arrows.length) lines.push(`  link: ${arrows.join(", ")}`);
    const body = String(card.body ?? "");
    if (body) {
      lines.push("  body: |");
      for (const bodyLine of body.split("\n")) lines.push(bodyLine === "" ? "" : `    ${bodyLine}`);
    }
    lines.push("@end");
    lines.push("");
  }

  for (const note of Array.isArray(board.notes) ? board.notes : []) {
    if (!note || typeof note !== "object") continue;
    if (!ID_RE.test(String(note.id || ""))) throw new Error(`文字块 ID 不合法：${note.id}`);
    const rawWidth = Number(note.width);
    const width = Number.isFinite(rawWidth) ? Math.min(2000, Math.max(90, Math.round(rawWidth))) : 180;
    lines.push(`@note ${note.id} x=${fmtCoord(note.x)} y=${fmtCoord(note.y)} w=${width}`);
    const text = String(note.text ?? "");
    lines.push("  text: |");
    if (text) {
      for (const textLine of text.split("\n")) lines.push(textLine === "" ? "" : `    ${textLine}`);
    }
    lines.push("@end");
    lines.push("");
  }

  (Array.isArray(board.strokes) ? board.strokes : []).forEach((stroke, index) => {
    if (!stroke || typeof stroke !== "object") return;
    const id = ID_RE.test(String(stroke.id || "")) ? String(stroke.id) : `s_${index + 1}`;
    const attrs = [];
    const color = toHexColor(stroke.color);
    if (color) attrs.push(`color=${color}`);
    const width = Number(stroke.width);
    if (Number.isFinite(width) && width !== 2) attrs.push(`width=${fmtNum(width)}`);
    lines.push(`@stroke ${id}${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
    for (const point of Array.isArray(stroke.points) ? stroke.points : []) {
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) continue;
      lines.push(`  p: ${fmtNum(point.x)},${fmtNum(point.y)}`);
    }
    lines.push("@end");
    lines.push("");
  });

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** 从文件文本直接得到一块可入库的黑板（board.id 会被调用方换成本机新 id）。 */
export function slmlToBoard(text, options = {}) {
  const { board } = parseSlml(text, options);
  return {
    ...board,
    showSteps: board.showSteps === true,
    cards: board.cards,
    notes: board.notes,
    strokes: board.strokes,
  };
}
