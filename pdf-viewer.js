import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";

const PDF = globalThis.__LT_PDF_CORE__;
const $ = (id) => document.getElementById(id);

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const COPY = {
  en: {
    brand: "Local Translate",
    restore: "Restore original",
    hint: "English and Chinese sit side by side. Switch to Chinese only from the toolbar.",
    modeBilingual: "English + Chinese",
    modeZh: "Chinese only",
    loading: "Reading PDF…",
    laying: "Reading the text layer…",
    translating: "Page {page} · {done}/{total}",
    done: "Translated",
    empty: "This PDF has no selectable text layer. Scanned pages need OCR, which this extension does not do.",
    fileDenied:
      "This local file could not be read. On chrome://extensions, turn on Allow access to file URLs for Local Translate, then retry. Or drop the PDF here.",
    httpFailed: "The PDF could not be downloaded. Drop the file here instead.",
    retry: "Retry",
    drop: "Drop a PDF here, or choose a file.",
    choose: "Choose PDF",
    page: "Page {n}",
    failed: "Translation failed",
    again: "Retry this paragraph",
    pending: "Translating…",
    progress: "{done} / {total} pages"
  },
  zh: {
    brand: "本地翻译",
    restore: "恢复原文",
    hint: "中英对照并排。要只看译文，点工具栏的「只看中文」。",
    modeBilingual: "中英对照",
    modeZh: "只看中文",
    loading: "正在读取 PDF…",
    laying: "正在读取文字层…",
    translating: "第 {page} 页 · {done}/{total}",
    done: "已翻译",
    empty: "这份 PDF 没有可选中的文字层。扫描件需要 OCR，当前版本不做。",
    fileDenied:
      "读不到这个本地文件。到 chrome://extensions，打开本扩展的「允许访问文件网址」，然后点重试。也可以把 PDF 拖到这里。",
    httpFailed: "PDF 下载失败。可以把文件拖到这里。",
    retry: "重试",
    drop: "把 PDF 拖到这里，或选择文件。",
    choose: "选择 PDF",
    page: "第 {n} 页",
    failed: "翻译失败",
    again: "重试这段",
    pending: "翻译中…",
    progress: "{done} / {total} 页"
  }
};

const DEFAULTS = {
  uiLang: "",
  targetLang: "zh-CN",
  displayMode: "bilingual",
  translationStyle: "muted"
};

let uiLang = "zh";
let settings = { ...DEFAULTS };
let sourceUrl = "";
let pdfDoc = null;
let pages = [];
let generation = 0;
let showing = true;
const waiting = [];
let pumping = false;
let pumpToken = 0;

const params = new URLSearchParams(location.search);
sourceUrl = params.get("src") || "";

const port = chrome.runtime.connect({ name: "lt-pdf" });
port.onMessage.addListener((message) => {
  if (message?.cmd === "restore") restoreOriginal();
  if (message?.cmd === "toggle") {
    showing = !showing;
    document.body.classList.toggle("hide-notes", !showing);
    if (showing) queueVisible(true);
  }
  if (message?.cmd === "translate") {
    showing = true;
    document.body.classList.remove("hide-notes");
    queueVisible(true);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.uiLang) {
    uiLang = changes.uiLang.newValue === "en" ? "en" : "zh";
    applyChromeCopy();
    paintAll();
  }
  if (changes.displayMode) settings.displayMode = changes.displayMode.newValue || settings.displayMode;
  if (changes.translationStyle) {
    settings.translationStyle = changes.translationStyle.newValue || settings.translationStyle;
  }
  applyMode();
  if (changes.targetLang && changes.targetLang.newValue && changes.targetLang.newValue !== settings.targetLang) {
    settings.targetLang = changes.targetLang.newValue;
    retranslate();
    return;
  }
  if (changes.displayMode || changes.translationStyle || changes.uiLang) paintAll();
});

$("restore").addEventListener("click", restoreOriginal);
$("choose").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => {
  const file = $("file").files && $("file").files[0];
  if (file) readDroppedFile(file);
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  $("drop").hidden = false;
  $("drop").classList.add("over");
});
document.addEventListener("dragleave", () => $("drop").classList.remove("over"));
document.addEventListener("drop", (event) => {
  event.preventDefault();
  $("drop").classList.remove("over");
  const file = event.dataTransfer?.files?.[0];
  if (file) readDroppedFile(file);
});

window.addEventListener("resize", () => {
  clearTimeout(window.__ltPdfResize);
  window.__ltPdfResize = setTimeout(() => rerenderVisible(), 150);
});

init().catch((err) => showBanner(String(err?.message || err)));

