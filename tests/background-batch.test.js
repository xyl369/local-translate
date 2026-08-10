const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  let fetchCount = 0;
  let runtimeListener = null;
  const noopEvent = { addListener() {} };
  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          if (Array.isArray(keys)) callback({ __migratedFromSync: true });
          else callback({ ...(keys || {}), engine: "google", targetLang: "zh-CN" });
        },
        set(_value, callback) {
          callback?.();
        }
      },
      sync: {
        get(_keys, callback) {
          callback({});
        },
        clear(callback) {
          callback?.();
        }
      }
    },
    runtime: {
      onInstalled: noopEvent,
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      getContexts: async () => [],
      getURL: (value) => value,
      getManifest: () => ({ version: "3.9.1" }),
      sendMessage: async () => ({ available: false })
    },
    contextMenus: { onClicked: noopEvent, removeAll() {}, create() {} },
    commands: { onCommand: noopEvent },
    tabs: { onUpdated: noopEvent },
    scripting: {},
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    offscreen: {}
  };
  const context = vm.createContext({
    chrome,
    AbortController,
    URL,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      fetchCount += 1;
      const query = new URL(url).searchParams.get("q") || "";
      const translated = query.replace(/line-(\d+)/g, "译文-$1");
      return {
        ok: true,
        json: async () => [[[translated]]]
      };
    }
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return { context, getFetchCount: () => fetchCount, getRuntimeListener: () => runtimeListener };
}

test("24 subtitle lines are translated in one Google batch request", async () => {
  const { context, getFetchCount } = loadBackground();
  const input = Array.from({ length: 24 }, (_, index) => `line-${index}`);
  const output = await context.translateBatch(input, "zh-CN");
  assert.deepEqual(Array.from(output), input.map((_, index) => `译文-${index}`));
  assert.equal(getFetchCount(), 1);
});

test("runtime health reports the loaded background version and engine", async () => {
  const { getRuntimeListener } = loadBackground();
  const listener = getRuntimeListener();
  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener({ type: "RUNTIME_HEALTH" }, {}, resolve);
    if (keepAlive !== true) reject(new Error("health response channel was not kept alive"));
  });
  assert.equal(response.ok, true);
  assert.equal(response.version, "3.9.1");
  assert.equal(response.engine, "google");
  assert.equal(response.targetLang, "zh-CN");
  assert.equal(response.settings.videoSubsAuto, true);
  assert.equal(response.settings.videoSubsMode, "bilingual");
});

test("background network calls have a hard timeout", async () => {
  const { context } = loadBackground();
  context.fetch = (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  await assert.rejects(
    context.fetchWithTimeout("https://translate.googleapis.com/test", {}, 15),
    /Network timeout after 15ms/
  );
});
