// Every design token in tokens.css is read somewhere: through var() in a stylesheet, setProperty() / themeColor() /
// a "--name" literal in the renderer's scripts or markup, or by another token. A token nobody reads is an option that
// does nothing and only widens what has to be maintained. Tokens read by a derived name are listed with the code
// that derives them.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../ui/renderer/", import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  if (entry === "node_modules" || entry === "vendor") return [];
  return statSync(path).isDirectory() ? files(path) : /\.(css|js|html)$/.test(entry) ? [path] : [];
});

// Read by a name built at run time: core/data_grid.js reads `${rowHeightVar}-min` / `-max` for each grid's row height.
const DERIVED = /^--row-height-[\w-]+-(min|max)$/;

const tokensFile = join(RENDERER, "styles", "tokens.css");
const tokens = readFileSync(tokensFile, "utf8");
const declared = [...tokens.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(([, name]) => name);
const everything = files(RENDERER).map((file) => readFileSync(file, "utf8")).join("\n");
const unused = declared.filter((name) => {
  if (DERIVED.test(name)) return false;
  const uses = everything.match(new RegExp(`${name.replace(/[-]/g, "\\-")}(?![\\w-])`, "g")) || [];
  return uses.length <= 1;   // its own declaration only
});
assert.deepEqual(unused, [], `tokens nobody reads:\n  ${unused.join("\n  ")}`);
assert.ok(declared.length > 100, "tokens.css was read");
console.log(`renderer css token usage contract passed (${declared.length} tokens)`);
