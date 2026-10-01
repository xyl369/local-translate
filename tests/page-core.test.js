const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../page-core.js");

test("inline links inside a paragraph host at the paragraph", () => {
  const paragraph =
    "Transcribes audio files up to 1 hour in a single request via the Interactions API";
  assert.equal(core.shouldHostAtAncestor(paragraph, "Interactions API"), true);
  assert.equal(core.shouldHostAtAncestor("Get API key", "Get API key"), false);
  assert.equal(core.isInlinePieceTag("A"), true);
  assert.equal(core.isInlinePieceTag("CODE"), true);
  assert.equal(core.isBlockHostTag("P"), true);
  assert.equal(core.isInlinePieceTag("P"), false);
});

test("model ids are protected and empty parentheses are filled back", () => {
  const { protectedText, tokens } = core.protectStableTokens(
    "Pre-recorded audio processing (gemini-3.5-transcribe)"
  );
  assert.deepEqual(tokens, ["gemini-3.5-transcribe"]);
  assert.equal(protectedText.includes("gemini-3.5-transcribe"), false);
  assert.equal(protectedText.includes("⟦#0⟧"), true);
  assert.equal(
    core.restoreStableTokens("预录音频处理 (⟦#0⟧)", tokens),
    "预录音频处理 (gemini-3.5-transcribe)"
  );
  assert.equal(
    core.restoreStableTokens("预录音频处理 ()", tokens),
    "预录音频处理 (gemini-3.5-transcribe)"
  );
  const wordLevel = core.protectStableTokens("word-level timestamps");
  assert.deepEqual(wordLevel.tokens, []);
});

test("material icon ligatures are not treated as labels", () => {
  assert.equal(core.isIconLigatureName("arrow_circle_up"), true);
  assert.equal(core.isIconLigatureName("account_circle"), true);
  assert.equal(core.isIconLigatureName("shield_person"), true);
  assert.equal(core.isIconLigatureName("Submit prompt key"), false);
  assert.equal(core.isIconLigatureName("Settings"), false);
  assert.equal(core.joinHostPieces(["arrow_circle_up", "Submit prompt key"]), "Submit prompt key");
  assert.equal(core.joinHostPieces(["Privacy policy", "shield_person"]), "Privacy policy");
  assert.equal(
    core.joinHostPieces([
      "To view your billing statement, please",
      "log into your client panel",
      "."
    ]),
    "To view your billing statement, please log into your client panel."
  );
  assert.equal(core.joinHostPieces(["Hi", "xiaoyi,"]), "Hi xiaoyi,");
  assert.equal(core.shouldClimbToParent(0, false), true);
  assert.equal(core.shouldClimbToParent(1, true), true);
  assert.equal(core.shouldClimbToParent(3, false), false);
  assert.equal(core.isIconGlyphText("Hi", { className: "material-icons" }), false);
  assert.equal(core.isIconGlyphText("close", { className: "material-icons" }), true);
  assert.equal(
    core.shouldSkipIconNode({ tag: "MD-ICON", text: "arrow_circle_up" }),
    true
  );
  assert.equal(
    core.shouldSkipIconNode({ className: "google-symbols", text: "account_circle" }),
    true
  );
  assert.equal(
    core.shouldSkipIconNode({
      tag: "SPAN",
      fontFamily: '"Google Sans", "Google Symbols", sans-serif',
      text: "Settings"
    }),
    false
  );
  assert.equal(
    core.isIconGlyphText("close", { className: "material-icons" }),
    true
  );
  assert.equal(
    core.primaryFontIsIcon('"Google Sans", "Google Symbols"'),
    false
  );
  assert.equal(core.primaryFontIsIcon("Google Symbols, sans-serif"), true);
});

test("article title blocks are translated and site headers stay skipped", () => {
  const essayTitle = "On the Value of Doing a PhD in the Age of AI";
  assert.equal(core.looksLikeProseTitle(essayTitle), true);
  assert.equal(core.looksLikeProseTitle("Acme"), false);
  assert.equal(core.looksLikeProseTitle("For PhD Students in AI"), true);

  const titleBlock = {
    tag: "HEADER",
    role: "",
    hasHeading: true,
    hasNav: false,
    inContent: true,
    contentLinkCount: 0,
    originInNav: false
  };
  assert.equal(core.shouldSkipLandmark({ ...titleBlock, originIsHeading: false }), false);
  assert.equal(
    core.shouldSkipLandmark({
      ...titleBlock,
      originIsHeading: true,
      originHeadingText: essayTitle
    }),
    false
  );

  assert.equal(
    core.shouldSkipLandmark({
      tag: "HEADER",
      hasHeading: true,
      hasNav: true,
      inContent: false,
      contentLinkCount: 4,
      originInNav: false,
      originIsHeading: true,
      originHeadingText: "Acme"
    }),
    true
  );
  assert.equal(
    core.shouldSkipLandmark({
      tag: "HEADER",
      role: "banner",
      hasHeading: true,
      hasNav: false,
      inContent: true,
      contentLinkCount: 0,
      originInNav: false,
      originIsHeading: false
    }),
    true
  );
  assert.equal(
    core.shouldSkipLandmark({
      tag: "HEADER",
      hasNav: true,
      inContent: true,
      hasHeading: true,
      contentLinkCount: 3,
      originInNav: true,
      originIsHeading: false
    }),
    true
  );
  assert.equal(
    core.shouldSkipLandmark({
      tag: "HEADER",
      hasNav: true,
      inContent: true,
      hasHeading: true,
      contentLinkCount: 3,
      originInNav: false,
      originIsHeading: true,
      originHeadingText: essayTitle
    }),
    false
  );
  assert.equal(core.shouldSkipLandmark({ tag: "NAV" }), true);
  assert.equal(core.shouldSkipLandmark({ tag: "FOOTER" }), true);
  assert.equal(core.shouldSkipLandmark({ tag: "ASIDE" }), true);
  assert.equal(core.shouldSkipLandmark({ tag: "DIV", role: "toolbar" }), true);
});

test("bilingual layout stacks menus and headings, compact only for tiny chips", () => {
  assert.equal(
    core.chooseBilingualLayout({
      tag: "SPAN",
      role: "menuitem",
      textLength: 18,
      display: "flex",
      hasIconChild: true
    }),
    "stack"
  );
  assert.equal(
    core.chooseBilingualLayout({
      tag: "MD-MENU-ITEM",
      textLength: 14,
      display: "flex",
      inMenu: true
    }),
    "stack"
  );
  assert.equal(
    core.chooseBilingualLayout({
      tag: "H2",
      textLength: 14,
      display: "block",
      isHeading: true
    }),
    "stack"
  );
  assert.equal(
    core.chooseBilingualLayout({
      tag: "DIV",
      textLength: 13,
      display: "block",
      fontPx: 22,
      bodyPx: 14
    }),
    "stack"
  );
  assert.equal(
    core.chooseBilingualLayout({
      tag: "BUTTON",
      role: "button",
      textLength: 8,
      display: "inline-flex"
    }),
    "compact"
  );
  assert.equal(
    core.chooseBilingualLayout({
      tag: "SPAN",
      textLength: 8,
      display: "inline-flex"
    }),
    "compact"
  );
});
