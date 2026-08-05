(() => {
  "use strict";

  // Prevent duplicate injection
  if (window.__LT_LOADED__) return;
  window.__LT_LOADED__ = true;

  const DONE = "data-lt-done";
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    // Translate SELECT/OPTION visible labels; no longer skip the whole tag
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
    "SVG",
    "MATH",
    "CANVAS",
    "IFRAME",
    "VIDEO",
    "AUDIO"
  ]);

  // Inline tags (do not break onto their own line)
  const INLINE_TAGS = new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "CITE",
    "DATA",
    "DFN",
    "EM",
    "I",
    "MARK",
    "Q",
    "S",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
    "VAR"
  ]);

  // Semantic block tags — preferred translation hosts
  const SEMANTIC_BLOCK_TAGS = new Set([
    "P",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TD",
    "TH",
    "DT",
    "DD",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "SUMMARY"
  ]);

  // Skip technical IDs (model names, etc.). UI words like tokens/Type are translated.
  const TECH_RE =
    /^(claude|gpt|gemini|composer|cursor|auto|opus|sonnet|fable|grok|api|id|uuid)[-_a-z0-9.]*$/i;

  // Common short billing/settings UI labels — force into queue
  const UI_LABEL_RE =
    /^(other models|on-demand usage|invoices?|type|tokens?|cost|qty|quantity|total|subtotal|date|description|status|amount|invoice|view|paid|void|cycle starting|usage|billing|included|on-demand)$/i;

  let translating = false;
  let translated = false;
  let settings = null;
  let observer = null;
  let spaHooked = false;
  let spaTimer = null;
  let scrollTimer = null;
  let incrementalBusy = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (String(message?.type || "").startsWith("OFFSCREEN_")) return;
    if (message.type === "TOGGLE_TRANSLATE") {
      toggleTranslate()
        .then((info) => sendResponse({ ok: true, translated, ...info }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message.type === "TRANSLATE_PAGE") {
      startTranslate({ force: true })
        .then((info) => sendResponse({ ok: true, translated, ...info }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message.type === "RESTORE_PAGE") {
      restorePage();
      if (typeof window.__LT_YT_STOP__ === "function") window.__LT_YT_STOP__();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "GET_STATUS") {
      const blocked = isHostBlocked(settings);
      sendResponse({
        ok: true,
        translated,
        translating,
        enabled: isEnabled(),
        blocked,
        host: location.hostname
      });
      return false;
    }
    if (message.type === "SHOW_SELECTION_RESULT") {
      if (isHostBlocked(settings)) {
        sendResponse({ ok: false, blocked: true });
        return false;
      }
      showToast(message.original, message.translated);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "SETTINGS_UPDATED") {
      settings = { ...(settings || {}), ...(message.settings || {}) };
      applyStyleClasses();
      if (isHostBlocked(settings)) {
        restorePage();
        if (typeof window.__LT_YT_STOP__ === "function") window.__LT_YT_STOP__();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  init();

  async function init() {
    settings = await getSettings();
    applyStyleClasses();
    hookSpa();
    hookScroll();
    if (isHostBlocked(settings)) return;
    if (settings.autoTranslate || isEnabled()) {
      setEnabled(true);
      setTimeout(() => startTranslate({ force: false }).catch(() => {}), 200);
    }
  }

  function isHostBlocked(s) {
    const host = location.hostname || "";
    const list = Array.isArray(s?.blockedHosts) ? s.blockedHosts : [];
    return !!(host && list.includes(host));
  }

  function isEnabled() {
    try {
      return sessionStorage.getItem("lt-enabled") === "1";
    } catch {
      return translated;
    }
  }

  function setEnabled(on) {
    try {
      sessionStorage.setItem("lt-enabled", on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
        resolve(res?.settings || {});
      });
    });
  }

  function sendMsg(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(res);
      });
    });
  }

  function applyStyleClasses() {
    document.documentElement.classList.remove(
      "bt-style-muted",
      "bt-style-underline",
      "bt-style-box",
      "bt-translation-only"
    );
    document.documentElement.classList.add(`bt-style-${settings?.translationStyle || "muted"}`);
    if (settings?.displayMode === "translation-only") {
      document.documentElement.classList.add("bt-translation-only");
    }
  }

  async function toggleTranslate() {
    if (translating) return {};
    settings = settings || (await getSettings());
    if (isHostBlocked(settings)) {
      restorePage();
      return { blocked: true };
    }
    if (translated || isEnabled()) {
      restorePage();
      return { restored: true };
    }
    return startTranslate({ force: true });
  }

  function getScanRoot() {
    // YouTube: prefer comments section (new nodes on scroll)
    if (/youtube\.com\/watch/i.test(location.href)) {
      return (
        document.querySelector("#comments") ||
        document.querySelector("ytd-comments") ||
        document.querySelector("#primary") ||
        document.body
      );
    }
    return document.body;
  }

  // ─── Core: viewport-first + fast response + scroll incremental ───

  async function startTranslate(opts = {}) {
    if (translating) return { count: 0 };
    settings = await getSettings();
    if (isHostBlocked(settings)) {
      restorePage();
      if (opts.force) showToast("This site is blocked", "Never translate this site is enabled");
      return { blocked: true, count: 0 };
    }
    translating = true;
    applyStyleClasses();
    setEnabled(true);

    // Start video subs immediately; don't await heavy logic
    if (
      /youtube\.com\/watch|youtu\.be\//i.test(location.href) &&
      typeof window.__LT_YT_START__ === "function"
    ) {
      try {
        window.__LT_YT_START__();
      } catch {
        /* ignore */
      }
    }

    try {
      const root = getScanRoot();
      // Pass 1: translate only visible content (fast)
      const visible = collectUnits({
        root,
        viewportOnly: true,
        limit: 140
      });
      let injected = 0;
      if (visible.length) {
        showProgress(0.05);
        injected = await translateUnitList(visible);
      }

      translated = true;
      watchDynamic();
      hookScroll();

      // Pass 2: backfill nearby area in background
      queueMicrotask(() => {
        translateNearbyBackground().catch(() => {});
      });

      return { count: injected, total: visible.length, progressive: true };
    } catch (err) {
      if (opts.force) showToast("Translation error", String(err.message || err));
      throw err;
    } finally {
      translating = false;
      hideProgress();
    }
  }

  async function translateUnitList(units) {
    if (!units.length) return 0;
    let injected = 0;
    const BATCH = 20;
    for (let i = 0; i < units.length; i += BATCH) {
      const slice = units.slice(i, i + BATCH);
      const res = await sendMsg({
        type: "TRANSLATE_BATCH",
        texts: slice.map((u) => u.text),
        targetLang: settings.targetLang
      });
      if (!res?.ok) throw new Error(res?.error || "Translation service failed");
      slice.forEach((unit, idx) => {
        const out = String(res.results?.[idx] || "").trim();
        if (!out) {
          if (unit.kind === "text" && injectFailed(unit)) injected += 1;
          return;
        }
        if (normalizeCmp(out) === normalizeCmp(unit.text)) return;
        if (unit.kind === "attr") {
          if (injectAttr(unit, out)) injected += 1;
        } else if (unit.kind === "option" || unit.el?.tagName === "OPTION") {
          if (injectOption(unit.el, out, unit.text)) injected += 1;
        } else if (injectAfter(unit.el, out, unit.text)) {
          injected += 1;
        }
      });
    }
    return injected;
  }

  async function translateNearbyBackground() {
    if (!isEnabled()) return;
    const more = collectUnits({
      root: getScanRoot(),
      viewportOnly: false,
      nearViewport: true,
      limit: 100
    });
    if (more.length) await translateUnitList(more);
  }

  async function translateIncremental(roots) {
    if (!isEnabled() || incrementalBusy) return;
    settings = settings || (await getSettings());
    if (isHostBlocked(settings)) return;
    incrementalBusy = true;
    try {
      settings = settings || (await getSettings());
      const units = [];
      const list = roots?.length ? roots : [getScanRoot()];
      for (const root of list) {
        if (!root || !root.querySelectorAll) continue;
        units.push(
          ...collectUnits({
            root,
            viewportOnly: true,
            limit: 80
          })
        );
      }
      // Deduplicate
      const seen = new Set();
      const uniq = [];
      for (const u of units) {
        const k = u.el;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(u);
      }
      if (uniq.length) await translateUnitList(uniq.slice(0, 40));
    } catch (e) {
      console.warn("[Local Translate][incremental]", e);
    } finally {
      incrementalBusy = false;
    }
  }

  function hookScroll() {
    if (window.__LT_SCROLL_HOOKED__) return;
    window.__LT_SCROLL_HOOKED__ = true;
    const onScroll = () => {
      if (!isEnabled()) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        translateIncremental().catch(() => {});
      }, 180);
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  }

  function normalizeCmp(s) {
    return String(s || "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  // ─── Text collection: root / viewport / Shadow / short UI ───

  function collectUnits(opts = {}) {
    const skipCode = settings?.skipCode !== false;
    const root = opts.root || document.body;
    const viewportOnly = !!opts.viewportOnly;
    const nearViewport = !!opts.nearViewport;
    const limit = opts.limit || 80;
    const units = [];
    const seenKey = new Set();
    const hostDone = new Set();

    if (!root) return units;

    const pushTextUnit = (el, text, kind = "text", priority = 0) => {
      if (!el || hostDone.has(el)) return;
      if (el.getAttribute?.(DONE)) return;
      if (el.querySelector?.(":scope > .bt-translated-block")) return;
      if (viewportOnly && !isInViewport(el)) return;
      if (nearViewport && !isNearViewport(el)) return;
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (!shouldTranslateText(t)) return;
      const key = `${kind}:${getPathKey(el)}:${t.slice(0, 100)}`;
      if (seenKey.has(key)) return;
      seenKey.add(key);
      hostDone.add(el);
      units.push({ el, text: t, kind, priority });
    };

    const walkRoot = (walkRootEl, depth = 0) => {
      if (!walkRootEl || depth > 6) return;

      const walker = document.createTreeWalker(walkRootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".bt-translated-block, #bt-selection-toast, #bt-progress, #lt-yt-overlay")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(".ytp-caption-window-container, .html5-video-player")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (isSkipped(parent, skipCode)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const hostMap = new Map();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const piece = node.nodeValue.replace(/\s+/g, " ").trim();
        if (!piece) continue;
        if (parent.closest("select") && parent.tagName !== "OPTION") continue;
        const host = parent.tagName === "OPTION" ? parent : findBestHost(parent);
        if (!host) continue;
        if (host.tagName === "SELECT") continue;
        if (host.getAttribute(DONE)) continue;
        if (host.querySelector?.(":scope > .bt-translated-block")) continue;
        if (viewportOnly && !isInViewport(host)) continue;
        if (nearViewport && !isNearViewport(host)) continue;
        if (!hostMap.has(host)) hostMap.set(host, []);
        hostMap.get(host).push(piece);
      }

      for (const [el, parts] of hostMap.entries()) {
        const text = parts.join(" ").replace(/\s+/g, " ").trim();
        const pri = uiPriority(el, text);
        pushTextUnit(el, text, el.tagName === "OPTION" ? "option" : "text", pri);
      }

      try {
        const attrNodes =
          walkRootEl.querySelectorAll?.("[title], [aria-label], [placeholder], [alt]") || [];
        attrNodes.forEach((el) => {
          if (isSkipped(el, skipCode)) return;
          for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
            const val = (el.getAttribute(attr) || "").replace(/\s+/g, " ").trim();
            if (!val || !shouldTranslateText(val)) continue;
            if (el.getAttribute(`data-lt-attr-${attr}`)) continue;
            if (viewportOnly && !isInViewport(el)) continue;
            const key = `a:${getPathKey(el)}:${attr}:${val}`;
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            units.push({
              el,
              text: val,
              kind: "attr",
              attr,
              priority: uiPriority(el, val) + 5
            });
          }
        });
      } catch {
        /* ignore */
      }

      try {
        const chromeSel =
          "th, [role='columnheader'], [role='heading'], h1, h2, h3, h4, legend, button, [role='button'], label, summary";
        walkRootEl.querySelectorAll?.(chromeSel)?.forEach((el) => {
          if (isSkipped(el, skipCode)) return;
          const text = getDirectText(el) || (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 80) return;
          pushTextUnit(el, text, "text", uiPriority(el, text) + 20);
        });
      } catch {
        /* ignore */
      }

      try {
        walkRootEl.querySelectorAll?.("*")?.forEach((el) => {
          if (el.shadowRoot) walkRoot(el.shadowRoot, depth + 1);
        });
      } catch {
        /* ignore */
      }
    };

    walkRoot(root, 0);

    try {
      const commentSel =
        "#content-text, ytd-comment-thread-renderer #content-text, .comment-text, yt-formatted-string";
      root.querySelectorAll?.(commentSel)?.forEach((el) => {
        if (isSkipped(el, skipCode)) return;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 1200) return;
        pushTextUnit(el, text, "text", 1);
      });
    } catch {
      /* ignore */
    }

    units.sort(
      (a, b) => (b.priority || 0) - (a.priority || 0) || visibleScore(b.el) - visibleScore(a.el)
    );
    return units.slice(0, limit);
  }

  function uiPriority(el, text) {
    let p = 0;
    const t = String(text || "").trim();
    const tag = el?.tagName || "";
    if (tag === "TH" || el?.getAttribute?.("role") === "columnheader") p += 40;
    if (/^H[1-6]$/.test(tag) || el?.getAttribute?.("role") === "heading") p += 35;
    if (tag === "BUTTON" || el?.getAttribute?.("role") === "button") p += 25;
    if (tag === "OPTION" || tag === "LABEL" || tag === "LEGEND" || tag === "SUMMARY") p += 30;
    if (t.length > 0 && t.length <= 28) p += 15;
    if (typeof UI_LABEL_RE !== "undefined" && UI_LABEL_RE.test(t)) p += 50;
    const head = t.split(/\s+/).slice(0, 3).join(" ");
    if (typeof UI_LABEL_RE !== "undefined" && UI_LABEL_RE.test(head)) p += 30;
    if (/^[a-z0-9]+([-_.][a-z0-9]+){2,}$/i.test(t) && /[0-9]/.test(t)) p -= 40;
    return p;
  }

  function isInViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    } catch {
      return true;
    }
  }

  function isNearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      const pad = window.innerHeight * 0.8;
      return r.bottom > -pad && r.top < window.innerHeight + pad;
    } catch {
      return true;
    }
  }

  // Direct text content of element (excluding child elements)
  function getDirectText(el) {
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.nodeValue || "";
      }
    }
    return text.replace(/\s+/g, " ").trim();
  }

  // ─── Host selection: leaf-first strategy ───

  function findBestHost(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // Strategy 1: leaf element (no children or text/inline only) — use directly
    if (isLeafHost(el)) {
      return el;
    }

    // Strategy 2: walk up to nearest semantic block tag
    let cur = el;
    let depth = 0;
    let bestSmall = null; // Best short-text host
    let bestBlock = null; // Best semantic block host

    while (cur && cur !== document.body && depth < 10) {
      const tag = cur.tagName;

      // Semantic block tag — return directly
      if (SEMANTIC_BLOCK_TAGS.has(tag)) {
        const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > 0 && t.length <= 800) return cur;
      }

      // BUTTON / A / LABEL — interactive elements first
      if (tag === "BUTTON" || tag === "A" || tag === "LABEL") {
        const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > 0 && t.length <= 300) return cur;
      }

      // Short-text small host (span/div, etc.)
      if (["SPAN", "DIV", "SMALL", "STRONG", "EM", "B", "I"].includes(tag)) {
        const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > 0 && t.length <= 80 && cur.children.length <= 2) {
          if (!bestSmall) bestSmall = cur;
        }
        if (t.length > 0 && t.length <= 200 && isCompact(cur)) {
          if (!bestBlock) bestBlock = cur;
        }
      }

      cur = cur.parentElement;
      depth += 1;
    }

    // Prefer shortest small host
    return bestSmall || bestBlock || el;
  }

  // Whether element is a leaf host (text or inline children only)
  function isLeafHost(el) {
    if (!el) return false;
    const tag = el.tagName;

    // Direct text element
    if (el.children.length === 0) return true;

    // Inline children only and short total text
    if (el.children.length <= 3) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 0 && t.length <= 120) {
        const allInline = Array.from(el.children).every(
          (c) => INLINE_TAGS.has(c.tagName) || c.tagName === "BR"
        );
        if (allInline) return true;
      }
    }

    // Semantic block tags are good hosts
    if (SEMANTIC_BLOCK_TAGS.has(tag) || tag === "BUTTON" || tag === "A" || tag === "LABEL") {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 0 && t.length <= 200 && el.children.length <= 4) return true;
    }

    return false;
  }

  // ─── Translation filter: relaxed rules for small text ───

  function shouldTranslateText(text) {
    if (!text) return false;
    if (text.length < 1 || text.length > 5000) return false;

    // Common billing/settings short UI — force translate
    if (UI_LABEL_RE.test(text.trim())) return true;
    const head3 = text.trim().split(/\s+/).slice(0, 3).join(" ");
    if (UI_LABEL_RE.test(head3)) return true;
    if (/^cycle starting\b/i.test(text.trim())) return true;
    if (/^(other models|on-demand usage|invoices?)\b/i.test(text.trim())) return true;

    // Digits/symbols only
    if (/^[\d\s.,:%$€¥+\-/=_#@*]+$/.test(text)) return false;
    // URL
    if (/^https?:\/\//i.test(text)) return false;
    // Email
    if (/^[\w.+-]+@[\w.-]+$/.test(text)) return false;

    // Technical ID: single token without spaces (model family prefix); don't block UI words
    if (TECH_RE.test(text.trim()) && !text.includes(" ")) return false;

    // Model ID / version string (digits + multiple hyphen segments)
    if (/^[a-z0-9]+([-_.][a-z0-9]+){2,}$/i.test(text) && /[0-9]/.test(text) && text.length > 15) {
      return false;
    }

    // Target is Chinese: skip pure Chinese text
    if (String(settings?.targetLang || "").startsWith("zh")) {
      const chars = text.replace(/\s/g, "");
      const cn = (chars.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (chars.match(/[A-Za-z]/g) || []).length;
      // Pure Chinese (>70% and no Latin) — skip
      if (latin === 0 && cn / Math.max(chars.length, 1) > 0.7) return false;
      // Need at least one translatable character (letter or CJK)
      if (latin === 0 && cn === 0) return false;
    }
    return true;
  }

  function isCompact(el) {
    if (!el) return false;
    if (el.children.length > 8) return false;
    if (el.querySelector("ul, ol, table, nav, form, input, textarea, svg, video")) return false;
    return true;
  }

  function visibleScore(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return 0;
      const view = Math.max(0, window.innerHeight - Math.abs(r.top));
      return view + (r.top >= 0 && r.top < window.innerHeight ? 500 : 0);
    } catch {
      return 1;
    }
  }

  function getPathKey(el) {
    try {
      const parts = [];
      let cur = el;
      let i = 0;
      while (cur && cur.nodeType === 1 && i < 6) {
        let idx = 0;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) idx++;
          sib = sib.previousElementSibling;
        }
        parts.push(`${cur.tagName}${cur.id ? "#" + cur.id : ""}[${idx}]`);
        cur = cur.parentElement;
        i += 1;
      }
      return parts.join(">");
    } catch {
      return String(Math.random());
    }
  }

  // ─── Skip detection (reduce false exclusions) ───

  function isSkipped(el, skipCode) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (SKIP_TAGS.has(cur.tagName)) return true;
      // Skip chrome/nav chrome — focus on main content (fewer false positives on site shells).
      if (
        cur.tagName === "NAV" ||
        cur.tagName === "HEADER" ||
        cur.tagName === "FOOTER" ||
        cur.tagName === "ASIDE" ||
        cur.getAttribute?.("role") === "navigation" ||
        cur.getAttribute?.("role") === "banner" ||
        cur.getAttribute?.("role") === "contentinfo"
      ) {
        return true;
      }
      if (skipCode && (cur.tagName === "CODE" || cur.tagName === "PRE")) return true;
      if (cur.isContentEditable) return true;

      if (cur.getAttribute?.("aria-hidden") === "true") {
        try {
          const rect = cur.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return true;
          const style = getComputedStyle(cur);
          if (style.display === "none" || style.visibility === "hidden") return true;
        } catch {
          return true;
        }
      }

      cur = cur.parentElement;
    }
    return false;
  }

  // ─── Inject translation ───

  // Elements whose translation should stay on the same line as the
  // original text instead of stacking below it — this keeps buttons,
  // badges, pills and table cells from growing taller than their siblings.
  const COMPACT_HOST_TAGS = new Set([
    "A", "BUTTON", "LABEL", "SPAN", "STRONG", "EM", "B", "I", "SMALL", "TH", "TD"
  ]);
  const COMPACT_HOST_CLASS_RE = /\b(Label|Badge|Counter|State|Tag|Pill|chip|tooltipped)\b/i;

  function isCompactHost(el) {
    if (!el) return false;
    if (COMPACT_HOST_TAGS.has(el.tagName)) return true;
    if (typeof el.className === "string" && COMPACT_HOST_CLASS_RE.test(el.className)) return true;
    try {
      const disp = getComputedStyle(el).display;
      if (disp === "inline" || disp === "inline-block" || disp === "inline-flex" || disp === "inline-grid") {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function injectAfter(el, translatedText, originalText) {
    if (!el || !translatedText) return false;
    if (el.querySelector(":scope > .bt-translated-block")) return false;

    el.setAttribute(DONE, "1");
    el.classList.add("bt-host");
    if (isCompactHost(el)) el.classList.add("bt-host-compact");

    if (settings?.displayMode === "translation-only") wrapOriginal(el);

    const node = document.createElement("span");
    node.className = "bt-translated-block";
    node.setAttribute("lang", settings?.targetLang || "zh-CN");
    if (originalText && originalText.length <= 40) node.classList.add("bt-small");
    node.textContent = translatedText;

    el.appendChild(node);
    return true;
  }

  /** Failed unit: clickable retry stub (no empty silent fail). */
  function injectFailed(unit) {
    const el = unit?.el;
    if (!el || unit.kind !== "text") return false;
    if (el.querySelector(":scope > .bt-translated-block, :scope > .bt-failed-block")) return false;
    el.setAttribute(DONE, "1");
    el.classList.add("bt-host");
    const node = document.createElement("button");
    node.type = "button";
    node.className = "bt-failed-block";
    node.textContent = "Retry translate";
    node.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.disabled = true;
      node.textContent = "…";
      try {
        const res = await sendMsg({
          type: "TRANSLATE_BATCH",
          texts: [unit.text],
          targetLang: settings?.targetLang
        });
        const out = String(res?.results?.[0] || "").trim();
        if (!out) throw new Error("empty");
        node.remove();
        el.removeAttribute(DONE);
        injectAfter(el, out, unit.text);
      } catch {
        node.disabled = false;
        node.textContent = "Retry translate";
      }
    });
    el.appendChild(node);
    return true;
  }

  function injectOption(el, translatedText, originalText) {
    if (!el || !translatedText) return false;
    if (el.getAttribute(DONE)) return false;
    el.setAttribute(DONE, "1");
    el.setAttribute("data-lt-origin", originalText || el.textContent || "");
    // Option: original / translation; preserve value
    const origin = originalText || el.textContent || "";
    el.textContent = `${origin} / ${translatedText}`;
    return true;
  }

  function injectAttr(unit, translatedText) {
    const { el, attr, text } = unit;
    if (!el || !attr) return false;
    // Keep original attr; write translation to title note or readable hint
    el.setAttribute(`data-lt-attr-${attr}`, "1");
    el.setAttribute(`data-lt-origin-${attr}`, text);
    // placeholder / aria-label / alt / title: replace with translation, backup original
    el.setAttribute(attr, translatedText);
    return true;
  }

  function wrapOriginal(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".bt-translated-block")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const t of nodes) {
      if (t.parentElement?.classList?.contains("bt-original-hidden")) continue;
      const span = document.createElement("span");
      span.className = "bt-original-hidden";
      t.parentNode.insertBefore(span, t);
      span.appendChild(t);
    }
  }

  // ─── Restore original ───

  function restorePage() {
    document.querySelectorAll(".bt-translated-block, .bt-failed-block").forEach((n) => n.remove());
    document.querySelectorAll(`[${DONE}]`).forEach((el) => {
      el.removeAttribute(DONE);
      el.classList.remove("bt-host");
    });
    document.querySelectorAll(".bt-original-hidden").forEach((span) => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      span.remove();
    });
    // Restore attributes
    document.querySelectorAll("*").forEach((el) => {
      for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
        const mark = `data-lt-attr-${attr}`;
        const origin = `data-lt-origin-${attr}`;
        if (el.hasAttribute(mark) && el.hasAttribute(origin)) {
          el.setAttribute(attr, el.getAttribute(origin));
          el.removeAttribute(mark);
          el.removeAttribute(origin);
        }
      }
      if (el.tagName === "OPTION" && el.hasAttribute("data-lt-origin")) {
        el.textContent = el.getAttribute("data-lt-origin");
        el.removeAttribute("data-lt-origin");
      }
    });

    translated = false;
    setEnabled(false);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    hideProgress();
  }

  // ─── Dynamic content observer (scroll-loaded comments, etc.) ───

  function watchDynamic() {
    if (observer) observer.disconnect();
    let timer = null;
    const pendingRoots = new Set();

    observer = new MutationObserver((mutations) => {
      if (!isEnabled()) return;
      for (const m of mutations) {
        if (m.type !== "childList" || !m.addedNodes?.length) continue;
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.classList?.contains("bt-translated-block")) return;
          if (n.id === "bt-progress" || n.id === "lt-yt-overlay") return;
          if (n.closest?.(".ytp-caption-window-container")) return;
          pendingRoots.add(n);
        });
      }
      if (!pendingRoots.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const roots = [...pendingRoots];
        pendingRoots.clear();
        translateIncremental(roots).catch(() => {});
      }, 220);
    });

    const root = getScanRoot() || document.body;
    observer.observe(root, { childList: true, subtree: true });
    // Comments section may appear late — also watch body
    if (root !== document.body) {
      observer.observe(document.body, { childList: true, subtree: false });
    }
  }

  // ─── SPA route observer ───

  function hookSpa() {
    if (spaHooked) return;
    spaHooked = true;

    const schedule = () => {
      if (!isEnabled()) return;
      clearTimeout(spaTimer);
      spaTimer = setTimeout(() => {
        // After SPA navigation, stale marks may linger on unmounted nodes; re-translate new content
        startTranslate().catch(() => {});
      }, 400);
    };

    const wrap = (type) => {
      const raw = history[type];
      if (typeof raw !== "function") return;
      history[type] = function (...args) {
        const ret = raw.apply(this, args);
        schedule();
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);

    // Sidebar clicks etc. can trigger in-document routing
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a,button,[role='link'],[role='tab'],[role='menuitem']");
        if (!a) return;
        if (!isEnabled()) return;
        clearTimeout(spaTimer);
        spaTimer = setTimeout(() => startTranslate().catch(() => {}), 500);
      },
      true
    );
  }

  // ─── UI ───

  function showProgress(ratio) {
    // No top progress bar on YouTube watch (subs follow doesn't need it)
    if (/youtube\.com\/watch|youtu\.be\//i.test(location.href)) return;
    let bar = document.getElementById("bt-progress");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "bt-progress";
      bar.innerHTML = "<i></i>";
      document.documentElement.appendChild(bar);
    }
    const i = bar.querySelector("i");
    if (i) i.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`;
  }

  function hideProgress() {
    document.getElementById("bt-progress")?.remove();
  }

  function showToast(title, detail) {
    document.getElementById("bt-selection-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "bt-selection-toast";
    toast.innerHTML = `
      <button class="bt-toast-close" aria-label="Close">×</button>
      <div class="bt-toast-label">Notice</div>
      <div class="bt-toast-original"></div>
      <div class="bt-toast-label">Details</div>
      <div class="bt-toast-translated"></div>
    `;
    toast.querySelector(".bt-toast-original").textContent = title;
    toast.querySelector(".bt-toast-translated").textContent = detail;
    toast.querySelector(".bt-toast-close").addEventListener("click", () => toast.remove());
    toast.style.top = "72px";
    toast.style.left = "20px";
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 9000);
  }
})();
