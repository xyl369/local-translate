/**
 * Translation service worker.
 * Default engine: Google Translate (free). Optional: Chrome on-device Translator (no big model).
 * Google path: translate-pa list batch, clients5 fallback, then gtx POST.
 */

const DEFAULT_SETTINGS = {
  targetLang: "zh-CN",
  displayMode: "bilingual",
  translationStyle: "muted",
  autoTranslate: false,
  skipCode: true,
  minLength: 2,
  videoSubsAuto: true,
  videoSubsMode: "bilingual",
  blockedHosts: [],
  // google = free gtx (default); chrome = on-device Translator API when available
  engine: "google"
};

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const MIGRATED_KEY = "__migratedFromSync";
const ALLOWED_FETCH_HOSTS = new Set([
  "translate.googleapis.com",
  "translate-pa.googleapis.com",
  "clients5.google.com",
  "www.youtube.com",
  "youtube.com"
]);

/** Public Translate Web Pages JS used only to read Google's web client API key. */
const GOOGLE_PA_JS =
  "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main";

function markTabNeedsRefresh(tabId, needed) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b45309" })?.catch?.(() => {});
    chrome.action.setBadgeText({ tabId, text: needed ? "刷新" : "" })?.catch?.(() => {});
  } catch {
    /* badge is diagnostic only */
  }
}

function migrateSyncToLocal() {
  return new Promise((resolve) => {
    chrome.storage.local.get([MIGRATED_KEY], (local) => {
      if (local[MIGRATED_KEY]) {
        resolve();
        return;
      }
      chrome.storage.sync.get(null, (syncData) => {
        const payload = { ...DEFAULT_SETTINGS, ...(syncData || {}), [MIGRATED_KEY]: true };
        chrome.storage.local.set(payload, () => {
          chrome.storage.sync.clear(() => resolve());
        });
      });
    });
  });
}

const cache = new Map();
const CACHE_MAX = 2000;

function cacheKey(text, lang, engine) {
  return `${engine || "google"}||${lang}||${text}`;
}

function cacheGet(text, lang, engine) {
  const k = cacheKey(text, lang, engine);
  if (!cache.has(k)) return undefined;
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v);
  return v;
}

function cacheSet(text, lang, engine, result) {
  const k = cacheKey(text, lang, engine);
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(k, result);
}

chrome.runtime.onInstalled.addListener(() => {
  migrateSyncToLocal().then(() => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
      chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...settings, [MIGRATED_KEY]: true });
    });
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lt-translate-selection",
      title: "Translate selection",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "lt-translate-page",
      title: "Translate page (bilingual)",
      contexts: ["page"]
    });
  });
});

migrateSyncToLocal().then(() => {
  getGooglePaKey().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await ensureTabScript(tab.id, tab.url);
  const settings = await getSettings();
  try {
    const host = tab.url ? new URL(tab.url).hostname : "";
    const blocked = Array.isArray(settings.blockedHosts) ? settings.blockedHosts : [];
    if (host && blocked.includes(host)) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_SELECTION_RESULT",
        original: "This site is blocked",
        translated: "Never translate this site is enabled"
      });
      return;
    }
  } catch {
    /* ignore */
  }

  if (info.menuItemId === "lt-translate-selection" && info.selectionText) {
    try {
      const translated = await translateText(info.selectionText, settings.targetLang);
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_SELECTION_RESULT",
        original: info.selectionText,
        translated
      });
    } catch (err) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_SELECTION_RESULT",
        original: "Translation failed",
        translated: String(err?.message || err)
      });
    }
  }
  if (info.menuItemId === "lt-translate-page") {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATE" });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensureTabScript(tab.id, tab.url);
  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATE" });
});