function t(key, vars) {
  let text = (COPY[uiLang] || COPY.en)[key] || COPY.en[key] || key;
  if (vars) {
    for (const name of Object.keys(vars)) text = text.replace(`{${name}}`, vars[name]);
  }
  return text;
}

function applyChromeCopy() {
  document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  $("brand").textContent = t("brand");
  $("restore").textContent = t("restore");
  $("modeBilingual").textContent = t("modeBilingual");
  $("modeZh").textContent = t("modeZh");
  $("hint").textContent = t("hint");
  $("dropText").textContent = t("drop");
  $("choose").textContent = t("choose");
  $("restore").hidden = !sourceUrl;
  document.title = t("brand");
}

function applyMode() {
  const bilingual = settings.displayMode !== "translation-only";
  document.body.dataset.mode = bilingual ? "bilingual" : "translation-only";
  document.body.dataset.style = settings.translationStyle || "muted";
  $("modeBilingual").setAttribute("aria-pressed", bilingual ? "true" : "false");
  $("modeZh").setAttribute("aria-pressed", bilingual ? "false" : "true");
}

function setDisplayMode(mode) {
  settings.displayMode = mode === "translation-only" ? "translation-only" : "bilingual";
  applyMode();
  paintAll();
  chrome.storage.local.set({ displayMode: settings.displayMode });
}

function setStatus(text) {
  $("status").textContent = text;
}

function showBanner(text) {
  const banner = $("banner");
  banner.hidden = !text;
  banner.textContent = text || "";
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (data) => resolve({ ...DEFAULTS, ...data }));
  });
}

async function init() {
  settings = await loadSettings();
  uiLang = settings.uiLang || (/^zh/i.test(navigator.language || "") ? "zh" : "en");
  if (uiLang !== "en") uiLang = "zh";
  applyChromeCopy();
  applyMode();
  $("modeBilingual").addEventListener("click", () => setDisplayMode("bilingual"));
  $("modeZh").addEventListener("click", () => setDisplayMode("translation-only"));
  $("docName").textContent = sourceUrl ? PDF.pdfFileName(sourceUrl) : "";
  if (!sourceUrl) {
    showDrop(t("drop"));
    setStatus(t("drop"));
    return;
  }
  setStatus(t("loading"));
  try {
    const bytes = await fetchPdf(sourceUrl);
    await openDocument(bytes);
  } catch (err) {
    const fileUrl = /^file:/i.test(sourceUrl);
    showDrop(fileUrl ? t("fileDenied") : t("httpFailed"));
    setStatus(t("failed"));
    console.warn(err);
  }
}

async function fetchPdf(url) {
  if (!PDF.isPdfUrl(url)) throw new Error("Not a PDF");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

function showDrop(message) {
  $("drop").hidden = false;
  $("dropText").textContent = message || t("drop");
}

function readDroppedFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    sourceUrl = "";
    $("docName").textContent = file.name || "document.pdf";
    $("restore").hidden = true;
    $("drop").hidden = true;
    const bytes = new Uint8Array(reader.result);
    openDocument(bytes).catch((err) => showBanner(String(err?.message || err)));
  };
  reader.readAsArrayBuffer(file);
}

function restoreOriginal() {
  if (!sourceUrl) return;
  chrome.runtime.sendMessage({ type: "PDF_RESTORE", url: sourceUrl });
}

