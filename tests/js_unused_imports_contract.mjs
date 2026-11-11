// Every ES module of the repo imports only what it uses. Each module is parsed (tests/lib/js_ast.mjs, acorn) and an
// imported binding counts as used when an identifier of that name appears outside the import declarations other than
// as a property name, a method / field key or a label; `export { name }` uses it, `export { name } from "..."` is a
// re-export of its own and does not.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJs, unusedImports } from "./lib/js_ast.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["config", "health", "scripts", "service", "tests", "ui"];
const SKIP = new Set(["node_modules", "__pycache__", "dist", "target"]);
const files = (dir) => readdirSync(dir).flatMap((entry) => {
  if (SKIP.has(entry)) return [];
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path) : /\.(js|mjs|cjs)$/.test(entry) ? [path] : [];
});

let modules = 0;
const problems = [];
for (const file of ROOTS.flatMap((root) => files(join(REPO, root)))) {
  const source = readFileSync(file, "utf8");
  if (!/^\s*import\s/m.test(source)) continue;
  const name = relative(REPO, file).replaceAll("\\", "/");
  modules += 1;
  const unused = unusedImports(parseJs(source, { label: name }));
  if (unused.length) problems.push(`${name}: ${unused.join(", ")}`);
}
assert.ok(modules > 300, `the scan found the repo's modules (${modules})`);
assert.deepEqual(problems, [], `imports nothing uses:\n${problems.join("\n")}`);
console.log(`js unused imports contract passed (${modules} modules)`);
