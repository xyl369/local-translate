const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../pdf-core.js");

function glyph(text, x, y, w, h) {
  return { text, x, y, w, h, fontSize: h };
}

test("pdf urls are files and web documents, not the extension viewer", () => {
  assert.equal(
    core.isPdfUrl("file:///Users/xiaoyi/Desktop/vmad/papers/02_knuth_2019.pdf"),
    true
  );
  assert.equal(core.isPdfUrl("https://example.com/papers/knuth.pdf?download=1"), true);
  assert.equal(core.isPdfUrl("https://example.com/paper.html"), false);
  assert.equal(core.isPdfUrl("chrome-extension://abc/pdf-viewer.html"), false);
  assert.equal(
    core.isPdfViewerUrl("chrome-extension://abc/pdf-viewer.html?src=file%3A%2F%2F%2Fa.pdf", "abc"),
    true
  );
  assert.equal(
    core.isPdfViewerUrl("chrome-extension://other/pdf-viewer.html", "abc"),
    false
  );
  assert.equal(
    core.pdfViewerSrc("chrome-extension://abc/pdf-viewer.html?src=https%3A%2F%2Fexample.com%2Fa.pdf"),
    "https://example.com/a.pdf"
  );
  assert.equal(core.pdfFileName("file:///tmp/02_knuth_2019.pdf"), "02_knuth_2019.pdf");
});

test("title lines join and affiliation marks stay off the author line", () => {
  const paragraphs = core.buildPageParagraphs(
    [
      glyph("Estimating Flight Characteristics of Anomalous", 76, 110, 387, 18),
      glyph("Unidentified Aerial Vehicles in the 2004", 76, 130, 325, 18),
      glyph("Nimitz Encounter", 76, 150, 146, 18),
      glyph("Kevin H. Knuth", 76, 186, 73, 10),
      glyph("1,2,", 152, 184, 11, 7),
      glyph(", Robert M. Powell", 177, 186, 85, 10)
    ],
    595
  );
  assert.deepEqual(
    paragraphs.map((item) => item.text),
    [
      "Estimating Flight Characteristics of Anomalous Unidentified Aerial Vehicles in the 2004 Nimitz Encounter",
      "Kevin H. Knuth, Robert M. Powell"
    ]
  );
  assert.equal(paragraphs.every((item) => item.skip === false), true);

  const fragmented = core.buildPageParagraphs(
    [
      glyph("∗", 163, 185.2, 4.5, 7.9),
      glyph("2", 265, 185.5, 3.8, 7.6),
      glyph("1,2,", 152, 185.5, 11.4, 7.6),
      glyph(", Robert M. Powell", 177, 186.7, 85, 10),
      glyph(", and Peter A. Reali", 278, 186.7, 87, 10),
      glyph("Kevin H. Knuth", 76, 186.7, 73, 10)
    ],
    595
  );
  assert.deepEqual(
    fragmented.map((item) => item.text),
    ["Kevin H. Knuth, Robert M. Powell, and Peter A. Reali"]
  );
});

test("two columns read left then right, and a line-break hyphen is joined", () => {
  const paragraphs = core.buildPageParagraphs(
    [
      glyph("Flight characteristics", 40, 20, 520, 16),
      glyph("Left column starts with the", 40, 50, 240, 12),
      glyph("observed track.", 40, 66, 140, 12),
      glyph("Right column starts with the", 340, 50, 240, 12),
      glyph("estimated character-", 340, 66, 220, 12),
      glyph("istics of the craft.", 340, 82, 160, 12)
    ],
    600
  );
  assert.deepEqual(
    paragraphs.map((item) => item.text),
    [
      "Flight characteristics",
      "Left column starts with the observed track.",
      "Right column starts with the estimated characteristics of the craft."
    ]
  );
});

