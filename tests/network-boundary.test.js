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
    "page-core.js",
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
    "translate-pa.googleapis.com",
    "clients5.google.com",
    "www.youtube.com",
    "youtube.com"
  ]);
});

test("timed cues stay authoritative and the bridge recovers late injection", () => {
  const runtime = read("youtube-subs.js");
  const domTick = runtime.match(/function tickDom\([\s\S]*?\n  }/i)?.[0] || "";
  const timelineTick = runtime.match(/function tickTimeline\([\s\S]*?\n  }/i)?.[0] || "";
  const bridge = read("youtube-bridge.js");
  assert.match(domTick, /if \(STATE\.cues\.length\) return/);
  assert.doesNotMatch(timelineTick, /readDomCaption/);
  assert.match(bridge, /performance\.getEntriesByType\("resource"\)/);
  assert.match(bridge, /PerformanceObserver/);
});

test("translation runtime failures are bounded and visible", () => {
  const runtime = read("youtube-subs.js");
  assert.match(runtime, /function runtimeMessage/);
  assert.match(runtime, /translationErrorLabel/);
  assert.match(runtime, /扩展已更新，请刷新此页面/);
  assert.match(runtime, /extensionVersion: safeManifestVersion\(\)/);
});

test("injection requires an exact runtime version and never fakes subtitle success", () => {
  const background = read("background.js");
  const popup = read("popup.js");
  const content = read("content.js");
  const runtime = read("youtube-subs.js");
  assert.match(background, /STALE_PAGE_CONTEXT/);
  assert.match(background, /STALE_YOUTUBE_CONTEXT/);
  assert.match(popup, /runtime\.runtimeConnected !== true/);
  assert.doesNotMatch(popup, /softTimeout:\s*true/);
  assert.match(popup, /message\.type === "YT_SUBS_START"\) throw err/);
  assert.match(content, /version:\s*CONTENT_VERSION/);
  assert.doesNotMatch(content, /if \(window\.__LT_LOADED__\) return/);
  assert.match(content, /__LT_CONTENT_DISPOSE__/);
  assert.match(content, /removeListener\(onRuntimeMessage\)/);
  assert.match(runtime, /__LT_YT_MSG_VERSION__ !== SCRIPT_VERSION/);
  assert.match(runtime, /__LT_YT_MSG_HANDLER__/);
});

test("the visible subtitle uses a priority request outside future batching", () => {
  const runtime = read("youtube-subs.js");
  assert.match(runtime, /requestTranslate\(en, \{ force: true \}\)/);
  assert.match(runtime, /cueKey\(text\) !== cueKey\(en\)/);
  assert.doesNotMatch(runtime, /Last resort: current line/);
});

test("caption-track discovery retries until DOM fallback can upgrade", () => {
  const runtime = read("youtube-subs.js");
  assert.match(runtime, /function scheduleTrackRetry/);
  assert.match(runtime, /Math\.min\(4000/);
  assert.match(runtime, /if \(!raw\.length\) \{\s*scheduleTrackRetry\(token\)/);
  assert.doesNotMatch(runtime, /const fallbacks = \["en", "en-US"\]/);
});

test("page translation uses silent retry and Gmail site rules", () => {
  const content = read("content.js");
  const background = read("background.js");
  const css = read("content.css");
  assert.match(content, /SITE_PROFILES/);
  assert.ok(content.includes(String.raw`mail\.google\.com`));
  assert.match(content, /pendingRetranslate/);
  assert.match(content, /scheduleFailedSweep/);
  assert.match(content, /retries = 2/);
  assert.match(content, /hostToneClass/);
  assert.match(css, /color:\s*inherit/);
  assert.doesNotMatch(css, /#5b6b7c/);
  assert.doesNotMatch(content, /"SPAN", "STRONG", "EM"/);
  assert.match(background, /translate-pa\.googleapis\.com/);
  assert.match(background, /clients5\.google\.com/);
  assert.match(background, /page-core\.js/);
  assert.match(content, /shouldHostAtAncestor|enclosingBlock/);
  assert.doesNotMatch(background, /CONCURRENCY = 6/);
});
