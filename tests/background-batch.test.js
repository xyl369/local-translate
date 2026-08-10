const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  let fetchCount = 0;
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
      onMessage: noopEvent,
      getContexts: async () => [],
      getURL: (value) => value,
      sendMessage: async () => ({ available: false })
    },
    contextMenus: { onClicked: noopEvent, removeAll() {}, create() {} },
    commands: { onCommand: noopEvent },
    tabs: { onUpdated: noopEvent },
    scripting: {},
    offscreen: {}
  };
  const context = vm.createContext({
    chrome,
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
  return { context, getFetchCount: () => fetchCount };
}

test("24 subtitle lines are translated in one Google batch request", async () => {
  const { context, getFetchCount } = loadBackground();
  const input = Array.from({ length: 24 }, (_, index) => `line-${index}`);
  const output = await context.translateBatch(input, "zh-CN");
  assert.deepEqual(Array.from(output), input.map((_, index) => `译文-${index}`));
  assert.equal(getFetchCount(), 1);
});