/** Inject only when needed (not every page by default). */
async function ensureTabScript(tabId, tabUrl) {
  let contentReady = false;
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (pong?.ok && pong.version !== EXTENSION_VERSION) {
      markTabNeedsRefresh(tabId, true);
      throw new Error(`STALE_PAGE_CONTEXT:${pong.version || "legacy"}:${EXTENSION_VERSION}`);
    }
    contentReady = pong?.version === EXTENSION_VERSION;
  } catch (err) {
    if (/STALE_PAGE_CONTEXT/.test(String(err?.message || err))) throw err;
    /* inject below */
  }
  if (!contentReady) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-core.js", "content.js"] });
    await sleep(40);
    let pong;
    try {
      pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    } catch (err) {
      markTabNeedsRefresh(tabId, true);
      throw err;
    }
    if (pong?.version !== EXTENSION_VERSION) {
      markTabNeedsRefresh(tabId, true);
      throw new Error(`CONTENT_INJECTION_FAILED:${pong?.version || "missing"}`);
    }
  }

  const url = tabUrl || (await chrome.tabs.get(tabId).then((t) => t.url).catch(() => ""));
  if (/youtube\.com|youtu\.be/i.test(url || "")) {
    try {
      const status = await chrome.tabs.sendMessage(tabId, { type: "YT_SUBS_STATUS" });
      if (status?.extensionVersion === EXTENSION_VERSION) {
        markTabNeedsRefresh(tabId, false);
        return;
      }
      if (status?.ok) {
        markTabNeedsRefresh(tabId, true);
        throw new Error(
          `STALE_YOUTUBE_CONTEXT:${status.extensionVersion || "legacy"}:${EXTENSION_VERSION}`
        );
      }
    } catch (err) {
      if (/STALE_YOUTUBE_CONTEXT/.test(String(err?.message || err))) throw err;
      /* inject YouTube modules below */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["youtube-bridge.js"],
        world: "MAIN"
      });
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["youtube-subs-core.js", "youtube-subs.js"]
    });
    await sleep(40);
    let injectedStatus;
    try {
      injectedStatus = await chrome.tabs.sendMessage(tabId, { type: "YT_SUBS_STATUS" });
    } catch (err) {
      markTabNeedsRefresh(tabId, true);
      throw err;
    }
    if (injectedStatus?.extensionVersion !== EXTENSION_VERSION) {
      markTabNeedsRefresh(tabId, true);
      throw new Error(
        `YOUTUBE_INJECTION_FAILED:${injectedStatus?.extensionVersion || "missing"}`
      );
    }
  }
  markTabNeedsRefresh(tabId, false);
}

/** Auto-inject only for auto-translate / YouTube auto-subs. */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab?.url) return;
  if (!/^https?:/i.test(tab.url)) return;
  getSettings().then(async (s) => {
    const host = (() => {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return "";
      }
    })();
    const blocked = Array.isArray(s.blockedHosts) ? s.blockedHosts : [];
    if (host && blocked.includes(host)) return;
    const isYt = /youtube\.com|youtu\.be/i.test(tab.url);
    if (s.autoTranslate || (isYt && s.videoSubsAuto)) {
      try {
        await ensureTabScript(tabId, tab.url);
        if (isYt && s.videoSubsAuto) {
          const result = await chrome.tabs.sendMessage(tabId, {
            type: "YT_SUBS_START",
            targetLang: s.targetLang,
            mode: s.videoSubsMode || s.displayMode
          });
          if (!result?.ok) markTabNeedsRefresh(tabId, true);
        }
        if (s.autoTranslate && !isYt) {
          await chrome.tabs.sendMessage(tabId, { type: "TRANSLATE_PAGE" }).catch(() => {});
        }
      } catch {
        if (isYt) markTabNeedsRefresh(tabId, true);
      }
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "RUNTIME_HEALTH") {
    getSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          version: EXTENSION_VERSION,
          engine: settings.engine,
          targetLang: settings.targetLang,
          settings
        })
      )
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message.type === "GET_SETTINGS") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (message.type === "ENGINE_STATUS") {
    probeEngine()
      .then((info) => sendResponse({ ok: true, ...info }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message.type === "TRANSLATE_ONE") {
    translateText(message.text, message.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message.type === "TRANSLATE_BATCH") {
    translateBatch(message.texts, message.targetLang)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message.type === "FETCH_TEXT") {
    fetchAllowedText(message.url)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message.type === "ENSURE_SCRIPTS") {
    const tabId = _sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no tab" });
      return false;
    }
    ensureTabScript(tabId, _sender.tab?.url)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});

function getSettings() {
  return migrateSyncToLocal().then(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(DEFAULT_SETTINGS, (data) =>
          resolve({ ...DEFAULT_SETTINGS, ...data })
        );
      })
  );
}

