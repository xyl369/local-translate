# Local Translate

**Bilingual web translation + YouTube dual subtitles for Chromium browsers**

**Chromium 双语网页翻译 + YouTube 双语字幕扩展**

[English](#english) · [中文](#中文) · [License](LICENSE)

---

## English

### What is Local Translate?

A lightweight Chromium extension that provides:

1. **Bilingual web translation** — Translates visible viewport content; auto-translates on scroll
2. **YouTube dual subtitles** — Fetches subtitle tracks, pre-translates and caches for near-zero playback delay
3. **Site blocklist** — Never translate specified domains
4. **Hotkey** — `Alt+A` to toggle translation / restore original

Uses the **Google Translate public API** (`client=gtx`). No backend server, no account system.

> **Naming note:** "Local" means the extension runs in your browser and settings stay on your device. **Translation requests are sent to Google** — this is not an offline engine.

### Features

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

### Install

```bash
git clone https://github.com/xyl369/local-translate.git
```

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `local-translate` folder

### Usage

1. Open any webpage → click extension icon → **Translate page**
2. YouTube video (CC track required) → **Dual subtitles**
3. To skip a site → check **Never translate this site**

### Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save language, style, blocklist |
| `activeTab` | Inject translation script into active tab |
| `scripting` | Re-inject on hotkey / context menu |
| `contextMenus` | Right-click translate selection / page |
| `https://translate.googleapis.com/*` | Google Translate API |
| `http(s)://*/*` | Display bilingual text; YouTube subtitles |

The extension does not collect user data or upload browsing history. Only text to be translated is sent to Google.

### Project structure

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

### Technical notes

- **Manifest V3** — works on Chrome, Edge, and other Chromium browsers
- Web: semantic block traversal + viewport-first + MutationObserver incremental translation
- YouTube: subtitle XML → batch pre-translate → `requestAnimationFrame` timeline sync
- Translation: merged batch requests with per-item fallback; 2,000-entry LRU cache

### Disclaimer

1. Uses Google's **unofficial public API** — may be rate-limited, changed, or discontinued at any time.
2. Subject to [Google Terms of Service](https://policies.google.com/terms); no warranty on availability or compliance.
3. Provided **as-is** under [MIT License](LICENSE).
4. Do not use for bulk translation of copyrighted content or commercial scraping.

### Contributing

Issues and PRs welcome. Keep the extension lightweight — no heavy dependencies or backend services.

---

## 中文

### 这是什么

轻量 Chromium 扩展，提供：

1. **网页双语翻译** — 翻译当前视口可见内容，下滑自动续译
2. **YouTube 双语字幕** — 抓取字幕轨、预译缓存，播放时近零延迟显示
3. **站点屏蔽** — 指定网站永不翻译
4. **快捷键** — `Alt+A` 切换翻译 / 恢复原文

翻译引擎使用 **Google Translate 公开接口**（`client=gtx`），无自建后端、无账号体系。

> **命名说明：**「Local」指扩展在浏览器内运行、设置保存在本机；**翻译请求会联网访问 Google**，并非离线翻译引擎。

### 功能

| 功能 | 说明 |
|------|------|
| 视口翻译 | 先译可见区域，滚动后自动补译 |
| 双语 / 仅译文 | 可切换显示模式 |
| 译文样式 | 淡色 / 下划线 / 左侧色条 |
| 跳过代码块 | 默认不翻译 `<code>` / `<pre>` |
| 右键菜单 | 翻译选中文字 / 双语翻译整页 |
| YouTube 字幕 | 双段显示（上一句 + 当前句） |
| 站点屏蔽 | 按域名加入黑名单 |
| 批量合并 | 多条文本合并请求，带 LRU 缓存 |

### 安装

```bash
git clone https://github.com/xyl369/local-translate.git
```

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择克隆下来的 `local-translate` 文件夹

### 使用

1. 打开任意网页 → 点扩展图标 → **Translate page**
2. YouTube 视频（需有 CC 字幕轨）→ **Dual subtitles**
3. 不想翻译某站 → 勾选 **Never translate this site**

### 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存语言、样式、屏蔽站点列表 |
| `activeTab` | 对当前标签页注入翻译脚本 |
| `scripting` | 快捷键 / 右键菜单时补注入 |
| `contextMenus` | 右键翻译选中 / 整页 |
| `https://translate.googleapis.com/*` | 调用 Google 翻译接口 |
| `http(s)://*/*` | 在网页显示双语译文、处理 YouTube 字幕 |

扩展不收集用户数据，不上传浏览记录；仅将待译文本发送至 Google 翻译接口。

### 项目结构

约 3000 行 JavaScript，无构建步骤，无 npm 依赖。目录结构见上方 English 章节。

### 技术说明

- **Manifest V3**，兼容 Chrome / Edge / 其他 Chromium 内核浏览器
- 网页：语义块遍历 + 视口优先 + MutationObserver 增量补译
- YouTube：字幕轨 XML → 批量预译 → `requestAnimationFrame` 时间轴同步
- 翻译：多条合并请求，失败时逐条回退；内存 LRU 缓存 2000 条

### 免责声明

1. 通过 Google **非官方公开接口** 获取翻译，可能随时限流、变更或失效。
2. 使用须遵守 [Google 服务条款](https://policies.google.com/terms)；作者不对接口可用性或合规性作保证。
3. 本软件按「原样」提供，详见 [MIT License](LICENSE)。
4. 请勿用于侵犯版权内容的批量翻译或商业爬虫场景。

### 参与贡献

欢迎 Issue 与 PR。请保持扩展轻量，避免引入重型依赖或后端服务。

---

## License

[MIT](LICENSE) © 2026 xyl369
