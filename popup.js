const DEFAULTS = {
  uiLang: "",
  targetLang: "zh-CN",
  displayMode: "bilingual",
  translationStyle: "muted",
  autoTranslate: false,
  skipCode: true,
  videoSubsAuto: true,
  videoSubsMode: "bilingual",
  blockedHosts: [],
  engine: "google"
};

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const $ = (id) => document.getElementById(id);
const fields = [
  "targetLang",
  "displayMode",
  "translationStyle",
  "autoTranslate",
  "skipCode",
  "videoSubsAuto",
  "engineSelect"
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
  $("engineSelect").value = settings.engine === "chrome" ? "chrome" : "google";

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
    refreshEngineLabel();
  });

  if ($("blockSite").checked) {
    setStatus("blocked");
    setEngine("engineNeverHint", null, "engine");
  } else {
    refreshEngineLabel();
  }

  refreshStatus().catch(() => {});
}

function refreshEngineLabel() {
  const eng = $("engineSelect")?.value === "chrome" ? "chrome" : "google";
  if (eng === "chrome") {
    setEngine("engineChrome", null, "engine ok");
    chrome.runtime.sendMessage({ type: "ENGINE_STATUS" }, (res) => {
      if (!res?.ok) return;
      if (res.engine === "chrome" && !res.available) {
        setEngine("engineChromeFallback", null, "engine");
      }
    });
  } else {
    setEngine("engineOk", null, "engine ok");
  }
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
    engine: $("engineSelect").value === "chrome" ? "chrome" : "google",
    blockedHosts: normalizeBlocked(prev.blockedHosts)
  };
  await chrome.storage.local.set(settings);
  sendToActiveTab({ type: "SETTINGS_UPDATED", settings }, { waitMs: 600 }).catch(() => {});
  setStatus("saved");
  refreshEngineLabel();
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
    setStatus("translating");

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

    setStatus("enabled");
    refreshEngineLabel();
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
      { waitMs: 4500, inject: true }
    );
    if (!res || res.ok === false) throw new Error(res?.error || t("startFailedDefault"));
    const runtime = await sendToActiveTab(
      { type: "YT_SUBS_STATUS" },
      { waitMs: 1500, inject: false }
    );
    if (
      !runtime?.enabled ||
      runtime.extensionVersion !== EXTENSION_VERSION ||
      runtime.runtimeConnected !== true
    ) {
      throw new Error(runtime?.translationError || t("subtitleRuntimeFailed"));
    }
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
  let contentReady = false;
  try {
    const pong = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: "PING" }),
      300,
      "ping"
    );
    if (pong?.ok && pong.version !== EXTENSION_VERSION) {
      throw new Error(`STALE_PAGE_CONTEXT:${pong.version || "legacy"}`);
    }
    contentReady = pong?.version === EXTENSION_VERSION;
  } catch (err) {
    if (/STALE_PAGE_CONTEXT/.test(String(err?.message || err))) {
      throw new Error(t("refreshAfterUpdate"));
    }
  }

  if (!contentReady) {
    const files = ["page-core.js", "content.js"];
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await new Promise((r) => setTimeout(r, 40));
    const pong = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: "PING" }),
      500,
      "content verification"
    );
    if (pong?.version !== EXTENSION_VERSION) throw new Error(t("refreshAfterUpdate"));
  }

  if (/youtube\.com|youtu\.be/i.test(tabUrl || "")) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["youtube-bridge.js"],
        world: "MAIN"
      });
    } catch {
      /* ignore */
    }
    let youtubeReady = false;
    try {
      const status = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "YT_SUBS_STATUS" }),
        300,
        "yt"
      );
      if (status?.ok && status.extensionVersion !== EXTENSION_VERSION) {
        throw new Error(`STALE_YOUTUBE_CONTEXT:${status?.extensionVersion || "legacy"}`);
      }
      youtubeReady = status?.extensionVersion === EXTENSION_VERSION;
    } catch (err) {
      if (/STALE_YOUTUBE_CONTEXT/.test(String(err?.message || err))) {
        throw new Error(t("refreshAfterUpdate"));
      }
    }
    if (!youtubeReady) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["youtube-subs-core.js", "youtube-subs.js"]
      });
      await new Promise((r) => setTimeout(r, 40));
      const status = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "YT_SUBS_STATUS" }),
        600,
        "YouTube runtime verification"
      );
      if (status?.extensionVersion !== EXTENSION_VERSION) {
        throw new Error(t("subtitleRuntimeFailed"));
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
      await withTimeout(ensureContentScript(tab.id, tab.url), 3000, t("injectionTimeout"));
    }
    if (message.type === "RESTORE_PAGE") setStatus("restored");
    return await withTimeout(
      chrome.tabs.sendMessage(tab.id, message),
      waitMs,
      t("pageResponseTimeout")
    );
  } catch (err) {
    const msg = String(err?.message || err);
    setRawStatus(msg);
    setRawEngine(msg, "engine bad");
    if (message.type === "YT_SUBS_START") throw err;
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
    if (res?.ok && res.version !== EXTENSION_VERSION) {
      setStatus("failed");
      setEngine("refreshAfterUpdate", null, "engine bad");
      return;
    }
    if (res?.blocked) {
      $("blockSite").checked = true;
      setStatus("blocked");
      return;
    }
    if (res?.translating) setStatus("translating");
    else if (res?.translated || res?.enabled) setStatus("enabled");
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
