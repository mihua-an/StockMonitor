// The renderer's JS draws with the stylesheet's colours: no colour literal (#rrggbb, #rgb, rgb()/rgba()) in
// ui/renderer/js or the renderer pages; canvases read tokens through core/market_palette.js themeColor / marketPalette.
// The one exception is market_palette.js's FALLBACK, the market red / green / white for a context without a document.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../ui/renderer/", import.meta.url));
const ALLOWED = new Set(["js/core/market_palette.js"]);
const LITERAL = /["'`(\s:,]#[0-9a-fA-F]{6}\b|["'`(\s:,]#[0-9a-fA-F]{3}["'`;)\s]|\brgba?\(\s*\d/g;

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  if (statSync(path).isDirectory()) return entry === "styles" || entry === "vendor" ? [] : walk(path);
  return /\.(js|html)$/.test(entry) ? [path] : [];
});

const offenders = [];
for (const file of walk(RENDERER)) {
  const name = relative(RENDERER, file).replaceAll("\\", "/");
  if (ALLOWED.has(name)) continue;
  const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");
  const found = code.match(LITERAL) || [];
  if (found.length) offenders.push(`${name}: ${found.length} (${[...new Set(found.map((f) => f.trim()))].slice(0, 5).join(" ")})`);
}
if (offenders.length) {
  console.error(`colour literals in renderer JS / HTML (read a token instead):\n  ${offenders.join("\n  ")}`);
  process.exit(1);
}
console.log("js colour literal contract passed: the renderer draws with tokens.css colours");
