// The classes the renderer's JavaScript produces follow the same rules as the HTML pages' (renderer_css_naming_contract
// checks those): every one has an owner in styles/names.json, and every one is used -- a stylesheet selects it, or
// the renderer's own code looks it up. Tests do not count: a class only a test reads is dead in the product, so the
// test finds the element by a data-* hook instead. A class nothing in the product reads is dropped.
//
// The renderer's modules are parsed (tests/lib/js_ast.mjs, acorn), so a comment or a word in a message is neither a
// producer nor a lookup. Produced = a class="..." attribute inside a string or template, `x.className = "..."`, the
// string arguments of classList.add/remove(...) and the first argument of classList.toggle/replace; a token joined to
// a ${...} expression is computed and not checked. Looked up = a selector in a string (".x", "a .x > b",
// "[class~=x]") or classList.contains/toggle / matches with the name.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eachNode, memberName, parseJs, stringText } from "./lib/js_ast.mjs";

const ROOT = fileURLToPath(new URL("../ui/renderer/", import.meta.url));
const STYLES = join(ROOT, "styles");
const files = (dir, ext) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? files(path, ext) : ext.some((e) => path.endsWith(e)) ? [path] : [];
});

const registry = JSON.parse(readFileSync(join(STYLES, "names.json"), "utf8"));
const words = new Set(registry.words);
const prefixOwner = new Map(Object.entries(registry.owners).flatMap(([owner, prefixes]) => prefixes.map((p) => [p, owner])));
const ownerOf = (name) => {
  if (!name.includes("-") && words.has(name)) return "word";
  let best = "";
  for (const prefix of prefixOwner.keys()) if ((name === prefix || name.startsWith(`${prefix}-`)) && prefix.length > best.length) best = prefix;
  return best ? prefixOwner.get(best) : null;
};

// The value of every class="..." / class='...' attribute written in `text` (a string or a template's text).
const classAttributes = (text) => [...text.matchAll(/class=(["'])([^"']*)\1/g)].map((m) => m[2]);

const produced = new Map();
const add = (value, file) => {
  for (const token of String(value || "").split(/\s+/)) {
    if (!token || token.includes("§") || !/^-?[A-Za-z_][\w-]*$/.test(token)) continue;
    if (!produced.has(token)) produced.set(token, new Set());
    produced.get(token).add(relative(ROOT, file).replaceAll("\\", "/"));
  }
};
// Every string text of the product (selectors are looked up in them) and every name a classList.contains / toggle or
// matches call is given.
const texts = [];
const queried = new Set();
const stringsWithin = (node) => {
  const found = [];
  eachNode(node, (inner) => { const text = stringText(inner); if (text !== null && inner.type === "Literal") found.push(text); });
  return found;
};

// The class strings a `className = ...` value can be: a string or template, through `.trim()` and either side of
// `a ? b : c` / `a || b` / `a ?? b`.
const classNameValues = (node) => {
  const text = stringText(node);
  if (text !== null) return [text];
  if (node?.type === "CallExpression" && memberName(node.callee) === "trim") return classNameValues(node.callee.object);
  if (node?.type === "ConditionalExpression") return [...classNameValues(node.consequent), ...classNameValues(node.alternate)];
  if (node?.type === "LogicalExpression") return [...classNameValues(node.left), ...classNameValues(node.right)];
  return [];
};

for (const file of files(ROOT, [".js"]).filter((f) => !f.startsWith(STYLES))) {
  const program = parseJs(readFileSync(file, "utf8"), { label: relative(ROOT, file) });
  eachNode(program, (node) => {
    const text = stringText(node);
    if (text !== null) {
      texts.push(text);
      for (const value of classAttributes(text)) add(value, file);
      return;
    }
    if (node.type === "AssignmentExpression" && memberName(node.left) === "className") {
      for (const value of classNameValues(node.right)) add(value, file);
      return;
    }
    if (node.type !== "CallExpression") return;
    const method = memberName(node.callee);
    const onClassList = memberName(node.callee?.object) === "classList";
    if (onClassList && (method === "add" || method === "remove")) {
      for (const argument of node.arguments) for (const value of stringsWithin(argument)) add(value, file);
    } else if (onClassList && (method === "toggle" || method === "replace")) {
      const first = node.arguments[0]?.type === "Literal" ? stringText(node.arguments[0]) : null;
      if (first !== null) add(first, file);
    }
    if (method === "contains" || method === "toggle" || method === "matches") {
      const first = node.arguments[0] ? stringText(node.arguments[0]) : null;
      if (first !== null) queried.add(first.replace(/^\./, ""));
    }
  });
}

const css = files(STYLES, [".css"]).map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
const styled = new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));
const lookedUp = (name) => {
  if (queried.has(name)) return true;
  const n = name.replace(/[-]/g, "\\-");
  const selector = new RegExp(`\\.${n}(?![\\w-])`);
  const attribute = new RegExp(`\\[class[~*^|$]?=\\s*["']?[^\\]]*${n}`);
  return texts.some((text) => selector.test(text) || attribute.test(text));
};

const problems = [];
for (const [name, where] of [...produced].sort()) {
  if (!ownerOf(name)) problems.push(`.${name} has no owner in names.json  (${[...where].join(", ")})`);
  else if (!styled.has(name) && !lookedUp(name)) problems.push(`.${name} is produced but nothing selects it  (${[...where].join(", ")})`);
}
assert.ok(produced.size > 500, `the scan found the renderer's classes (${produced.size})`);
assert.deepEqual(problems, [], `renderer JS classes:\n${problems.join("\n")}`);
console.log(`css class usage contract passed (${produced.size} classes produced by renderer JS, each owned and used)`);
