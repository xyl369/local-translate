const DEFAULTS = {
  uiLang: "",
  targetLang: "zh-CN",
  displayMode: "bilingual",
  translationStyle: "muted",
  autoTranslate: false,
  skipCode: true,
  videoSubsAuto: true,
  videoSubsMode: "bilingual",
  blockedHosts: []
};

const $ = (id) => document.getElementById(id);
const fields = [
  "targetLang",
  "displayMode",
  "translationStyle",
  "autoTranslate",
  "skipCode",
  "videoSubsAuto"
];

let currentHost = "";
// Track the *meaning* of the current status/engine text (not the literal
// string) so switching UI language re-renders it correctly instead of
// leaving stale English/Chinese behind.
let statusState = { key: "ready" };
let engineState = { key: "engineOk", cls: "engine ok" };

init();

async function init() {
  const settings = await loadSettings();
  uiLang = settings.uiLang || detectDefaultUiLang();
  applyStaticI18n();

  $("targetLang").value = settings.targetLang;
  $("displayMode").value = settings.displayMode;
  $("translationStyle").value = settings.translationStyle;
  $("autoTranslate").checked = !!settings.autoTranslate;
  $("skipCode").checked = settings.skipCode !== false;
  $("videoSubsAuto").checked = settings.videoSubsAuto !== false;

  currentHost = await getActiveHostname();
  const blocked = normalizeBlocked(settings.blockedHosts);
  $("blockSite").checked = !!(currentHost && blocked.includes(currentHost));
  renderBlockSiteLabel();

  fields.forEach((id) => $(id).addEventListener("change", saveFromUI));
  $("blockSite").addEventListener("change", onBlockSiteChange);
  $("uiLangToggle").addEventListener("click", onUiLangToggle);

  $("btn-translate").addEventListener("click", onTranslateClick);
  $("btn-restore").addEventListener("click", () =>
    sendToActiveTab({ type: "RESTORE_PAGE" }, { waitMs: 1500 })
  );
  $("btn-yt-subs").addEventListener("click", onYtSubsClick);
  $("btn-yt-stop").addEventListener("click", async () => {
    await sendToActiveTab({ type: "YT_SUBS_STOP" }, { waitMs: 800 });
    setStatus("subtitlesOff");
    setEngine("engineOk", null, "engine ok");
  });

  if ($("blockSite").checked) {
    setStatus("blocked");
    setEngine("engineNeverHint", null, "engine");
  }

  refreshStatus().catch(() => {});
}

function renderBlockSiteLabel() {
  $("blockSiteLabel").textContent = currentHost
    ? t("neverTranslateSiteHost", { host: currentHost })
    : t("neverTranslateSite");
}

async function onUiLangToggle() {
  uiLang = uiLang === "zh" ? "en" : "zh";
  await chrome.storage.local.set({ uiLang });
  applyStaticI18n();
  renderBlockSiteLabel();
  // Re-render the last status/engine message in the new language instead
  // of leaving it in whatever language it was originally shown in.
  setStatus(statusState.key, statusState.vars);
  setEngine(engineState.key, engineState.vars, engineState.cls);
}

function normalizeBlocked(list) {
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

function getActiveHostname() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        const url = tabs?.[0]?.url || "";
        if (!url || /^(chrome|chrome-extension|edge|about)/i.test(url)) {
          resolve("");
          return;
        }
        resolve(new URL(url).hostname || "");
      } catch {
        resolve("");
      }
    });
  });
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (data) => resolve({ ...DEFAULTS, ...data }));
  });
}

async function saveFromUI() {
  const prev = await loadSettings();
  const settings = {
    targetLang: $("targetLang").value,
    displayMode: $("displayMode").value,
    translationStyle: $("translationStyle").value,
    autoTranslate: $("autoTranslate").checked,
    skipCode: $("skipCode").checked,
    videoSubsAuto: $("videoSubsAuto").checked,
    videoSubsMode: $("displayMode").value,
    blockedHosts: normalizeBlocked(prev.blockedHosts)
  };
  await chrome.storage.local.set(settings);
  sendToActiveTab({ type: "SETTINGS_UPDATED", settings }, { waitMs: 600 }).catch(() => {});
  setStatus("saved");
}

async function onBlockSiteChange() {
  if (!currentHost) {
    $("blockSite").checked = false;
    setStatus("cannotIdentifySite");
    return;
  }

  const prev = await loadSettings();
  let blocked = normalizeBlocked(prev.blockedHosts);
  const on = $("blockSite").checked;

  if (on) {
    if (!blocked.includes(currentHost)) blocked.push(currentHost);
    await chrome.storage.local.set({ blockedHosts: blocked });
    // Restore page and stop subtitles immediately
    await sendToActiveTab({ type: "RESTORE_PAGE" }, { waitMs: 1200, inject: true });
    await sendToActiveTab({ type: "YT_SUBS_STOP" }, { waitMs: 600 });
    await sendToActiveTab(
      { type: "SETTINGS_UPDATED", settings: { ...(await loadSettings()), blockedHosts: blocked } },
      { waitMs: 600 }
    );
    setStatus("blocked");
    setEngine("hostBlocked", { host: currentHost }, "engine");
  } else {
    blocked = blocked.filter((h) => h !== currentHost);
    await chrome.storage.local.set({ blockedHosts: blocked });
    await sendToActiveTab(
      { type: "SETTINGS_UPDATED", settings: { ...(await loadSettings()), blockedHosts: blocked } },
      { waitMs: 600 }
    );
    setStatus("unblocked");
    setEngine("engineOk", null, "engine ok");
  }
}

