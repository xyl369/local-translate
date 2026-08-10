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
    const next = answer + 1;
    return next < cues.length ? next : -1;
  }

  /** Current cue first, then only the near future; avoids request storms. */
  function buildPrefetchTexts(cues, currentTime, options = {}) {
    const limit = Math.max(1, Number(options.limit) || 20);
    const horizon = Math.max(5, Number(options.horizon) || 75);
    const index = findCueIndex(cues, currentTime);
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
    alignTranslatedCues,
    findCueIndex,
    buildPrefetchTexts
  };
});
