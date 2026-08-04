// UI language dictionary for the popup itself (independent from the
// "Target language" a page gets translated into).
const I18N = {
  en: {
    appName: "Local Translate",
    appSubtitle: "Viewport translate · auto-fill on scroll",
    langToggle: "中文",
    ready: "Ready",
    engineOk: "Engine: Google Translate",

    translatePage: "Translate page",
    restoreOriginal: "Restore original",
    dualSubtitles: "Dual subtitles",
    turnOffSubtitles: "Turn off subtitles",

    targetLanguage: "Target language",
    lang_zhCN: "Simplified Chinese",
    lang_zhTW: "Traditional Chinese",
    lang_en: "English",
    lang_ja: "Japanese",
    lang_ko: "Korean",
    lang_fr: "French",
    lang_de: "German",
    lang_es: "Spanish",
    lang_ru: "Russian",
    lang_pt: "Portuguese",
    lang_vi: "Vietnamese",
    lang_th: "Thai",

    displayMode: "Display mode",
    mode_bilingual: "Bilingual (recommended)",
    mode_translationOnly: "Translation only",

    translationStyle: "Translation style",
    style_muted: "Muted follow",
    style_underline: "Underline",
    style_box: "Left accent bar",

    autoTranslate: "Auto-translate on page load",
    neverTranslateSite: "Never translate this site",
    neverTranslateSiteHost: "Never translate this site ({host})",
    videoSubsAuto: "YouTube auto dual subtitles",
    skipCode: "Skip code blocks",

    footer: "Translate page = visible area; scroll for more · turn on CC for video subs",

    saved: "Saved",
    blocked: "Blocked",
    cannotIdentifySite: "Cannot identify site",
    unblocked: "Unblocked",
    hostBlocked: "{host} blocked",
    translatingViewport: "Translating viewport…",
    uncheckBlockFirst: "Uncheck Never translate this site first",
    translatedCount: "Translated {count} visible · scroll for more",
    enabled: "Enabled",
    failed: "Failed",
    starting: "Starting…",
    liveSyncOn: "Live sync on",
    subtitlesOff: "Subtitles off",
    cannotTranslatePage: "This page cannot be translated",
    restored: "Restored",
    translating: "Translating…",
    translatedScroll: "Translated · scroll for more",

    engineNeverHint: "Never translate this site · uncheck to restore",
    engineViewportOnly: "Visible area only; auto-fills on scroll",
    engineAutoScroll: "Scroll-loaded content translates automatically",
    engineTurnOnCC: "Turn on CC; scroll comments with Translate page",
    injectionTimeout: "Injection timeout",
    pageResponseTimeout: "Page response timeout",
    translationFailedDefault: "Translation failed",
    startFailedDefault: "Failed to start"
  },
  zh: {
    appName: "本地翻译",
    appSubtitle: "可视区翻译 · 滚动自动加载",
    langToggle: "EN",
    ready: "就绪",
    engineOk: "引擎：Google 翻译",

    translatePage: "翻译页面",
    restoreOriginal: "恢复原文",
    dualSubtitles: "双语字幕",
    turnOffSubtitles: "关闭字幕",

    targetLanguage: "目标语言",
    lang_zhCN: "简体中文",
    lang_zhTW: "繁体中文",
    lang_en: "英语",
    lang_ja: "日语",
    lang_ko: "韩语",
    lang_fr: "法语",
    lang_de: "德语",
    lang_es: "西班牙语",
    lang_ru: "俄语",
    lang_pt: "葡萄牙语",
    lang_vi: "越南语",
    lang_th: "泰语",

    displayMode: "显示模式",
    mode_bilingual: "双语（推荐）",
    mode_translationOnly: "仅译文",

    translationStyle: "翻译样式",
    style_muted: "灰度跟随",
    style_underline: "下划线",
    style_box: "左侧强调条",

    autoTranslate: "打开页面自动翻译",
    neverTranslateSite: "此网站从不翻译",
    neverTranslateSiteHost: "此网站从不翻译（{host}）",
    videoSubsAuto: "YouTube 自动双语字幕",
    skipCode: "跳过代码块",

    footer: "翻译页面 = 可见区域；滚动加载更多 · 视频字幕请开启 CC",

    saved: "已保存",
    blocked: "已屏蔽",
    cannotIdentifySite: "无法识别当前网站",
    unblocked: "已取消屏蔽",
    hostBlocked: "{host} 已屏蔽",
    translatingViewport: "正在翻译可视区域…",
    uncheckBlockFirst: "请先取消勾选“此网站从不翻译”",
    translatedCount: "已翻译 {count} 处可见内容 · 滚动加载更多",
    enabled: "已启用",
    failed: "失败",
    starting: "启动中…",
    liveSyncOn: "实时同步已开启",
    subtitlesOff: "字幕已关闭",
    cannotTranslatePage: "此页面无法翻译",
    restored: "已恢复原文",
    translating: "翻译中…",
    translatedScroll: "已翻译 · 滚动加载更多",

    engineNeverHint: "此网站从不翻译 · 取消勾选可恢复",
    engineViewportOnly: "仅翻译可见区域；滚动自动加载",
    engineAutoScroll: "滚动加载的内容会自动翻译",
    engineTurnOnCC: "请开启 CC 字幕；评论区用“翻译页面”滚动加载",
    injectionTimeout: "注入超时",
    pageResponseTimeout: "页面响应超时",
    translationFailedDefault: "翻译失败",
    startFailedDefault: "启动失败"
  }
};

let uiLang = "en";

function t(key, vars) {
  const dict = I18N[uiLang] || I18N.en;
  let s = dict[key] ?? I18N.en[key] ?? key;
  if (vars) {
    for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  }
  return s;
}

function detectDefaultUiLang() {
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}

// Swap the static text of every element marked with data-i18n / data-i18n-html.
function applyStaticI18n() {
  document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
}
