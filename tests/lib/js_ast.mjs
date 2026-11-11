// JavaScript source read by a real parser (acorn, a devDependency) for the contracts that inspect source text: the
// string texts a module writes (class names, selectors) and the names a module imports and uses. A contract about
// what a function DOES imports the real module and runs it; no function text is copied out and re-run.
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const OPTIONS = {
  ecmaVersion: "latest",
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
};

const parsed = new Map();

/** The program of `source` (an ES module; a script when it is not one). Parse errors throw with `label`. */
export function parseJs(source, { label = "source" } = {}) {
  const known = parsed.get(source);
  if (known) return known;
  let program;
  try {
    program = acorn.parse(source, { ...OPTIONS, sourceType: "module" });
  } catch (moduleError) {
    try {
      program = acorn.parse(source, { ...OPTIONS, sourceType: "script" });
    } catch {
      throw new Error(`${label} does not parse: ${moduleError.message}`);
    }
  }
  parsed.set(source, program);
  return program;
}

/** The text of a string literal or a template ("§" for each `${...}`); null for any other node. */
export function stringText(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("§");
  return null;
}

/** Calls `visit(node, ancestors)` for every node of the program. */
export function eachNode(program, visit) {
  walk.fullAncestor(program, (node, _state, ancestors) => visit(node, ancestors));
}

/** The member name of a non-computed `a.name` (or a computed `a["name"]`); null otherwise. */
export function memberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return node.computed ? stringText(node.property) : null;
}

/**
 * The names `program` imports that nothing in it reads: an import's local binding counts as used when an identifier
 * of that name appears anywhere outside the import declarations, other than as a property name, a method / field
 * key or a label.
 */
export function unusedImports(program) {
  const imported = [];
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) imported.push(specifier.local.name);
  }
  if (!imported.length) return [];
  const used = new Set();
  const visitor = walk.make({
    ImportDeclaration() {},
    Identifier(node) { used.add(node.name); },
    // `export { name }` re-exports a binding; acorn-walk does not visit the specifiers.
    ExportNamedDeclaration(node, state, c) {
      if (node.declaration) c(node.declaration, state, "Statement");
      if (!node.source) for (const specifier of node.specifiers) used.add(specifier.local.name);
    },
    MemberExpression(node, state, c) {
      c(node.object, state, "Expression");
      if (node.computed) c(node.property, state, "Expression");
    },
    Property(node, state, c) {
      if (node.computed || node.shorthand) c(node.key, state, "Expression");
      c(node.value, state, "Expression");
    },
    MethodDefinition(node, state, c) {
      if (node.computed) c(node.key, state, "Expression");
      c(node.value, state, "Expression");
    },
    PropertyDefinition(node, state, c) {
      if (node.computed) c(node.key, state, "Expression");
      if (node.value) c(node.value, state, "Expression");
    },
    LabeledStatement(node, state, c) { c(node.body, state, "Statement"); },
    BreakStatement() {},
    ContinueStatement() {},
  });
  walk.recursive(program, null, visitor);
  return imported.filter((name) => !used.has(name));
}
