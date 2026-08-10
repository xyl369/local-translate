const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../youtube-subs-core.js");

test("parses YouTube json3 captions", () => {
  const raw = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 2100, dDurationMs: 800, segs: [{ utf8: "Next line" }] }
    ]
  });
  assert.deepEqual(core.parseCueJson(raw), [
    { start: 1, end: 1.9, text: "Hello world" },
    { start: 2.1, end: 2.9, text: "Next line" }
  ]);
});

test("aligns differently segmented translated captions by time", () => {
  const source = [
    { start: 0, end: 2, text: "A" },
    { start: 2.1, end: 4.8, text: "B" }
  ];
  const translated = [
    { start: 0, end: 0.9, text: "第" },
    { start: 0.9, end: 2, text: "一句" },
    { start: 2.2, end: 4.7, text: "第二句" }
  ];
  assert.deepEqual(core.alignTranslatedCues(source, translated), ["第 一句", "第二句"]);
});

test("builds a bounded current-first prefetch window", () => {
  const cues = Array.from({ length: 20 }, (_, index) => ({
    start: index * 5,
    end: index * 5 + 4,
    text: `line-${index}`
  }));
  assert.deepEqual(core.buildPrefetchTexts(cues, 26, { limit: 4, horizon: 20 }), [
    "line-5",
    "line-6",
    "line-7",
    "line-8"
  ]);
});

test("merges only genuinely short adjacent cues", () => {
  const cues = [
    { start: 0, end: 0.3, text: "short" },
    { start: 0.35, end: 1.1, text: "continuation" },
    { start: 2, end: 4, text: "separate" }
  ];
  assert.deepEqual(core.mergeShortCues(cues), [
    { start: 0, end: 1.1, text: "short continuation" },
    { start: 2, end: 4, text: "separate" }
  ]);
});
