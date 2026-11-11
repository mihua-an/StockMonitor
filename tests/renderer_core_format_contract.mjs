import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// These core files were whole methods and classes on single lines (review R02-13): queries, state changes, DOM
// writes and early returns could not be told apart in a diff, a stack trace or blame. Each is now one main statement
// per line; this keeps them so. A file joins the list once it is reformatted.
const FORMATTED = [
  "core/trend/interaction_controller.js",
  "core/trend/trend_chart_manager.js",
  "core/trend/adapters.js",
  "core/components/trade_flow_component.js",
];
const MAX_LINE = 160;
const STRINGS = /`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

for (const file of FORMATTED) {
  const lines = readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    assert.ok(line.length <= MAX_LINE, `${where} is ${line.length} characters (at most ${MAX_LINE})`);
    const code = line.replace(STRINGS, '""').replace(/\/\/.*$/, "").replace(/\bfor\s*\([^)]*\)/g, "for()");
    // A block's last statement before its brace (`=> { x = y; }`) is that block's one statement, not a second one.
    const statements = code.replace(/;\s*\}/g, " }").split(";").length - 1;
    assert.ok(statements <= 1, `${where} holds ${statements} statements: ${line.trim()}`);
  });
}
console.log(`renderer core format contract passed (${FORMATTED.length} files)`);
