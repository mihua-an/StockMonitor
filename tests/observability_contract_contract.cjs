"use strict";
// 07 section 2/3 and 06 section 5 rules as executable checks (CFG-05, CFG-06, CFG-14).
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const oc = require("../config/js/observability_contract.js");

test("missing is never zero; OK requires a value; utilization only with a capacity", () => {
  const empty = oc.metric({ name: "queue", serviceId: "market_runtime", sampledAt: "t", unit: "events" });
  assert.equal(empty.value, null);
  assert.equal(empty.availability, "NO_SAMPLE");
  assert.throws(() => oc.metric({ name: "x", serviceId: "s", sampledAt: "t", unit: "u", availability: "OK" }));
  assert.throws(() => oc.metric({ name: "x", serviceId: "s", sampledAt: "t", unit: "u", value: 3, availability: "UNSUPPORTED" }));
  const zero = oc.metric({ name: "q", serviceId: "s", sampledAt: "t", unit: "events", value: 0, capacity: 100 });
  assert.equal(zero.availability, "OK");
  assert.equal(zero.utilization, 0);
  const noCap = oc.metric({ name: "q", serviceId: "s", sampledAt: "t", unit: "events", value: 5 });
  assert.equal("utilization" in noCap, false, "no capacity -> no percentage");
});

test("the shared cases give the same complete metric as the Python module (tests/test_observability_contract_cases.py)", () => {
  const fs = require("node:fs");
  const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "observability_metric_cases.json"), "utf8"));
  const camel = (key) => key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  for (const { name, args, metric, error } of cases) {
    const input = Object.fromEntries(Object.entries(args).map(([k, v]) => [camel(k), v]));
    if (error) assert.throws(() => oc.metric(input), (e) => e.message.includes(error), name);
    else assert.deepEqual(oc.metric(input), metric, name);
  }
  const sampled = oc.metric({ name: "q", serviceId: "s", unit: "u", value: 1 }).sampled_at;
  assert.match(sampled, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "a missing sample time is filled with now, as in Python");
});

test("a failed sample marks only that metric stale and keeps the last value", () => {
  const last = oc.metric({ name: "lag", serviceId: "analysis_runtime", sampledAt: "t1", unit: "events", value: 12 });
  const stale = oc.staleMetric(last, { reason: "probe timeout", sampledAt: "t2" });
  assert.equal(stale.value, 12);
  assert.equal(stale.availability, "STALE");
  assert.equal(stale.stale_since, "t2");
});

test("operation verdict is derived per service; partial is never global success", () => {
  const op = oc.operation({ operationId: "op-1", kind: "network", candidateRevision: 3, expectedActiveRevision: 2, requestedBy: "settings" });
  for (const step of ["drain", "stop", "release_verified", "bind", "readiness", "identity_verified", "effective_recorded"]) {
    oc.recordStep(op, "quote_api", step, { ok: true });
  }
  assert.equal(oc.verdict(op), "APPLIED");
  oc.recordStep(op, "history_api", "bind", { ok: false, detail: "EADDRINUSE" });
  assert.equal(oc.verdict(op), "PARTIALLY_APPLIED");
  assert.throws(() => oc.recordStep(op, "x", "made_up_step", { ok: true }));
});

test("service run state and pending config are separate fields", () => {
  const d = oc.serviceDescriptor({ serviceId: "analysis_runtime", displayName: "累積計算", state: "RUNNING",
    pendingOperation: "op-9", addresses: { default: null, effective: null } });
  assert.equal(d.state, "RUNNING");
  assert.equal(d.pending_operation, "op-9");
  assert.throws(() => oc.serviceDescriptor({ serviceId: "x", state: "PORT_BUSY" }));
});

test("Python mirror applies the same metric rules", () => {
  const root = path.resolve(__dirname, "..");
  const py = spawnSync(process.env.PYTHON || "python", ["-c", [
    "import sys,json", "sys.path.insert(0, sys.argv[1])", "from config.observability_contract import metric, histogram_summary",
    "out = {}", "out['empty'] = metric('q','s',unit='events')['availability']",
    "out['zero_util'] = metric('q','s',unit='events',value=0,capacity=10)['utilization']",
    "try:\n    metric('q','s',unit='u',availability='OK')\n    out['ok_without_value']='accepted'\nexcept ValueError:\n    out['ok_without_value']='refused'",
    "h = histogram_summary('lat','market_runtime',[1,2,3,4,100],start='a_received',end='wal_committed',window_ms=5000)",
    "out['p99'] = h['p99']; out['samples'] = h['samples']",
    "print(json.dumps(out))",
  ].join("\n"), root], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), { empty: "NO_SAMPLE", zero_util: 0, ok_without_value: "refused", p99: 100, samples: 5 });
});
