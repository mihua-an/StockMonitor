"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Color preferences and window state were rewritten in place (a crash mid-write left a truncated
// file) and an unreadable file was silently replaced by the defaults.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = makeTempDir("ui-prefs-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createColorPreferenceStore } = require("../ui/main/color_preference_store.js");
const atomicFiles = require("../service/platform/js/atomic_files.js");
const { writeJsonAtomic } = atomicFiles;
// Window state goes through the shared atomic writer: desktop_windows.js binds it at require time, so it is wrapped
// before that module loads.
const atomicWrites = [];
atomicFiles.writeJsonAtomic = (file, value, ...rest) => { atomicWrites.push(file); return writeJsonAtomic(file, value, ...rest); };
const { createDesktopWindows } = require("../ui/main/desktop_windows.js");

const store = createColorPreferenceStore(root);
const saved = store.save({});
const files = fs.readdirSync(root, { recursive: true }).map(String);
const file = path.join(root, files.find((f) => f.endsWith("ui_color_preferences.json")));
assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), saved);
assert.ok(!fs.readdirSync(path.dirname(file)).some((n) => n.endsWith(".tmp")), "no temp file is left behind");

fs.writeFileSync(file, "{\"up\": \"#ff");   // truncated by a crash
const warn = console.warn; const warnings = []; console.warn = (l) => warnings.push(l);
try { assert.deepStrictEqual(store.load(), store.defaults()); } finally { console.warn = warn; }
const asides = () => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith("ui_color_preferences.json.corrupt-"));
assert.strictEqual(asides().length, 1, "the unreadable file is set aside, not silently lost");
assert.strictEqual(warnings.length, 1);
assert.ok(warnings[0].includes(path.join(path.dirname(file), asides()[0])), "the record names where it went");
// A second damaged file gets its own name: an earlier one is never in the way.
fs.writeFileSync(file, "{");
console.warn = (l) => warnings.push(l);
try { store.load(); } finally { console.warn = warn; }
assert.strictEqual(asides().length, 2);
assert.ok(!fs.existsSync(file));

const target = path.join(root, "window-state.json");
writeJsonAtomic(target, { width: 10 });
assert.deepStrictEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), { width: 10 });
const userData = path.join(root, "user-data");
fs.mkdirSync(userData);
const desktopWindows = createDesktopWindows({ app: { getPath: () => userData }, BrowserWindow: class {}, screen: {},
  uiMainDir: path.join(__dirname, "..", "ui", "main"), getProjectRoot: () => path.join(__dirname, ".."), connectSources: () => [] });
desktopWindows.setMainWindow({ isDestroyed: () => false, isMaximized: () => false, getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }) });
desktopWindows.saveWindowState();
const stateFile = path.join(userData, "window-state.json");
assert.deepStrictEqual(atomicWrites.slice(-1), [stateFile], "window state is written by the shared atomic writer, not the color store (R09-13)");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { x: 1, y: 2, width: 800, height: 600, isMaximized: false, adaptiveUiScaleVersion: 1 });
fs.rmSync(root, { recursive: true, force: true });
console.log("ui preferences atomic contract passed");