async function onTranslateClick() {
  try {
    if ($("blockSite").checked) {
      setStatus("blocked");
      setEngine("uncheckBlockFirst", null, "engine bad");
      return;
    }
    $("btn-translate").disabled = true;
    setStatus("translatingViewport");
    setEngine("engineViewportOnly", null, "engine");

    const res = await sendToActiveTab(
      { type: "TRANSLATE_PAGE" },
      { waitMs: 8000, inject: true }
    );
    if (!res) return;
    if (res.ok === false) throw new Error(res.error || t("translationFailedDefault"));
    if (res.blocked) {
      setStatus("blocked");
      $("blockSite").checked = true;
      setEngine("neverTranslateSite", null, "engine");
      return;
    }

    if (res.count != null) setStatus("translatedCount", { count: res.count });
    else setStatus("enabled");
    setEngine("engineAutoScroll", null, "engine ok");
  } catch (err) {
    setStatus("failed");
    setRawEngine(String(err?.message || err), "engine bad");
  } finally {
    $("btn-translate").disabled = false;
  }
}

async function onYtSubsClick() {
  try {
    if ($("blockSite").checked) {
      setStatus("blocked");
      setEngine("uncheckBlockFirst", null, "engine bad");
      return;
    }
    $("btn-yt-subs").disabled = true;
    setStatus("starting");
    const res = await sendToActiveTab(
      {
        type: "YT_SUBS_START",
        targetLang: $("targetLang").value,
        mode: $("displayMode").value
      },
      { waitMs: 1200, inject: true }
    );
    if (res?.ok === false) throw new Error(res.error || t("startFailedDefault"));
    setStatus("liveSyncOn");
    setEngine("engineTurnOnCC", null, "engine ok");
  } catch (err) {
    setStatus("failed");
    setRawEngine(String(err?.message || err), "engine bad");
  } finally {
    $("btn-yt-subs").disabled = false;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label || `Timeout ${ms}ms`)), ms)
    )
  ]);
}

async function ensureContentScript(tabId, tabUrl) {
  const ping = chrome.tabs.sendMessage(tabId, { type: "PING" });
  try {
    await withTimeout(ping, 250, "ping");
  } catch {
    const files = ["content.js"];
    if (/youtube\.com|youtu\.be/i.test(tabUrl || "")) files.push("youtube-subs.js");
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await new Promise((r) => setTimeout(r, 40));
  }

  if (/youtube\.com|youtu\.be/i.test(tabUrl || "")) {
    try {
      await withTimeout(chrome.tabs.sendMessage(tabId, { type: "YT_SUBS_STATUS" }), 200, "yt");
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["youtube-subs.js"]
        });
        await new Promise((r) => setTimeout(r, 30));
      } catch {
        /* ignore */
      }
    }
  }
}

async function sendToActiveTab(message, opts = {}) {
  const waitMs = opts.waitMs ?? 3000;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  if (
    !tab.url ||
    /^(chrome|chrome-extension|edge|about|chrome-untrusted|https:\/\/chrome\.google\.com)/i.test(
      tab.url
    )
  ) {
    setStatus("cannotTranslatePage");
    return null;
  }
  try {
    if (opts.inject !== false) {
      await withTimeout(ensureContentScript(tab.id, tab.url), 900, t("injectionTimeout"));
    }
    if (message.type === "RESTORE_PAGE") setStatus("restored");
    return await withTimeout(
      chrome.tabs.sendMessage(tab.id, message),
      waitMs,
      t("pageResponseTimeout")
    );
  } catch (err) {
    if (message.type === "YT_SUBS_START") {
      return { ok: true, ready: true, softTimeout: true };
    }
    const msg = String(err?.message || err);
    setRawStatus(msg);
    setRawEngine(msg, "engine bad");
    return null;
  }
}

async function refreshStatus() {
  try {
    if ($("blockSite").checked) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const res = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }),
      400,
      "status"
    );
    if (res?.blocked) {
      $("blockSite").checked = true;
      setStatus("blocked");
      return;
    }
    if (res?.translating) setStatus("translating");
    else if (res?.translated || res?.enabled) setStatus("translatedScroll");
  } catch {
    /* ignore */
  }
}

function setStatus(key, vars) {
  statusState = { key, vars };
  $("status").textContent = t(key, vars);
}

function setEngine(key, vars, cls) {
  engineState = { key, vars, cls: cls || "engine" };
  $("engine").textContent = t(key, vars);
  $("engine").className = engineState.cls;
}

// For raw, non-localizable messages (e.g. unexpected browser/runtime errors)
// that don't come from our own dictionary of known status keys.
function setRawStatus(text) {
  $("status").textContent = text;
}

function setRawEngine(text, cls) {
  $("engine").textContent = text;
  $("engine").className = cls || "engine";
}
