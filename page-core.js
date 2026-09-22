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

  /** Material / Google Symbols ligatures: arrow_circle_up, account_circle */
  const ICON_LIGATURE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
  const ICON_FONT_RE =
    /Material Icons|Material Symbols|Google Symbols|Noto Sans Symbols|Font Awesome|FontAwesome|bootstrap-icons|iconfont|LigatureSymbols/i;
  const ICON_CLASS_RE =
    /\b(material-icons|material-symbols(?:-outlined|-rounded|-sharp)?|google-symbols|ms-Icon|fa[srlb]?|glyphicon|iconfont)\b/i;
  const ICON_TAG_RE = /^(MD-ICON|MAT-ICON|IRON-ICON)$/i;
  const MENU_TAG_RE = /^(MD-MENU-ITEM|MD-LIST-ITEM|MAT-LIST-ITEM|MAT-OPTION|MD-MENU|MAT-NAV-LIST)$/i;
  const MENU_ROLE_RE = /^(menuitem|option|listitem|treeitem|heading)$/i;

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

  function classNameToString(className) {
    if (!className) return "";
    if (typeof className === "string") return className;
    if (typeof className.baseVal === "string") return className.baseVal;
    try {
      return String(className);
    } catch {
      return "";
    }
  }

  function isIconLigatureName(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 48 || /\s/.test(t)) return false;
    return ICON_LIGATURE_RE.test(t);
  }

  function isIconFontFamily(family) {
    return ICON_FONT_RE.test(String(family || ""));
  }

  function primaryFontIsIcon(family) {
    const first = String(family || "")
      .split(",")[0]
      .replace(/["']/g, "")
      .trim();
    return ICON_FONT_RE.test(first);
  }

  function isIconClassName(className) {
    return ICON_CLASS_RE.test(classNameToString(className));
  }

  function isIconTag(tag) {
    return ICON_TAG_RE.test(String(tag || ""));
  }

  function isMaterialSymbolsAxes(fontVariationSettings) {
    return /FILL|wght|GRAD|opsz/.test(String(fontVariationSettings || ""));
  }

  /**
   * True when a text node is an icon glyph, not a user-facing label.
   * Snake_case ligatures are skipped even without font context; single tokens
   * like "close" are skipped only inside an explicit icon tag/class/primary font.
   */
  function isIconGlyphText(text, info = {}) {
    const t = String(text || "").trim();
    if (!t || /\s/.test(t) || t.length > 48) return false;
    const fontPx = Number(info.fontPx) || 0;
    const inIcon =
      isIconTag(info.tag) ||
      isIconClassName(info.className) ||
      primaryFontIsIcon(info.fontFamily) ||
      (isMaterialSymbolsAxes(info.fontVariationSettings) && (!fontPx || fontPx <= 32));
    if (inIcon) return /^[a-z][a-z0-9_]{1,47}$/i.test(t);
    return isIconLigatureName(t);
  }

  function shouldSkipIconNode(info = {}) {
    if (isIconTag(info.tag) || isIconClassName(info.className)) return true;
    if (info.ariaHidden && isIconLigatureName(info.text)) return true;
    return isIconGlyphText(info.text, info);
  }

  function joinHostPieces(parts) {
    return (Array.isArray(parts) ? parts : [])
      .map((part) => String(part || "").replace(/\s+/g, " ").trim())
      .filter((part) => part && !isIconLigatureName(part))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMenuLikeHost(info = {}) {
    const role = String(info.role || "").toLowerCase();
    if (MENU_ROLE_RE.test(role)) return true;
    if (MENU_TAG_RE.test(String(info.tag || ""))) return true;
    return !!info.inMenu;
  }

  /**
   * Immersive Translate default: bilingual pair on the next line.
   * Compact (same line) is only for tiny inline chips, never menus/headings/icons.
   */
  function chooseBilingualLayout(info = {}) {
    const tag = String(info.tag || "").toUpperCase();
    const role = String(info.role || "").toLowerCase();
    const display = String(info.display || "").toLowerCase();
    const textLength = Number(info.textLength) || 0;
    const fontPx = Number(info.fontPx) || 0;
    const bodyPx = Number(info.bodyPx) || 16;
    if (info.hasIconChild || info.inMenu || info.isHeading) return "stack";
    if (isMenuLikeHost(info)) return "stack";
    if (isBlockHostTag(tag) || /^H[1-6]$/.test(tag) || role === "heading") return "stack";
    if (textLength > 22) return "stack";
    if (fontPx && fontPx >= bodyPx * 1.12) return "stack";
    const inline = display === "inline" || display === "inline-flex" || display === "inline-block";
    const chip = tag === "BUTTON" || tag === "A" || tag === "LABEL" || role === "button";
    if (chip && inline && textLength > 0 && textLength <= 16 && !info.hasIconChild) return "compact";
    if (inline && textLength > 0 && textLength <= 12 && !info.hasIconChild && !info.inMenu) return "compact";
    return "stack";
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
    ICON_CLOSEST:
      "md-icon, mat-icon, iron-icon, .material-icons, .material-symbols-outlined, .material-symbols-rounded, .material-symbols-sharp, .google-symbols, .ms-Icon",
    isInlinePieceTag,
    isBlockHostTag,
    shouldHostAtAncestor,
    isIconLigatureName,
    isIconFontFamily,
    primaryFontIsIcon,
    isIconClassName,
    isIconTag,
    isMaterialSymbolsAxes,
    isIconGlyphText,
    shouldSkipIconNode,
    joinHostPieces,
    isMenuLikeHost,
    chooseBilingualLayout,
    protectStableTokens,
    restoreStableTokens
  };
});
