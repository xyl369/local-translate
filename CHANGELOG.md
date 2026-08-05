# Changelog

## [3.7.1] — 2026-08-05

### YouTube dual subs — catch-up when ZH lags

- Late translations now fill **previous** line too (was stuck English-only after line advance)
- Map DOM/ASR fragments to full caption-track cues for stabler cache hits
- Prefix cache lookup while ASR text is still growing
- Larger / faster prefetch window; show `…` while ZH is pending

## [3.7.0] — 2026-08-05

### Optimal free UX path (no local LLM)

- Default engine remains **Google gtx** (free, best day-to-day UX)
- Optional **Chrome on-device Translator** via offscreen document (no Ollama / no big model)
- If Chrome API is missing, translation falls back to Google automatically

### Architecture / privacy surface

- Removed always-on content scripts; inject on demand (or when auto-translate / YouTube auto-subs is on)
- Page scripts no longer call Google directly — translate + YouTube timedtext go through the service worker allowlist
- YouTube: MAIN-world bridge to capture pot-bearing timedtext URLs; prefer **tlang** whole-track translation before gtx

### Page UX

- Skip `nav` / `header` / `footer` / `aside` shells
- Failed blocks show a clickable **Retry translate** control

## [3.6.0] — 2026-08-04

### Privacy

- Settings now use `chrome.storage.local` only (no Chrome Sync / Google account sync)
- One-time migration: existing `storage.sync` values are copied to local, then sync is cleared
- Documented threat model: no China-vendor SDKs/analytics; translation text still goes to Google only

### Docs

- README: bilingual threat model, honest “not offline” naming note, contribution boundary

## [3.5.2] — 2026-07-26

- Popup / UI polish and i18n groundwork
