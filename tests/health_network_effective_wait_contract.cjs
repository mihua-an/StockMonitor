"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health's effective endpoints are confirmed by Health itself, not guessed by the reader: a read with `wait_ms` made
// while a network operation is open is held until the operation in progress changes (or the wait runs out), and the
// operations object tells its waiters whenever the running operation changes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createControllerHttpApi } = require("../health/control_api");
const { NetworkOperations } = require("../health/operations");

(async () => {
  const configRoot = makeTempDir("network-wait-");
  const waiters = new Set();
  const changed = () => { for (const release of [...waiters]) release(); };
  const waitNetwork = (ms) => new Promise((resolve) => {
    const release = () => { clearTimeout(timer); waiters.delete(release); resolve(); };
    const timer = setTimeout(release, ms);
    waiters.add(release);
  });
  const operations = new NetworkOperations({ configRoot, manifest: {}, supervisor: {}, entries: {},
    effectiveRef: () => ({ services: {} }), onRunningChange: changed, logger: { warn() {}, error() {}, log() {} } });
  const token = "t".repeat(32);
  const api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({}),
    supervisor: { status: () => ({}), stopping: false }, collector: {}, performShutdown: async () => ({}),
    network: () => ({ health_instance_id: "h-1", operation: operations.running?.operation_id || null, effective: !operations.running }),
    waitNetwork, logger: { error() {}, log() {}, warn() {} } });
  await api.listen();
  const { port } = api.server.address();
  const get = (query = "") => fetch(`http://127.0.0.1:${port}/network/effective${query}`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json());
  try {
    operations.claim({ operation_id: "op-1" });
    const now = await get();
    assert.equal(now.effective, false, "an open operation: not settled");

    const started = Date.now();
    const held = get("?wait_ms=20000");
    setTimeout(() => operations.release({ operation_id: "op-1" }), 150);
    const answer = await held;
    assert.equal(answer.effective, true, "answered as soon as the operation was released");
    assert.ok(Date.now() - started < 5000, "not after the whole wait");

    const quick = Date.now();
    assert.equal((await get("?wait_ms=20000")).effective, true);
    assert.ok(Date.now() - quick < 2000, "a settled read is never held");
    assert.equal(waiters.size, 0, "no waiter is left behind");
  } finally {
    await api.close();
  }
  console.log("health network effective wait contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
