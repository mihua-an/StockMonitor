// 設定 navigation: every category button opens its own panel. showSettingsSection() sends a name missing from
// SETTINGS_SECTIONS back to 顯示, so a button added to the page without it cannot be opened (資金 was).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("ui/renderer/pages/settings.html");
const script = read("ui/renderer/js/pages/settings.js");

const buttons = [...page.matchAll(/data-settings-section="([^"]+)"/g)].map((m) => m[1]);
const panels = [...page.matchAll(/data-settings-panel="([^"]+)"/g)].map((m) => m[1]);
const listed = JSON.parse(script.match(/const SETTINGS_SECTIONS = (\[[^\]]*\]);/)[1]);

assert.ok(buttons.includes("capital"), "資金 is a category");
assert.deepEqual([...buttons].sort(), [...listed].sort(), "SETTINGS_SECTIONS lists exactly the page's category buttons");
assert.deepEqual([...panels].sort(), [...buttons].sort(), "each category button has one panel");
console.log("renderer settings sections contract passed");
