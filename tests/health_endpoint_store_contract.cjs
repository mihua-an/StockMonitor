"use strict";
// Health's endpoint record has one owner (service/platform/js/health_endpoint.js): its path, schema and the planned-
// restart exit code are spelled there only, and Health (writer) and Electron's bootstrap (reader) both go through it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHealthEndpointStore, SCHEMA, PLANNED_RESTART_EXIT, recordPath } = require("../service/platform/js/health_endpoint.js");
const bootstrap = require("../ui/main/health_bootstrap.js");

const ROOT = path.join(__dirname, "..");

// 1. No second spelling of the record in its two users.
for (const rel of ["health/main.js", "ui/main/health_bootstrap.js"]) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  assert.ok(text.includes("service/platform/js/health_endpoint.js"), `${rel} uses the shared endpoint store`);
  assert.ok(!text.includes("\"health_endpoint.json\""), `${rel} does not spell the record's file name`);
  assert.ok(!text.includes("stock-monitor-health-endpoint-v1"), `${rel} does not spell the record's schema`);
  assert.ok(!/exit\(\s*75\s*\)|=\s*75\s*;/.test(text), `${rel} does not spell the planned-restart exit code`);
}
assert.equal(bootstrap.PLANNED_RESTART_EXIT, PLANNED_RESTART_EXIT, "the bootstrap's exit code is the store's");

// 2. The store: write, read back, damage throws (never read as "no Health"), removal only by its owner.
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "health-endpoint-"));
try {
  const store = createHealthEndpointStore(configRoot);
  assert.equal(store.file, recordPath(configRoot));
  assert.equal(store.read(), null, "no record yet");
  store.write({ pid: 4242, host: "127.0.0.1", port: 8765, instance_id: "health-1" });
  const record = store.read();
  assert.equal(record.schema, SCHEMA);
  assert.equal(record.pid, 4242);
  assert.equal(record.port, 8765);

  store.removeIfOwnedBy(1111, { logger: { warn() {} } });
  assert.ok(store.read(), "another process's record stays");
  store.removeIfOwnedBy(4242);
  assert.equal(store.read(), null, "the owner removes it");

  fs.writeFileSync(store.file, "{not json");
  assert.throws(() => store.read(), /not valid JSON/);
  fs.writeFileSync(store.file, JSON.stringify({ schema: SCHEMA, pid: 1, host: "127.0.0.1", port: 0 }));
  assert.throws(() => store.read(), /does not match/);
} finally {
  fs.rmSync(configRoot, { recursive: true, force: true });
}
console.log("health endpoint store contract passed");
