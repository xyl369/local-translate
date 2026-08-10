# Changelog

## [3.9.0] — 2026-08-10

### Stable YouTube subtitle rhythm

- Make the real timed caption track authoritative; rolling DOM/ASR text is now fallback-only and can no longer overwrite complete cues word by word
- Recover caption requests made before extension injection by scanning buffered Resource Timing entries and observing future timedtext requests
- Rebuild fragmented captions into complete 1.8–5.5 second reading units with overlap deduplication and sentence/pause boundaries
- Keep the immediately previous bilingual cue visible while the current cue advances; extend captions into real silence according to reading length without crossing the next cue
- Avoid redundant overlay rewrites and use one restrained 140 ms cue transition instead of repeated flicker

### Privacy and verification

- Add timing-gap, ASR rebuilding, overlap, retention, late-injection, and cue-authority regression coverage
- No new provider, endpoint, SDK, analytics, or telemetry dependency

## [3.8.0] — 2026-08-10

### YouTube low-latency subtitle pipeline

- Discover captured timedtext URLs and player caption tracks in parallel; cut the page-RPC ceiling from two serial 900 ms waits to one 450 ms wait
- Fetch source and YouTube `tlang` tracks concurrently; never block engine prefetch on a slow whole-track translation
- Align independently segmented `tlang` cues by real time overlap instead of array index
- Prefetch up to 24 near-future cues in one background batch request; retry only missing lines with concurrency 3
- Coalesce growing ASR fragments for 130 ms to prevent repeated requests for the same sentence
- Remove per-frame overlay layout work and expose track/translation latency in `window.__LT_YT__.status()`

### Privacy and verification

- Keep the service worker as the only translation network boundary; remove the content-script direct-fetch fallback
- Add deterministic cue-alignment, prefetch, batch-count, endpoint-boundary, and China-vendor/telemetry regression tests

## [3.7.2] — 2026-08-05

### Fix: YouTube Chinese missing

- Remove over-aggressive cue remapping that dropped ZH onto the wrong line
- Only accept translations that contain real CJK; restore page-level Google fallback if background messaging fails
- Re-apply ZH to previous/current lines reliably after advance

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

## [3.6.1] — 2026-08-05

### Fix

- Stop duplicate bilingual lines on nested UI (sidebar links, billing tables): parent containers no longer re-translate child labels; chromeSel uses direct text only

## [3.6.0] — 2026-08-04

### Privacy

- Settings now use `chrome.storage.local` only (no Chrome Sync / Google account sync)
- One-time migration: existing `storage.sync` values are copied to local, then sync is cleared
- Documented threat model: no China-vendor SDKs/analytics; translation text still goes to Google only

### Docs

- README: bilingual threat model, honest “not offline” naming note, contribution boundary

## [3.5.2] — 2026-07-26

- Popup / UI polish and i18n groundwork