async function probeEngine() {
  const settings = await getSettings();
  const engine = settings.engine === "chrome" ? "chrome" : "google";
  if (engine === "chrome") {
    const avail = await chromeTranslatorAvailable();
    return {
      engine,
      available: avail,
      label: avail ? "Chrome on-device" : "Chrome on-device (unavailable → use Google)",
      offlineCapable: avail
    };
  }
  return { engine: "google", available: true, label: "Google Translate", offlineCapable: false };
}

async function fetchAllowedText(url) {
  const u = new URL(String(url || ""));
  if (!ALLOWED_FETCH_HOSTS.has(u.hostname)) {
    throw new Error("Host not allowed: " + u.hostname);
  }
  if (u.protocol !== "https:") throw new Error("HTTPS only");
  const res = await fetchWithTimeout(u.toString(), {}, 6500);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (text.length > 4_000_000) throw new Error("Caption response too large");
  return text;
}

async function fetchWithTimeout(input, init = {}, timeoutMs = 6500) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    return await fetch(input, controller ? { ...init, signal: controller.signal } : init);
  } catch (err) {
    if (controller?.signal.aborted) throw new Error(`Network timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const GOOGLE_GROUP_CHARS = 1800;
const GOOGLE_GROUP_ITEMS = 24;

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function wrapIndexedHtml(texts) {
  const inner = (Array.isArray(texts) ? texts : [])
    .map((text, i) => `<a i=${i}>${escapeHtml(text)}</a>`)
    .join("");
  return `<pre>${inner}</pre>`;
}

function unwrapIndexedHtml(html, count) {
  const out = Array.from({ length: count }, () => "");
  const re = /<a\s+i\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/a>/gi;
  let found = 0;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const idx = Number(match[1]);
    if (idx >= 0 && idx < count) {
      out[idx] += unescapeHtml(match[2] || "");
      found += 1;
    }
  }
  if (found < count) return null;
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

function parsePaList(data, count) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const list = data[0];
  if (list.length === 1 && count > 1 && /<a\s+i\s*=/i.test(String(list[0] || ""))) {
    return unwrapIndexedHtml(String(list[0]), count);
  }
  if (list.length < count) return null;
  return list.slice(0, count).map((s) => String(s || "").replace(/\s+/g, " ").trim());
}

function parseClients5List(data, count) {
  if (!Array.isArray(data) || !data.length) return null;
  const out = data.map((row) => (Array.isArray(row) ? String(row[0] || "") : String(row || "")));
  if (out.length === 1 && count > 1 && /<a\s+i\s*=/i.test(out[0])) {
    return unwrapIndexedHtml(out[0], count);
  }
  if (out.length < count) return null;
  return out.slice(0, count).map((s) => s.replace(/\s+/g, " ").trim());
}

function parseGtxSingle(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
  return data[0].map((seg) => (seg && seg[0]) || "").join("");
}

function isLimitStatus(status) {
  return status === 429 || status === 403 || status === 503;
}

function createLimiter(concurrency, minInterval) {
  let active = 0;
  let lastAt = 0;
  const waiters = [];
  async function acquire() {
    while (active >= concurrency) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    const wait = lastAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    active += 1;
    lastAt = Date.now();
  }
  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }
  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

const googleLimiter = createLimiter(2, 80);
let googlePaKey = { value: "", at: 0 };
let googlePaKeyPromise = null;
let googleBackoffUntil = 0;

async function waitGoogleBackoff() {
  const wait = googleBackoffUntil - Date.now();
  if (wait > 0) await sleep(Math.min(wait, 8000));
}

function noteGoogleLimit(retryAfterHeader) {
  const parsed = Number(retryAfterHeader);
  const extra = Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : 1000;
  googleBackoffUntil = Date.now() + Math.min(8000, extra);
}

async function getGooglePaKey() {
  if (googlePaKey.value && Date.now() - googlePaKey.at < 20 * 60 * 1000) {
    return googlePaKey.value;
  }
  if (googlePaKeyPromise) return googlePaKeyPromise;
  googlePaKeyPromise = (async () => {
    const res = await fetchWithTimeout(GOOGLE_PA_JS, {}, 5000);
    if (!res.ok) throw new Error(`Google key HTTP ${res.status}`);
    const text = await res.text();
    const named = text.match(/['"]x-goog-api-key['"]\s*:\s*['"]([A-Za-z0-9_-]{20,})['"]/i);
    const loose = text.match(/AIza[0-9A-Za-z_-]{30,}/);
    const key = (named && named[1]) || (loose && loose[0]) || "";
    if (!key) throw new Error("Google web client key missing");
    googlePaKey = { value: key, at: Date.now() };
    return key;
  })().finally(() => {
    googlePaKeyPromise = null;
  });
  return googlePaKeyPromise;
}

function rememberGoogleResult(text, lang, engine, translated) {
  const value = String(translated || "").trim();
  if (!value) return "";
  cacheSet(text, lang, engine, value);
  return value;
}

async function readJsonResponse(res, label) {
  if (isLimitStatus(res.status)) {
    noteGoogleLimit(res.headers?.get?.("Retry-After"));
    throw new Error(`${label} HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

async function callTranslatePa(texts, targetLang) {
  const key = await getGooglePaKey();
  await waitGoogleBackoff();
  return googleLimiter.run(async () => {
    const body = JSON.stringify([[texts, "auto", targetLang || "zh-CN"], "te"]);
    const res = await fetchWithTimeout(
      "https://translate-pa.googleapis.com/v1/translateHtml",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json+protobuf",
          "X-goog-api-key": key
        },
        body
      },
      8000
    );
    const data = await readJsonResponse(res, "translate-pa");
    const parsed = parsePaList(data, texts.length);
    if (!parsed || !parsed.some(Boolean)) throw new Error("translate-pa parse mismatch");
    return parsed;
  });
}