test("formulas and page numbers are barriers, repeated margins are chrome", () => {
  assert.equal(core.shouldTranslateParagraph("a = v^2/r + (75 ± 3)"), false);
  assert.equal(core.shouldTranslateParagraph("dt √"), false);
  assert.equal(core.shouldTranslateParagraph("ax ti + xo"), false);
  assert.equal(core.shouldTranslateParagraph("11"), false);
  assert.equal(core.shouldTranslateParagraph("Abstract"), true);
  assert.equal(core.shouldTranslateParagraph("Results"), true);
  assert.equal(core.shouldTranslateParagraph("dt P(y, t | a, I) (2)"), false);
  assert.equal(
    core.shouldTranslateParagraph("where the symbol represents the prior information"),
    true
  );

  const prose = core.buildPageParagraphs(
    [
      glyph("Acceleration stays inside the model.", 40, 40, 360, 12),
      glyph("a = v^2/r + (75 ± 3)", 40, 70, 180, 12),
      glyph("The following sentence is separate.", 40, 100, 360, 12)
    ],
    595
  );
  assert.deepEqual(
    prose.filter((item) => !item.skip).map((item) => item.text),
    ["Acceleration stays inside the model.", "The following sentence is separate."]
  );

  const header = {
    text: "proceedings",
    x: 40,
    y: 12,
    w: 80,
    h: 12,
    fontSize: 12,
    skip: false
  };
  const pages = [
    { height: 800, paragraphs: [{ ...header }] },
    { height: 800, paragraphs: [{ ...header, y: 14 }] }
  ];
  core.markRepeatedChrome(pages);
  assert.equal(pages[0].paragraphs[0].skip, true);
  assert.equal(pages[1].paragraphs[0].skip, true);

  const running = (n) => ({
    text: `Proceedings 2019, 33, 26 ${n} of 11`,
    x: 40,
    y: 12,
    w: 220,
    h: 10,
    fontSize: 10,
    skip: false
  });
  const numbered = [
    { height: 842, paragraphs: [running(2)] },
    { height: 842, paragraphs: [running(3)] }
  ];
  core.markRepeatedChrome(numbered);
  assert.equal(numbered[0].paragraphs[0].skip, true);
  assert.equal(numbered[1].paragraphs[0].skip, true);
});

test("pdf.js text items use the viewport baseline, not the PDF origin", () => {
  const viewport = { transform: [1, 0, 0, -1, 0, 841.89] };
  const glyphs = core.glyphsFromPdfItems(
    [
      {
        str: "proceedings",
        width: 76.59,
        height: 15.95,
        transform: [15.95, 0, 0, 15.95, 115.77, 771.33]
      }
    ],
    viewport
  );
  assert.equal(glyphs.length, 1);
  assert.ok(Math.abs(glyphs[0].x - 115.77) < 0.01);
  assert.ok(Math.abs(glyphs[0].y - (70.56 - 15.95)) < 0.02);
  assert.ok(Math.abs(glyphs[0].w - 76.59) < 0.01);
});

test("long paragraphs split on a sentence before the engine limit", () => {
  const sentence = "The craft accelerated. ";
  const text = sentence.repeat(80).trim();
  const parts = core.splitForTranslate(text, 1400);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1400));
  assert.equal(parts.join(" "), text);
});

test("pdf routing is wired through the service worker and the popup", () => {
  const root = path.resolve(__dirname, "..");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const popup = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
  assert.match(background, /importScripts\("pdf-core\.js"\)/);
  assert.match(background, /OPEN_PDF_VIEWER/);
  assert.match(background, /PDF_RESTORE/);
  assert.match(popup, /isPdfUrl/);
  assert.equal(fs.existsSync(path.join(root, "pdf-viewer.html")), true);
  const viewer = fs.readFileSync(path.join(root, "pdf-viewer.js"), "utf8");
  assert.match(viewer, /TRANSLATE_BATCH/);
  assert.match(viewer, /glyphsFromPdfItems/);
  assert.match(manifest, /"version": "3\.11\.1"/);
});
