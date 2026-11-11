// Every CSS class name says who owns it (ui/renderer/styles/names.json, rules in styles/index.css):
//   - a class of one word is a state or modifier word from `words` (active, up, buy, ...), or an owner's own name;
//   - any other class starts with exactly one owner's registered prefix (the longest one that is the class itself or
//     is followed by "-"): orderbook-total-bar belongs to components/orderbook.css, realtime-workspace to pages/realtime.css;
//   - no class names a data source or a page by an old name (shioaji-, moomoo-, futu-, monitor-): a component is the
//     same for every source, and the 即時報價 page is `realtime`.
// Checked on every selector of every stylesheet and every class attribute of the HTML pages.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../ui/renderer/", import.meta.url));
const STYLES = join(ROOT, "styles");
const registry = JSON.parse(readFileSync(join(STYLES, "names.json"), "utf8"));
const words = new Set(registry.words);
const prefixOwner = new Map();
for (const [owner, prefixes] of Object.entries(registry.owners)) {
  for (const prefix of prefixes) {
    assert.ok(!prefixOwner.has(prefix), `prefix "${prefix}" is registered to ${prefixOwner.get(prefix)} and ${owner}`);
    assert.ok(!words.has(prefix), `"${prefix}" is both a word and an owner's prefix`);
    prefixOwner.set(prefix, owner);
  }
}

function ownerOf(name) {
  if (!name.includes("-") && words.has(name)) return "word";
  let best = "";
  for (const prefix of prefixOwner.keys()) {
    if ((name === prefix || name.startsWith(`${prefix}-`)) && prefix.length > best.length) best = prefix;
  }
  return best ? prefixOwner.get(best) : null;
}

const FORBIDDEN = /(^|-)(shioaji|moomoo|futu|monitor)(-|$)/;
const problems = [];
const check = (name, where) => {
  if (FORBIDDEN.test(name)) problems.push(`${where}: .${name} names a data source or the old page name`);
  else if (!ownerOf(name)) problems.push(`${where}: .${name} has no owner in names.json`);
};

const files = (dir, ext) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path, ext) : path.endsWith(ext) ? [path] : [];
});

let selectorClasses = 0;
for (const file of files(STYLES, ".css")) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, prelude] of css.matchAll(/([^{}]+)\{/g)) {
    if (prelude.trim().startsWith("@")) continue;
    for (const [, name] of prelude.replace(/url\([^)]*\)/g, "").matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
      selectorClasses += 1;
      check(name, relative(STYLES, file));
    }
  }
}

let markupClasses = 0;
for (const file of files(ROOT, ".html")) {
  if (file.startsWith(STYLES)) continue;
  for (const [, value] of readFileSync(file, "utf8").matchAll(/\sclass="([^"]*)"/g)) {
    for (const name of value.split(/\s+/).filter(Boolean)) {
      markupClasses += 1;
      check(name, relative(ROOT, file));
    }
  }
}

assert.deepEqual(problems, [], `class names without a clear owner:\n${problems.join("\n")}`);
console.log(`css naming contract passed (${selectorClasses} selector classes, ${markupClasses} markup classes)`);
