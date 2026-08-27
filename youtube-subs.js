/**
 * YouTube bilingual subtitles
 * - Dual panel: top = previous line, bottom = current line; each EN + ZH
 * - With caption track: timeline sync + parallel pre-translate (near-zero delay)
 * - No track / CC follow: DOM sync, English immediately, translation backfills ASAP
 */
(() => {
  "use strict";

  const CORE = globalThis.__LT_YT_CORE__;
  if (!CORE) {
    console.error("[Local Translate] YouTube subtitle core was not loaded");
    return;
  }

  const SCRIPT_VERSION = safeManifestVersion();
  const previousApi = window.__LT_YT__;
  if (previousApi?.extensionVersion === SCRIPT_VERSION) return;
  try {
    previousApi?.stop?.();
  } catch {
    /* stale instances are replaced below */
  }

  const API = {
    extensionVersion: SCRIPT_VERSION,
    start: startSubs,
    stop: stopSubs,
    status: () => ({
      ok: true,
      enabled: STATE.enabled,
      videoId: STATE.videoId,
      cues: STATE.cues.length,
      cachedPhrases: cache.size,
      isYouTube: isYouTubeWatch(),
      mode: STATE.cues.length ? "timeline" : "dom-fallback",
      extensionVersion: SCRIPT_VERSION,
      backgroundVersion: STATE.backgroundVersion,
      runtimeConnected: STATE.runtimeConnected,
      translationError: STATE.translationError,
      trackAttempts: STATE.trackAttempt,
      trackReadyMs: STATE.metrics.trackReadyMs,
      lastTranslationMs: STATE.metrics.lastTranslationMs,
      medianTranslationMs: median(STATE.metrics.samples)
    })
  };
  window.__LT_YT__ = API;
  window.__LT_YT_START__ = () => API.start({});
  window.__LT_YT_STOP__ = () => API.stop();

  if (window.__LT_YT_MSG_VERSION__ !== SCRIPT_VERSION) {
    try {
      chrome.runtime.onMessage.removeListener?.(window.__LT_YT_MSG_HANDLER__);
    } catch {
      /* legacy or invalidated listeners are already detached */
    }
    window.__LT_YT_MSG_BOUND__ = true;
    window.__LT_YT_MSG_VERSION__ = SCRIPT_VERSION;
    const messageHandler = (message, _sender, sendResponse) => {
      if (String(message?.type || "").startsWith("OFFSCREEN_")) return;
      const api = window.__LT_YT__;
      if (!api) return false;
      if (message.type === "YT_SUBS_START") {
        Promise.resolve(api.start(message))
          .then((info) => sendResponse({ ok: true, ...info }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
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
    };
    window.__LT_YT_MSG_HANDLER__ = messageHandler;
    chrome.runtime.onMessage.addListener(messageHandler);
  }

  const STATE = {
    enabled: false,
    videoId: null,
    targetLang: "zh-CN",
    mode: "bilingual",
    overlay: null,
    textEl: null,
    lastHtml: "",
    translationError: "",
    runtimeConnected: false,
    backgroundVersion: "",
    cues: [],
    lastCueIdx: -1,
    lastDomKey: "",
    token: 0,
    raf: 0,
    video: null,
    observer: null,
    pollTimer: 0,
    growTimer: 0,
    trackRetryTimer: 0,
    trackAttempt: 0,
    metrics: {
      trackReadyMs: null,
      lastTranslationMs: null,
      samples: []
    },
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
  const BATCH_SIZE = 24;
  const RETRY_CONCURRENCY = 3;

  document.addEventListener("yt-navigate-finish", () => {
    if (window.__LT_YT__ !== API || !STATE.enabled) return;
    const id = getVideoId();
    if (id && id !== STATE.videoId) startSubs({}).catch(setTranslationError);
  });

  setTimeout(async () => {
    if (window.__LT_YT__ !== API || !isYouTubeWatch()) return;
    try {
      const s = await getSettings();
      const host = location.hostname || "";
      const blocked = Array.isArray(s.blockedHosts) ? s.blockedHosts : [];
      if (host && blocked.includes(host)) return;
      if (s.videoSubsAuto) {
        startSubs({ targetLang: s.targetLang, mode: s.videoSubsMode || s.displayMode })
          .catch(setTranslationError);
      }
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

  async function getSettings() {
    const res = await runtimeMessage({ type: "GET_SETTINGS" }, 1800, "settings");
    if (!res?.ok || !res.settings) throw new Error(res?.error || "settings unavailable");
    return res.settings;
  }

  function safeManifestVersion() {
    try {
      return chrome.runtime.getManifest().version || "unknown";
    } catch {
      return "disconnected";
    }
  }

  async function checkRuntimeHealth() {
    const health = await runtimeMessage({ type: "RUNTIME_HEALTH" }, 1800, "runtime health");
    if (!health?.ok) throw new Error(health?.error || "subtitle runtime unavailable");
    const currentVersion = safeManifestVersion();
    if (!health.version || health.version !== currentVersion) {
      STATE.runtimeConnected = false;
      STATE.backgroundVersion = health.version || "";
      throw new Error(`扩展版本不一致（页面 ${currentVersion} / 后台 ${health.version || "未知"}），请刷新页面`);
    }
    STATE.runtimeConnected = true;
    STATE.backgroundVersion = health.version;
    return health;
  }

  async function startSubs(opts = {}) {
    if (window.__LT_YT__ !== API) throw new Error("Stale subtitle runtime instance");
    if (!isYouTubeWatch()) throw new Error("YouTube watch pages only");

    const health = await checkRuntimeHealth();
    const settings = opts.settings || health.settings || (await getSettings());
    const host = location.hostname || "";
    const blocked = Array.isArray(settings.blockedHosts) ? settings.blockedHosts : [];
    if (host && blocked.includes(host)) throw new Error("This site is blocked");

    STATE.targetLang = opts.targetLang || settings.targetLang || STATE.targetLang || "zh-CN";
    STATE.mode =
      opts.mode || settings.videoSubsMode || settings.displayMode || STATE.mode || "bilingual";

    STATE.enabled = true;
    STATE.token += 1;
    const token = STATE.token;
    STATE.videoId = getVideoId();
    STATE.cues = [];
    STATE.lastCueIdx = -1;
    STATE.lastDomKey = "";
    STATE.prev = null;
    STATE.cur = null;
    STATE.lastHtml = "";
    STATE.translationError = "";
    STATE.runtimeConnected = true;
    STATE.trackAttempt = 0;
    clearTimeout(STATE.trackRetryTimer);
    STATE.metrics = { trackReadyMs: null, lastTranslationMs: null, samples: [] };
    clearTimeout(STATE.growTimer);

    ensureOverlay();
    bindVideo();
    watchCaptions();
    startPoll();

    // Follow current CC immediately
    tickDom(true);
    // Fetch track in background + parallel pre-translate
    bootTrack(token).catch(() => scheduleTrackRetry(token));

    return {
      ready: true,
      instant: true,
      extensionVersion: safeManifestVersion(),
      runtimeConnected: true,
      tip: "Dual-panel sync on; enable CC"
    };
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
    clearTimeout(STATE.trackRetryTimer);
    document.querySelectorAll("#lt-yt-overlay").forEach((n) => n.remove());
    STATE.overlay = null;
    STATE.textEl = null;
    STATE.lastHtml = "";
    STATE.runtimeConnected = false;
    STATE.drag.dragging = false;
    STATE.drag.bound = false;
    document.documentElement.classList.remove("lt-yt-hide-native-cc");
  }

  async function bootTrack(token) {
    STATE.trackAttempt += 1;
    const startedAt = performance.now();
    const track = await Promise.race([
      findCaptionTrack(STATE.videoId),
      sleep(1800).then(() => null)
    ]);
    if (token !== STATE.token || !STATE.enabled) return;
    if (!track) {
      scheduleTrackRetry(token);
      return;
    }

    // Start source and YouTube's translated track together. The source track
    // remains the critical path; a slow translated track never blocks prefetch.
    const sourceTask = fetchCues(track.baseUrl).catch(() => []);
    const tlang = toYtTlang(STATE.targetLang);
    const translatedTask = tlang
      ? fetchCues(withQuery(track.baseUrl, { tlang, fmt: "json3" })).catch(() => [])
      : Promise.resolve([]);
    const raw = await Promise.race([sourceTask, sleep(3500).then(() => [])]);
    if (token !== STATE.token || !STATE.enabled) return;
    if (!raw.length) {
      scheduleTrackRetry(token);
      return;
    }

    clearTimeout(STATE.trackRetryTimer);
    STATE.trackRetryTimer = 0;

    STATE.cues = CORE.buildReadableCues(raw, {
      minDuration: 1.8,
      maxDuration: 5.5,
      maxChars: 110,
      pauseBreak: 0.7
    });
    STATE.metrics.trackReadyMs = Math.round(performance.now() - startedAt);

    // The timed track is now authoritative. Replace rolling DOM fragments with
    // the complete reading unit under the playhead immediately.
    const activeIdx = findCueIndex(STATE.video?.currentTime || 0);
    if (activeIdx >= 0) {
      STATE.prev = null;
      STATE.cur = null;
      STATE.lastDomKey = "";
      STATE.lastCueIdx = activeIdx;
      const activeText = STATE.cues[activeIdx].text;
      STATE.lastDomKey = cueKey(activeText);
      pushNew(activeText);
    }

    const applyTranslatedTrack = (async () => {
      const translated = await Promise.race([
        translatedTask,
        sleep(5000).then(() => [])
      ]);
      if (token !== STATE.token || !STATE.enabled || !translated.length) return;
      const aligned = CORE.alignTranslatedCues(STATE.cues, translated);
      for (let i = 0; i < STATE.cues.length; i += 1) {
        const en = STATE.cues[i]?.text;
        const zh = String(aligned[i] || "").trim();
        if (en && isUsableTranslation(zh, en)) cacheSet(ck(en), zh);
      }
      backfillPairsFromCache();
      paint();
    })();

    // Give a fast tlang response a tiny head start, then immediately batch the
    // visible and near-future cues through the configured translation engine.
    await Promise.race([applyTranslatedTrack, sleep(180)]);
    await warmWindow(token, true);
    warmLoop(token);
  }

  function scheduleTrackRetry(token) {
    if (token !== STATE.token || !STATE.enabled || STATE.cues.length) return;
    clearTimeout(STATE.trackRetryTimer);
    const attempt = Math.max(1, STATE.trackAttempt);
    const delay = Math.min(4000, 500 * 1.55 ** Math.min(attempt - 1, 6));
    STATE.trackRetryTimer = setTimeout(() => {
      STATE.trackRetryTimer = 0;
      if (token !== STATE.token || !STATE.enabled || STATE.cues.length) return;
      bootTrack(token).catch(() => scheduleTrackRetry(token));
    }, Math.round(delay));
  }

  function toYtTlang(code) {
    const c = String(code || "zh-CN");
    if (c === "zh-CN" || c === "zh") return "zh-CN";
    if (c === "zh-TW") return "zh-TW";
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
    const list = CORE.buildPrefetchTexts(STATE.cues, now, {
      limit: urgent ? BATCH_SIZE : 16,
      horizon: urgent ? 90 : 45
    }).filter((text) => !cache.has(ck(text)) && !inflight.has(ck(text)));
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
      if (token === STATE.token && STATE.enabled) setTimeout(tick, 1600);
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
    }, 80);
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
    const left = String(a).split(/\s+/).filter(Boolean);
    const right = String(b).split(/\s+/).filter(Boolean);
    const maxOverlap = Math.min(left.length, right.length, 8);
    for (let size = maxOverlap; size >= 2; size -= 1) {
      if (left.slice(-size).join(" ") === right.slice(0, size).join(" ")) return true;
    }
    return false;
  }

  function cueKey(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function tickDom(force) {
    // Once a real timed track exists, never let rolling on-screen ASR fragments
    // overwrite stable sentence-level cues. DOM reading is fallback-only.
    if (STATE.cues.length) return;
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
    return CORE.findCueIndex(STATE.cues, t);
  }

  function pushNew(en) {
    const key = cueKey(en);
    const now = performance.now();
    // Whole new current line → old current becomes previous
    if (STATE.cur && STATE.cur.key && STATE.cur.key !== key && !isGrowing(STATE.cur.key, key)) {
      // The current cue must stay time-accurate; the old cue receives one full
      // additional cue as the previous line. Keeping an older line longer would
      // hide newer context and feels laggy even when its translation is fast.
      STATE.prev = { ...STATE.cur };
    }

    const hit = lookupZh(en);
    STATE.cur = {
      en,
      zh: hit || "",
      key,
      pending: !hit,
      req: 0,
      asked: "",
      startedAt: now,
      translatedAt: hit ? now : 0
    };
    paint();
    // Current text gets its own priority request. Never make the visible cue
    // wait behind a 24-line future-prefetch batch.
    requestTranslate(en, { force: true });
    prefetchNeighbors(en);
  }

  function updateCurrent(en) {
    const key = cueKey(en);
    const hit = lookupZh(en);
    if (!STATE.cur) {
      const now = performance.now();
      STATE.cur = {
        en,
        zh: hit || "",
        key,
        pending: !hit,
        req: 0,
        asked: "",
        startedAt: now,
        translatedAt: hit ? now : 0
      };
      paint();
      requestTranslate(en, { force: !STATE.cues.length });
      return;
    }

    STATE.cur.en = en;
    STATE.cur.key = key;
    if (hit) {
      STATE.cur.zh = hit;
      STATE.cur.pending = false;
      recordTranslationLatency(STATE.cur);
    } else if (!STATE.cur.zh) {
      STATE.cur.pending = true;
    }
    paint();
    requestTranslate(en, { force: false });
  }

  /** Exact hit, or longest cached prefix (ASR still growing). */
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
      if (!hasTargetScript(v)) continue;
      const src = String(k).slice(prefix.length);
      if (!src || src.length < 8) continue;
      if (text === src) return v;
      if (text.startsWith(src) && src.length > bestLen) {
        best = v;
        bestLen = src.length;
      }
    }
    return best;
  }

  function hasCjk(s) {
    return /[\u4e00-\u9fff]/.test(String(s || ""));
  }

  function hasTargetScript(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    return /^zh(?:-|$)/i.test(STATE.targetLang || "zh-CN") ? hasCjk(text) : true;
  }

  function isUsableTranslation(output, source) {
    const translated = String(output || "").trim();
    if (!translated || translated === String(source || "").trim()) return false;
    return hasTargetScript(translated);
  }

  function translationErrorLabel(error) {
    const detail = String(error?.message || error || "");
    if (/context invalidated|extension.*reload|receiving end does not exist|版本不一致|stale subtitle runtime/i.test(detail)) {
      return "扩展已更新，请刷新此页面";
    }
    if (/timeout|timed out/i.test(detail)) return "翻译连接超时，正在重试";
    return "翻译暂时不可用，请刷新页面";
  }

  function setTranslationError(error) {
    STATE.translationError = translationErrorLabel(error);
    if (/context invalidated|receiving end|runtime health|settings|timeout|版本不一致|stale subtitle runtime/i.test(
      String(error?.message || error || "")
    )) {
      STATE.runtimeConnected = false;
    }
    paint();
  }

  function clearTranslationError() {
    if (!STATE.translationError) return;
    STATE.translationError = "";
    STATE.runtimeConnected = true;
    paint();
  }

  function recordTranslationLatency(pair) {
    if (!pair?.startedAt) return;
    const now = performance.now();
    if (pair.translatedAt) return;
    pair.translatedAt = now;
    const elapsed = Math.max(0, Math.round(pair.translatedAt - pair.startedAt));
    STATE.metrics.lastTranslationMs = elapsed;
    STATE.metrics.samples.push(elapsed);
    if (STATE.metrics.samples.length > 30) STATE.metrics.samples.shift();
  }

  function median(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  function backfillPairsFromCache() {
    for (const pair of [STATE.cur, STATE.prev]) {
      if (!pair?.en || (pair.zh && hasTargetScript(pair.zh))) continue;
      const zh = lookupZh(pair.en);
      if (zh && hasTargetScript(zh)) {
        pair.zh = zh;
        pair.pending = false;
        STATE.translationError = "";
        recordTranslationLatency(pair);
      }
    }
  }

  function pairRelated(pair, text) {
    if (!pair?.en || !text) return false;
    const a = cueKey(pair.en);
    const b = cueKey(text);
    if (!a || !b) return false;
    if (a === b) return true;
    if (isGrowing(a, b) || isGrowing(b, a)) return true;
    // Same line after minor ASR rewrite
    if (a.length > 20 && b.length > 20 && (a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24)))) {
      return true;
    }
    return false;
  }

  /** Apply finished ZH onto cur and/or prev (line may have advanced). */
  function applyZhToPairs(en, zh) {
    if (!zh || !hasTargetScript(zh)) return false;
    STATE.translationError = "";
    let changed = false;
    if (pairRelated(STATE.cur, en)) {
      STATE.cur.zh = zh;
      STATE.cur.pending = false;
      recordTranslationLatency(STATE.cur);
      changed = true;
    }
    if (pairRelated(STATE.prev, en)) {
      STATE.prev.zh = zh;
      STATE.prev.pending = false;
      recordTranslationLatency(STATE.prev);
      changed = true;
    }
    return changed;
  }

  function requestTranslate(en, opts = {}) {
    if (!en || !STATE.cur) return;
    clearTimeout(STATE.growTimer);

    const run = () => {
      if (!STATE.enabled || !STATE.cur) return;
      const latest = String(STATE.cur.en || en).trim();
      if (!latest) return;
      const cached = lookupZh(latest);
      if (cached) {
        if (applyZhToPairs(latest, cached)) paint();
        return;
      }
      if (STATE.cur.asked === latest && inflight.has(ck(latest))) return;
      STATE.cur.asked = latest;
      const req = (STATE.cur.req = (STATE.cur.req || 0) + 1);
      const my = req;
      const asked = latest;

      translateOne(asked)
        .then((zh) => {
          if (!STATE.enabled) return;
          // Drop only clearly superseded requests on the *same* cur object
          if (STATE.cur && my < (STATE.cur.req || 0) - 2) return;
          if (!zh) return;
          clearTranslationError();
          if (applyZhToPairs(asked, zh)) paint();
          else {
            backfillPairsFromCache();
            paint();
          }
        })
        .catch((err) => {
          console.warn("[LT subs translate]", err);
          if (pairRelated(STATE.cur, asked) && !STATE.cur?.zh) {
            setTranslationError(err);
          }
        });
    };

    if (opts.force) {
      run();
      return;
    }
    STATE.growTimer = setTimeout(run, 130);
  }

  function prefetchNeighbors(en) {
    if (!STATE.cues.length) return;
    const now = STATE.video?.currentTime || 0;
    const batch = CORE.buildPrefetchTexts(STATE.cues, now, {
      limit: 12,
      horizon: 35
    }).filter(
      (text) =>
        cueKey(text) !== cueKey(en) &&
        !cache.has(ck(text)) &&
        !inflight.has(ck(text))
    );
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
    const html = parts.join("");
    if (html === STATE.lastHtml) return;
    STATE.lastHtml = html;
    STATE.textEl.innerHTML = html;
  }

  function pairHtml(pair, role, onlyZh) {
    const en = escapeHtml(clip(pair.en, 120));
    const zhRaw = pair.zh && hasTargetScript(pair.zh) ? pair.zh : "";
    const zh = zhRaw ? escapeHtml(clip(zhRaw, 80)) : "";
    const pendingText = STATE.translationError
      ? escapeHtml(STATE.translationError)
      : "…";
    const pendingClass = STATE.translationError
      ? "lt-yt-pending lt-yt-error"
      : "lt-yt-pending";
    if (onlyZh) {
      return `<div class="lt-yt-pair lt-yt-pair-${role}"><div class="lt-yt-trans ${zh ? "" : pendingClass}">${zh || (pair.pending ? pendingText : en)}</div></div>`;
    }
    const zhLine = zh
      ? `<div class="lt-yt-trans">${zh}</div>`
      : `<div class="lt-yt-trans ${pendingClass}">${pendingText}</div>`;
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
    if (cache.has(key)) {
      const hit = cache.get(key);
      if (hit && hasTargetScript(hit)) return hit;
    }
    if (inflight.has(key)) return inflight.get(key);

    // The service worker is the only network boundary. One short retry handles
    // MV3 worker wake-up without bypassing the audited host allowlist.
    const p = translateViaBg(text)
      .catch(async () => {
        await sleep(80);
        return translateViaBg(text);
      })
      .then((out) => {
        const zh = String(out || "").trim();
        if (!isUsableTranslation(zh, text)) throw new Error("empty or invalid translation");
        cacheSet(key, zh);
        return zh;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  function translateViaBg(text) {
    return runtimeMessage(
      { type: "TRANSLATE_ONE", text, targetLang: STATE.targetLang || "zh-CN" },
      4500,
      "translation"
    ).then((res) => {
      if (!res?.ok || !res.translated) throw new Error(res?.error || "bg translate empty");
      return res.translated;
    });
  }

  async function translateMany(texts) {
    const uniq = [...new Set(texts.filter(Boolean))];
    const need = uniq.filter((t) => !cache.has(ck(t)) && !inflight.has(ck(t)));
    if (!need.length) return;
    let lastError = null;

    const chunks = [];
    for (let i = 0; i < need.length; i += BATCH_SIZE) chunks.push(need.slice(i, i + BATCH_SIZE));

    for (const chunk of chunks) {
      const batch = translateBatchViaBg(chunk);
      const promises = chunk.map((text, index) => {
        const key = ck(text);
        const p = batch
          .then((results) => {
            const out = String(results?.[index] || "").trim();
            if (isUsableTranslation(out, text)) cacheSet(key, out);
            return isUsableTranslation(out, text) ? out : "";
          })
          .catch((err) => {
            lastError = err;
            return "";
          })
          .finally(() => {
            if (inflight.get(key) === p) inflight.delete(key);
          });
        inflight.set(key, p);
        return p;
      });
      await Promise.all(promises);
    }

    // Retry only missing lines, with restrained concurrency. A 24-line warmup
    // is normally one request instead of the previous 12 simultaneous calls.
    const missing = need.filter((text) => !cache.has(ck(text)));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(RETRY_CONCURRENCY, missing.length) }, async () => {
        while (cursor < missing.length) {
          const text = missing[cursor++];
          try {
            await translateOne(text);
          } catch (err) {
            lastError = err;
          }
        }
      })
    );

    const stillMissing = need.filter((text) => !cache.has(ck(text)));
    const currentMissing = stillMissing.some((text) => pairRelated(STATE.cur, text));
    if (currentMissing) {
      setTranslationError(lastError || new Error("translation returned no usable text"));
    } else if (!stillMissing.length) {
      clearTranslationError();
    }
  }

  function translateBatchViaBg(texts) {
    return runtimeMessage(
      { type: "TRANSLATE_BATCH", texts, targetLang: STATE.targetLang || "zh-CN" },
      20000,
      "batch translation"
    ).then((res) => {
      if (!res?.ok || !Array.isArray(res.results)) {
        throw new Error(res?.error || "bg batch translate empty");
      }
      return res.results;
    });
  }

  function runtimeMessage(message, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`${label || "extension message"} timeout`)),
        timeoutMs
      );
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            finish(reject, new Error(runtimeError.message));
            return;
          }
          finish(resolve, res);
        });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  function cacheSet(key, val) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, val);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // ─── Caption track ───

  async function findCaptionTrack(videoId) {
    if (!videoId) return null;

    // MAIN-world signals are independent; waiting serially added up to 1.8s.
    const [sniffed, player] = await Promise.all([
      getSniffedTimedtextUrls(),
      getPlayerResponse()
    ]);
    const sniffedSource = sniffed
      .filter((url) => !/[?&]tlang=/i.test(url))
      .filter((url) => captionUrlMatchesVideo(url, videoId))
      .sort((a, b) => captionUrlScore(b) - captionUrlScore(a))[0];
    if (sniffedSource) {
      return { baseUrl: withQuery(sniffedSource, { fmt: "json3" }), lang: "sniffed" };
    }

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
    // Do not guess unsigned timedtext URLs. Modern YouTube often requires a
    // player token; wait for the real player track or a captured request.
    return null;
  }

  function captionUrlScore(value) {
    try {
      const url = new URL(value, location.origin);
      const lang = String(url.searchParams.get("lang") || "").toLowerCase();
      const kind = String(url.searchParams.get("kind") || "").toLowerCase();
      let score = 0;
      if (lang.startsWith("en")) score += 50;
      if (kind !== "asr") score += 20;
      if (!url.searchParams.has("tlang")) score += 10;
      return score;
    } catch {
      return 0;
    }
  }

  function captionUrlMatchesVideo(value, videoId) {
    try {
      const url = new URL(value, location.origin);
      const capturedId = url.searchParams.get("v");
      return !capturedId || capturedId === videoId;
    } catch {
      return false;
    }
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
      }, 450);
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

  async function fetchCues(baseUrl) {
    let url = baseUrl;
    if (!/[?&]fmt=/.test(url)) url += (url.includes("?") ? "&" : "?") + "fmt=json3";
    const raw = await fetchTextViaBg(url);
    return CORE.parseCueJson(raw);
  }

  function fetchTextViaBg(url) {
    return runtimeMessage({ type: "FETCH_TEXT", url }, 6000, "caption fetch").then((res) => {
      if (!res?.ok) throw new Error(res?.error || "fetch failed");
      return res.text || "";
    });
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
    placeOverlay();
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
