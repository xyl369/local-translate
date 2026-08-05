/**
 * YouTube bilingual subtitles
 * - Dual panel: top = previous line, bottom = current line; each EN + ZH
 * - With caption track: timeline sync + parallel pre-translate (near-zero delay)
 * - No track / CC follow: DOM sync, English immediately, translation backfills ASAP
 */
(() => {
  "use strict";

  const API = {
    start: startSubs,
    stop: stopSubs,
    status: () => ({
      ok: true,
      enabled: STATE.enabled,
      videoId: STATE.videoId,
      cues: STATE.cues.length,
      cachedPhrases: cache.size,
      isYouTube: isYouTubeWatch(),
      mode: STATE.cues.length ? "timeline+dom" : "dom"
    })
  };
  window.__LT_YT__ = API;
  window.__LT_YT_START__ = () => API.start({});
  window.__LT_YT_STOP__ = () => API.stop();

  if (!window.__LT_YT_MSG_BOUND__) {
    window.__LT_YT_MSG_BOUND__ = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (String(message?.type || "").startsWith("OFFSCREEN_")) return;
      const api = window.__LT_YT__;
      if (!api) return false;
      if (message.type === "YT_SUBS_START") {
        try {
          const info = api.start(message);
          sendResponse({ ok: true, ...info });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return false;
      }
      if (message.type === "YT_SUBS_STOP") {
        api.stop();
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "YT_SUBS_STATUS") {
        sendResponse(api.status());
        return false;
      }
      return false;
    });
  }

  const STATE = {
    enabled: false,
    videoId: null,
    targetLang: "zh-CN",
    mode: "bilingual",
    overlay: null,
    textEl: null,
    cues: [],
    lastCueIdx: -1,
    lastDomKey: "",
    token: 0,
    raf: 0,
    video: null,
    observer: null,
    pollTimer: 0,
    growTimer: 0,
    // Dual-panel stack: keep at most previous + current line
    prev: null, // { en, zh, key }
    cur: null,
    drag: {
      userLeft: null,
      userTop: null,
      dragging: false,
      startX: 0,
      startY: 0,
      origLeft: 0,
      origTop: 0,
      bound: false
    }
  };

  const cache = new Map();
  const inflight = new Map();
  const CACHE_MAX = 5000;
  const TRANS_CONCURRENCY = 12;

  document.addEventListener("yt-navigate-finish", () => {
    if (!STATE.enabled) return;
    const id = getVideoId();
    if (id && id !== STATE.videoId) startSubs({});
  });

  setTimeout(async () => {
    if (!isYouTubeWatch()) return;
    try {
      const s = await getSettings();
      const host = location.hostname || "";
      const blocked = Array.isArray(s.blockedHosts) ? s.blockedHosts : [];
      if (host && blocked.includes(host)) return;
      if (s.videoSubsAuto) startSubs({ targetLang: s.targetLang, mode: s.videoSubsMode || s.displayMode });
    } catch {
      /* ignore */
    }
  }, 1600);

  function isYouTubeWatch() {
    return /youtube\.com\/watch|youtu\.be\//i.test(location.href);
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
      return u.searchParams.get("v");
    } catch {
      return null;
    }
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
        resolve(res?.settings || {});
      });
    });
  }

  function startSubs(opts = {}) {
    if (!isYouTubeWatch()) throw new Error("YouTube watch pages only");

    STATE.targetLang = opts.targetLang || STATE.targetLang || "zh-CN";
    STATE.mode = opts.mode || STATE.mode || "bilingual";
    getSettings().then((s) => {
      const host = location.hostname || "";
      const blocked = Array.isArray(s.blockedHosts) ? s.blockedHosts : [];
      if (host && blocked.includes(host)) {
        stopSubs();
        return;
      }
      if (!opts.targetLang) STATE.targetLang = s.targetLang || STATE.targetLang;
      if (!opts.mode) STATE.mode = s.videoSubsMode || s.displayMode || STATE.mode;
      paint();
    });

    STATE.enabled = true;
    STATE.token += 1;
    const token = STATE.token;
    STATE.videoId = getVideoId();
    STATE.cues = [];
    STATE.lastCueIdx = -1;
    STATE.lastDomKey = "";
    STATE.prev = null;
    STATE.cur = null;
    clearTimeout(STATE.growTimer);

    ensureOverlay();
    bindVideo();
    watchCaptions();
    startPoll();
    document.getElementById("bt-progress")?.remove();

    // Follow current CC immediately
    tickDom(true);
    // Fetch track in background + parallel pre-translate
    bootTrack(token).catch(() => {});

    return { ready: true, instant: true, tip: "Dual-panel sync on; enable CC" };
  }

  function stopSubs() {
    STATE.enabled = false;
    STATE.token += 1;
    STATE.cues = [];
    stopPoll();
    unbindVideo();
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }
    clearTimeout(STATE.growTimer);
    document.querySelectorAll("#lt-yt-overlay").forEach((n) => n.remove());
    STATE.overlay = null;
    STATE.textEl = null;
    STATE.drag.dragging = false;
    STATE.drag.bound = false;
    document.documentElement.classList.remove("lt-yt-hide-native-cc");
  }

  async function bootTrack(token) {
    const track = await Promise.race([
      findCaptionTrack(STATE.videoId),
      sleep(2500).then(() => null)
    ]);
    if (token !== STATE.token || !STATE.enabled || !track) return;

    const raw = await Promise.race([
      fetchCues(track.baseUrl),
      sleep(5000).then(() => [])
    ]);
    if (token !== STATE.token || !STATE.enabled || !raw.length) return;

    STATE.cues = mergeShortCues(raw, 0.55);

    // Prefer YouTube whole-track translation (tlang) — free, aligned, less gtx traffic.
    const tlang = toYtTlang(STATE.targetLang);
    if (tlang) {
      try {
        const tUrl = withQuery(track.baseUrl, { tlang, fmt: "json3" });
        const translated = await Promise.race([
          fetchCues(tUrl),
          sleep(5000).then(() => [])
        ]);
        if (token === STATE.token && translated.length) {
          const n = Math.min(STATE.cues.length, translated.length);
          for (let i = 0; i < n; i++) {
            const zh = String(translated[i]?.text || "").trim();
            const en = STATE.cues[i]?.text;
            if (zh && en) cacheSet(ck(en), zh);
          }
        }
      } catch {
        /* fall through to engine pre-translate */
      }
    }

    await warmWindow(token, true);
    warmLoop(token);
  }

  function toYtTlang(code) {
    const c = String(code || "zh-CN");
    if (c === "zh-CN" || c === "zh") return "zh-Hans";
    if (c === "zh-TW") return "zh-Hant";
    return c.split("-")[0] || c;
  }

  function withQuery(baseUrl, params) {
    try {
      const u = new URL(baseUrl, location.origin);
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v != null && v !== "") u.searchParams.set(k, v);
      });
      return u.toString();
    } catch {
      let url = baseUrl;
      for (const [k, v] of Object.entries(params || {})) {
        if (new RegExp(`[?&]${k}=`).test(url)) continue;
        url += (url.includes("?") ? "&" : "?") + `${k}=${encodeURIComponent(v)}`;
      }
      return url;
    }
  }

  async function warmWindow(token, urgent) {
    if (!STATE.cues.length || !STATE.video) return;
    const now = STATE.video.currentTime || 0;
    const list = [];
    // Always prioritize the cue under the playhead first.
    const nowIdx = findCueIndex(now);
    if (nowIdx >= 0) {
      for (let i = nowIdx; i < Math.min(STATE.cues.length, nowIdx + (urgent ? 36 : 20)); i++) {
        const t = STATE.cues[i].text;
        if (!cache.has(ck(t)) && !inflight.has(ck(t))) list.push(t);
      }
    } else {
      for (const c of STATE.cues) {
        if (c.start < now - 2) continue;
        if (c.start > now + (urgent ? 120 : 60)) break;
        if (!cache.has(ck(c.text)) && !inflight.has(ck(c.text))) list.push(c.text);
        if (list.length >= (urgent ? 36 : 20)) break;
      }
    }
    if (list.length) await translateMany([...new Set(list)]);
    if (token === STATE.token && STATE.enabled) {
      backfillPairsFromCache();
      paint();
    }
  }

  function warmLoop(token) {
    const tick = async () => {
      if (token !== STATE.token || !STATE.enabled) return;
      try {
        await warmWindow(token, false);
      } catch {
        /* ignore */
      }
      if (token === STATE.token && STATE.enabled) setTimeout(tick, 1200);
    };
    setTimeout(tick, 400);
  }

  function startPoll() {
    stopPoll();
    STATE.pollTimer = setInterval(() => {
      if (!STATE.enabled) return;
      tickDom(false);
      tickTimeline();
      placeOverlay();
    }, 50);
  }

  function stopPoll() {
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = 0;
  }

  function watchCaptions() {
    if (STATE.observer) STATE.observer.disconnect();
    const root =
      document.querySelector(".ytp-caption-window-container") ||
      document.querySelector(".html5-video-player") ||
      document.body;
    STATE.observer = new MutationObserver(() => {
      if (STATE.enabled) tickDom(false);
    });
    STATE.observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function readDomCaption() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (segs.length) {
      const parts = [];
      const seen = new Set();
      segs.forEach((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || seen.has(t)) return;
        seen.add(t);
        parts.push(t);
      });
      return parts.join(" ").trim();
    }
    const win = document.querySelector(
      ".ytp-caption-window-bottom .captions-text, .caption-window .captions-text"
    );
    return (win?.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Strict: only prefix growth counts as same line, avoids merging two lines */
  function isGrowing(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.startsWith(a)) return true;
    if (a.startsWith(b) && a.length - b.length < 20) return true;
    return false;
  }

  function cueKey(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function tickDom(force) {
    const text = readDomCaption();
    if (!text) return;
    const key = cueKey(text);
    if (!force && key === STATE.lastDomKey) return;

    const prevKey = STATE.lastDomKey;
    STATE.lastDomKey = key;

    if (prevKey && isGrowing(prevKey, key)) {
      updateCurrent(text);
      return;
    }

    // New line: current becomes previous
    pushNew(text);
  }

  function tickTimeline() {
    if (!STATE.cues.length || !STATE.video) return;
    // Prefer DOM when captions are visible (finer granularity, closer to CC)
    if (readDomCaption()) return;

    const t = STATE.video.currentTime || 0;
    const idx = findCueIndex(t);
    if (idx < 0 || idx === STATE.lastCueIdx) return;
    STATE.lastCueIdx = idx;
    const text = STATE.cues[idx].text;
    const key = cueKey(text);
    if (key === STATE.lastDomKey) return;
    STATE.lastDomKey = key;
    pushNew(text);
  }

  function findCueIndex(t) {
    const cues = STATE.cues;
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans >= 0 && t <= cues[ans].end + 0.4) return ans;
    return -1;
  }

  function pushNew(en) {
    const key = cueKey(en);
    const source = resolveTranslateSource(en);
    // Whole new current line → old current becomes previous (keep pending so late ZH can fill).
    if (STATE.cur && STATE.cur.key && STATE.cur.key !== key && !isGrowing(STATE.cur.key, key)) {
      STATE.prev = { ...STATE.cur };
      // Still translating previous line — bump its waiter below via requestTranslate(prev).
      if (STATE.prev.pending && STATE.prev.en) {
        requestTranslate(STATE.prev.en, { force: true, target: "prev" });
      }
    }

    const hit = lookupZh(source) || lookupZh(en);
    STATE.cur = {
      en,
      zh: hit || "",
      key,
      pending: !hit,
      req: 0,
      source
    };
    paint();
    requestTranslate(source || en, { force: true, target: "cur" });
    prefetchNeighbors(source || en);
  }

  function updateCurrent(en) {
    const key = cueKey(en);
    const source = resolveTranslateSource(en);
    const hit = lookupZh(source) || lookupZh(en);
    if (!STATE.cur) {
      STATE.cur = { en, zh: hit || "", key, pending: !hit, req: 0, source };
      paint();
      requestTranslate(source || en, { force: true, target: "cur" });
      return;
    }

    // Growing word-by-word: keep existing translation when possible, update English.
    STATE.cur.en = en;
    STATE.cur.key = key;
    STATE.cur.source = source || STATE.cur.source;
    if (hit) {
      STATE.cur.zh = hit;
      STATE.cur.pending = false;
    } else if (!STATE.cur.zh) {
      STATE.cur.pending = true;
    }
    paint();

    // Prefer stable cue text for translate; force when still missing ZH.
    requestTranslate(source || en, { force: !STATE.cur.zh, target: "cur" });
  }

  /**
   * Prefer full caption-track cue over fragile ASR DOM fragments —
   * track sentences cache-hit far more often after tlang / prefetch.
   */
  function resolveTranslateSource(domText) {
    const raw = String(domText || "").replace(/\s+/g, " ").trim();
    if (!raw || !STATE.cues.length) return raw;
    const k = cueKey(raw);
    let best = null;
    let bestScore = 0;
    const t = STATE.video?.currentTime;
    const around = typeof t === "number" ? findCueIndex(t) : -1;
    const lo = around >= 0 ? Math.max(0, around - 2) : 0;
    const hi = around >= 0 ? Math.min(STATE.cues.length - 1, around + 4) : STATE.cues.length - 1;
    for (let i = lo; i <= hi; i++) {
      const c = STATE.cues[i];
      const ck0 = cueKey(c.text);
      if (!ck0) continue;
      let score = 0;
      if (ck0 === k) score = 1000;
      else if (k.startsWith(ck0) || ck0.startsWith(k)) score = 400 + Math.min(ck0.length, k.length);
      else if (ck0.includes(k) || k.includes(ck0)) score = 200 + Math.min(ck0.length, 80);
      if (around >= 0 && Math.abs(i - around) <= 1) score += 50;
      if (score > bestScore) {
        bestScore = score;
        best = c.text;
      }
    }
    return best || raw;
  }

  /** Exact cache hit, else longest cached source that is a prefix of `en` (growing ASR). */
  function lookupZh(en) {
    const text = String(en || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const exact = cache.get(ck(text));
    if (exact) return exact;
    let best = "";
    let bestLen = 0;
    const prefix = `${STATE.targetLang}||`;
    for (const [k, v] of cache) {
      if (!v || !String(k).startsWith(prefix)) continue;
      const src = String(k).slice(prefix.length);
      if (!src) continue;
      if (text === src) return v;
      if (text.startsWith(src) && src.length > bestLen && src.length >= 12) {
        best = v;
        bestLen = src.length;
      }
    }
    return best;
  }

  function backfillPairsFromCache() {
    if (STATE.cur?.en && !STATE.cur.zh) {
      const zh = lookupZh(STATE.cur.source || STATE.cur.en) || lookupZh(STATE.cur.en);
      if (zh) {
        STATE.cur.zh = zh;
        STATE.cur.pending = false;
      }
    }
    if (STATE.prev?.en && !STATE.prev.zh) {
      const zh = lookupZh(STATE.prev.source || STATE.prev.en) || lookupZh(STATE.prev.en);
      if (zh) {
        STATE.prev.zh = zh;
        STATE.prev.pending = false;
      }
    }
  }

  /** Apply ZH to cur and/or prev — lines often advance before translate returns. */
  function applyZhToPairs(en, zh) {
    if (!zh) return false;
    const k = cueKey(en);
    let changed = false;
    const fits = (pair) => {
      if (!pair?.en) return false;
      const pk = cueKey(pair.en);
      const sk = cueKey(pair.source || "");
      return (
        pk === k ||
        sk === k ||
        isGrowing(pk, k) ||
        isGrowing(k, pk) ||
        isGrowing(sk, k) ||
        isGrowing(k, sk) ||
        (pair.source && cueKey(pair.source) === k)
      );
    };
    if (fits(STATE.cur)) {
      STATE.cur.zh = zh;
      STATE.cur.pending = false;
      changed = true;
    }
    if (fits(STATE.prev)) {
      STATE.prev.zh = zh;
      STATE.prev.pending = false;
      changed = true;
    }
    return changed;
  }

  /** No translation: fire immediately; has translation: debounce to avoid per-char resets */
  function requestTranslate(en, opts = {}) {
    if (!en) return;
    clearTimeout(STATE.growTimer);

    const run = () => {
      if (!STATE.enabled) return;
      const latest = String(en || "").trim();
      if (!latest) return;
      // Stamp req on the intended pair so late results still apply after line advance.
      const target = opts.target === "prev" ? STATE.prev : STATE.cur;
      if (target) target.req = (target.req || 0) + 1;
      const my = target ? target.req : 0;

      translateOne(latest)
        .then((zh) => {
          if (!STATE.enabled || !zh) return;
          if (target && my < (target.req || 0) - 1) return;
          if (applyZhToPairs(latest, zh)) paint();
          else {
            // Orphaned result: still cache; warm may backfill next paint.
            paint();
          }
        })
        .catch((err) => console.warn("[LT subs translate]", err));
    };

    if (opts.force) {
      run();
      return;
    }
    STATE.growTimer = setTimeout(run, 160);
  }

  function prefetchNeighbors(en) {
    if (!STATE.cues.length) return;
    const idx = STATE.cues.findIndex((c) => cueKey(c.text) === cueKey(en));
    const start = idx >= 0 ? idx : Math.max(0, STATE.lastCueIdx);
    if (start < 0) return;
    const batch = [];
    for (let i = start; i < Math.min(STATE.cues.length, start + 24); i++) {
      const t = STATE.cues[i].text;
      if (!cache.has(ck(t)) && !inflight.has(ck(t))) batch.push(t);
    }
    if (batch.length) {
      translateMany(batch).then(() => {
        backfillPairsFromCache();
        paint();
      });
    }
  }

  function paint() {
    if (!STATE.textEl || !STATE.enabled) return;
    backfillPairsFromCache();
    const onlyZh = STATE.mode === "translation-only";
    STATE.overlay?.classList.toggle("lt-yt-trans-only", onlyZh);

    const parts = [];
    if (STATE.prev && STATE.prev.en) {
      parts.push(pairHtml(STATE.prev, "prev", onlyZh));
    }
    if (STATE.cur && STATE.cur.en) {
      parts.push(pairHtml(STATE.cur, "current", onlyZh));
    }
    STATE.textEl.innerHTML = parts.join("");
  }

  function pairHtml(pair, role, onlyZh) {
    const en = escapeHtml(clip(pair.en, 120));
    const zh = pair.zh ? escapeHtml(clip(pair.zh, 80)) : "";
    if (onlyZh) {
      const line = zh || (pair.pending ? "…" : en);
      return `<div class="lt-yt-pair lt-yt-pair-${role}"><div class="lt-yt-trans">${line}</div></div>`;
    }
    const zhLine = zh
      ? `<div class="lt-yt-trans">${zh}</div>`
      : `<div class="lt-yt-trans lt-yt-pending">…</div>`;
    return `<div class="lt-yt-pair lt-yt-pair-${role}"><div class="lt-yt-origin">${en}</div>${zhLine}</div>`;
  }

  function clip(s, n) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length <= n ? t : t.slice(0, n - 1) + "…";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function ck(text) {
    return `${STATE.targetLang}||${text}`;
  }

  async function translateOne(text) {
    const key = ck(text);
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);

    // Only via background — page must not call Google directly.
    const p = translateViaBg(text)
      .then((out) => {
        const zh = String(out || "").trim();
        if (zh) cacheSet(key, zh);
        return zh;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  function translateViaBg(text) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "TRANSLATE_ONE", text, targetLang: STATE.targetLang || "zh-CN" },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!res?.ok || !res.translated) {
              reject(new Error(res?.error || "bg translate empty"));
              return;
            }
            resolve(res.translated);
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  async function translateMany(texts) {
    const uniq = [...new Set(texts.filter(Boolean))];
    const need = uniq.filter((t) => !cache.has(ck(t)) && !inflight.has(ck(t)));
    if (!need.length) return;

    let i = 0;
    const workers = Array.from({ length: Math.min(TRANS_CONCURRENCY, need.length) }, async () => {
      while (i < need.length) {
        const t = need[i++];
        try {
          await translateOne(t);
        } catch {
          /* ignore */
        }
      }
    });
    await Promise.all(workers);
  }

  function cacheSet(key, val) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, val);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // ─── Caption track ───

  async function findCaptionTrack(videoId) {
    if (!videoId) return null;

    // Prefer pot-bearing timedtext URL captured in MAIN world.
    const sniffed = await getSniffedTimedtextUrls();
    for (const url of sniffed) {
      try {
        const cues = await fetchCues(url);
        if (cues.length) {
          return { baseUrl: withQuery(url, { fmt: "json3" }), lang: "sniffed" };
        }
      } catch {
        /* try next */
      }
    }

    const player = await getPlayerResponse();
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(tracks) && tracks.length) {
      return tracks
        .map((t) => {
          const lang = (t.languageCode || "").toLowerCase();
          let score = 0;
          if (lang.startsWith("en")) score += 50;
          if (t.kind !== "asr") score += 20;
          return { baseUrl: t.baseUrl, lang, score };
        })
        .sort((a, b) => b.score - a.score)[0];
    }
    for (const lang of ["en", "en-US"]) {
      const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${lang}&fmt=json3`;
      try {
        const cues = await fetchCues(url);
        if (cues.length) return { baseUrl: url, lang };
      } catch {
        /* next */
      }
    }
    return null;
  }

  function pageRpc(type) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const handler = (event) => {
        if (event.source !== window) return;
        if (event.data?.source !== "lt-yt-page" || event.data.id !== id) return;
        window.removeEventListener("message", handler);
        resolve(event.data);
      };
      window.addEventListener("message", handler);
      window.postMessage({ source: "lt-yt-ext", type, id }, "*");
      setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, 900);
    });
  }

  async function getSniffedTimedtextUrls() {
    const res = await pageRpc("LT_YT_GET_TIMEDTEXT");
    return Array.isArray(res?.urls) ? res.urls.filter(Boolean) : [];
  }

  async function getPlayerResponse() {
    const res = await pageRpc("LT_YT_GET_PLAYER");
    if (res?.payload) return res.payload;
    return null;
  }

  function parseCueJson(raw) {
    if (!raw || !String(raw).trim().startsWith("{")) return [];
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const cues = [];
    for (const ev of data.events || []) {
      if (!ev.segs || ev.tStartMs == null) continue;
      const text = ev.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      cues.push({
        start: ev.tStartMs / 1000,
        end: (ev.tStartMs + (ev.dDurationMs || 2000)) / 1000,
        text
      });
    }
    return cues;
  }

  async function fetchCues(baseUrl) {
    let url = baseUrl;
    if (!/[?&]fmt=/.test(url)) url += (url.includes("?") ? "&" : "?") + "fmt=json3";
    const raw = await fetchTextViaBg(url);
    return parseCueJson(raw);
  }

  function fetchTextViaBg(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "FETCH_TEXT", url }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res?.ok) {
          reject(new Error(res?.error || "fetch failed"));
          return;
        }
        resolve(res.text || "");
      });
    });
  }

  function mergeShortCues(cues, minDur) {
    if (!cues.length) return [];
    const out = [];
    let cur = { ...cues[0] };
    for (let i = 1; i < cues.length; i++) {
      const n = cues[i];
      const gap = n.start - cur.end;
      const dur = cur.end - cur.start;
      if (dur < minDur && gap < 0.55 && (cur.text + " " + n.text).length < 140) {
        cur.end = Math.max(cur.end, n.end);
        cur.text = `${cur.text} ${n.text}`.replace(/\s+/g, " ").trim();
      } else {
        out.push(cur);
        cur = { ...n };
      }
    }
    out.push(cur);
    return out;
  }

  // ─── overlay / drag ───

  function ensureOverlay() {
    document.querySelectorAll("#lt-yt-overlay").forEach((n) => n.remove());
    const el = document.createElement("div");
    el.id = "lt-yt-overlay";
    el.innerHTML =
      '<div class="lt-yt-panel" title="Drag to move · double-click to reset"><div class="lt-yt-text"></div></div>';
    document.documentElement.appendChild(el);
    STATE.overlay = el;
    STATE.textEl = el.querySelector(".lt-yt-text");
    STATE.drag.bound = false;
    document.documentElement.classList.add("lt-yt-hide-native-cc");
    el.classList.toggle("lt-yt-trans-only", STATE.mode === "translation-only");
    bindDrag(el.querySelector(".lt-yt-panel"));
    placeOverlay();
  }

  function getPlayerRect() {
    const player =
      document.querySelector(".html5-video-player") ||
      document.querySelector("#movie_player") ||
      document.querySelector("video");
    return player ? player.getBoundingClientRect() : null;
  }

  function placeOverlay() {
    const panel = STATE.overlay?.querySelector(".lt-yt-panel");
    if (!panel || STATE.drag.dragging) return;
    const rect = getPlayerRect();
    if (!rect) return;
    const width = Math.min(rect.width * 0.92, Math.max(280, rect.width - 40));
    panel.style.width = `${width}px`;
    panel.style.maxWidth = "none";
    panel.style.transform = "none";
    const ph = panel.offsetHeight || 88;
    let left =
      STATE.drag.userLeft != null
        ? STATE.drag.userLeft
        : rect.left + (rect.width - width) / 2;
    let top =
      STATE.drag.userTop != null
        ? STATE.drag.userTop
        : Math.max(rect.top + 8, rect.bottom - ph - 14);
    const c = clampPos(left, top, width, ph, rect);
    panel.style.left = `${c.left}px`;
    panel.style.top = `${c.top}px`;
    if (STATE.drag.userLeft != null) {
      STATE.drag.userLeft = c.left;
      STATE.drag.userTop = c.top;
    }
  }

  function clampPos(left, top, width, height, rect) {
    const pad = 4;
    const minL = rect.left + pad;
    const maxL = Math.max(minL, rect.right - width - pad);
    const minT = rect.top + pad;
    const maxT = Math.max(minT, rect.bottom - height - pad);
    return {
      left: Math.min(maxL, Math.max(minL, left)),
      top: Math.min(maxT, Math.max(minT, top))
    };
  }

  function bindDrag(panel) {
    if (!panel || STATE.drag.bound) return;
    STATE.drag.bound = true;

    panel.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      STATE.drag.dragging = true;
      STATE.drag.startX = e.clientX;
      STATE.drag.startY = e.clientY;
      STATE.drag.origLeft = r.left;
      STATE.drag.origTop = r.top;
      panel.classList.add("lt-yt-dragging");
      try {
        panel.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      e.stopPropagation();
    });

    panel.addEventListener("pointermove", (e) => {
      if (!STATE.drag.dragging) return;
      const rect = getPlayerRect();
      if (!rect) return;
      const left = STATE.drag.origLeft + (e.clientX - STATE.drag.startX);
      const top = STATE.drag.origTop + (e.clientY - STATE.drag.startY);
      const c = clampPos(left, top, panel.offsetWidth, panel.offsetHeight, rect);
      STATE.drag.userLeft = c.left;
      STATE.drag.userTop = c.top;
      panel.style.left = `${c.left}px`;
      panel.style.top = `${c.top}px`;
      e.preventDefault();
    });

    const up = (e) => {
      if (!STATE.drag.dragging) return;
      STATE.drag.dragging = false;
      panel.classList.remove("lt-yt-dragging");
      try {
        panel.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    panel.addEventListener("pointerup", up);
    panel.addEventListener("pointercancel", up);
    panel.addEventListener("dblclick", (e) => {
      STATE.drag.userLeft = null;
      STATE.drag.userTop = null;
      placeOverlay();
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function bindVideo() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    unbindVideo();
    if (!video) {
      setTimeout(() => {
        if (STATE.enabled) bindVideo();
      }, 400);
      return;
    }
    STATE.video = video;
    const loop = () => {
      if (!STATE.enabled) return;
      placeOverlay();
      STATE.raf = requestAnimationFrame(loop);
    };
    STATE.raf = requestAnimationFrame(loop);
  }

  function unbindVideo() {
    if (STATE.raf) cancelAnimationFrame(STATE.raf);
    STATE.raf = 0;
    STATE.video = null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
