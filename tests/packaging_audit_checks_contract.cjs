"use strict";
// The packaging audit compares every toolchain evidence field with its pin (not Electron alone), and checks the
// packaged interpreter path by calling launch_runtime.js's resolver in a synthetic packaged layout, never by searching
// its source text.
const assert = require("node:assert/strict");
const path = require("node:path");
const audit = require("../scripts/tooling/audit_packaging.cjs");

const pins = { electron: "44.4.3", node: "24.18.0", rust: ["1.97.1", "1.97.1"] };
const evidence = { node: "24.18.0", electron: "44.4.3", rustc: "1.97.1 (8bab26f4f 2026-07-14)", cargo: "1.97.1 (c980f4866 2026-06-30)" };
assert.deepEqual(audit.toolchainEvidenceProblems(evidence, pins), []);
for (const [field, value, why] of [["node", "22.1.0", /node evidence/], ["rustc", "1.90.0 (x)", /rustc evidence/],
  ["cargo", "1.96.0", /cargo evidence/], ["electron", "31.0.0", /electron evidence/]]) {
  const problems = audit.toolchainEvidenceProblems({ ...evidence, [field]: value }, pins);
  assert.equal(problems.length, 1, field);
  assert.match(problems[0], why);
}
assert.match(audit.toolchainEvidenceProblems(evidence, { ...pins, rust: ["1.97.1", "1.96.0"] }).join(";"), /different Rust toolchains/);
assert.match(audit.toolchainEvidenceProblems(evidence, { ...pins, node: "" }).join(";"), /engines\.node/);

// The current repository's pins agree with its evidence.
const current = require("../requirements/toolchain-evidence.json");
const pkg = require("../package.json");
assert.equal(pkg.engines.node, current.node, "package.json engines.node is the Node pin");

assert.deepEqual(audit.bundledInterpreterResolution(), { ok: true });
const source = require("node:fs").readFileSync(path.join(__dirname, "..", "scripts", "tooling", "audit_packaging.cjs"), "utf8");
assert.doesNotMatch(source, /runtimeSource\.includes/, "the resolver is called, not grepped");
console.log("packaging audit checks contract passed");
