const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("translation endpoints exist only in the service worker", () => {
  for (const file of ["content.js", "popup.js", "youtube-subs.js", "youtube-bridge.js"] ) {
    assert.doesNotMatch(read(file), /translate\.googleapis\.com/i, file);
  }
  assert.match(read("background.js"), /translate\.googleapis\.com/);
});

test("runtime contains no China-vendor, analytics, or telemetry clients", () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    "offscreen.js",
    "popup.js",
    "popup-i18n.js",
    "youtube-bridge.js",
    "youtube-subs-core.js",
    "youtube-subs.js"
  ];
  const source = runtimeFiles.map((file) => read(file)).join("\n");
  assert.doesNotMatch(
    source,
    /baidu|aliyun|alibaba|tencent|volcengine|bytedance|youdao|niutrans|sogou|umeng|bugly|growingio|sensorsdata|sentry|segment\.io|mixpanel/i
  );
});

test("background fetch allowlist stays limited to Google and YouTube", () => {
  const source = read("background.js");
  const block = source.match(/const ALLOWED_FETCH_HOSTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "allowlist must remain explicit");
  const hosts = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(hosts, [
    "translate.googleapis.com",
    "www.youtube.com",
    "youtube.com"
  ]);
});
