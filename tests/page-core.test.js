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
