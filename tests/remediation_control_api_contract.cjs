"use strict";
// Electron main's remediation events reach Health's ledger over the control API (POST /control/remediation), because
// Node cannot open the ledger pipe at identification level or check which Windows user serves it (S-1116-06): the
// real controller client posts through the real route into a real ledger; settled events are written and fsync'd
// once (a resent batch is a duplicate), a refused event counts as settled, a malformed or oversized batch is a 400
// and an unauthenticated one a 401.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contract = require("../config/js/remediation_contract.js");
const { createControllerHttpApi } = require("../health/control_api.js");
const { RemediationLedger } = require("../health/remediation/ledger.js");
const { createControllerClient } = require("../ui/main/controller_client.js");
const { createRemediationClient } = require("../service/platform/js/remediation_client.js");

const quiet = { log() {}, warn() {}, error() {} };
const proc = { service_id: "electron_main", instance_id: "e-1", pid: process.pid, runtime: "node" };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-control-api-"));
  const logs = path.join(root, "logs");
  const ledger = new RemediationLedger({ logsRoot: logs, sessionDir: path.join(logs, "20261117_090000-abcdef"),
    summaryDir: path.join(root, "output", "remediation", "daily"), logger: quiet,
    writer: { service_id: "service_controller", instance_id: "health-1", pid: process.pid } });
  await ledger.start();
  const token = "c".repeat(64);
  const limits = contract.loadRegistry().limits;
  const api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({ instance_id: "health-1" }),
    supervisor: { status: () => ({}), stopping: false }, collector: {}, performShutdown: async () => ({}), logger: quiet,
    remediation: { maxEvents: contract.HTTP_BATCH_EVENTS, maxBodyBytes: contract.HTTP_BATCH_EVENTS * limits.frame_bytes,
      admitBatch: (events) => ledger.admitBatch(events, limits.client_ack_timeout_ms) } });
  await api.listen();
  const baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  // The controller client reads the token file the way Electron main does (this process's override variable).
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = path.join(root, "controller_auth_token");
  fs.writeFileSync(process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE, token);
  const raw = (body, auth = true) => fetch(`${baseUrl}/control/remediation`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const controller = createControllerClient({ fs, baseUrl });
    const client = createRemediationClient({ process: proc, logger: quiet,
      post: (events, timeoutMs) => controller.postRemediation(events, timeoutMs) });
    const op = client.begin({ component: "supervisor", mechanismId: "health.service_restart", triggerReason: "service_not_alive",
      identity: {}, detail: { service_id: "app_api" } });
    op.finish("succeeded", { attempt: 1 });
    client.emit({ component: "x", mechanismId: "not.registered", triggerReason: "x", identity: {}, outcome: "failed" });
    assert.equal(await client.flush(8000), true, "every event settled");
    assert.equal(client.status().delivered, 3);
    await ledger.flush();
    const written = fs.readdirSync(ledger.sessionDir).filter((n) => n.startsWith("remediation-"))
      .flatMap((n) => fs.readFileSync(path.join(ledger.sessionDir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
      .filter((r) => r.schema === contract.loadRegistry().event_schema);
    assert.deepEqual(written.map((e) => e.outcome), ["started", "succeeded"], "the unregistered event is refused, not written");
    assert.equal(ledger.stats.rejected, 1);

    // A batch whose answer was lost comes again: settled, written once.
    const resent = await raw({ events: written });
    assert.deepEqual(resent, { status: 200, body: { ok: true, settled: 2 } });
    assert.equal(ledger.stats.duplicates, 2);

    assert.equal((await raw({ events: written }, false)).status, 401);
    assert.equal((await raw({ events: "x" })).status, 400);
    assert.equal((await raw({ events: Array.from({ length: contract.HTTP_BATCH_EVENTS + 1 }, () => written[0]) })).status, 400);
    client.close();
  } finally {
    await api.close();
    await ledger.close("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("remediation control api contract ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
