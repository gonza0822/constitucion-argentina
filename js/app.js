// ============================================================
// Constitución de la Nación Argentina — libro digital
// Motor de paginación + StPageFlip + búsqueda (Fuse.js)
// ============================================================
(function () {
  "use strict";

  var MOBILE_BREAKPOINT = 720;
  var BASE_W = 480;
  var BASE_H = 660;
  var IS_MOBILE = false;

  function isMobileViewport() {
    return window.matchMedia && window.matchMedia("(max-width:" + MOBILE_BREAKPOINT + "px)").matches;
  }

  function chooseBaseSize() {
    IS_MOBILE = isMobileViewport();
    document.body.classList.toggle("mobile-mode", IS_MOBILE);
    if (IS_MOBILE) {
      // Fill most of the phone's width so the visual scale stays close to 1
      // (crisper, more legible text) instead of shrinking a desktop-sized page.
      BASE_W = Math.max(260, Math.min(window.innerWidth - 24, 420));
      BASE_H = Math.round(BASE_W * 1.5);
    } else {
      BASE_W = 480;
      BASE_H = 660;
    }
  }

  var DATA = window.CONSTITUCION;
  var bookEl = document.getElementById("book");
  var stageEl = document.getElementById("book-stage");
  var appEl = document.getElementById("app");
  var loadingEl = document.getElementById("loading-screen");

  var pageFlip = null;
  var pageMeta = [];      // parallel array: pageMeta[i] = {kind, label}
  var articlePage = {};   // article number -> page index
  var transitoriaPage = {}; // transitoria number -> page index
  var searchItems = [];   // flat list for Fuse: {id, kind, number, text}
  var fuse = null;

  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState === "complete" || document.readyState === "interactive") {
    // script is loaded at end of body, DOM already parsed
    init();
  }

  var started = false;
  function init() {
    if (started) return;
    started = true;

    buildSunRays();

    if (!DATA) {
      fatalError("No se pudo cargar el texto de la Constitución. Verificá que el archivo data/constitucion.js exista.");
      return;
    }

    // Pagination measures real text height, so it must run only after the
    // book's web fonts have actually finished loading — document.fonts.ready
    // resolves trivially (near-instantly, with an empty font set) if the
    // Google Fonts <link> stylesheet itself hasn't loaded yet, which made
    // pagination non-deterministic depending on network timing.
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    Promise.race([fontsReadyPromise(), timeout]).then(build);

    function build() {
      try {
        chooseBaseSize();
        var pages = buildPages(DATA);
        mountBook(pages);
        buildSearchIndex(DATA);
        wireToolbar();
        wireSearch();
        wireKeyboard();
        window.addEventListener("resize", debounce(fitBook, 120));
        finishLoading();
      } catch (err) {
        console.error(err);
        fatalError("Ocurrió un error al construir el libro: " + err.message);
      }
    }
  }

  function finishLoading() {
    appEl.hidden = false;
    requestAnimationFrame(function () {
      fitBook();
      loadingEl.classList.add("fade-out");
      setTimeout(function () {
        if (loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
      }, 650);
    });
  }

  function fontsReadyPromise() {
    return new Promise(function (resolve) {
      var link = document.querySelector('link[href*="fonts.googleapis.com"]');
      if (link && !link.sheet) {
        var done = false;
        var settle = function () { if (!done) { done = true; resolve(); } };
        link.addEventListener("load", settle, { once: true });
        link.addEventListener("error", settle, { once: true });
        setTimeout(settle, 2500);
      } else {
        resolve();
      }
    }).then(function () {
      if (!document.fonts) return;
      var specs = [
        '400 14.5px "EB Garamond"',
        'italic 400 14.5px "EB Garamond"',
        '600 14.5px "EB Garamond"',
        '700 16px "Playfair Display"',
        'italic 500 16px "Playfair Display"',
        '700 16px "Cinzel"'
      ];
      return Promise.all(
        specs.map(function (s) { return document.fonts.load(s).catch(function () {}); })
      ).then(function () { return document.fonts.ready; });
    });
  }

  function fatalError(msg) {
    loadingEl.innerHTML =
      '<p class="loading-text" style="color:#e3a3a3;max-width:32rem;text-align:center;padding:0 1.5rem;">' +
      msg + "</p>";
  }

  // ---------------------------------------------------------
  // Sun emblem decorative rays (loading screen)
  // ---------------------------------------------------------
  function buildSunRays() {
    var g = document.getElementById("rays");
    if (!g) return;
    var n = 16, cx = 100, cy = 100, r1 = 46, r2 = 58;
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 * i) / n;
      var x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a);
      var x2 = cx + r2 * Math.cos(a), y2 = cy + r2 * Math.sin(a);
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "3");
      g.appendChild(line);
    }
  }

  // ---------------------------------------------------------
  // Pagination engine
  // ---------------------------------------------------------
  // "Atoms" are the smallest schedulable units of content. Each atom renders
  // to an HTML string via renderAtom() and can be split further if it alone
  // overflows an empty page (splitAtom()).

  function sectionHeading(section) {
    return [section.parte, section.titulo, section.seccion, section.capitulo]
      .filter(function (s) { return s && String(s).trim(); })
      .join(" — ");
  }

  function keyOf(art) {
    return art.suffix ? art.number + "-" + art.suffix : String(art.number);
  }
  function labelOf(art) {
    return art.suffix ? art.number + " " + art.suffix : art.number + "º";
  }

  function buildPages(data) {
    var atoms = [];

    atoms.push({ type: "heading", text: "Preámbulo", forceBreak: true });
    splitLongText(data.preambulo || "", 650).forEach(function (chunk, i) {
      atoms.push({ type: "preambulo", text: chunk, first: i === 0 });
    });

    (data.sections || []).forEach(function (section) {
      atoms.push({
        type: "heading",
        text: sectionHeading(section),
        forceBreak: true
      });
      (section.articles || []).forEach(function (art) {
        var chunks = splitLongText(art.text || "", 650);
        var key = keyOf(art), label = labelOf(art);
        chunks.forEach(function (chunk, i) {
          atoms.push({
            type: "article",
            number: art.number,
            key: key,
            label: label,
            text: chunk,
            first: i === 0
          });
        });
      });
    });

    if (data.transitorias && data.transitorias.length) {
      atoms.push({ type: "heading", text: "Disposiciones Transitorias", forceBreak: true });
      data.transitorias.forEach(function (tr) {
        var chunks = splitLongText(tr.text || "", 650);
        chunks.forEach(function (chunk, i) {
          atoms.push({
            type: "transitoria",
            number: tr.number,
            text: chunk,
            first: i === 0
          });
        });
      });
    }

    var measurer = createMeasurer();
    var pages = paginateAtoms(atoms, measurer);
    document.body.removeChild(measurer.wrap);

    return pages;
  }

  // Pre-split very long article/transitoria texts into smaller chunks along
  // natural boundaries (newlines = incisos, else sentence breaks) so a single
  // huge article (e.g. facultades del Congreso) can flow across pages.
  function splitLongText(text, softLimit) {
    text = (text || "").trim();
    if (text.length <= softLimit) return [text];

    var pieces = text.indexOf("\n") !== -1
      ? text.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)
      : text.split(/(?<=[.;])\s+(?=[A-ZÁÉÍÓÚÑ0-9])/);

    // merge tiny pieces so we don't end up with too many micro-atoms
    var out = [], buf = "";
    pieces.forEach(function (p) {
      if ((buf + " " + p).trim().length <= softLimit) {
        buf = (buf ? buf + " " : "") + p;
      } else {
        if (buf) out.push(buf);
        buf = p;
      }
    });
    if (buf) out.push(buf);
    return out.length ? out : [text];
  }

  function renderAtom(atom) {
    switch (atom.type) {
      case "heading":
        return '<h3 class="page-heading">' + escapeHtml(atom.text) + "</h3>";
      case "preambulo":
        return '<p class="preambulo-text">' + (atom.first ? "" : "") + escapeHtml(atom.text) + "</p>";
      case "article":
        return (
          '<p class="article-block" data-article="' + escapeHtml(atom.key) + '">' +
          (atom.first ? '<span class="article-number">Art. ' + escapeHtml(atom.label) + '.- </span>' : "") +
          '<span class="article-text">' + escapeHtml(atom.text) + "</span></p>"
        );
      case "transitoria":
        return (
          '<p class="transitoria-block" data-transitoria="' + escapeHtml(String(atom.number)) + '">' +
          (atom.first ? '<span class="transitoria-title">' + escapeHtml(String(atom.number)) + ".- </span>" : "") +
          '<span class="article-text">' + escapeHtml(atom.text) + "</span></p>"
        );
      default:
        return "";
    }
  }

  function splitAtom(atom) {
    // Try splitting at a sentence boundary near the middle; fall back to words.
    var text = atom.text;
    var mid = Math.floor(text.length / 2);
    var sentenceBreak = findNearestBreak(text, mid, /[.;]\s+/g);
    var cut = sentenceBreak != null ? sentenceBreak : findNearestBreak(text, mid, /\s+/g);
    if (cut == null || cut <= 0 || cut >= text.length) {
      // cannot split further meaningfully
      return null;
    }
    var a = Object.assign({}, atom, { text: text.slice(0, cut).trim() });
    var b = Object.assign({}, atom, { text: text.slice(cut).trim(), first: false });
    return [a, b];
  }

  function findNearestBreak(text, target, regex) {
    var best = null, bestDist = Infinity, m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text))) {
      var pos = m.index + m[0].length;
      var dist = Math.abs(pos - target);
      if (dist < bestDist) { bestDist = dist; best = pos; }
    }
    return best;
  }

  function createMeasurer() {
    var wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.left = "-9999px";
    wrap.style.top = "0";
    wrap.style.visibility = "hidden";
    wrap.style.pointerEvents = "none";

    var page = document.createElement("div");
    page.className = "page";
    page.style.width = BASE_W + "px";
    page.style.height = BASE_H + "px";

    var inner = document.createElement("div");
    inner.className = "page-inner";
    page.appendChild(inner);
    wrap.appendChild(page);
    document.body.appendChild(wrap);

    return { wrap: wrap, page: page, inner: inner };
  }

  function overflows(measurer, htmlList) {
    measurer.inner.innerHTML = htmlList.join("");
    return measurer.inner.scrollHeight > measurer.inner.clientHeight + 1;
  }

  function paginateAtoms(atoms, measurer) {
    var pages = [];
    var current = [];
    var currentHtml = [];

    var queue = atoms.slice();
    var guard = 0;
    while (queue.length) {
      if (++guard > 20000) { throw new Error("Bucle de paginación excedido"); }
      var atom = queue.shift();

      if (atom.forceBreak && current.length) {
        pages.push(current);
        current = []; currentHtml = [];
      }

      var html = renderAtom(atom);
      var testHtml = currentHtml.concat([html]);

      if (!overflows(measurer, testHtml)) {
        current.push(atom);
        currentHtml = testHtml;
        continue;
      }

      // Doesn't fit with existing content
      if (current.length) {
        pages.push(current);
        current = []; currentHtml = [];
        // retry this atom alone on a fresh page
        if (!overflows(measurer, [html])) {
          current.push(atom);
          currentHtml = [html];
          continue;
        }
      }

      // Doesn't fit even alone on an empty page: split it further
      var split = splitAtom(atom);
      if (split) {
        queue.unshift(split[1]);
        queue.unshift(split[0]);
      } else {
        // give up splitting further, place as-is (will just overflow visually)
        current.push(atom);
        currentHtml = [html];
      }
    }
    if (current.length) pages.push(current);
    return pages;
  }

  // ---------------------------------------------------------
  // Mount into StPageFlip
  // ---------------------------------------------------------
  function mountBook(pages) {
    bookEl.innerHTML = "";
    pageMeta = [];

    // Front cover
    appendPageEl(buildCoverEl(true), { kind: "cover" });

    // Table of contents (built after we know page indices — placeholder now,
    // filled in below once content pages are numbered)
    var tocEl = document.createElement("div");
    tocEl.className = "page page-toc";
    appendPageEl(tocEl, { kind: "toc" });

    var contentCounter = 0;
    pages.forEach(function (pageAtoms) {
      contentCounter++;
      var el = document.createElement("div");
      el.className = "page " + (contentCounter % 2 === 1 ? "page-right" : "page-left");
      var inner = document.createElement("div");
      inner.className = "page-inner";
      inner.innerHTML = pageAtoms.map(renderAtom).join("");
      el.appendChild(inner);
      var num = document.createElement("div");
      num.className = "page-number";
      num.textContent = String(contentCounter);
      el.appendChild(num);

      var idx = appendPageEl(el, { kind: "content" });

      pageAtoms.forEach(function (atom) {
        if (atom.type === "article" && atom.first && articlePage[atom.key] === undefined) {
          articlePage[atom.key] = idx;
        }
        if (atom.type === "transitoria" && atom.first && transitoriaPage[atom.number] === undefined) {
          transitoriaPage[atom.number] = idx;
        }
      });
    });

    // Back cover
    appendPageEl(buildCoverEl(false), { kind: "cover" });

    fillToc(tocEl);

    pageFlip = new St.PageFlip(bookEl, {
      width: BASE_W,
      height: BASE_H,
      size: "fixed",
      minWidth: 300,
      maxWidth: 700,
      minHeight: 420,
      maxHeight: 960,
      showCover: true,
      usePortrait: true,
      maxShadowOpacity: 0.55,
      // No in-book scrolling ever happens (each page is a fixed, fully
      // paginated slice), so disabling this gives touch swipes to the flip
      // gesture instead of the browser's own scroll/refresh handling.
      mobileScrollSupport: false,
      flippingTime: IS_MOBILE ? 500 : 700
    });
    pageFlip.loadFromHTML(document.querySelectorAll("#book .page"));

    pageFlip.on("flip", function (e) {
      updatePageIndicator(e.data);
    });
    updatePageIndicator(0);
  }

  function appendPageEl(el, meta) {
    bookEl.appendChild(el);
    pageMeta.push(meta);
    return pageMeta.length - 1;
  }

  function buildCoverEl(isFront) {
    var el = document.createElement("div");
    el.className = "page page-cover";
    el.setAttribute("data-density", "hard");
    if (isFront) {
      el.innerHTML =
        '<svg class="cover-sun" viewBox="0 0 200 200" width="70" height="70"><circle cx="100" cy="100" r="34" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="100" cy="100" r="22" fill="currentColor"/></svg>' +
        '<div class="cover-title">Constitución<br>de la Nación<br>Argentina</div>' +
        '<div class="cover-sub">Texto ordenado &middot; 1853&ndash;1994</div>' +
        '<div class="cover-ribbon"></div>';
    } else {
      el.innerHTML =
        '<svg class="cover-sun" viewBox="0 0 200 200" width="46" height="46" style="opacity:.6"><circle cx="100" cy="100" r="34" fill="none" stroke="currentColor" stroke-width="4"/></svg>';
    }
    return el;
  }

  function fillToc(tocEl) {
    var inner = document.createElement("div");
    inner.className = "page-inner";
    var html = '<h3 class="page-heading">Índice</h3><ul class="toc-list">';

    html += tocRow("Preámbulo", pageMeta.length > 2 ? 2 : 0, false);

    var lastParte = null, lastGroupKey = null;
    (DATA.sections || []).forEach(function (section) {
      if (section.parte !== lastParte) {
        html += '<li class="toc-kicker-row">' + escapeHtml(section.parte || "") + "</li>";
        lastParte = section.parte;
        lastGroupKey = null;
      }
      var sub = section.titulo
        ? section.titulo + (section.seccion ? " — " + section.seccion : "")
        : (section.capitulo || "");
      var groupKey = section.titulo ? section.titulo + "|" + (section.seccion || "") : (section.capitulo || "");
      if (groupKey === lastGroupKey) return;
      lastGroupKey = groupKey;

      var firstArt = section.articles && section.articles[0];
      var target = firstArt ? articlePage[keyOf(firstArt)] : null;
      if (target == null) return;
      html += tocRow(sub, target, true);
    });

    if (DATA.transitorias && DATA.transitorias.length) {
      var trTarget = transitoriaPage[DATA.transitorias[0].number];
      if (trTarget != null) html += tocRow("Disposiciones Transitorias", trTarget, false);
    }

    html += "</ul>";
    inner.innerHTML = html;
    tocEl.appendChild(inner);
  }

  function tocRow(label, target, indent) {
    return (
      '<li' + (indent ? ' class="toc-sub"' : "") + '><button type="button" data-goto="' + target + '">' +
      escapeHtml(label) + "</button>" +
      '<span class="toc-page">' + pageLabel(target) + "</span></li>"
    );
  }

  function findKindPage(kind) {
    for (var i = 0; i < pageMeta.length; i++) if (pageMeta[i].kind === kind) return i;
    return 0;
  }
  function pageLabel(idx) {
    return idx == null ? "" : String(idx + 1);
  }

  // ---------------------------------------------------------
  // Responsive scaling (keeps pagination stable; scales visually)
  // ---------------------------------------------------------
  function fitBook() {
    if (!bookEl) return;
    bookEl.style.transform = "none";
    var rect = bookEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var availW = stageEl.clientWidth - 20;
    var availH = stageEl.clientHeight - 20;
    var scale = Math.min(availW / rect.width, availH / rect.height, 1.15);
    if (scale > 0 && isFinite(scale)) {
      bookEl.style.transform = "scale(" + scale + ")";
    }
  }

  // ---------------------------------------------------------
  // Toolbar / navigation
  // ---------------------------------------------------------
  function wireToolbar() {
    document.getElementById("btn-prev").addEventListener("click", function () {
      pageFlip.flipPrev();
    });
    document.getElementById("btn-next").addEventListener("click", function () {
      pageFlip.flipNext();
    });
    document.getElementById("btn-cover").addEventListener("click", function () {
      pageFlip.flip(findKindPage("toc"));
    });

    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-goto]");
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-goto"), 10);
      if (!isNaN(idx)) pageFlip.flip(idx);
    });
  }

  function updatePageIndicator(idx) {
    var el = document.getElementById("page-indicator");
    var total = pageMeta.length;
    el.textContent = (idx + 1) + " / " + total;
    document.getElementById("btn-prev").disabled = idx <= 0;
    document.getElementById("btn-next").disabled = idx >= total - 1;
  }

  function wireKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (document.activeElement === document.getElementById("search-input")) return;
      if (e.key === "ArrowRight") pageFlip.flipNext();
      if (e.key === "ArrowLeft") pageFlip.flipPrev();
    });
  }

  // ---------------------------------------------------------
  // Search (Fuse.js)
  // ---------------------------------------------------------
  function buildSearchIndex(data) {
    searchItems = [];
    (data.sections || []).forEach(function (section) {
      (section.articles || []).forEach(function (art) {
        var key = keyOf(art);
        searchItems.push({
          id: "art-" + key,
          kind: "article",
          number: art.number,
          label: "Artículo " + labelOf(art),
          text: art.text || "",
          page: articlePage[key]
        });
      });
    });
    (data.transitorias || []).forEach(function (tr) {
      searchItems.push({
        id: "tr-" + tr.number,
        kind: "transitoria",
        number: tr.number,
        label: "Disposición transitoria " + tr.number,
        text: tr.text || "",
        page: transitoriaPage[tr.number]
      });
    });

    fuse = new Fuse(searchItems, {
      keys: [
        { name: "text", weight: 0.75 },
        { name: "label", weight: 0.25 }
      ],
      includeMatches: true,
      threshold: 0.34,
      ignoreLocation: true,
      minMatchCharLength: 2
    });
  }

  function wireSearch() {
    var box = document.getElementById("search-box");
    var input = document.getElementById("search-input");
    var clearBtn = document.getElementById("search-clear");
    var results = document.getElementById("search-results");

    input.addEventListener("input", debounce(function () {
      var q = input.value.trim();
      box.classList.toggle("has-text", !!q);
      if (!q) { results.hidden = true; return; }
      runSearch(q);
    }, 150));

    clearBtn.addEventListener("click", function () {
      input.value = "";
      box.classList.remove("has-text");
      results.hidden = true;
      input.focus();
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest("#search-box") && !e.target.closest("#search-results")) {
        results.hidden = true;
      }
    });

    input.addEventListener("focus", function () {
      if (input.value.trim()) results.hidden = false;
    });
  }

  function runSearch(query) {
    var results = document.getElementById("search-results");
    var hits = fuse.search(query, { limit: 25 });

    if (!hits.length) {
      results.innerHTML = '<div class="sr-empty">Sin resultados para “' + escapeHtml(query) + '”.</div>';
      results.hidden = false;
      return;
    }

    var html = '<div class="sr-count">' + hits.length + " resultado" + (hits.length === 1 ? "" : "s") + "</div>";
    html += hits
      .map(function (h) {
        var item = h.item;
        var snippet = buildSnippet(item.text, h.matches);
        return (
          '<button type="button" class="sr-item" data-goto="' + item.page + '">' +
          '<span class="sr-num">' + escapeHtml(item.label) + "</span>" +
          '<span class="sr-snippet">' + snippet + "</span>" +
          "</button>"
        );
      })
      .join("");

    results.innerHTML = html;
    results.hidden = false;
  }

  function buildSnippet(text, matches) {
    var match = matches && matches.find(function (m) { return m.key === "text"; });
    if (!match || !match.indices || !match.indices.length) {
      return escapeHtml(text.slice(0, 140)) + (text.length > 140 ? "…" : "");
    }
    var idx = match.indices[0];
    var start = Math.max(0, idx[0] - 60);
    var end = Math.min(text.length, idx[1] + 60);
    var prefix = start > 0 ? "…" : "";
    var suffix = end < text.length ? "…" : "";

    var relevant = match.indices.filter(function (r) { return r[0] >= start && r[1] < end; });
    var out = "", cursor = start;
    relevant.forEach(function (r) {
      out += escapeHtml(text.slice(cursor, r[0]));
      out += "<mark>" + escapeHtml(text.slice(r[0], r[1] + 1)) + "</mark>";
      cursor = r[1] + 1;
    });
    out += escapeHtml(text.slice(cursor, end));
    return prefix + out + suffix;
  }

  // ---------------------------------------------------------
  // Utils
  // ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }
})();
