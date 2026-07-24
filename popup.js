const DEFAULTS = {
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

init();

async function init() {
  const settings = await loadSettings();
  $("targetLang").value = settings.targetLang;
  $("displayMode").value = settings.displayMode;
  $("translationStyle").value = settings.translationStyle;
  $("autoTranslate").checked = !!settings.autoTranslate;
  $("skipCode").checked = settings.skipCode !== false;
  $("videoSubsAuto").checked = settings.videoSubsAuto !== false;

  currentHost = await getActiveHostname();
  const blocked = normalizeBlocked(settings.blockedHosts);
  $("blockSite").checked = !!(currentHost && blocked.includes(currentHost));
  $("blockSiteLabel").textContent = currentHost
    ? `Never translate this site (${currentHost})`
    : "Never translate this site";

  fields.forEach((id) => $(id).addEventListener("change", saveFromUI));
  $("blockSite").addEventListener("change", onBlockSiteChange);

  $("btn-translate").addEventListener("click", onTranslateClick);
  $("btn-restore").addEventListener("click", () =>
    sendToActiveTab({ type: "RESTORE_PAGE" }, { waitMs: 1500 })
  );
  $("btn-yt-subs").addEventListener("click", onYtSubsClick);
  $("btn-yt-stop").addEventListener("click", async () => {
    await sendToActiveTab({ type: "YT_SUBS_STOP" }, { waitMs: 800 });
    setStatus("Subtitles off");
    $("engine").textContent = "Engine: Google Translate";
    $("engine").className = "engine ok";
  });

  if ($("blockSite").checked) {
    setStatus("Blocked");
    $("engine").textContent = "Never translate this site · uncheck to restore";
    $("engine").className = "engine";
  }

  refreshStatus().catch(() => {});
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
    chrome.storage.sync.get(DEFAULTS, (data) => resolve({ ...DEFAULTS, ...data }));
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
  await chrome.storage.sync.set(settings);
  sendToActiveTab({ type: "SETTINGS_UPDATED", settings }, { waitMs: 600 }).catch(() => {});
  setStatus("Saved");
}

async function onBlockSiteChange() {
  if (!currentHost) {
    $("blockSite").checked = false;
    setStatus("Cannot identify site");
    return;
  }

  const prev = await loadSettings();
  let blocked = normalizeBlocked(prev.blockedHosts);
  const on = $("blockSite").checked;

  if (on) {
    if (!blocked.includes(currentHost)) blocked.push(currentHost);
    await chrome.storage.sync.set({ blockedHosts: blocked });
    // Restore page and stop subtitles immediately
    await sendToActiveTab({ type: "RESTORE_PAGE" }, { waitMs: 1200, inject: true });
    await sendToActiveTab({ type: "YT_SUBS_STOP" }, { waitMs: 600 });
    await sendToActiveTab(
      { type: "SETTINGS_UPDATED", settings: { ...(await loadSettings()), blockedHosts: blocked } },
      { waitMs: 600 }
    );
    setStatus("Blocked");
    $("engine").textContent = `${currentHost} blocked`;
    $("engine").className = "engine";
  } else {
    blocked = blocked.filter((h) => h !== currentHost);
    await chrome.storage.sync.set({ blockedHosts: blocked });
    await sendToActiveTab(
      { type: "SETTINGS_UPDATED", settings: { ...(await loadSettings()), blockedHosts: blocked } },
      { waitMs: 600 }
    );
    setStatus("Unblocked");
    $("engine").textContent = "Engine: Google Translate";
    $("engine").className = "engine ok";
  }
}

async function onTranslateClick() {
  try {
    if ($("blockSite").checked) {
      setStatus("Blocked");
      $("engine").textContent = "Uncheck Never translate this site first";
      $("engine").className = "engine bad";
      return;
    }
    $("btn-translate").disabled = true;
    setStatus("Translating viewport…");
    $("engine").textContent = "Visible area only; auto-fills on scroll";
    $("engine").className = "engine";

    const res = await sendToActiveTab(
      { type: "TRANSLATE_PAGE" },
      { waitMs: 8000, inject: true }
    );
    if (!res) return;
    if (res.ok === false) throw new Error(res.error || "Translation failed");
    if (res.blocked) {
      setStatus("Blocked");
      $("blockSite").checked = true;
      $("engine").textContent = "Never translate this site";
      $("engine").className = "engine";
      return;
    }

    setStatus(res.count != null ? `Translated ${res.count} visible · scroll for more` : "Enabled");
    $("engine").textContent = "Scroll-loaded content translates automatically";
    $("engine").className = "engine ok";
  } catch (err) {
    setStatus("Failed");
    $("engine").textContent = String(err?.message || err);
    $("engine").className = "engine bad";
  } finally {
    $("btn-translate").disabled = false;
  }
}

async function onYtSubsClick() {
  try {
    if ($("blockSite").checked) {
      setStatus("Blocked");
      $("engine").textContent = "Uncheck Never translate this site first";
      $("engine").className = "engine bad";
      return;
    }
    $("btn-yt-subs").disabled = true;
    setStatus("Starting…");
    const res = await sendToActiveTab(
      {
        type: "YT_SUBS_START",
        targetLang: $("targetLang").value,
        mode: $("displayMode").value
      },
      { waitMs: 1200, inject: true }
    );
    if (res?.ok === false) throw new Error(res.error || "Failed to start");
    setStatus("Live sync on");
    $("engine").textContent = "Turn on CC; scroll comments with Translate page";
    $("engine").className = "engine ok";
  } catch (err) {
    setStatus("Failed");
    $("engine").textContent = String(err?.message || err);
    $("engine").className = "engine bad";
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
    setStatus("This page cannot be translated");
    return null;
  }
  try {
    if (opts.inject !== false) {
      await withTimeout(ensureContentScript(tab.id, tab.url), 900, "Injection timeout");
    }
    if (message.type === "RESTORE_PAGE") setStatus("Restored");
    return await withTimeout(
      chrome.tabs.sendMessage(tab.id, message),
      waitMs,
      "Page response timeout"
    );
  } catch (err) {
    if (message.type === "YT_SUBS_START") {
      return { ok: true, ready: true, softTimeout: true };
    }
    setStatus(String(err?.message || err));
    $("engine").textContent = String(err?.message || err);
    $("engine").className = "engine bad";
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
      setStatus("Blocked");
      return;
    }
    if (res?.translating) setStatus("Translating…");
    else if (res?.translated || res?.enabled) setStatus("Translated · scroll for more");
  } catch {
    /* ignore */
  }
}

function setStatus(text) {
  $("status").textContent = text;
}
