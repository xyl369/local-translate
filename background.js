/**
 * Translation service: Google Translate (public gtx API, higher quality than Chrome on-device)
 * Settings use chrome.storage.local only — never sync to a Google account.
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
  blockedHosts: []
};

const MIGRATED_KEY = "__migratedFromSync";

/** One-time: copy chrome.storage.sync → local, then clear sync (avoids Google account sync). */
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

// ─── Translation cache (in-memory LRU, max 2000 entries) ───
const cache = new Map();
const CACHE_MAX = 2000;

function cacheKey(text, lang) {
  return `${lang}||${text}`;
}

function cacheGet(text, lang) {
  const k = cacheKey(text, lang);
  if (!cache.has(k)) return undefined;
  const v = cache.get(k);
  // LRU: move to end
  cache.delete(k);
  cache.set(k, v);
  return v;
}

function cacheSet(text, lang, result) {
  const k = cacheKey(text, lang);
  if (cache.size >= CACHE_MAX) {
    // Evict oldest
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(k, result);
}

// ─── Install & context menu ───

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

// Also migrate on service worker wake (covers upgrades that skip onInstalled).
migrateSyncToLocal();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await ensureTabScript(tab.id);
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
  await ensureTabScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATE" });
});

async function ensureTabScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    try {
      const tab = await chrome.tabs.get(tabId);
      if (/youtube\.com|youtu\.be/i.test(tab.url || "")) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["youtube-subs.js"] });
      }
    } catch {
      /* ignore */
    }
  }
}

// ─── Message handling ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_SETTINGS") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
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

// ─── Core: batched translation ───

// Numbered markers as separators; Google is less likely to eat them. Fall back per-item on split failure.
const MARK = (i) => `\n\n[[LT${i}]]\n\n`;
const MARK_SPLIT = /\[\[[\s]*LT[\s]*\d+[\s]*\]\]/i;

async function translateBatch(texts, targetLang) {
  const settings = await getSettings();
  const lang = targetLang || settings.targetLang;
  const list = Array.isArray(texts) ? texts : [];
  const results = new Array(list.length).fill("");

  const uncached = [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] || "").trim();
    if (!text) continue;
    const hit = cacheGet(text, lang);
    if (hit !== undefined) results[i] = hit;
    else uncached.push({ index: i, text });
  }

  if (!uncached.length) return results;

  const MAX_CHARS = 4200;
  const groups = [];
  let currentGroup = [];
  let currentLen = 0;

  for (const item of uncached) {
    const addLen = item.text.length + 16;
    if (currentLen + addLen > MAX_CHARS && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
      currentLen = 0;
    }
    currentGroup.push(item);
    currentLen += addLen;
  }
  if (currentGroup.length) groups.push(currentGroup);

  const CONCURRENCY = 6;
  let cursor = 0;

  async function translateGroup(group) {
    if (group.length === 1) {
      try {
        const translated = await translateText(group[0].text, lang);
        results[group[0].index] = translated;
        cacheSet(group[0].text, lang, translated);
      } catch {
        results[group[0].index] = "";
      }
      return;
    }

    const merged = group.map((item, j) => `${item.text}${MARK(j)}`).join("");
    try {
      const translatedMerged = await callGoogle(merged, lang);
      const parts = translatedMerged.split(MARK_SPLIT).map((s) => s.trim());
      // Trailing empty segment is common
      while (parts.length && !parts[parts.length - 1]) parts.pop();

      if (parts.length >= group.length) {
        for (let j = 0; j < group.length; j++) {
          const translated = (parts[j] || "").trim();
          results[group[j].index] = translated;
          if (translated) cacheSet(group[j].text, lang, translated);
        }
        return;
      }
    } catch {
      /* fall through */
    }

    // Split failed or request failed: fall back per item
    await Promise.all(
      group.map(async (item) => {
        try {
          const translated = await translateText(item.text, lang);
          results[item.index] = translated;
          cacheSet(item.text, lang, translated);
        } catch {
          results[item.index] = "";
        }
      })
    );
  }

  async function groupWorker() {
    while (cursor < groups.length) {
      const gi = cursor++;
      if (gi >= groups.length) break;
      await translateGroup(groups[gi]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, groups.length) }, () => groupWorker())
  );

  return results;
}

// ─── Single-item translation ───

async function translateText(text, targetLang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";

  // Check cache
  const hit = cacheGet(trimmed, targetLang);
  if (hit !== undefined) return hit;

  const MAX = 1500;
  let result;
  if (trimmed.length <= MAX) {
    result = await callGoogle(trimmed, targetLang);
  } else {
    const parts = splitBySentence(trimmed, MAX);
    const out = [];
    for (const part of parts) out.push(await callGoogle(part, targetLang));
    result = out.join("");
  }

  cacheSet(trimmed, targetLang, result);
  return result;
}

// ─── Google Translate API (with retries) ───

async function callGoogle(text, targetLang, retries = 2) {
  const tl = encodeURIComponent(targetLang || "zh-CN");
  const q = encodeURIComponent(text);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${q}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw new Error(`Translation request failed HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
      return data[0].map((seg) => (seg && seg[0]) || "").join("");
    } catch (err) {
      if (attempt < retries) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  return "";
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
