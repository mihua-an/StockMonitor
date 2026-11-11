// Stylesheet hygiene: no empty rule or @media block (a block that styles nothing reads as if it did), and no @media
// list whose conditions are the same kind of bound twice (one of them always contains the other).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = fileURLToPath(new URL("../ui/renderer/styles/", import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".css") ? [path] : [];
});

const problems = [];
for (const file of files(STYLES)) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rel = relative(STYLES, file).replaceAll("\\", "/");
  const lineOf = (index) => css.slice(0, index).split("\n").length;
  for (const match of css.matchAll(/([^{};]+)\{\s*\}/g)) problems.push(`${rel}:${lineOf(match.index)}: empty block "${match[1].trim()}"`);
  for (const match of css.matchAll(/@media([^{]+)\{/g)) {
    const bounds = [...match[1].matchAll(/\((min|max)-(width|height)\s*:/g)].map(([, edge, axis]) => `${edge}-${axis}`);
    const queries = match[1].split(",");
    if (queries.length > 1 && queries.every((query) => /\((min|max)-(width|height)\s*:[^)]*\)\s*$/.test(query.trim()))
      && new Set(bounds).size < bounds.length) {
      problems.push(`${rel}:${lineOf(match.index)}: @media${match[1]} lists the same bound twice`);
    }
  }
}
assert.deepEqual(problems, [], problems.join("\n"));
console.log("renderer css block hygiene contract passed");
