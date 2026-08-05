/**
 * Offscreen page: Chrome on-device Translator API (no local LLM).
 * Falls back to unavailable when the browser lacks the API.
 */

const translators = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasTranslatorApi() {
  return typeof Translator !== "undefined" && typeof Translator.create === "function";
}

async function getTranslator(targetLang) {
  const key = `auto→${targetLang}`;
  if (translators.has(key)) return translators.get(key);

  if (!hasTranslatorApi()) throw new Error("Translator API unavailable (need newer Chrome)");

  // Prefer auto source detection when supported; else English → target.
  let translator;
  try {
    translator = await Translator.create({
      sourceLanguage: "en",
      targetLanguage: targetLang
    });
  } catch (err) {
    throw new Error(String(err?.message || err));
  }
  translators.set(key, translator);
  return translator;
}

async function translate(text, targetLang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const translator = await getTranslator(targetLang || "zh-Hans");
  return await translator.translate(trimmed);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_PROBE") {
    sendResponse({ ok: true, available: hasTranslatorApi() });
    return false;
  }
  if (message.type === "OFFSCREEN_TRANSLATE") {
    translate(message.text, message.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});
