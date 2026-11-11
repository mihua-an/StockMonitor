"use strict";
// The application variables a child inherits are a closed list (config/child_env_names.json). Every application-
// prefixed name the runtime code spells -- a quoted string or a JS `env.NAME` read -- must be classified: inherited,
// a config/var_layout.json location, a credential (granted, never inherited), or listed as not inherited with a
// reason. A new variable that nobody listed fails here instead of silently never reaching the child that reads it.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { childEnv, isSecretName, layoutNames } = require("../service/platform/js/child_env");
const names = require("../config/child_env_names.json");

const ROOT = path.join(__dirname, "..");
const DIRS = ["backend", "service", "api", "config", "health", "ui/main", "packaging", "native/market_runtime/src", "native/analysis_runtime/src"];
// The bundled interpreter's sitecustomize.py is written by this script (its text is in the script); the staged copy
// under packaging/python/ is a build output that exists only after staging, so it is not read.
const GENERATORS = ["scripts/tooling/stage_python_runtime.py"];
const BUILD_OUTPUTS = ["packaging/python", "packaging/vc_runtime"].map((dir) => path.join(ROOT, dir));
const EXTENSIONS = new Set([".py", ".js", ".cjs", ".mjs", ".rs", ".json", ".ps1"]);
const PREFIX = "(?:STOCK_MONITOR_|MOOMOO_|FUTU_|SHIOAJI_|SJ_|MARKET_DAEMON_|HISTORY_CACHE_)";
const QUOTED = new RegExp(`["'\`](${PREFIX}[A-Z0-9_]+)["'\`]`, "g");
const JS_ENV = new RegExp(`\\benv(?:\\??\\.|\\[["'])(${PREFIX}[A-Z0-9_]+)`, "g");

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The bundled interpreter's own packages and Rust build output are not this project's code.
      if (!["node_modules", "target", "site-packages", "__pycache__"].includes(entry.name) && !BUILD_OUTPUTS.includes(full)) yield* files(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

const seen = new Map();
const sources = [...DIRS.flatMap((dir) => [...files(path.join(ROOT, dir))]), ...GENERATORS.map((rel) => path.join(ROOT, rel))];
for (const file of sources) {
  if (file === path.join(ROOT, "config", "child_env_names.json")) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of [QUOTED, JS_ENV]) {
    for (const match of text.matchAll(pattern)) {
      if (!seen.has(match[1])) seen.set(match[1], path.relative(ROOT, file).replace(/\\/g, "/"));
    }
  }
}

const inherit = new Set(names.inherit);
const other = new Set(Object.keys(names.not_inherited));
const layout = new Set(layoutNames());
const unclassified = [...seen].filter(([name]) => !inherit.has(name) && !other.has(name) && !layout.has(name) && !isSecretName(name));
assert.deepEqual(unclassified.map(([name, file]) => `${name} (${file})`), [],
  "add each to config/child_env_names.json: inherit if a child process reads it, not_inherited with the reason otherwise");

for (const name of inherit) {
  assert.ok(seen.has(name), `${name} is listed as inherited but no code reads it any more`);
  assert.equal(isSecretName(name), false, `${name} looks like a credential: grant it to the role that needs it instead`);
  assert.equal(other.has(name), false, `${name} is in both lists`);
}
for (const [name, reason] of Object.entries(names.not_inherited)) assert.ok(String(reason).trim(), `${name} needs a reason`);

// The list is what reaches a child: a listed name passes, an unlisted name with an application prefix does not.
const parent = Object.fromEntries([...inherit].map((name) => [name, "1"]));
const env = childEnv({ ...parent, STOCK_MONITOR_UNLISTED_SETTING: "1", FUTU_SOMETHING_NEW: "1", STOCK_MONITOR_DEVTOOLS: "1" });
for (const name of inherit) assert.equal(env[name], "1", `${name} must reach the child`);
for (const name of ["STOCK_MONITOR_UNLISTED_SETTING", "FUTU_SOMETHING_NEW", "STOCK_MONITOR_DEVTOOLS"]) {
  assert.equal(env[name], undefined, `${name} is not on the list and must stay with the launcher`);
}
console.log(`child environment names contract passed (${inherit.size} inherited, ${seen.size} application names classified)`);
