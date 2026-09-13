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
  var actions = q(".hero-actions");
  var badges = qa(".hero-badges .badge");
  var footnotes = qa(".hero-install, .hero-shipped");
  var prehide = [mark].concat(letters, [q(".hero-sub"), q(".hero-en"), actions], badges, footnotes).filter(Boolean);

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
  if (q(".hero-sub") || q(".hero-en")) {
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
  if (footnotes.length) {
    tl.add({
      targets: footnotes, opacity: [0, 1], translateY: [12, 0],
      duration: 460, delay: anime.stagger(90),
    }, "-=300");
  }

  // ── Scroll accents: the index stamps down, then the evidence paths light up ──
  var indexes = qa(".diff-index");
  var codes = qa(".diff-evidence code");
  if (indexes.length) anime.set(indexes, { opacity: 0 });
  if (codes.length) anime.set(codes, { opacity: 0, translateY: 12 });

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
      } else {
        var chips = el.querySelectorAll("code");
        if (chips.length) {
          anime({
            targets: chips, opacity: [0, 1], translateY: [12, 0],
            duration: 480, delay: anime.stagger(90, { start: 240 }),
          });
        }
      }
    });
  }, { threshold: 0.12 });
  qa(".diff-head, .diff-evidence").forEach(function (el) { observer.observe(el); });
})();
