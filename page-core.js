/** Paragraph-grain helpers for page translation. Works in Chrome and Node tests. */
(function exposePageCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.__LT_PAGE_CORE__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const INLINE_PIECE_TAGS = new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "BR",
    "CITE",
    "CODE",
    "DATA",
    "DFN",
    "EM",
    "FONT",
    "I",
    "KBD",
    "MARK",
    "Q",
    "S",
    "SAMP",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "TT",
    "U",
    "VAR",
    "WBR"
  ]);

  const BLOCK_HOST_TAGS = new Set([
    "P",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TD",
    "TH",
    "DT",
    "DD",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "SUMMARY"
  ]);

  /** Model ids / dotted tokens Google often drops, e.g. gemini-3.5-transcribe */
  const STABLE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+\b/gi;

  function isInlinePieceTag(tag) {
    return INLINE_PIECE_TAGS.has(String(tag || "").toUpperCase());
  }

  function isBlockHostTag(tag) {
    return BLOCK_HOST_TAGS.has(String(tag || "").toUpperCase()) || /^H[1-6]$/.test(String(tag || ""));
  }

  function shouldHostAtAncestor(ancestorText, nodeText) {
    const ancestor = String(ancestorText || "").replace(/\s+/g, " ").trim();
    const node = String(nodeText || "").replace(/\s+/g, " ").trim();
    if (!node || !ancestor) return false;
    return ancestor.length > node.length + 8;
  }

  function protectStableTokens(text) {
    const tokens = [];
    const protectedText = String(text || "").replace(STABLE_TOKEN_RE, (tok) => {
      const marks = (tok.match(/[-_.]/g) || []).length;
      if (tok.length < 7 || marks < 1) return tok;
      if (!/[0-9]/.test(tok) && marks < 2) return tok;
      const index = tokens.length;
      tokens.push(tok);
      return `⟦#${index}⟧`;
    });
    return { protectedText, tokens };
  }

  function restoreStableTokens(translated, tokens) {
    let out = String(translated || "");
    const list = Array.isArray(tokens) ? tokens : [];
    list.forEach((tok, index) => {
      const mark = new RegExp(`⟦\\s*#?\\s*${index}\\s*⟧`, "gi");
      out = out.replace(mark, tok);
    });
    list.forEach((tok) => {
      if (!tok || out.includes(tok)) return;
      if (/\(\s*\)/.test(out)) {
        out = out.replace(/\(\s*\)/, `(${tok})`);
        return;
      }
      if (/（\s*）/.test(out)) out = out.replace(/（\s*）/, `（${tok}）`);
    });
    return out;
  }

  return {
    INLINE_PIECE_TAGS,
    BLOCK_HOST_TAGS,
    isInlinePieceTag,
    isBlockHostTag,
    shouldHostAtAncestor,
    protectStableTokens,
    restoreStableTokens
  };
});