async function openDocument(data) {
  generation += 1;
  pumpToken += 1;
  const gen = generation;
  waiting.length = 0;
  pumping = false;
  pages = [];
  $("pages").replaceChildren();
  showBanner("");
  $("drop").hidden = true;
  setStatus(t("laying"));
  if (pdfDoc?.destroy) {
    try {
      await pdfDoc.destroy();
    } catch {
      /* ignore */
    }
  }
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise;
  if (gen !== generation) {
    doc.destroy?.();
    return;
  }
  pdfDoc = doc;
  const first = await loadPdfPage(doc, 1);
  if (gen !== generation) return;
  pages.push(first);
  mountPage(first);
  renderPage(first).catch(() => {});
  if (!first.paragraphs.some((paragraph) => !paragraph.skip)) {
    showBanner(t("empty"));
  }
  queuePage(first, true);

  for (let number = 2; number <= doc.numPages; number += 1) {
    if (gen !== generation) return;
    const page = await loadPdfPage(doc, number);
    if (gen !== generation) return;
    pages.push(page);
    mountPage(page);
    if (number % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  PDF.markRepeatedChrome(pages);
  paintAll();
  const prose = pages.reduce(
    (count, page) => count + page.paragraphs.filter((paragraph) => !paragraph.skip).length,
    0
  );
  if (!prose) {
    showBanner(t("empty"));
    setStatus(t("empty"));
    return;
  }
  watchPages();
}

async function loadPdfPage(doc, number) {
  const pdfPage = await doc.getPage(number);
  const base = pdfPage.getViewport({ scale: 1 });
  const content = await pdfPage.getTextContent();
  const glyphs = PDF.glyphsFromPdfItems(content.items, base);
  const paragraphs = PDF.buildPageParagraphs(glyphs, base.width).map((paragraph) => ({
    ...paragraph,
    translation: "",
    failed: false
  }));
  return {
    pdfPage,
    number,
    width: base.width,
    height: base.height,
    paragraphs,
    queued: false,
    busy: false,
    rendered: false
  };
}

function mountPage(page) {
  const section = document.createElement("section");
  section.className = "page";
  section.dataset.index = String(pages.length - 1);
  const label = document.createElement("p");
  label.className = "page-label";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const canvas = document.createElement("canvas");
  sheet.appendChild(canvas);
  const transcript = document.createElement("div");
  transcript.className = "transcript";
  section.append(label, sheet, transcript);
  $("pages").appendChild(section);
  page.section = section;
  page.sheet = sheet;
  page.canvas = canvas;
  page.transcript = transcript;
  page.label = label;
  layoutFrame(page);
}

function watchPages() {
  if (window.__ltPdfObserver) window.__ltPdfObserver.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = pages[Number(entry.target.dataset.index)];
        if (!page) continue;
        if (entry.isIntersecting) {
          const rect = entry.boundingClientRect;
          const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
          renderPage(page).catch(() => {});
          queuePage(page, onScreen);
        } else if (page.rendered) {
          releasePage(page);
        }
      }
    },
    { root: null, rootMargin: "900px 0px" }
  );
  window.__ltPdfObserver = observer;
  for (const page of pages) observer.observe(page.section);
}

function columnWidth() {
  const stage = Math.max(320, $("stage").clientWidth || 800);
  if (stage < 880) return stage - 24;
  return Math.min(760, Math.floor((stage - 40) * 0.62));
}

function fitScale(page) {
  if (!page?.width) return 1;
  return columnWidth() / page.width;
}

function layoutFrame(page) {
  const scale = fitScale(page);
  const width = page.width * scale;
  if (page.sheet) page.sheet.style.width = `${width}px`;
  page.canvas.style.width = `${width}px`;
  page.canvas.style.height = `${page.height * scale}px`;
}

async function renderPage(page) {
  const scale = fitScale(page);
  layoutFrame(page);
  if (page.rendered && Math.abs(scale - (page.scale || 0)) < 0.02) return;
  const viewport = page.pdfPage.getViewport({ scale });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = page.canvas;
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  page.renderTask?.cancel?.();
  const renderParams = { canvasContext: context, viewport };
  if (outputScale !== 1) renderParams.transform = [outputScale, 0, 0, outputScale, 0, 0];
  const task = page.pdfPage.render(renderParams);
  page.renderTask = task;
  try {
    await task.promise;
    page.rendered = true;
    page.scale = scale;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  }
}

function releasePage(page) {
  page.renderTask?.cancel?.();
  page.canvas.width = 0;
  page.canvas.height = 0;
  page.rendered = false;
}

function rerenderVisible() {
  for (const page of pages) {
    layoutFrame(page);
    const rect = page.section.getBoundingClientRect();
    if (rect.bottom > -900 && rect.top < window.innerHeight + 900) {
      page.rendered = false;
      renderPage(page).catch(() => {});
    }
  }
}

function queueVisible(front) {
  const visible = [];
  const near = [];
  for (const page of pages) {
    const rect = page.section.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) visible.push(page);
    else if (rect.bottom > -900 && rect.top < window.innerHeight + 900) near.push(page);
  }
  const ordered = front ? visible.concat(near) : near.concat(visible);
  for (const page of ordered) queuePage(page, front);
  if (!ordered.length && pages[0]) queuePage(pages[0], true);
}

