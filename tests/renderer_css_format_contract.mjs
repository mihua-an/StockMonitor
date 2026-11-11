// The renderer stylesheets are written one declaration per line: no rule on a single line, no two declarations on
// one line -- a diff then shows the one property that changed, and a repeated property is visible. Keyframe steps are
// the exception (`0% { opacity: 0; }` reads as one frame).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = fileURLToPath(new URL("../ui/renderer/styles/", import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".css") ? [path] : [];
});

const semicolons = (line) => {
  let depth = 0, quote = "", count = 0;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === ";" && depth === 0) count += 1;
  }
  return count;
};

const problems = [];
for (const file of files(STYLES)) {
  const rel = relative(STYLES, file).replaceAll("\\", "/");
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  let depth = 0;
  let keyframesDepth = 0;
  css.split("\n").forEach((line, index) => {
    if (/@keyframes\b/.test(line)) keyframesDepth = depth + 1;
    const inKeyframes = keyframesDepth > 0;
    if (!inKeyframes) {
      if (/\{[^{}]*:[^{}]*\}/.test(line)) problems.push(`${rel}:${index + 1}: a rule on one line`);
      else if (semicolons(line) > 1) problems.push(`${rel}:${index + 1}: more than one declaration on a line`);
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (keyframesDepth && depth < keyframesDepth) keyframesDepth = 0;
  });
}
assert.deepEqual(problems.slice(0, 40), [], `${problems.length} formatting problems:\n${problems.slice(0, 40).join("\n")}`);
console.log("renderer css format contract passed");
