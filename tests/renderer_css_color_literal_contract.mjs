// Every colour of the renderer's stylesheets is a token: tokens.css is the only file under ui/renderer/styles with a
// colour literal (#rgb, #rrggbb, rgb()/rgba(), hsl()/hsla(), or a named colour such as white / black in a value);
// everything else reads var(--...). docs/BACKLOG.md §1.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = fileURLToPath(new URL("../ui/renderer/styles/", import.meta.url));
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;
const NAMED = /(?<![-\w])(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|navy|teal|maroon|lime|aqua|fuchsia|olive|pink|brown|gold|cyan|magenta)(?![-\w])/g;

const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".css") ? [path] : [];
});

const offenders = [];
for (const file of files(STYLES)) {
  const name = relative(STYLES, file).replaceAll("\\", "/");
  if (name === "tokens.css") continue;
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Inside url(...) or a string a "#" is not a colour (an id fragment, a glyph).
  const code = css.replace(/url\([^)]*\)/g, "").replace(/"[^"]*"|'[^']*'/g, "");
  // A named colour counts only in a declaration's value (never in a selector or a property name).
  const values = [...code.matchAll(/:\s*([^;{}]+)/g)].map(([, value]) => value).join(";");
  const found = [...(code.match(LITERAL) || []), ...(values.match(NAMED) || [])];
  if (found.length) offenders.push(`${name}: ${found.length} (${[...new Set(found)].slice(0, 6).join(" ")})`);
}

if (offenders.length) {
  console.error(`colour literals outside tokens.css:\n  ${offenders.join("\n  ")}`);
  process.exit(1);
}
console.log("css colour literal contract passed: tokens.css holds every colour");
