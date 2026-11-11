// Outer layers never style inner ones (docs/BACKLOG.md section 1): a stylesheet's selectors use only the classes it
// owns (styles/names.json), state / modifier words and base.css's app-wide primitives. A page lays out its slots and
// leaves the components inside them alone; a component looks the same wherever it is placed and does not style the
// components it contains. `!important` and ID selectors are being removed the same way.
//
// The numbers below are what each file still has: a file may go down, never up. When a file reaches 0 its entry is
// deleted; the contract is complete when OPEN is empty.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = fileURLToPath(new URL("../ui/renderer/styles/", import.meta.url));

// file: [rules reaching another owner's classes, !important declarations, rules with an ID selector]
const OPEN = {};

const registry = JSON.parse(readFileSync(join(STYLES, "names.json"), "utf8"));
const words = new Set(registry.words);
const prefixOwner = new Map(Object.entries(registry.owners).flatMap(([owner, prefixes]) => prefixes.map((p) => [p, owner])));
const ownerOf = (name) => {
  if (!name.includes("-") && words.has(name)) return "word";
  let best = "";
  for (const prefix of prefixOwner.keys()) if ((name === prefix || name.startsWith(`${prefix}-`)) && prefix.length > best.length) best = prefix;
  return best ? prefixOwner.get(best) : null;
};

const files = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".css") ? [path] : [];
});

const measured = {};
const examples = {};
for (const file of files(STYLES)) {
  const name = relative(STYLES, file).replaceAll("\\", "/");
  if (name === "tokens.css" || name === "index.css") continue;
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const counts = [0, (css.match(/!important/g) || []).length, 0];
  for (const [, prelude] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    if (prelude.trim().startsWith("@")) continue;
    const foreign = [...prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(([, cls]) => cls)
      .filter((cls) => !["word", "base.css", name].includes(ownerOf(cls)));
    if (foreign.length) {
      counts[0] += 1;
      (examples[name] ||= []).push(`${prelude.trim().replace(/\s+/g, " ")}  (${[...new Set(foreign)].join(", ")})`);
    }
    if (/#[A-Za-z_][\w-]*/.test(prelude.replace(/url\([^)]*\)/g, ""))) counts[2] += 1;
  }
  if (counts.some(Boolean)) measured[name] = counts;
}

const problems = [];
for (const [name, counts] of Object.entries(measured)) {
  const allowed = OPEN[name] || [0, 0, 0];
  ["rules reaching another owner", "!important", "ID-selector rules"].forEach((label, index) => {
    if (counts[index] > allowed[index]) {
      problems.push(`${name}: ${counts[index]} ${label} (allowed ${allowed[index]})`
        + (index === 0 ? `\n    ${(examples[name] || []).slice(0, 8).join("\n    ")}` : ""));
    }
  });
}
assert.deepEqual(problems, [], `outer stylesheets styling inner ones:\n${problems.join("\n")}`);
const left = Object.values(measured).reduce((sum, c) => [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]], [0, 0, 0]);
console.log(`css ownership contract passed; still open: ${left[0]} reaching rules, ${left[1]} !important, ${left[2]} ID-selector rules`);
for (const [name, allowed] of Object.entries(OPEN)) {
  const counts = measured[name] || [0, 0, 0];
  if (counts.some((value, index) => value < allowed[index])) {
    console.log(`  ${name} is down to ${counts} -- ${counts.some(Boolean) ? "lower" : "delete"} its OPEN entry`);
  }
}
