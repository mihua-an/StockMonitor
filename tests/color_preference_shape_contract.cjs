const { makeTempDir } = require("./support/temp_dirs.cjs");
// The color preference file has one shape: the three color keys. The first color setting's {"scheme": ...} file is
// refused with a warning (defaults apply) and never rewritten or reinterpreted.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = makeTempDir("color-pref-");
process.env.STOCK_MONITOR_VAR_ROOT = tmp;
const { createColorPreferenceStore, DEFAULT_COLORS } = require("../ui/main/color_preference_store.js");
const { resolveVarPaths } = require("../config/js/var_paths.js");

const projectRoot = path.resolve(__dirname, "..");
const file = path.join(resolveVarPaths({ projectRoot, env: process.env }).data, "preferences", "ui_color_preferences.json");
const store = createColorPreferenceStore(projectRoot);
const quiet = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
try {
  assert.deepEqual(store.load(), DEFAULT_COLORS, "never saved: the defaults");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, JSON.stringify({ scheme: "green-up" }));
  assert.deepEqual(store.load(), DEFAULT_COLORS, "an old scheme file is refused: the defaults");
  assert.ok(warnings.some((line) => line.includes("not the current color shape")), "the refusal is logged");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { scheme: "green-up" }, "the refused file is not rewritten");

  const saved = store.save({ priceUpColor: "#00993d", priceDownColor: "#e11919", priceFlatColor: "#ffffff" });
  assert.deepEqual(store.load(), saved, "the current shape is read back as saved");
} finally {
  console.warn = quiet;
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("color preference shape contract ok");
