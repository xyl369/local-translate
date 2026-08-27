const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function translateLikeGoogle(text) {
  return String(text || "").replace(/line-(\d+)/g, "译文-$1");
}

function loadBackground(fetchImpl) {
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
      getManifest: () => ({ version: "3.10.2" }),
      sendMessage: async () => ({ available: false })
    },
    contextMenus: { onClicked: noopEvent, removeAll() {}, create() {} },
    commands: { onCommand: noopEvent },
    tabs: { onUpdated: noopEvent },
    scripting: {},
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    offscreen: {}
  };
  const defaultFetch = async (url, init = {}) => {
    fetchCount += 1;
    const u = String(url);
    const headers = { get: () => null };
    if (u.includes("k=translate_http") || u.includes("translate_http")) {
      return {
        ok: true,
        status: 200,
        headers,
        text: async () => '{"x-goog-api-key":"AIzaSyTESTKEYTESTKEYTESTKEY12"}'
      };
    }
    if (u.includes("translate-pa.googleapis.com")) {
      const payload = JSON.parse(init.body);
      const texts = payload[0][0];
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => [texts.map(translateLikeGoogle), texts.map(() => "en")],
        text: async () => ""
      };
    }
    if (u.includes("clients5.google.com")) {
      const texts = String(init.body || "")
        .split("&")
        .filter((part) => part.startsWith("q="))
        .map((part) => decodeURIComponent(part.slice(2)));
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => texts.map((text) => [translateLikeGoogle(text), "en"]),
        text: async () => ""
      };
    }
    let query = "";
    try {
      query = new URL(u).searchParams.get("q") || "";
    } catch {
      query = "";
    }
    if (!query && init.body) {
      const match = String(init.body).match(/(?:^|&)q=([^&]*)/);
      if (match) query = decodeURIComponent(match[1]);
    }
    return {
      ok: true,
      status: 200,
      headers,
      json: async () => [[[translateLikeGoogle(query)]]],
      text: async () => ""
    };
  };
  const context = vm.createContext({
    chrome,
    AbortController,
    URL,
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl
      ? async (url, init) => {
          fetchCount += 1;
          return fetchImpl(url, init, { fetchCount });
        }
      : defaultFetch
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return { context, getFetchCount: () => fetchCount, getRuntimeListener: () => runtimeListener };
}

test("24 subtitle lines are translated in one Google batch request", async () => {
  const { context, getFetchCount } = loadBackground();
  await context.getGooglePaKey();
  const afterKey = getFetchCount();
  const input = Array.from({ length: 24 }, (_, index) => `line-${index}`);
  const output = await context.translateBatch(input, "zh-CN");
  assert.deepEqual(Array.from(output), input.map((_, index) => `译文-${index}`));
  assert.equal(getFetchCount() - afterKey, 1);
});

test("translate-pa 429 falls back to clients5 without a request stampede", async () => {
  const hosts = [];
  const { context, getFetchCount } = loadBackground(async (url, init) => {
    const u = String(url);
    hosts.push(u);
    const headers = { get: () => null };
    if (u.includes("k=translate_http") || u.includes("translate_http")) {
      return {
        ok: true,
        status: 200,
        headers,
        text: async () => '{"x-goog-api-key":"AIzaSyTESTKEYTESTKEYTESTKEY12"}'
      };
    }
    if (u.includes("translate-pa.googleapis.com")) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        json: async () => ({}),
        text: async () => ""
      };
    }
    if (u.includes("clients5.google.com")) {
      const texts = String(init.body || "")
        .split("&")
        .filter((part) => part.startsWith("q="))
        .map((part) => decodeURIComponent(part.slice(2)));
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => texts.map((text) => [translateLikeGoogle(text), "en"]),
        text: async () => ""
      };
    }
    throw new Error("gtx should not be used when clients5 succeeds");
  });
  await context.getGooglePaKey();
  const afterKey = getFetchCount();
  const input = ["line-0", "line-1", "line-2"];
  const output = await context.translateBatch(input, "zh-CN");
  assert.deepEqual(Array.from(output), ["译文-0", "译文-1", "译文-2"]);
  assert.equal(getFetchCount() - afterKey, 2);
  assert.equal(hosts.filter((url) => url.includes("clients5.google.com")).length, 1);
  assert.equal(hosts.filter((url) => url.includes("translate.googleapis.com/translate_a")).length, 0);
});

test("empty Google results are not cached", async () => {
  let paCalls = 0;
  const { context } = loadBackground(async (url) => {
    const u = String(url);
    const headers = { get: () => null };
    if (u.includes("k=translate_http") || u.includes("translate_http")) {
      return {
        ok: true,
        status: 200,
        headers,
        text: async () => '{"x-goog-api-key":"AIzaSyTESTKEYTESTKEYTESTKEY12"}'
      };
    }
    if (u.includes("translate-pa.googleapis.com")) {
      paCalls += 1;
      const text = paCalls === 1 ? "" : "你好";
      return { ok: true, status: 200, headers, json: async () => [[text], ["en"]] };
    }
    return { ok: false, status: 500, headers, json: async () => ({}), text: async () => "" };
  });
  const first = await context.translateBatch(["Hello"], "zh-CN");
  assert.deepEqual(Array.from(first), [""]);
  const callsAfterFirst = paCalls;
  const second = await context.translateBatch(["Hello"], "zh-CN");
  assert.deepEqual(Array.from(second), ["你好"]);
  assert.ok(paCalls > callsAfterFirst);
});

test("indexed HTML wrap survives Google tag reordering", () => {
  const { context } = loadBackground();
  const wrapped = context.wrapIndexedHtml(["Hello", "Get API key"]);
  assert.match(wrapped, /<a i=0>Hello<\/a>/);
  assert.match(wrapped, /<a i=1>Get API key<\/a>/);
  const parsed = context.unwrapIndexedHtml(
    "<pre><a i=1>获取 API 密钥</a><a i=0>你好</a></pre>",
    2
  );
  assert.deepEqual(Array.from(parsed), ["你好", "获取 API 密钥"]);
  assert.equal(context.unwrapIndexedHtml("no tags here", 2), null);
});

test("runtime health reports the loaded background version and engine", async () => {
  const { getRuntimeListener } = loadBackground();
  const listener = getRuntimeListener();
  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener({ type: "RUNTIME_HEALTH" }, {}, resolve);
    if (keepAlive !== true) reject(new Error("health response channel was not kept alive"));
  });
  assert.equal(response.ok, true);
  assert.equal(response.version, "3.10.2");
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
