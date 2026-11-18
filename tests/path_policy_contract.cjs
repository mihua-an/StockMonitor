"use strict";
// Paths are case-folded only on Windows, and "one volume" is the file system's device id, not the path root: on POSIX
// every mount shares "/", so a root comparison would rename across mounts instead of copying.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathKey, samePath, isInside, existingAncestor, sameVolume } = require("../config/js/path_policy.js");
const { dataChildPath } = require("../config/js/system_contract.js");
const { pipePath } = require("../config/js/remediation_contract.js");

const base = path.resolve(os.tmpdir(), "PolicyCase");
assert.equal(samePath(base, base.toLowerCase(), "win32"), true, "Windows: one folder in two spellings");
assert.equal(samePath(base, base.toLowerCase(), "linux"), false, "POSIX: a different case is another folder");
assert.equal(isInside(path.join(base, "a"), base.toUpperCase(), "win32"), true);
assert.equal(isInside(path.join(base, "a"), base.toUpperCase(), "linux"), false);
assert.equal(isInside(`${base}x`, base, "win32"), false, "a sibling with the same prefix is not inside");
assert.equal(pathKey(base, "linux"), path.resolve(base));

// The pipe name follows the same rule: one logs root in two spellings is one writer only where case does not matter.
assert.equal(pipePath({ logsRoot: base, platform: "win32" }), pipePath({ logsRoot: base.toLowerCase(), platform: "win32" }));
assert.notEqual(pipePath({ logsRoot: base, platform: "linux" }), pipePath({ logsRoot: base.toLowerCase(), platform: "linux" }));

// Volume by device id: a folder that does not exist yet is on its nearest existing ancestor's volume.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-"));
try {
  assert.equal(sameVolume(dir, path.join(dir, "not", "yet")), true);
  const [mountA, mountB] = [path.resolve("/mnt/a"), path.resolve("/mnt/b")];
  const fakeFs = {
    existsSync: (p) => p === mountA || p === mountB,
    statSync: (p) => ({ dev: p === mountA ? 1 : 2 }),
  };
  assert.equal(sameVolume("/mnt/a/x", "/mnt/b/y", { fsImpl: fakeFs }), false, "two mounts under one root are two volumes");
  // The one "nearest existing folder" rule, shared with Health's storage usage (its disk of a folder not created yet).
  assert.equal(existingAncestor(path.join(dir, "not", "yet"), fs), path.resolve(dir));
  assert.equal(existingAncestor(dir, fs), path.resolve(dir));

  // A DATA_ROOT child's full path comes from the system contract, never a hand-written folder name.
  assert.equal(dataChildPath(dir, "market_runtime"), path.join(dir, "live-engine"));
  assert.equal(dataChildPath(dir, "market_sessions"), path.join(dir, "live-engine", "market_sessions.json"));
  assert.throws(() => dataChildPath(dir, "no_such_owner"), /names no data directory/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("path policy contract passed");
