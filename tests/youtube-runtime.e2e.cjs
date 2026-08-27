#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
let activeBrowser = null;

async function main() {
  if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH for the E2E test");
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true
  });
  activeBrowser = browser;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.addInitScript(() => {
    const listeners = [];
    window.__mockMessageLog = [];
    const runtime = {
      lastError: null,
      getManifest: () => ({ version: "3.9.1" }),
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage(message, callback) {
        window.__mockMessageLog.push(message.type);
        const respond = (value) => setTimeout(() => callback?.(value), 0);
        if (message.type === "GET_SETTINGS") {
          respond({
            ok: true,
            settings: {
              targetLang: "zh-CN",
              displayMode: "bilingual",
              videoSubsMode: "bilingual",
              videoSubsAuto: false,
              blockedHosts: [],
              engine: "google"
            }
          });
          return;
        }
        if (message.type === "RUNTIME_HEALTH") {
          respond({
            ok: true,
            version: window.__mockBackgroundVersion || "3.9.1",
            engine: "google",
            targetLang: "zh-CN"
          });
          return;
        }
        if (message.type === "TRANSLATE_ONE") {
          if (window.__mockRuntimeDisconnected) {
            setTimeout(() => {
              runtime.lastError = { message: "Extension context invalidated." };
              callback?.();
              runtime.lastError = null;
            }, 0);
            return;
          }
          const translations = {
            "Learning comes from struggle, not memorization.": "学习来自奋斗，而不是死记硬背。",
            "Start the project instead of watching tutorials.": "直接开始项目，而不是一直看教程。",
            "The complete timed caption is now ready.": "完整的时间轴字幕现在已经就绪。"
          };
          respond({ ok: true, translated: translations[message.text] || "测试译文" });
          return;
        }
        if (message.type === "TRANSLATE_BATCH") {
          setTimeout(
            () => callback?.({ ok: true, results: (message.texts || []).map(() => "预译内容") }),
            500
          );
          return;
        }
        if (message.type === "FETCH_TEXT") {
          if (window.__mockTrackReady) {
            if (/[?&]tlang=/.test(message.url || "")) {
              respond({ ok: false, error: "force engine fallback in priority-lane test" });
              return;
            }
            respond({
              ok: true,
              text: JSON.stringify({
                events: [
                  { tStartMs: 0, dDurationMs: 2800, segs: [{ utf8: "The complete timed caption is now ready." }] },
                  { tStartMs: 4000, dDurationMs: 2600, segs: [{ utf8: "Future caption number two." }] },
                  { tStartMs: 8000, dDurationMs: 2600, segs: [{ utf8: "Future caption number three." }] }
                ]
              })
            });
            return;
          }
          respond({ ok: false, error: "no timed track in DOM fallback test" });
          return;
        }
        respond({ ok: false, error: `unexpected message ${message.type}` });
      }
    };
    window.chrome = { runtime };
  });

  await page.route("https://www.youtube.com/watch**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body style="margin:0">
        <div id="movie_player" class="html5-video-player" style="position:relative;width:1200px;height:680px">
          <video class="html5-main-video"></video>
          <div class="ytp-caption-window-container">
            <span class="ytp-caption-segment">Learning comes from struggle, not memorization.</span>
          </div>
        </div>
      </body></html>`
    })
  );
  await page.goto("https://www.youtube.com/watch?v=runtime-test");
  await page.addStyleTag({ path: path.join(ROOT, "content.css") });
  await page.addScriptTag({ path: path.join(ROOT, "youtube-bridge.js") });
  await page.addScriptTag({ path: path.join(ROOT, "youtube-subs-core.js") });
  await page.addScriptTag({ path: path.join(ROOT, "youtube-subs.js") });

  const started = await page.evaluate(() =>
    window.__LT_YT__.start({ targetLang: "zh-CN", mode: "bilingual" })
  );
  assert.equal(started.runtimeConnected, true);
  await page.waitForFunction(() =>
    document.querySelector("#lt-yt-overlay")?.textContent?.includes("学习来自奋斗")
  );
  const translated = await page.locator("#lt-yt-overlay").innerText();
  assert.match(translated, /Learning comes from struggle/);
  assert.match(translated, /学习来自奋斗/);

  await page.evaluate(() => {
    window.__mockRuntimeDisconnected = true;
    document.querySelector(".ytp-caption-segment").textContent =
      "Start the project instead of watching tutorials.";
  });
  await page.waitForFunction(() =>
    document.querySelector("#lt-yt-overlay")?.textContent?.includes("请刷新此页面")
  );
  const disconnected = await page.locator("#lt-yt-overlay").innerText();
  assert.match(disconnected, /扩展已更新，请刷新此页面/);

  await page.evaluate(() => {
    window.__mockRuntimeDisconnected = false;
    window.__mockTrackReady = true;
    window.__mockMessageLog.length = 0;
    Object.defineProperty(document.querySelector("video"), "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });
    document.querySelector("#movie_player").getPlayerResponse = () => ({
      videoDetails: { videoId: "runtime-test" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            languageCode: "en",
            baseUrl: "https://www.youtube.com/api/timedtext?v=runtime-test&lang=en&token=test"
          }]
        }
      }
    });
  });
  await page.waitForFunction(
    () => window.__LT_YT__.status().mode === "timeline",
    null,
    { timeout: 8000 }
  );
  const promoted = await page.evaluate(() => window.__LT_YT__.status());
  assert.ok(promoted.trackAttempts >= 2);
  assert.ok(promoted.cues >= 3);
  await page.waitForFunction(() =>
    document.querySelector("#lt-yt-overlay")?.textContent?.includes("完整的时间轴字幕")
  );
  const translationOrder = await page.evaluate(() =>
    window.__mockMessageLog.filter((type) => type.startsWith("TRANSLATE_"))
  );
  assert.equal(translationOrder[0], "TRANSLATE_ONE");
  assert.ok(translationOrder.includes("TRANSLATE_BATCH"));

  await page.evaluate(() => { document.querySelector("video").currentTime = 4.2; });
  await page.waitForFunction(() =>
    document.querySelector("#lt-yt-overlay")?.textContent?.includes("Future caption number two")
  );
  const secondCue = await page.locator("#lt-yt-overlay").innerText();
  assert.match(secondCue, /The complete timed caption is now ready/);
  assert.match(secondCue, /Future caption number two/);

  await page.evaluate(() => { document.querySelector("video").currentTime = 8.2; });
  await page.waitForFunction(() =>
    document.querySelector("#lt-yt-overlay")?.textContent?.includes("Future caption number three")
  );
  const thirdCue = await page.locator("#lt-yt-overlay").innerText();
  assert.doesNotMatch(thirdCue, /The complete timed caption is now ready/);
  assert.match(thirdCue, /Future caption number two/);
  assert.match(thirdCue, /Future caption number three/);

  await page.evaluate(() => {
    window.__LT_YT__.stop();
    window.__mockBackgroundVersion = "3.8.0";
  });
  const mismatch = await page.evaluate(async () => {
    try {
      await window.__LT_YT__.start({ targetLang: "zh-CN", mode: "bilingual" });
      return "unexpected success";
    } catch (error) {
      return String(error?.message || error);
    }
  });
  assert.match(mismatch, /扩展版本不一致/);

  const popup = await browser.newPage({ viewport: { width: 430, height: 720 } });
  await popup.addInitScript(() => {
    window.__popupCalls = [];
    const defaults = {
      uiLang: "zh",
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
    window.chrome = {
      runtime: {
        lastError: null,
        getManifest: () => ({ version: "3.9.1" }),
        sendMessage(message, callback) {
          if (message.type === "ENGINE_STATUS") callback?.({ ok: true, engine: "google" });
        }
      },
      storage: {
        local: {
          get(_keys, callback) { callback({ ...defaults }); },
          set() { return Promise.resolve(); }
        }
      },
      tabs: {
        query(_query, callback) {
          const tabs = [{ id: 7, url: "https://www.youtube.com/watch?v=stale" }];
          callback?.(tabs);
          return Promise.resolve(tabs);
        },
        sendMessage: async (_tabId, message) => {
          window.__popupCalls.push(message.type);
          if (message.type === "PING") return { ok: true, version: "3.8.0" };
          if (message.type === "GET_STATUS") return { ok: true, translated: false };
          return { ok: false };
        }
      },
      scripting: {
        insertCSS: async () => { window.__popupCalls.push("INSERT_CSS"); },
        executeScript: async () => { window.__popupCalls.push("EXECUTE_SCRIPT"); }
      }
    };
  });
  await popup.goto(pathToFileURL(path.join(ROOT, "popup.html")).href);
  await popup.waitForFunction(() =>
    document.documentElement.lang === "zh-CN" &&
    window.__popupCalls.includes("GET_STATUS")
  );
  await popup.locator("#btn-yt-subs").click();
  await popup.waitForFunction(() =>
    document.querySelector("#engine")?.textContent?.includes("请先刷新当前页面")
  );
  const popupCalls = await popup.evaluate(() => window.__popupCalls);
  assert.ok(popupCalls.includes("PING"));
  assert.ok(!popupCalls.includes("YT_SUBS_START"));
  assert.ok(!popupCalls.includes("EXECUTE_SCRIPT"));

  const lifecycle = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await lifecycle.addInitScript(() => {
    window.__LT_LOADED__ = true;
    window.__mockContentVersion = "3.9.1";
    const listeners = new Set();
    window.__contentListenerCount = () => listeners.size;
    window.__dispatchContentMessage = (message) =>
      new Promise((resolve) => {
        let resolved = false;
        const respond = (value) => {
          if (resolved) return;
          resolved = true;
          resolve(value);
        };
        for (const listener of listeners) listener(message, {}, respond);
        setTimeout(() => respond(null), 50);
      });
    const runtime = {
      lastError: null,
      getManifest: () => ({ version: window.__mockContentVersion }),
      onMessage: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); }
      },
      sendMessage(message, callback) {
        if (message.type === "GET_SETTINGS") {
          callback?.({
            ok: true,
            settings: {
              targetLang: "zh-CN",
              displayMode: "bilingual",
              translationStyle: "muted",
              autoTranslate: false,
              skipCode: true,
              blockedHosts: []
            }
          });
          return;
        }
        callback?.({ ok: false });
      }
    };
    window.chrome = { runtime };
  });
  await lifecycle.goto("data:text/html,<main><p>Lifecycle test</p></main>");
  await lifecycle.addScriptTag({ path: path.join(ROOT, "page-core.js") });
  await lifecycle.addScriptTag({ path: path.join(ROOT, "content.js") });
  await lifecycle.waitForFunction(() => window.__contentListenerCount() === 1);
  assert.equal(
    (await lifecycle.evaluate(() => window.__dispatchContentMessage({ type: "PING" }))).version,
    "3.9.1"
  );
  await lifecycle.addScriptTag({ path: path.join(ROOT, "content.js") });
  assert.equal(await lifecycle.evaluate(() => window.__contentListenerCount()), 1);
  await lifecycle.evaluate(() => { window.__mockContentVersion = "3.9.2"; });
  await lifecycle.addScriptTag({ path: path.join(ROOT, "content.js") });
  await lifecycle.waitForFunction(() => window.__LT_CONTENT_VERSION__ === "3.9.2");
  assert.equal(await lifecycle.evaluate(() => window.__contentListenerCount()), 1);
  assert.equal(
    (await lifecycle.evaluate(() => window.__dispatchContentMessage({ type: "PING" }))).version,
    "3.9.2"
  );

  await browser.close();
  activeBrowser = null;
  console.log("runtime e2e: 6 scenarios passed");
}

main().catch(async (error) => {
  await activeBrowser?.close().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
