/** PDF paragraph grain. Pure logic: no network, no DOM, no PDF.js. */
(function exposePdfCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.__LT_PDF_CORE__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function isPdfUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      if (parsed.protocol !== "file:" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return /\.pdf$/i.test(decodeURIComponent(parsed.pathname || ""));
    } catch {
      return false;
    }
  }

  function isPdfViewerUrl(url, extensionId) {
    try {
      const parsed = new URL(String(url || ""));
      if (parsed.protocol !== "chrome-extension:") return false;
      if (extensionId && parsed.host !== extensionId) return false;
      return /\/pdf-viewer\.html$/i.test(parsed.pathname || "");
    } catch {
      return false;
    }
  }

  function pdfViewerSrc(url) {
    try {
      return new URL(String(url || "")).searchParams.get("src") || "";
    } catch {
      return "";
    }
  }

  function pdfFileName(url) {
    try {
      const name = decodeURIComponent(new URL(String(url || "")).pathname || "").split("/").pop();
      return name || "document.pdf";
    } catch {
      return "document.pdf";
    }
  }

  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /**
   * pdf.js text items → top-left glyph boxes in viewport pixels.
   * viewport.transform is the 6-number matrix from page.getViewport().
   */
  function glyphsFromPdfItems(items, viewport) {
    const matrix = viewport && viewport.transform;
    if (!matrix || matrix.length < 6) return [];
    const scaleX = Math.hypot(matrix[0], matrix[1]) || 1;
    const glyphs = [];
    for (const item of items || []) {
      if (!item || item.str == null || !item.transform) continue;
      const angle = Math.atan2(item.transform[1], item.transform[0]);
      if (Math.abs(angle) > 0.35) continue;
      const tx = multiplyMatrix(matrix, item.transform);
      const fontSize = Math.hypot(tx[2], tx[3]);
      if (!fontSize) continue;
      glyphs.push({
        text: String(item.str),
        x: tx[4],
        y: tx[5] - fontSize,
        w: Math.abs((Number(item.width) || 0) * scaleX),
        h: fontSize,
        fontSize
      });
    }
    return glyphs;
  }

  function shouldTranslateParagraph(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value.length < 2) return false;
    const letters = value.match(/\p{L}/gu);
    const letterCount = letters ? letters.length : 0;
    if (letterCount < 2) return false;
    if (letterCount < 8 && /[=+\-−–/^√∑∫π±<>≤≥≈∞]/.test(value)) return false;
    if (letterCount < 4) return false;
    const words = value.match(/\p{L}{4,}/gu);
    if ((!words || words.length < 2) && /[=+\-−√∑∫π±^<>|]/.test(value)) return false;
    const ratio = letterCount / value.length;
    if (value.length < 24 && ratio < 0.45) return false;
    if (ratio < 0.3) return false;
    return true;
  }

  function splitForTranslate(text, maxLen) {
    const limit = maxLen || 1400;
    const source = String(text || "").replace(/\s+/g, " ").trim();
    if (!source) return [];
    if (source.length <= limit) return [source];
    const parts = [];
    let rest = source;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(". ", limit);
      if (cut < limit * 0.4) cut = rest.lastIndexOf(" ", limit);
      if (cut < limit * 0.4) cut = limit;
      else cut += 1;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  function lineBounds(line) {
    let left = Infinity;
    let right = -Infinity;
    for (const glyph of line.glyphs) {
      if (glyph.x < left) left = glyph.x;
      const edge = glyph.x + glyph.w;
      if (edge > right) right = edge;
    }
    return { left, right };
  }

  function canJoinLine(line, glyph) {
    const height = Math.max(glyph.h, 1);
    const center = glyph.y + height / 2;
    const limit = Math.max(line.h, height) * 0.6;
    if (Math.abs(center - line.cy) > limit) return false;
    const bounds = lineBounds(line);
    let gap = 0;
    if (glyph.x >= bounds.right) gap = glyph.x - bounds.right;
    else if (glyph.x + glyph.w <= bounds.left) gap = bounds.left - (glyph.x + glyph.w);
    return gap <= Math.max(line.h, height, 8) * 1.6;
  }

  function isSuperscriptMark(glyph, bodyFont) {
    const text = String(glyph.text || "").trim();
    if (!text) return false;
    if ((glyph.fontSize || glyph.h) >= bodyFont * 0.82) return false;
    return /^[\d,.*∗†‡§˚]+$/.test(text);
  }

  function joinGlyphs(glyphs) {
    let text = "";
    let prev = null;
    for (const glyph of glyphs) {
      const piece = String(glyph.text || "");
      if (!piece) continue;
      if (!text) {
        text = piece;
        prev = glyph;
        continue;
      }
      if (/\s$/.test(text) || /^\s/.test(piece)) {
        text += piece;
      } else {
        const gap = glyph.x - (prev.x + prev.w);
        const font = Math.max(glyph.fontSize || glyph.h, prev.fontSize || prev.h, 1);
        const punctuation = /^[,.;:)\]]/.test(piece);
        const opener = /[(\[“"']$/.test(text);
        if (!punctuation && !opener && gap > font * 0.15) text += " ";
        text += piece;
      }
      prev = glyph;
    }
    return text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .trim();
  }

  function finalizeLine(raw) {
    const glyphs = raw.glyphs.slice().sort((a, b) => a.x - b.x);
    const sized = glyphs.filter((glyph) => String(glyph.text || "").trim());
    if (!sized.length) return null;
    const bodyFont = Math.max(...sized.map((glyph) => glyph.fontSize || glyph.h));
    const kept = glyphs.filter((glyph) => !isSuperscriptMark(glyph, bodyFont));
    const text = joinGlyphs(kept);
    if (!text) return null;
    const box = kept.filter((glyph) => String(glyph.text || "").trim());
    const source = box.length ? box : kept;
    const x = Math.min(...source.map((glyph) => glyph.x));
    const y = Math.min(...source.map((glyph) => glyph.y));
    const right = Math.max(...source.map((glyph) => glyph.x + glyph.w));
    const bottom = Math.max(...source.map((glyph) => glyph.y + glyph.h));
    return { text, x, y, w: right - x, h: Math.max(bottom - y, bodyFont), fontSize: bodyFont };
  }

  function centerY(glyph) {
    return glyph.y + Math.max(glyph.h, glyph.fontSize, 1) / 2;
  }

  function rememberLine(line, glyph) {
    line.glyphs.push(glyph);
    const centers = line.glyphs
      .filter((item) => String(item.text || "").trim())
      .map(centerY)
      .sort((a, b) => a - b);
    const heights = line.glyphs
      .filter((item) => String(item.text || "").trim())
      .map((item) => item.h || item.fontSize || 1)
      .sort((a, b) => a - b);
    if (centers.length) line.cy = centers[Math.floor(centers.length / 2)];
    if (heights.length) line.h = heights[Math.floor(heights.length / 2)];
  }

  /** Superscripts are drawn first and would otherwise split one baseline into several lines. */
  function mergeRawLines(lines) {
    const used = new Set();
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const current = {
        glyphs: lines[i].glyphs.slice(),
        cy: lines[i].cy,
        h: lines[i].h
      };
      used.add(i);
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < lines.length; j++) {
          if (used.has(j)) continue;
          const other = lines[j];
          if (Math.abs(current.cy - other.cy) > Math.max(current.h, other.h) * 0.5) continue;
          const bounds = lineBounds(current);
          const otherBounds = lineBounds(other);
          const gap = Math.max(otherBounds.left - bounds.right, bounds.left - otherBounds.right);
          if (gap > Math.max(current.h, other.h, 8) * 1.25) continue;
          current.glyphs.push(...other.glyphs);
          const centers = current.glyphs.filter((item) => String(item.text || "").trim()).map(centerY).sort((a, b) => a - b);
          if (centers.length) current.cy = centers[Math.floor(centers.length / 2)];
          current.h = Math.max(current.h, other.h);
          used.add(j);
          grew = true;
        }
      }
      merged.push(current);
    }
    return merged;
  }

  function clusterLines(glyphs) {
    const sorted = (glyphs || [])
      .filter((glyph) => glyph && glyph.text != null && (String(glyph.text).trim() || glyph.w > 0.4))
      .slice()
      .sort((a, b) => Math.round(centerY(a) / 5) - Math.round(centerY(b) / 5) || a.x - b.x);
    const lines = [];
    for (const glyph of sorted) {
      let best = null;
      let bestGap = Infinity;
      const start = Math.max(0, lines.length - 10);
      for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!canJoinLine(line, glyph)) continue;
        const bounds = lineBounds(line);
        if (glyph.x + Math.max(glyph.w, 0) < bounds.left - 1) continue;
        const gap = Math.abs(glyph.x - bounds.right);
        if (gap < bestGap) {
          best = line;
          bestGap = gap;
        }
      }
      if (!best) {
        if (!String(glyph.text || "").trim()) continue;
        lines.push({
          glyphs: [glyph],
          cy: centerY(glyph),
          h: glyph.h || glyph.fontSize || 1
        });
        continue;
      }
      rememberLine(best, glyph);
    }
    return mergeRawLines(lines).map(finalizeLine).filter(Boolean);
  }

  function isFullWidth(line, pageWidth) {
    return !!pageWidth && line.w >= pageWidth * 0.68;
  }

  function orderBucket(bucket, pageWidth) {
    const mid = pageWidth / 2;
    const left = [];
    const right = [];
    for (const line of bucket) {
      const center = line.x + line.w / 2;
      if (center < mid) left.push(line);
      else right.push(line);
    }
    if (left.length < 2 || right.length < 2) {
      return bucket.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    }
    const leftEdge = Math.max(...left.map((line) => line.x + line.w));
    const rightEdge = Math.min(...right.map((line) => line.x));
    if (rightEdge - leftEdge < Math.max(8, pageWidth * 0.015)) {
      return bucket.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    }
    const byY = (a, b) => a.y - b.y || a.x - b.x;
    left.sort(byY);
    right.sort(byY);
    return left.concat(right);
  }

  function orderLines(lines, pageWidth) {
    const sorted = lines.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const ordered = [];
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      ordered.push(...orderBucket(bucket, pageWidth));
      bucket = [];
    };
    for (const line of sorted) {
      if (isFullWidth(line, pageWidth)) {
        flush();
        ordered.push(line);
      } else bucket.push(line);
    }
    flush();
    return ordered;
  }

  function joinLineText(prev, next) {
    if (/[\p{L}][-\u00ad]$/u.test(prev) && /^\p{Ll}/u.test(next)) return prev.slice(0, -1) + next;
    return `${prev} ${next}`;
  }

  function sameParagraph(paragraph, line) {
    const fontRatio = line.fontSize / (paragraph.fontSize || line.fontSize || 1);
    if (fontRatio < 0.82 || fontRatio > 1.22) return false;
    const prev = paragraph.lastLine;
    const gap = line.y - (prev.y + prev.h);
    const leading = Math.max(prev.fontSize || prev.h, line.fontSize || line.h, 1);
    if (gap > leading * 0.75) return false;
    if (gap < -leading * 0.35) return false;
    const indent = line.x - paragraph.x;
    if (indent > leading * 1.15 && gap > leading * 0.15) return false;
    const prevShort = prev.w < paragraph.maxLineW * 0.72;
    const returnsLeft = line.x <= prev.x + leading * 0.45;
    if (prevShort && returnsLeft && gap > leading * 0.12) return false;
    return true;
  }

  function groupParagraphs(lines) {
    const paragraphs = [];
    let current = null;
    const finish = () => {
      if (!current) return;
      const text = current.text.replace(/\s+/g, " ").trim();
      if (text) {
        paragraphs.push({
          text,
          x: current.x,
          y: current.y,
          w: current.w,
          h: current.bottom - current.y,
          fontSize: current.fontSize,
          skip: !shouldTranslateParagraph(text)
        });
      }
      current = null;
    };
    for (const line of lines) {
      if (!shouldTranslateParagraph(line.text)) {
        finish();
        continue;
      }
      if (!current) {
        current = {
          text: line.text,
          x: line.x,
          y: line.y,
          w: line.w,
          bottom: line.y + line.h,
          fontSize: line.fontSize,
          maxLineW: line.w,
          lastLine: line
        };
        continue;
      }
      if (!sameParagraph(current, line)) {
        finish();
        current = {
          text: line.text,
          x: line.x,
          y: line.y,
          w: line.w,
          bottom: line.y + line.h,
          fontSize: line.fontSize,
          maxLineW: line.w,
          lastLine: line
        };
        continue;
      }
      current.text = joinLineText(current.text, line.text);
      const left = Math.min(current.x, line.x);
      const right = Math.max(current.x + current.w, line.x + line.w);
      current.x = left;
      current.w = right - left;
      current.bottom = Math.max(current.bottom, line.y + line.h);
      current.maxLineW = Math.max(current.maxLineW, line.w);
      current.lastLine = line;
    }
    finish();
    return paragraphs;
  }

  function buildPageParagraphs(glyphs, pageWidth) {
    return groupParagraphs(orderLines(clusterLines(glyphs), pageWidth || 0));
  }

  function normalizeChromeKey(text) {
    return String(text || "")
      .replace(/\b\d+\s+of\s+\d+\b/gi, "#")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Drop running headers and footers that repeat in the page margin. */
  function markRepeatedChrome(pages) {
    const buckets = new Map();
    for (const page of pages || []) {
      const height = Number(page.height) || 0;
      if (!height) continue;
      for (const paragraph of page.paragraphs || []) {
        const key = normalizeChromeKey(paragraph.text);
        if (key.length < 4 || key.length > 160) continue;
        const top = paragraph.y <= height * 0.11;
        const bottom = paragraph.y >= height * 0.9;
        if (!top && !bottom) continue;
        const list = buckets.get(key) || [];
        list.push(paragraph);
        buckets.set(key, list);
      }
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      for (const paragraph of list) paragraph.skip = true;
    }
    return pages;
  }

  return {
    isPdfUrl,
    isPdfViewerUrl,
    pdfViewerSrc,
    pdfFileName,
    multiplyMatrix,
    glyphsFromPdfItems,
    shouldTranslateParagraph,
    splitForTranslate,
    buildPageParagraphs,
    markRepeatedChrome
  };
});
