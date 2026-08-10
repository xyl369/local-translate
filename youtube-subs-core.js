/** Pure helpers for the YouTube subtitle pipeline. Works in Chrome and Node tests. */
(function exposeYouTubeSubtitleCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.__LT_YT_CORE__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function parseCueJson(raw) {
    if (!raw || !String(raw).trim().startsWith("{")) return [];
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const cues = [];
    for (const event of data.events || []) {
      if (!event.segs || event.tStartMs == null) continue;
      const text = normalizeText(event.segs.map((segment) => segment.utf8 || "").join(""));
      if (!text) continue;
      cues.push({
        start: event.tStartMs / 1000,
        end: (event.tStartMs + (event.dDurationMs || 2000)) / 1000,
        text
      });
    }
    return cues;
  }

  function mergeShortCues(cues, minDuration = 0.55) {
    if (!Array.isArray(cues) || !cues.length) return [];
    const out = [];
    let current = { ...cues[0] };
    for (let i = 1; i < cues.length; i += 1) {
      const next = cues[i];
      const gap = next.start - current.end;
      const duration = current.end - current.start;
      if (
        duration < minDuration &&
        gap < 0.55 &&
        `${current.text} ${next.text}`.length < 140
      ) {
        current.end = Math.max(current.end, next.end);
        current.text = normalizeText(`${current.text} ${next.text}`);
      } else {
        out.push(current);
        current = { ...next };
      }
    }
    out.push(current);
    return out;
  }

  function joinCueText(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a) return b;
    if (!b || a === b) return a;
    if (b.startsWith(a)) return b;
    if (a.startsWith(b) || a.includes(b)) return a;

    const aWords = a.split(" ");
    const bWords = b.split(" ");
    const maxWords = Math.min(aWords.length, bWords.length, 12);
    for (let size = maxWords; size >= 1; size -= 1) {
      const tail = aWords.slice(-size).join(" ").toLowerCase();
      const head = bWords.slice(0, size).join(" ").toLowerCase();
      if (tail === head) return normalizeText([...aWords, ...bWords.slice(size)].join(" "));
    }

    // CJK and punctuation-heavy captions may have no spaces. Only remove a
    // meaningful overlap; one or two repeated characters are too ambiguous.
    const maxChars = Math.min(a.length, b.length, 24);
    for (let size = maxChars; size >= 4; size -= 1) {
      if (a.slice(-size) === b.slice(0, size)) return normalizeText(a + b.slice(size));
    }
    return normalizeText(`${a} ${b}`);
  }

  /** Turn word-level/ASR fragments into stable reading units. */
  function buildReadableCues(cues, options = {}) {
    if (!Array.isArray(cues) || !cues.length) return [];
    const minDuration = Math.max(0.8, Number(options.minDuration) || 1.8);
    const maxDuration = Math.max(minDuration, Number(options.maxDuration) || 5.5);
    const maxChars = Math.max(40, Number(options.maxChars) || 110);
    const pauseBreak = Math.max(0.2, Number(options.pauseBreak) || 0.7);
    const sentenceEnd = /[.!?…。！？]["'”’」』》】)）\]]?\s*$/;
    const sorted = cues
      .filter((cue) => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end))
      .map((cue) => ({ ...cue, text: normalizeText(cue.text) }))
      .filter((cue) => cue.text)
      .sort((a, b) => a.start - b.start);
    if (!sorted.length) return [];

    const out = [];
    let current = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i += 1) {
      const next = sorted[i];
      const gap = next.start - current.end;
      const combinedText = joinCueText(current.text, next.text);
      const combinedEnd = Math.max(current.end, next.end);
      const currentDuration = current.end - current.start;
      const combinedDuration = combinedEnd - current.start;
      const withinCaps = combinedDuration <= maxDuration && combinedText.length <= maxChars;
      const needsReadingFloor = currentDuration < minDuration && gap <= pauseBreak;
      const naturalBreak =
        gap > pauseBreak || sentenceEnd.test(current.text) || !withinCaps;

      if (withinCaps && (needsReadingFloor || !naturalBreak)) {
        current.end = combinedEnd;
        current.text = combinedText;
      } else {
        const readingDuration = Math.min(
          maxDuration,
          Math.max(minDuration, readingHoldMs(current.text) / 1000)
        );
        current.end = Math.max(
          current.end,
          Math.min(next.start, current.start + readingDuration)
        );
        out.push(current);
        current = { ...next };
      }
    }
    const finalReadingDuration = Math.min(
      maxDuration,
      Math.max(minDuration, readingHoldMs(current.text) / 1000)
    );
    current.end = Math.max(current.end, current.start + finalReadingDuration);
    out.push(current);
    return out;
  }

  function readingHoldMs(text, options = {}) {
    const minMs = Math.max(800, Number(options.minMs) || 2200);
    const maxMs = Math.max(minMs, Number(options.maxMs) || 5200);
    const value = normalizeText(text);
    const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const words = value.split(/\s+/).filter(Boolean).length;
    const estimated = cjkCount >= Math.max(2, words)
      ? 900 + cjkCount * 110
      : 900 + words * 300;
    return Math.round(Math.min(maxMs, Math.max(minMs, estimated)));
  }

  /** Align independently segmented translated cues to source cues by time overlap. */
  function alignTranslatedCues(sourceCues, translatedCues, slack = 0.22) {
    const source = Array.isArray(sourceCues) ? sourceCues : [];
    const translated = Array.isArray(translatedCues) ? translatedCues : [];
    const aligned = new Array(source.length).fill("");
    let cursor = 0;

    for (let i = 0; i < source.length; i += 1) {
      const cue = source[i];
      while (cursor < translated.length && translated[cursor].end <= cue.start) {
        cursor += 1;
      }
      const parts = [];
      const seen = new Set();
      for (let j = cursor; j < translated.length; j += 1) {
        const item = translated[j];
        if (item.start >= cue.end) break;
        const overlap = Math.min(cue.end, item.end) - Math.max(cue.start, item.start);
        if (overlap <= 0) continue;
        const text = normalizeText(item.text);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        parts.push(text);
      }
      // Some tracks differ by a few milliseconds. Use the nearest cue only when
      // there was no real overlap, so adjacent source lines never share text.
      if (!parts.length) {
        let nearest = null;
        let nearestGap = Infinity;
        for (let j = Math.max(0, cursor - 1); j < translated.length; j += 1) {
          const item = translated[j];
          if (item.start > cue.end + slack) break;
          const gap = Math.max(cue.start - item.end, item.start - cue.end, 0);
          if (gap <= slack && gap < nearestGap) {
            nearest = item;
            nearestGap = gap;
          }
        }
        const text = normalizeText(nearest?.text);
        if (text) parts.push(text);
      }
      aligned[i] = normalizeText(parts.join(" "));
    }
    return aligned;
  }

  function findCueIndex(cues, time) {
    if (!Array.isArray(cues) || !cues.length) return -1;
    let low = 0;
    let high = cues.length - 1;
    let answer = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (answer >= 0 && time <= cues[answer].end + 0.4) return answer;
    return -1;
  }

  /** Current cue first, then only the near future; avoids request storms. */
  function buildPrefetchTexts(cues, currentTime, options = {}) {
    const limit = Math.max(1, Number(options.limit) || 20);
    const horizon = Math.max(5, Number(options.horizon) || 75);
    let index = findCueIndex(cues, currentTime);
    if (index < 0) index = cues.findIndex((cue) => cue.start >= currentTime);
    if (index < 0) return [];
    const result = [];
    const seen = new Set();
    for (let i = index; i < cues.length && result.length < limit; i += 1) {
      const cue = cues[i];
      if (i > index && cue.start > currentTime + horizon) break;
      const text = normalizeText(cue.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
    return result;
  }

  return {
    normalizeText,
    parseCueJson,
    mergeShortCues,
    joinCueText,
    buildReadableCues,
    readingHoldMs,
    alignTranslatedCues,
    findCueIndex,
    buildPrefetchTexts
  };
});
