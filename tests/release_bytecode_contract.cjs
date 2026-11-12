"use strict";

// The installer ships compiled bytecode for every Python tree it ships (scripts/tooling/compile_bytecode.cjs, the
// electron-builder afterPack): a tree added to extraResources without being compiled would be compiled again by each
// service on an installed App's first start.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const { TREES } = require(path.join(root, "scripts", "tooling", "compile_bytecode.cjs"));

assert.equal(pkg.build.afterPack, "scripts/tooling/compile_bytecode.cjs", "the afterPack hook compiles the shipped Python");

const runtimePrefix = "app-runtime/";
const shippedPython = pkg.build.extraResources
  .filter((entry) => String(entry.to || "").startsWith(runtimePrefix))
  .filter((entry) => entry.from.endsWith(".py") || (entry.filter || []).some((glob) => glob.includes("*.py") || glob === "**/*"))
  .map((entry) => entry.to.slice(runtimePrefix.length));
const compiled = new Set(TREES.map((tree) => tree.split(path.sep).join("/")));
for (const tree of shippedPython) {
  const covered = [...compiled].some((c) => c === tree || c.startsWith(`${tree}/`));
  assert.ok(covered, `${tree} ships Python but compile_bytecode.cjs does not compile it`);
}
assert.ok(compiled.has("python/Lib/site-packages"), "the bundled packages are compiled too");
console.log("release bytecode contract passed");