function queuePage(page, urgent) {
  if (page.busy) return;
  if (page.paragraphs.every((paragraph) => paragraph.skip || paragraph.translation || paragraph.failed)) {
    paintPage(page);
    updateProgress();
    return;
  }
  page.urgent = !!urgent;
  if (!page.queued) {
    page.queued = true;
    waiting.push(page);
  }
  waiting.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.number - b.number);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const token = ++pumpToken;
  const gen = generation;
  try {
    while (waiting.length && gen === generation && token === pumpToken) {
      const page = waiting.shift();
      page.queued = false;
      await translatePage(page, gen);
    }
  } finally {
    if (token !== pumpToken) return;
    pumping = false;
    if (waiting.length && gen === generation) pump();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function translateSlice(slice, gen) {
  const jobs = [];
  for (const paragraph of slice) {
    paragraph.failed = false;
    for (const chunk of PDF.splitForTranslate(paragraph.text)) jobs.push({ paragraph, chunk });
  }
  let response;
  try {
    response = await withTimeout(
      chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: jobs.map((job) => job.chunk),
        targetLang: settings.targetLang
      }),
      12000
    );
  } catch {
    response = { ok: false };
  }
  if (gen !== generation) return false;
  const results = response?.ok && Array.isArray(response.results) ? response.results : null;
  const grouped = new Map();
  jobs.forEach((job, index) => {
    const list = grouped.get(job.paragraph) || [];
    list.push(results ? results[index] || "" : "");
    grouped.set(job.paragraph, list);
  });
  let ok = true;
  for (const paragraph of slice) {
    const parts = grouped.get(paragraph) || [];
    if (!parts.length || parts.some((part) => !String(part || "").trim())) {
      paragraph.failed = true;
      paragraph.translation = "";
      ok = false;
    } else {
      paragraph.failed = false;
      paragraph.translation = parts.join("");
    }
  }
  return ok;
}

async function translatePage(page, gen) {
  page.busy = true;
  paintPage(page);
  updateProgress();
  try {
    while (gen === generation && showing) {
      const pending = page.paragraphs.filter(
        (paragraph) => !paragraph.skip && !paragraph.translation && !paragraph.failed
      );
      if (!pending.length) break;
      const slice = [];
      let chars = 0;
      for (const paragraph of pending) {
        if (slice.length >= 3 || (slice.length && chars + paragraph.text.length > 900)) break;
        slice.push(paragraph);
        chars += paragraph.text.length;
      }
      const ok = await translateSlice(slice, gen);
      if (gen !== generation) return;
      paintPage(page);
      updateProgress();
      if (!ok) break;
    }
  } finally {
    if (gen === generation) {
      page.busy = false;
      paintPage(page);
      updateProgress();
    }
  }
}

function retranslate() {
  generation += 1;
  pumpToken += 1;
  waiting.length = 0;
  pumping = false;
  for (const page of pages) {
    page.queued = false;
    for (const paragraph of page.paragraphs) {
      paragraph.translation = "";
      paragraph.failed = false;
    }
    paintPage(page);
  }
  queueVisible(true);
}

function translatedPages() {
  return pages.filter((page) => {
    const prose = page.paragraphs.filter((paragraph) => !paragraph.skip);
    return prose.length > 0 && prose.every((paragraph) => paragraph.translation || paragraph.failed);
  }).length;
}

function updateProgress() {
  if (!pages.length) return;
  const active = pages.find((page) => page.busy) || pages.find((page) => page.urgent && page.queued);
  if (active) {
    const prose = active.paragraphs.filter((paragraph) => !paragraph.skip);
    const done = prose.filter((paragraph) => paragraph.translation || paragraph.failed).length;
    setStatus(t("translating", { page: active.number, done, total: prose.length }));
    return;
  }
  const done = translatedPages();
  if (done >= pages.length) setStatus(t("done"));
  else setStatus(t("progress", { done, total: pages.length }));
}

function paintAll() {
  applyMode();
  for (const page of pages) paintPage(page);
}

function paintPage(page) {
  page.label.textContent = t("page", { n: page.number });
  const host = page.transcript;
  host.dataset.mode = settings.displayMode === "translation-only" ? "zh" : "bilingual";
  host.replaceChildren();
  if (!showing) return;
  let pendingShown = 0;
  for (const paragraph of page.paragraphs) {
    if (paragraph.skip) continue;
    const block = document.createElement("article");
    block.className = "para";
    if (settings.displayMode !== "translation-only") {
      const source = document.createElement("p");
      source.className = "src";
      source.textContent = paragraph.text;
      block.appendChild(source);
    }
    const dest = document.createElement("p");
    dest.className = "dst";
    if (paragraph.translation) dest.textContent = paragraph.translation;
    else if (!paragraph.failed && !(page.busy && pendingShown < 1)) {
      if (settings.displayMode === "translation-only") continue;
      host.appendChild(block);
      continue;
    } else if (paragraph.failed) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "retry";
      button.textContent = t("again");
      button.addEventListener("click", () => {
        paragraph.failed = false;
        paragraph.translation = "";
        page.queued = false;
        queuePage(page, true);
      });
      dest.append(button);
    } else {
      dest.textContent = t("pending");
      pendingShown += 1;
    }
    block.appendChild(dest);
    host.appendChild(block);
  }
}
