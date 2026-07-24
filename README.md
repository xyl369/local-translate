# Local Translate

**Bilingual web translation + YouTube dual subtitles for Chromium browsers**

[License](LICENSE)

## What is Local Translate?

A lightweight Chromium extension that provides:

1. **Bilingual web translation** — Translates visible viewport content; auto-translates on scroll
2. **YouTube dual subtitles** — Fetches subtitle tracks, pre-translates and caches for near-zero playback delay
3. **Site blocklist** — Never translate specified domains
4. **Hotkey** — `Alt+A` to toggle translation / restore original

Uses the **Google Translate public API** (`client=gtx`). No backend server, no account system.

> **Naming note:** "Local" means the extension runs in your browser and settings stay on your device. **Translation requests are sent to Google** — this is not an offline engine.

## Features

| Feature | Description |
|---------|-------------|
| Viewport translation | Translate visible area first; continue on scroll |
| Bilingual / translation-only | Switchable display mode |
| Translation style | Muted / underline / left color bar |
| Skip code blocks | `<code>` / `<pre>` not translated by default |
| Context menu | Translate selection / bilingual whole page |
| YouTube subtitles | Dual-line display (previous + current sentence) |
| Site blocklist | Block domains from translation |
| Batch merge | Multiple texts per request; LRU cache |

## Install

```bash
git clone https://github.com/xyl369/local-translate.git
```

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `local-translate` folder

## Usage

1. Open any webpage → click extension icon → **Translate page**
2. YouTube video (CC track required) → **Dual subtitles**
3. To skip a site → check **Never translate this site**

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save language, style, blocklist |
| `activeTab` | Inject translation script into active tab |
| `scripting` | Re-inject on hotkey / context menu |
| `contextMenus` | Right-click translate selection / page |
| `https://translate.googleapis.com/*` | Google Translate API |
| `http(s)://*/*` | Display bilingual text; YouTube subtitles |

The extension does not collect user data or upload browsing history. Only text to be translated is sent to Google.

## Project structure

```
local-translate/
├── manifest.json
├── background.js
├── content.js / content.css
├── youtube-subs.js
├── popup.html / popup.js / popup.css
└── icons/
```

~3,000 lines of JavaScript. No build step. No npm dependencies.

## Technical notes

- **Manifest V3** — works on Chrome, Edge, and other Chromium browsers
- Web: semantic block traversal + viewport-first + MutationObserver incremental translation
- YouTube: subtitle XML → batch pre-translate → `requestAnimationFrame` timeline sync
- Translation: merged batch requests with per-item fallback; 2,000-entry LRU cache

## Disclaimer

1. Uses Google's **unofficial public API** — may be rate-limited, changed, or discontinued at any time.
2. Subject to [Google Terms of Service](https://policies.google.com/terms); no warranty on availability or compliance.
3. Provided **as-is** under [MIT License](LICENSE).
4. Do not use for bulk translation of copyrighted content or commercial scraping.

## Contributing

Issues and PRs welcome. Keep the extension lightweight — no heavy dependencies or backend services.

## License

[MIT](LICENSE) © 2026 xyl369
