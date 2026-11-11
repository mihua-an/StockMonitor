import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// No hover hints in the renderer (user 10-20, 11-03 "不需要任何提示"): nothing is said only while the mouse rests on
// it -- not an icon button's name (aria-label carries it for screen readers), not how to use a control, not data or
// program detail, not why a control is disabled. No ⓘ icons either.
const root = fileURLToPath(new URL("../ui/renderer/", import.meta.url));

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "vendor" ? [] : files(full);
    return /\.(js|html|css)$/.test(name) ? [full] : [];
  });
}

const HINT = [
  /(?<![\w-])title="/,                           // markup: title="..." (not data-component-title)
  /(?<![\w-])title=\$\{/,                        // markup: title=${...}
  /(?<!document)\.title\s*=(?!=)/,               // node.title = ...
  /setAttribute\(\s*["']title["']/,              // node.setAttribute("title", ...)
  /<title>(?![^<]*<\/title>\s*$)/,               // an SVG <title> drawn from script
  /settings-info\b/,                             // the ⓘ icon
];

const found = [];
for (const file of files(root)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    // A page's own <title> in its <head> is the window title, not a hover hint.
    if (/^\s*<title>[^<]*<\/title>\s*$/.test(line)) return;
    if (/\bthis\.title\s*=/.test(line)) return;   // a component's own name property
    if (HINT.some((pattern) => pattern.test(line))) found.push(`${rel}:${index + 1}: ${line.trim().slice(0, 140)}`);
  });
}
assert.deepEqual(found, [], `hover hints are not allowed (user 10-20, 11-03):\n${found.join("\n")}`);

// The technical-analysis » button stays; only its hint went (user 10-20).
const ta = readFileSync(join(root, "js/features/realtime/technical_candles.js"), "utf8");
assert.match(ta, /<button type="button" class="technical-analysis-latest" data-role="ta-latest" aria-label="回到最新" hidden>»<\/button>/);
console.log("renderer no hover hints contract passed");