async function callClients5(texts, targetLang) {
  await waitGoogleBackoff();
  return googleLimiter.run(async () => {
    const tl = encodeURIComponent(targetLang || "zh-CN");
    const body = texts.map((text) => `q=${encodeURIComponent(text)}`).join("&");
    const res = await fetchWithTimeout(
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      },
      8000
    );
    const data = await readJsonResponse(res, "clients5");
    const parsed = parseClients5List(data, texts.length);
    if (!parsed || !parsed.some(Boolean)) throw new Error("clients5 parse mismatch");
    return parsed;
  });
}

async function callGtx(text, targetLang, retries = 2) {
  const tl = encodeURIComponent(targetLang || "zh-CN");
  const body = `q=${encodeURIComponent(text)}`;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await waitGoogleBackoff();
      const data = await googleLimiter.run(async () => {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body
          },
          8000
        );
        return readJsonResponse(res, "gtx");
      });
      return parseGtxSingle(data);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("gtx failed");
}

async function callGoogleMany(texts, targetLang) {
  const list = (Array.isArray(texts) ? texts : []).map((text) => String(text || "").trim());
  if (!list.length) return [];
  if (list.length === 1) return [await callGoogle(list[0], targetLang)];
  try {
    return await callTranslatePa(list, targetLang);
  } catch {
    /* next endpoint */
  }
  try {
    return await callClients5(list, targetLang);
  } catch {
    /* next endpoint */
  }
  throw new Error("google batch endpoints failed");
}

async function callGoogle(text, targetLang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  try {
    const [one] = await callTranslatePa([trimmed], targetLang);
    if (one) return one;
  } catch {
    /* next endpoint */
  }
  try {
    const [one] = await callClients5([trimmed], targetLang);
    if (one) return one;
  } catch {
    /* next endpoint */
  }
  return callGtx(trimmed, targetLang);
}

