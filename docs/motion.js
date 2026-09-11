(function () {
  if (typeof window.anime !== "function") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var anime = window.anime;

  var q = function (sel) { return document.querySelector(sel); };
  var qa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ── Hero wordmark: split so each glyph rises out of the ink ──
  var title = q(".hero-title");
  var letters = [];
  if (title) {
    var chars = Array.from(title.textContent.trim());
    title.textContent = "";
    chars.forEach(function (ch) {
      var span = document.createElement("span");
      span.className = "ht-letter";
      span.textContent = ch;
      title.appendChild(span);
      letters.push(span);
    });
  }

  var mark = q(".hero-mark");
  var sub = q(".hero-sub");
  var en = q(".hero-en");
  var actions = q(".hero-actions");
  var badges = qa(".hero-badges .badge");
  var prehide = [mark].concat(letters, [sub, en, actions], badges).filter(Boolean);

  if (prehide.length) anime.set(prehide, { opacity: 0 });
  if (letters.length) anime.set(letters, { translateY: 42, rotate: -6 });

  var tl = anime.timeline({ easing: "easeOutCubic" });
  if (mark) tl.add({ targets: mark, opacity: [0, 1], translateY: [18, 0], duration: 520 });
  if (letters.length) {
    tl.add({
      targets: letters, opacity: [0, 1], translateY: [42, 0], rotate: [-6, 0],
      duration: 820, delay: anime.stagger(74), easing: "easeOutBack",
    }, "-=270");
  }
  if (sub || en) {
    tl.add({
      targets: qa(".hero-sub, .hero-en"), opacity: [0, 1], translateY: [16, 0],
      duration: 540, delay: anime.stagger(110),
    }, "-=560");
  }
  if (actions) tl.add({ targets: actions, opacity: [0, 1], translateY: [16, 0], duration: 500 }, "-=430");
  if (badges.length) {
    tl.add({
      targets: badges, opacity: [0, 1], translateY: [14, 0], scale: [0.92, 1],
      duration: 470, delay: anime.stagger(66), easing: "easeOutBack",
    }, "-=380");
  }

  // ── Mission deck: the run fills in, the stream lines up, the signals drift ──
  var bar = q(".mission-progress i");
  if (bar) {
    var fillTo = bar.style.width || "72%";
    anime.set(bar, { width: "0%" });
    anime({ targets: bar, width: ["0%", fillTo], duration: 1500, delay: 900, easing: "easeOutQuart" });
  }
  var stream = qa(".agent-stream > div");
  if (stream.length) {
    anime.set(stream, { opacity: 0 });
    anime({
      targets: stream, opacity: [0, 1], translateX: [-18, 0],
      duration: 560, delay: anime.stagger(200, { start: 760 }),
    });
  }
  var panels = qa(".signal-panel");
  if (panels.length) {
    anime({
      targets: panels, translateY: [0, -6], direction: "alternate", loop: true,
      duration: 2600, delay: anime.stagger(420), easing: "easeInOutSine",
    });
  }
  var heroGrid = q(".hero-grid");
  if (heroGrid) {
    anime({
      targets: heroGrid, opacity: [0.55, 1], direction: "alternate", loop: true,
      duration: 7000, easing: "easeInOutSine",
    });
  }

  // ── Scroll-triggered accents. Each target sits inside a .reveal, so it is
  //    already invisible before its own animation starts — pre-hide it here. ──
  var indexes = qa(".diff-index");
  var codes = qa(".diff-evidence code");
  if (indexes.length) anime.set(indexes, { opacity: 0 });
  if (codes.length) anime.set(codes, { opacity: 0, translateY: 12 });

  var accents = qa(".diff-head, .diff-evidence, .stats-grid [data-count]");
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      var el = entry.target;
      if (el.classList.contains("diff-head")) {
        var idx = el.querySelector(".diff-index");
        if (idx) {
          anime({
            targets: idx, opacity: [0, 1], scale: [0.55, 1], rotate: [-10, 0],
            duration: 700, delay: 130, easing: "easeOutBack",
          });
        }
      } else if (el.classList.contains("diff-evidence")) {
        var chips = el.querySelectorAll("code");
        if (chips.length) {
          anime({
            targets: chips, opacity: [0, 1], translateY: [12, 0],
            duration: 480, delay: anime.stagger(90, { start: 240 }),
          });
        }
      } else {
        var num = el.closest(".stat-num") || el;
        anime({
          targets: num, translateY: [0, -8], direction: "alternate",
          duration: 320, delay: 1460, easing: "easeInOutQuad",
        });
      }
    });
  }, { threshold: 0.35 });
  accents.forEach(function (el) { observer.observe(el); });
})();
