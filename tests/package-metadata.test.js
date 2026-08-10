const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"));
}

test("package metadata stays aligned with the extension and has no runtime dependency", () => {
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");
  assert.equal(pkg.version, manifest.version);
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.match(pkg.devDependencies["playwright-core"], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.scripts.test, "node --test tests/*.test.js");
  assert.equal(pkg.scripts["test:e2e"], "node tests/youtube-runtime.e2e.cjs");
});