async function translateBatch(texts, targetLang) {
  const settings = await getSettings();
  const lang = targetLang || settings.targetLang;
  const requestedEngine = settings.engine === "chrome" ? "chrome" : "google";
  const engine =
    requestedEngine === "chrome" && (await chromeTranslatorAvailable()) ? "chrome" : "google";
  const list = Array.isArray(texts) ? texts : [];
  const results = new Array(list.length).fill("");

  const uncached = [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] || "").trim();
    if (!text) continue;
    const hit = cacheGet(text, lang, engine);
    if (hit) results[i] = hit;
    else uncached.push({ index: i, text });
  }
  if (!uncached.length) return results;

  if (engine === "chrome") {
    for (const item of uncached) {
      try {
        const translated = await callChrome(item.text, lang);
        results[item.index] = rememberGoogleResult(item.text, lang, engine, translated);
      } catch {
        results[item.index] = "";
      }
    }
    return results;
  }

  const groups = [];
  let currentGroup = [];
  let currentLen = 0;
  for (const item of uncached) {
    const addLen = item.text.length + 8;
    if (
      currentGroup.length &&
      (currentGroup.length >= GOOGLE_GROUP_ITEMS || currentLen + addLen > GOOGLE_GROUP_CHARS)
    ) {
      groups.push(currentGroup);
      currentGroup = [];
      currentLen = 0;
    }
    currentGroup.push(item);
    currentLen += addLen;
  }
  if (currentGroup.length) groups.push(currentGroup);

  async function fillGroup(group) {
    if (!group.length) return;
    const pending = group.filter((item) => !results[item.index]);
    if (!pending.length) return;
    if (pending.length === 1) {
      try {
        results[pending[0].index] = rememberGoogleResult(
          pending[0].text,
          lang,
          "google",
          await callGoogle(pending[0].text, lang)
        );
      } catch {
        results[pending[0].index] = "";
      }
      return;
    }
    try {
      const parts = await callGoogleMany(
        pending.map((item) => item.text),
        lang
      );
      if (Array.isArray(parts) && parts.length >= pending.length) {
        for (let j = 0; j < pending.length; j++) {
          results[pending[j].index] = rememberGoogleResult(
            pending[j].text,
            lang,
            "google",
            parts[j]
          );
        }
        return;
      }
    } catch {
      /* split missing items instead of stampeding */
    }
    const missing = pending.filter((item) => !results[item.index]);
    if (!missing.length) return;
    const mid = Math.ceil(missing.length / 2);
    await fillGroup(missing.slice(0, mid));
    await fillGroup(missing.slice(mid));
  }

  let cursor = 0;
  const workers = Math.min(2, groups.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < groups.length) {
        const gi = cursor++;
        if (gi < groups.length) await fillGroup(groups[gi]);
      }
    })
  );
  return results;
}

async function translateText(text, targetLang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const settings = await getSettings();
  const lang = targetLang || settings.targetLang;
  const requestedEngine = settings.engine === "chrome" ? "chrome" : "google";
  const engine =
    requestedEngine === "chrome" && (await chromeTranslatorAvailable()) ? "chrome" : "google";

  const hit = cacheGet(trimmed, lang, engine);
  if (hit) return hit;

  let result = "";
  if (engine === "chrome") {
    result = await callChrome(trimmed, lang);
  } else {
    const MAX = 1500;
    if (trimmed.length <= MAX) {
      result = await callGoogle(trimmed, lang);
    } else {
      const parts = splitBySentence(trimmed, MAX);
      const out = [];
      for (const part of parts) out.push(await callGoogle(part, lang));
      result = out.join("");
    }
  }

  return rememberGoogleResult(trimmed, lang, engine, result);
}

/** Map UI lang codes → Chrome Translator BCP-47 tags. */
function toChromeLang(code) {
  const c = String(code || "zh-CN");
  const map = {
    "zh-CN": "zh-Hans",
    "zh-TW": "zh-Hant",
    zh: "zh-Hans",
    en: "en",
    ja: "ja",
    ko: "ko",
    fr: "fr",
    de: "de",
    es: "es",
    ru: "ru",
    pt: "pt",
    vi: "vi",
    th: "th"
  };
  return map[c] || c;
}

let chromeAvailCache = { at: 0, value: null };

async function chromeTranslatorAvailable() {
  if (Date.now() - chromeAvailCache.at < 30000 && chromeAvailCache.value != null) {
    return chromeAvailCache.value;
  }
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PROBE" });
    chromeAvailCache = { at: Date.now(), value: !!res?.available };
    return chromeAvailCache.value;
  } catch {
    chromeAvailCache = { at: Date.now(), value: false };
    return false;
  }
}

async function callChrome(text, targetLang) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_TRANSLATE",
    text,
    targetLang: toChromeLang(targetLang)
  });
  if (!res?.ok) throw new Error(res?.error || "Chrome Translator failed");
  return String(res.translated || "");
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Run Chrome on-device Translator API without a local LLM"
  });
}

function splitBySentence(text, maxLen) {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？\n]*|[^.!?。！？\n]+$/g) || [text];
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > maxLen && buf) {
      chunks.push(buf);
      buf = s;
    } else buf += s;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
