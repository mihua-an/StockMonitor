"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The content-addressed renderer release cache is bounded -- the release in use and the newest few stay,
// older releases and abandoned staging trees go.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pruneRendererAssets } = require("../ui/main/renderer_assets");

const dir = makeTempDir("renderer-assets-");
try {
  const names = Array.from({ length: 6 }, (_, i) => String(i).repeat(16));
  names.forEach((name, i) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "index.html"), "x");
    const t = new Date(Date.UTC(2026, 9, 1 + i));
    fs.utimesSync(path.join(dir, name), t, t);
  });
  fs.mkdirSync(path.join(dir, ".prepare-old"));
  fs.utimesSync(path.join(dir, ".prepare-old"), new Date(2026, 8, 1), new Date(2026, 8, 1));
  fs.mkdirSync(path.join(dir, "not-a-release"));
  const inUse = path.join(dir, names[0]);   // the oldest, but a window shows it
  const removed = pruneRendererAssets(dir, { keep: [inUse], keepRecent: 3 }).sort();
  assert.deepEqual(removed, [".prepare-old", names[1], names[2]].sort());
  assert.ok(fs.existsSync(inUse), "the release a window shows is kept");
  for (const name of names.slice(3)) assert.ok(fs.existsSync(path.join(dir, name)), "the newest three are kept");
  assert.ok(fs.existsSync(path.join(dir, "not-a-release")), "anything that is not a release is left alone");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("renderer assets prune contract passed");
