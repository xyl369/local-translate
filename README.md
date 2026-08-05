# Local Translate

**Auditable Chromium bilingual translation + YouTube dual subtitles**  
**可审计的 Chromium 双语网页翻译 + YouTube 双语字幕**

No analytics · no account system · no China-vendor SDKs · settings stay on-device  
无埋点 · 无账号 · 无国产厂商 SDK · 设置仅存本机

[English](#english) · [中文](#中文) · [Threat model](#threat-model--威胁模型) · [License](LICENSE)

---

## Threat model / 威胁模型

| Goal | Status |
|------|--------|
| Avoid **China-company** analytics / account upload / vendor SDKs | **Yes** — no such endpoints in source |
| Keep extension settings on **this browser only** | **Yes** (v3.6+) — `chrome.storage.local` only; not Google Sync |
| Pure offline / no text leaves the machine | **Optional** — choose **Chrome on-device** engine (newer Chrome). Default **Google gtx** still sends text to Google |
| Local LLM / Ollama | **Not included** — too heavy for typical laptops; not part of this project |

**Engines (v3.7+)**

| Engine | Cost | Leaves machine? | Notes |
|--------|------|-----------------|-------|
| **Google Translate (default)** | Free | Yes → Google only | Best day-to-day UX |
| **Chrome on-device** | Free | No (when API available) | Needs newer Chrome; falls back to Google if unavailable |

**What leaves the machine (Google engine)**

| Data | Destination |
|------|-------------|
| Text you ask to translate | `https://translate.googleapis.com/...` (`client=gtx`) |
| YouTube caption track / `tlang` | `https://www.youtube.com/api/timedtext?...` |
| Browsing history / full page dumps | **Not uploaded** |
| Settings / blocklist | **Device only** (`chrome.storage.local`) |

**What this is *not***

- Not a China-vendor product (no ByteDance / Alibaba / Tencent clients)
- Not a local LLM runner
- Not a guarantee that websites cannot detect DOM injection

> **Naming:** “Local” means *runs in your browser, settings on-device, no project-operated backend*. Default translation is **not** offline unless you switch to Chrome on-device.

---

## English

### What is Local Translate?

A lightweight Chromium extension that provides:

1. **Bilingual web translation** — Viewport-first; continues on scroll
2. **YouTube dual subtitles** — Prefetch + cache for near-zero playback delay
3. **Site blocklist** — Never translate specified domains
4. **Hotkey** — `Alt+A` to toggle translation / restore original

Uses the **Google Translate public API** (`client=gtx`) by default. Optional **Chrome on-device** engine for pages where you do not want text to leave the machine. No backend you must trust, no account system, no analytics, **no local LLM**.

### Features

| Feature | Description |
|---------|-------------|
| Viewport translation | Visible area first; scroll backfill |
| Engine switch | Google (default) or Chrome on-device |
| Bilingual / translation-only | Switchable display mode |
| Translation style | Muted / underline / left color bar |
| Skip code + site chrome | `<code>` / `<pre>`; skip nav/header/footer/aside |
| Retry failed blocks | Click **Retry translate** |
| Context menu | Translate selection / bilingual page |
| YouTube subtitles | Dual-line; prefer YouTube `tlang`, then engine |
| Site blocklist | Per-domain never-translate |
| On-demand inject | Scripts inject when you translate (or auto options) |
| On-device settings | `storage.local` only (no Chrome Sync) |

### Install

```bash
git clone https://github.com/xyl369/local-translate.git
```

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the `local-translate` folder
4. After upgrade to **v3.6+**, reload the extension once (migrates old Sync settings → local)

### Usage

1. Open any page → extension icon → **Translate page**
2. YouTube (CC track required) → **Dual subtitles**
3. Skip a site → **Never translate this site**

### Permissions

| Permission | Why |
|------------|-----|
| `storage` | Language, style, blocklist (**local only**) |
| `activeTab` | Inject into the active tab |
| `scripting` | Hotkey / context-menu reinject |
| `contextMenus` | Right-click translate |
| `https://translate.googleapis.com/*` | Google Translate |
| `http(s)://*/*` | Inject bilingual UI; YouTube subs |

### Project structure

```
local-translate/
├── manifest.json
├── background.js         # Engines + allowlisted fetch
├── offscreen.html/.js    # Chrome on-device Translator
├── content.js / content.css
├── youtube-bridge.js     # MAIN-world timedtext sniffer
├── youtube-subs.js
├── popup.html / popup.js / popup.css / popup-i18n.js
└── icons/
```

No build step. No npm dependencies.

### Disclaimer

1. Unofficial Google `gtx` API — may be rate-limited or broken without notice.
2. Follow [Google Terms](https://policies.google.com/terms); no warranty.
3. MIT **as-is**. Do not use for copyright bulk scraping.

### Contributing

Keep it auditable and light: **no analytics, no China-vendor SDKs, no cloud account sync**. Optional local engines (`localhost`) welcome.

---

## 中文

### 这是什么

轻量 Chromium 扩展：

1. **网页双语翻译** — 视口优先，滚动续译  
2. **YouTube 双语字幕** — 预译缓存  
3. **站点屏蔽**  
4. **快捷键** `Alt+A`

翻译走 **Google Translate 公开接口**（`client=gtx`）。无自建后端、无账号、无埋点。

> 「Local」= 扩展在浏览器内跑、设置在本机；**不是**离线翻译引擎，待译文本会发往 Google。

### 功能

| 功能 | 说明 |
|------|------|
| 视口翻译 | 先译可见区域，滚动补译 |
| 双语 / 仅译文 | 可切换 |
| 译文样式 | 淡色 / 下划线 / 左侧色条 |
| 跳过代码块 | 默认不译 `<code>` / `<pre>` |
| 右键菜单 | 选中 / 整页 |
| YouTube 字幕 | 双段显示 |
| 站点屏蔽 | 按域名 |
| 本机设置 | 仅 `storage.local`，不同步到 Google 账号 |

### 安装

```bash
git clone https://github.com/xyl369/local-translate.git
```

1. `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序**  
2. 升级到 **v3.6+** 后请重新加载扩展一次（会把旧 Sync 设置迁到本机）

### 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 语言、样式、黑名单（**仅本机**） |
| `activeTab` / `scripting` / `contextMenus` | 注入与右键 |
| `https://translate.googleapis.com/*` | 翻译请求 |
| `http(s)://*/*` | 页面注入与 YouTube 字幕 |

### 免责声明

1. Google 非官方接口可能随时失效。  
2. 须遵守 Google 服务条款。  
3. 按 MIT「原样」提供。

### 参与贡献

保持可审计：无埋点、无国产 SDK、无云账号同步。欢迎后续接入本机 `localhost` 翻译引擎。

---

## License

[MIT](LICENSE) © 2026 xyl369
