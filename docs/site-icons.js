(function () {
  const ICONS = {
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.25.6.84 1 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    scroll: '<path d="M6 2h9a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 7h5M10 11h5M10 15h3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    "message-circle": '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    "pen-tool": '<path d="M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M6 8h12v4a6 6 0 0 1-12 0V8z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    "book-open": '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7"/>',
    "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    factory: '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    "edit-3": '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    flask: '<path d="M9 3h6M10 3v5l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V3"/>',
    lightbulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
    hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>',
    puzzle: '<path d="M19.4 13.5a2.2 2.2 0 1 0 0-3H17V7.7a2.2 2.2 0 1 0-3 0V10h-3V7.7a2.2 2.2 0 1 0-3 0V10H5v9h4a2.2 2.2 0 1 1 4 0h4v-5.5h2.4z"/>',
  };

  const ALIASES = {
    "\u2715": "x",
    "\u2726": "sliders",
    "\u26A1": "zap",
    "\u{1F3AF}": "target",
    "\u{1F6E0}": "tool",
    "\u{1F6E0}\uFE0F": "tool",
    "\u2699": "settings",
    "\uFE0F": "",
    "\u{1F680}": "send",
    "\u{1F4DC}": "scroll",
    "\u2B07": "download",
    "\u2605": "star",
    "\u263E": "moon",
    "\u2600": "sun",
    "\u{1F5E3}\uFE0F": "message-circle",
    "\u{1F5E3}": "message-circle",
    "\u{1F58C}\uFE0F": "pen-tool",
    "\u{1F58C}": "pen-tool",
    "\u{1F50C}": "plug",
    "\u{1F6E1}\uFE0F": "shield",
    "\u{1F6E1}": "shield",
    "\u{1F9E9}": "puzzle",
    "\u{1F393}": "book-open",
    "\u{1F465}": "users",
    "\u{1F500}": "shuffle",
    "\u23F0": "clock",
    "\u{1F9E0}": "database",
    "\u{1F4BE}": "save",
    "\u{1F50D}": "search",
    "\u{1F514}": "bell",
    "\u{1F512}": "lock",
    "\u{1F4D6}": "book-open",
    "\u{1F5C2}\uFE0F": "folder",
    "\u{1F5C2}": "folder",
    "\u{1F3ED}": "factory",
    "\u{1F4E1}": "wifi",
    "\u{1F30D}": "globe",
    "\u{1F4DA}": "book",
    "\u{1F4C2}": "folder",
    "\u{1F4D1}": "file-text",
    "\u{1F4DD}": "edit-3",
    "\u{1F9EA}": "flask",
    "\u{1F4A1}": "lightbulb",
    "\u23F3": "hourglass",
    "\u{1F3A4}": "mic",
    "\u2713": "check",
    "\u2714": "check",
    "\u2728": "sparkles",
  };

  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SVG"]);
  const keys = Object.keys(ALIASES)
    .filter((key) => ALIASES[key])
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegex).join("|"), "gu");

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function iconSvg(name) {
    const inner = ICONS[name];
    if (!inner) return "";
    return `<svg class="site-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  function replaceTextNode(node) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!text || !pattern.test(text)) return;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    text.replace(pattern, (match, offset) => {
      if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
      const tpl = document.createElement("template");
      tpl.innerHTML = iconSvg(ALIASES[match]);
      frag.appendChild(tpl.content.firstElementChild);
      last = offset + match.length;
      return match;
    });
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }

  function walk(root) {
    if (!root || SKIP.has(root.nodeName)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script,style,textarea,input,svg")) return NodeFilter.FILTER_REJECT;
        pattern.lastIndex = 0;
        const hasIcon = pattern.test(node.nodeValue || "");
        pattern.lastIndex = 0;
        return hasIcon ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(replaceTextNode);
    pattern.lastIndex = 0;
  }

  function injectStyle() {
    if (document.getElementById("slate-site-icon-style")) return;
    const style = document.createElement("style");
    style.id = "slate-site-icon-style";
    style.textContent = `
      .site-svg-icon {
        width: 1em;
        height: 1em;
        display: inline-block;
        vertical-align: -0.16em;
        flex: 0 0 auto;
      }
      .drawer-icon .site-svg-icon,
      .bottom-icon .site-svg-icon,
      .feature-icon .site-svg-icon,
      .scene-icon .site-svg-icon,
      .theme-toggle .site-svg-icon,
      .nav-btn .site-svg-icon {
        width: 1.15em;
        height: 1.15em;
      }
    `;
    document.head.appendChild(style);
  }

  function startObserver() {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) replaceTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) walk(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  injectStyle();
  walk(document.body);
  startObserver();
  window.SlateSiteIcons = { replaceEmojiIcons: walk, iconSvg };
})();
