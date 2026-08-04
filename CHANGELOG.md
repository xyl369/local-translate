# Changelog

## [3.6.0] — 2026-08-04

### Privacy

- Settings now use `chrome.storage.local` only (no Chrome Sync / Google account sync)
- One-time migration: existing `storage.sync` values are copied to local, then sync is cleared
- Documented threat model: no China-vendor SDKs/analytics; translation text still goes to Google only

### Docs

- README: bilingual threat model, honest “not offline” naming note, contribution boundary

## [3.5.2] — 2026-07-26

- Popup / UI polish and i18n groundwork
