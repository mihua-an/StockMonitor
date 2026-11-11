"use strict";
// The market_runtime credential file is written through the shared atomic writer: overlapping writers never share a
// temp file, a failed write leaves no temp behind and the previous file whole (R15-26).
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { writeCredentialsFile, CREDENTIALS_SCHEMA, ROLES } = require("../service/platform/js/runtime_credentials.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-credentials-"));
try {
  const env = { ...process.env, STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR: path.join(dir, "auth") };
  const file = path.join(dir, "run", "credentials.json");
  const temps = [];
  const watching = { ...fs, renameSync: (from, to) => { temps.push(from); return fs.renameSync(from, to); } };
  writeCredentialsFile(file, env, ROLES, { fsImpl: watching });
  writeCredentialsFile(file, env, ROLES, { fsImpl: watching });
  assert.equal(new Set(temps).size, 2, "each write has its own temp file");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.schema, CREDENTIALS_SCHEMA);
  assert.deepEqual(Object.keys(document.roles), ROLES);

  const before = fs.readFileSync(file, "utf8");
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error("EPERM: in use"), { code: "EPERM" }); } };
  assert.throws(() => writeCredentialsFile(file, env, ROLES, { fsImpl: failing }), /EPERM/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the previous file is whole");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["credentials.json"], "no temp left behind");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("runtime credentials file contract passed");
