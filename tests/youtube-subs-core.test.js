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

test("does not render the next cue early during a real gap", () => {
  const cues = [
    { start: 0, end: 1, text: "first" },
    { start: 3, end: 4, text: "second" }
  ];
  assert.equal(core.findCueIndex(cues, 2), -1);
  assert.deepEqual(core.buildPrefetchTexts(cues, 2, { limit: 2, horizon: 10 }), ["second"]);
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

test("rebuilds fragmented ASR cues into readable timed units", () => {
  const cues = [
    { start: 0, end: 0.7, text: "The best" },
    { start: 0.72, end: 1.5, text: "ideas start" },
    { start: 1.52, end: 2.4, text: "as questions." },
    { start: 2.45, end: 3.1, text: "Then" },
    { start: 3.12, end: 4.2, text: "we test them." }
  ];
  assert.deepEqual(core.buildReadableCues(cues), [
    { start: 0, end: 2.45, text: "The best ideas start as questions." },
    { start: 2.45, end: 4.65, text: "Then we test them." }
  ]);
});

test("extends a readable cue into silence without crossing the next cue", () => {
  assert.deepEqual(core.buildReadableCues([
    { start: 0, end: 1, text: "A short sentence." },
    { start: 4, end: 5, text: "The next sentence." }
  ]), [
    { start: 0, end: 2.2, text: "A short sentence." },
    { start: 4, end: 6.2, text: "The next sentence." }
  ]);
});

test("deduplicates rolling caption overlap", () => {
  assert.equal(
    core.joinCueText("There are videos on YouTube", "on YouTube with millions of views"),
    "There are videos on YouTube with millions of views"
  );
  assert.equal(core.joinCueText("这是一个测试字幕", "测试字幕系统"), "这是一个测试字幕系统");
});

test("reading hold stays inside a human-readable range", () => {
  assert.equal(core.readingHoldMs("很短"), 2200);
  assert.equal(core.readingHoldMs("这是一条需要更多时间阅读的中文字幕内容"), 2990);
  assert.equal(core.readingHoldMs("one two three four five six seven eight nine ten"), 3900);
});
