"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health's control API, the market_runtime host's identity verification, and the monitoring snapshot rules
// (docs/system-architecture/00 sections 3-4, 07 sections 1-3):
//  * every control route needs the controller credential; full shutdown runs the shutdown and then exits;
//  * a listener is only "market_runtime" when it proves service_id + wall clock over the authenticated health exchange;
//    anything else on the port is an unverified occupant (never adopted, never killed);
//  * the snapshot: missing is not zero, a failed metric read keeps the last value marked stale, a shared PID is
//    counted once, and detail is collected only while a monitoring page asks for it (reading does not turn it on).

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.STOCK_MONITOR_PORT_OVERRIDES;
delete process.env.STOCK_MONITOR_NETWORK_REVISION;

const networkConfig = require("../config/js/network_config.js");
const { createControllerHttpApi } = require("../health/control_api.js");
const { MarketRuntimeHost } = require("../health/services/market_runtime_host.js");
const { MonitoringCollector } = require("../health/monitoring/collector.js");

const manifest = networkConfig.loadManifest(networkConfig.manifestPath(process.env));
const effective = networkConfig.resolve(manifest, { env: {} });

test("control API: credential required everywhere; full shutdown runs then exits", async () => {
  const calls = [];
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const api = createControllerHttpApi({
    host: "127.0.0.1", port: 0, token: "controller-token-0123456789",
    identity: () => ({ service_id: "service_controller", instance_id: "h-1" }),
    supervisor: { stopping: false, status: () => ({}), startup: {}, entries: {} },
    collector: { current: (options) => { calls.push(`snapshot:${JSON.stringify(options)}`); return null; } },
    performShutdown: async (scope) => { calls.push(`shutdown:${scope}`); return { ok: true, scope }; },
    onFullShutdown: (result) => { calls.push(`exit:${result.scope}`); finished(); },
  });
  await api.listen();
  const { port } = api.server.address();
  try {
    const anonymous = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/control/shutdown`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(calls, [], "an unauthenticated shutdown does nothing");
    const snapshot = await fetch(`http://127.0.0.1:${port}/snapshot`, { headers: { Authorization: "Bearer controller-token-0123456789" } });
    assert.deepEqual(await snapshot.json(), { ok: false, snapshot: null, stale: true }, "no snapshot yet is reported as such, not as an empty one");
    for (const query of ["?trend_since=1700000000000", "?trend_since=0", "?trend_since=-5", "?trend_since=x"]) {
      await fetch(`http://127.0.0.1:${port}/snapshot${query}`, { headers: { Authorization: "Bearer controller-token-0123456789" } });
    }
    assert.deepEqual(calls.splice(0), ['snapshot:{"trendSince":null}', 'snapshot:{"trendSince":1700000000000}', 'snapshot:{"trendSince":0}',
      'snapshot:{"trendSince":null}', 'snapshot:{"trendSince":null}'], "trend_since is the cursor; absent or invalid, no trend");
    const response = await fetch(`http://127.0.0.1:${port}/control/shutdown`, {
      method: "POST", headers: { Authorization: "Bearer controller-token-0123456789" }, body: JSON.stringify({ scope: "full" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, scope: "full" });
    await done;
    assert.deepEqual(calls, ["shutdown:full", "exit:full"]);
  } finally {
    await api.close();
  }
});

function runtimeHost(health, { portOpen = false } = {}) {
  const host = Object.create(MarketRuntimeHost.prototype);
  Object.assign(host, { effective, child: null });
  host.portPresent = async () => true;
  host.health = async () => health;
  return { host, portOpen };
}

test("market_runtime host: only a listener proving service_id and the wall clock is verified", async () => {
  const good = runtimeHost({ service_id: "market_runtime", clock: "wall", instance_id: "mr-1", pid: 9, status: "healthy", runtime_epoch: 3 });
  const probe = await good.host.supervisorProbe();
  assert.equal(probe.verified, true);
  assert.equal(probe.alive, true);
  assert.equal(probe.instance_id, "mr-1");
  assert.equal(probe.runtime_epoch, 3);

  const testInstance = runtimeHost({ service_id: "market_runtime", clock: "exchange", instance_id: "mr-2" });
  const other = await testInstance.host.supervisorProbe();
  assert.equal(other.verified, false, "a test instance (exchange clock) is not this App's market_runtime");
  assert.equal(other.occupied, true, "but it does hold the port");

  const stranger = runtimeHost({ service_id: "realtime_api", clock: "wall", instance_id: "x" });
  assert.equal((await stranger.host.supervisorProbe()).verified, false);

  const stop = await testInstance.host.stop("test");
  assert.equal(stop.ok, false, "an unverified occupant is never stopped");
  assert.match(stop.error, /unverified occupant/);
});

function collectorWith(services, { resources = null, now = () => 1_000_000, jobPids } = {}) {
  return new MonitoringCollector({
    services, effective, manifest, configStore: null, resources, now, logger: { warn() {} }, jobPids,
  });
}

function running(pid, extra = {}) {
  return { host: { supervisorProbe: async () => ({ alive: true, verified: true, pid, instance_id: `i-${pid}` }), ...extra }, state: () => "RUNNING" };
}

test("monitoring: a service the Supervisor is starting is reported from its state, not probed", async () => {
  let probes = 0;
  const collector = collectorWith({
    app_api: { host: { supervisorProbe: async () => { probes += 1; return { alive: false, occupied: false }; } },
      state: () => "STARTING", stateReason: () => "行情引擎復原中（掃描 WAL）" },
  });
  const snap = await collector.collect();
  const app = snap.services.find((s) => s.service_id === "app_api");
  assert.deepEqual([app.state, app.state_reason, probes], ["STARTING", "行情引擎復原中（掃描 WAL）", 0]);
});

test("monitoring: detail only on request, missing is not zero, shared PIDs counted once, stale keeps the last value", async () => {
  let metricsCalls = 0;
  let failMetrics = false;
  const samples = [];
  const resources = {
    lastCostMs: 5,
    sample: async (pids) => {
      samples.push(pids);
      return new Map([[11, { availability: "OK", cpu_percent: 10, memory_bytes: 100 }],
        [process.pid, { availability: "OK", cpu_percent: 1, memory_bytes: 1 }]]);
    },
  };
  const services = {
    realtime_api: running(11, { metrics: async () => { metricsCalls += 1; if (failMetrics) throw new Error("boom"); return { requests: 7 }; } }),
    app_api: running(11), // same PID as realtime_api (e.g. a shared host): counted once
    provider_futu: { host: { supervisorProbe: async () => ({ alive: false, occupied: false }) } },
  };
  const collector = collectorWith(services, { resources });

  let snap = await collector.collect();
  assert.equal(snap.detail_collected, false);
  assert.equal(metricsCalls, 0, "no metrics are read while no page asked for them");
  assert.equal(samples.length, 0, "no OS resource query either");
  const hidden = snap.services.find((s) => s.service_id === "realtime_api");
  assert.equal(hidden.resources.availability, "TEMPORARILY_UNAVAILABLE");
  assert.equal(snap.totals.cpu_percent_unique_pids, null, "an unmeasured total is null, not 0");
  collector.current();
  assert.equal(collector.detailWanted(), false, "reading the snapshot does not turn detail collection on");

  collector.requestDetail();
  snap = await collector.collect();
  assert.equal(snap.detail_collected, true);
  assert.equal(snap.totals.unique_pids, 1, "realtime_api and app_api share PID 11");
  assert.equal(snap.totals.cpu_percent_unique_pids, 10);
  assert.equal(snap.services.find((s) => s.service_id === "realtime_api").metrics.document.requests, 7);
  const down = snap.services.find((s) => s.service_id === "provider_futu");
  assert.equal(down.state, "FAILED");
  assert.equal(down.metrics.availability, "NOT_APPLICABLE", "a service that is not running has no metrics, not zero metrics");

  failMetrics = true;
  collector.requestDetail();
  snap = await collector.collect();
  const stale = snap.services.find((s) => s.service_id === "realtime_api").metrics;
  assert.equal(stale.availability, "STALE");
  assert.equal(stale.document.requests, 7, "the last value stays, marked stale");
  assert.match(stale.reason, /boom/);

  const reserved = snap.reserved_ports.map((r) => r.port);
  assert.deepEqual(reserved, [8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009]);
  assert.ok(snap.services.every((s) => !reserved.includes(s.addresses?.effective?.port)), "reserved numbers are not services");
});

test("monitoring: a page that opens gets a detail pass at once, not at the next interval", async () => {
  let metricsCalls = 0;
  let release = null;
  const services = { realtime_api: running(11, { metrics: async () => { metricsCalls += 1; return { requests: 1 }; } }) };
  const collector = new MonitoringCollector({ services, effective, manifest, configStore: null, resources: null,
    logger: { warn() {} }, publishMs: 3_600_000 });
  // The first timed pass is held open, as a slow probe would hold it.
  const firstProbe = services.realtime_api.host.supervisorProbe;
  services.realtime_api.host.supervisorProbe = () => new Promise((resolve) => { release = () => resolve(firstProbe()); });
  collector.start();
  try {
    assert.equal(collector.running, true);
    services.realtime_api.host.supervisorProbe = firstProbe;
    collector.requestDetail();
    collector.requestDetail();
    release();
    for (let i = 0; i < 50 && (collector.running || !collector.current()?.detail_collected); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(collector.current().detail_collected, true, "the pass asked for while one ran ran right after it");
    assert.equal(metricsCalls, 1, "one extra pass, not one per request");
  } finally { collector.stop(); }
});

test("monitoring: with no page open, CPU is still sampled every 10 s for the trend only", async () => {
  let t = 1_000_000;
  const samples = [];
  const resources = {
    sample: async (pids) => {
      samples.push(pids);
      return new Map([[11, { availability: "OK", cpu_percent: 3, memory_bytes: 100 }]]);
    },
  };
  const collector = collectorWith({ realtime_api: running(11) }, { resources, now: () => t });

  await collector.collect();
  assert.equal(samples.length, 0, "not right after start");
  t += 10_000;
  let snap = await collector.collect();
  assert.equal(samples.length, 1, "one background sample after 10 s");
  const svc = snap.services.find((s) => s.service_id === "realtime_api");
  assert.equal(svc.resources.availability, "TEMPORARILY_UNAVAILABLE", "the snapshot still hides detail without a page");
  assert.equal(snap.totals.cpu_percent_unique_pids, null);
  t += 2_000;
  await collector.collect();
  assert.equal(samples.length, 1, "not again before the next 10 s");
  const trend = collector.current({ trendSince: 0 }).trend.map((p) => p.services.realtime_api.cpu);
  assert.deepEqual(trend, [3], "the trend carries the background sample; a pass that sampled nothing adds no empty point");
});

// The 系統 CPU / 記憶體 lines are there when the page opens (user 10-27): Electron reports its processes on its own lease,
// so the background samples carry the totals without any page having asked for detail.
test("monitoring: with no page open, the background samples carry the 系統 CPU / 記憶體 totals", async () => {
  let t = 1_000_000;
  const resources = {
    sample: async () => new Map([[11, { availability: "OK", cpu_percent: 3, memory_bytes: 100 }], [process.pid, { availability: "OK", cpu_percent: 0.5, memory_bytes: 10 }],
      [501, { availability: "OK", cpu_percent: 2, memory_bytes: 50 }]]),
  };
  const collector = collectorWith({ realtime_api: running(11) }, { resources, now: () => t });
  collector.setAppProcesses([501]);
  await collector.collect();
  for (let i = 0; i < 3; i += 1) { t += 10_000; await collector.collect(); }
  const snap = collector.current({ trendSince: 0 });
  assert.equal(snap.system.availability, "TEMPORARILY_UNAVAILABLE", "the snapshot still hides detail without a page");
  assert.deepEqual(snap.trend.map((p) => p.system), [{ cpu: 5.5, mem: 160 }, { cpu: 5.5, mem: 160 }, { cpu: 5.5, mem: 160 }]);
});

// Health is the trend's only owner (D06-05): a reader passes the time of its last point and gets only the points Health
// sampled after it -- a read between two samples gets none, so a page never has a reason to add a point of its own.
test("monitoring: the trend is read from a cursor, and a read between two samples carries no point", async () => {
  let t = 1_000_000;
  const resources = { sample: async () => new Map([[11, { availability: "OK", cpu_percent: 3, memory_bytes: 100 }]]) };
  const collector = collectorWith({ realtime_api: running(11) }, { resources, now: () => t });
  await collector.collect();
  for (let i = 0; i < 2; i += 1) { t += 10_000; await collector.collect(); }
  assert.equal(collector.current().trend, undefined, "no cursor, no trend");
  const all = collector.current({ trendSince: 0 }).trend;
  assert.deepEqual(all.map((p) => p.t), [1_010_000, 1_020_000]);
  t += 2_000;
  await collector.collect();
  assert.deepEqual(collector.current({ trendSince: all.at(-1).t }).trend, [], "nothing sampled since the cursor: no point");
  t += 8_000;
  await collector.collect();
  assert.deepEqual(collector.current({ trendSince: all.at(-1).t }).trend.map((p) => p.t), [1_030_000], "only the new sample");
});

// 連線診斷 系統 CPU and 記憶體 (user 10-20, 10-22): every StockMonitor process -- services, Health, Electron's own and
// Health's jobs -- one part per PID, the totals their sums.
test("monitoring: 系統 CPU counts Electron's processes beside the services, and only once Electron reported them", async () => {
  let t = 1_000_000;
  const samples = [];
  const resources = {
    cpus: 12,
    sample: async (pids) => {
      samples.push(pids);
      return new Map([[11, { availability: "OK", cpu_percent: 3, memory_bytes: 100 }], [process.pid, { availability: "OK", cpu_percent: 0.5, memory_bytes: 10 }],
        [501, { availability: "OK", cpu_percent: 2, memory_bytes: 50 }], [502, { availability: "OK", cpu_percent: 4, memory_bytes: 70 }],
        [601, { availability: "OK", cpu_percent: 1, memory_bytes: 300 }], [701, { availability: "OK", cpu_percent: 1, memory_bytes: 40 }],
        [702, { availability: "OK", cpu_percent: 1, memory_bytes: 60 }]]);
    },
  };
  let training = null;
  let materializer = [];
  const collector = collectorWith({ realtime_api: running(11), app_api: running(11) }, { resources, now: () => t,
    jobPids: () => ({ training: [training], materializer }) });
  collector.requestDetail();
  let snap = await collector.collect();
  assert.equal(snap.system.availability, "NO_SAMPLE", "without Electron's processes the services alone are not the App's total");
  assert.equal(snap.system.cpu_percent, null);

  assert.equal(collector.setAppProcesses([501, 502, 502, -1, "x", 1.5]), 2, "only valid, distinct PIDs");
  collector.requestDetail();
  snap = await collector.collect();
  assert.ok(samples.at(-1).includes(501) && samples.at(-1).includes(502), "Electron's PIDs are sampled with the services");
  assert.deepEqual([snap.system.availability, snap.system.cpu_percent, snap.system.cores, snap.system.app_processes], ["OK", 9.5, 12, 2],
    "3 (PID 11, shared) + 0.5 (Health) + 2 + 4");
  assert.equal(snap.system.memory_bytes, 230);
  assert.deepEqual(collector.current({ trendSince: 0 }).trend.at(-1).system, { cpu: 9.5, mem: 230 }, "the trend carries both for the 2-minute lines");
  // 記憶體 (user 10-22) from the same parts: one per process -- the two APIs share PID 11, Health its own, Electron's together.
  assert.deepEqual(snap.system.parts, [
    { id: "realtime_api", service_ids: ["realtime_api", "app_api"], cpu_percent: 3, bytes: 100 },
    { id: "service_controller", service_ids: ["service_controller"], cpu_percent: 0.5, bytes: 10 },
    { id: "app", service_ids: [], cpu_percent: 6, bytes: 120 }]);
  assert.equal(snap.memory, undefined, "no second list of the same processes");
  // Running jobs are sampled, one part per job name (materializer jobs together); none running, no part.
  training = 601;
  materializer = [701, 702];
  collector.requestDetail();
  snap = await collector.collect();
  assert.ok([601, 701, 702].every((pid) => samples.at(-1).includes(pid)), "the jobs' PIDs are sampled with the rest");
  assert.deepEqual(snap.system.parts.slice(-2), [{ id: "training", service_ids: [], cpu_percent: 1, bytes: 300 },
    { id: "materializer", service_ids: [], cpu_percent: 2, bytes: 100 }]);
  assert.deepEqual([snap.system.cpu_percent, snap.system.memory_bytes], [12.5, 630], "the jobs count in both totals");
  training = null;
  materializer = [];
  collector.requestDetail();
  snap = await collector.collect();
  assert.ok(!snap.system.parts.some((p) => p.id === "training" || p.id === "materializer"));

  // A set Electron stopped renewing is dropped after the trend's span: a reused PID is never counted long after.
  t += 5 * 60_000 + 1;
  collector.requestDetail();
  snap = await collector.collect();
  assert.equal(snap.system.availability, "NO_SAMPLE");
  assert.ok(!samples.at(-1).includes(501));
});

test("monitoring: 儲存空間 is walked at most once a minute, only while detail is wanted, parts never counted twice", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { StorageUsage } = require("../health/monitoring/storage_usage.js");
  const root = makeTempDir("storage-usage-");
  try {
    const put = (rel, bytes) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes)); };
    const { storagePaths } = require("../config/js/var_paths.js");
    put("var/data/historical/source=shioaji/a.parquet", 1000);
    put("var/data/historical/analysis-events/2026-10-27.jsonl", 400);
    put("var/data/historical/model/online_registry/m.onnx", 70);
    put("var/data/live-engine/wal/seg-1", 300);
    put("var/data/analysis-runtime/state.bin", 200);
    put("var/data/market/cache.json", 50);
    put("var/data/model/online_training/status.json", 20);
    put("var/logs/x.log", 5);
    put("zdrive/store/source=futu/b.parquet", 4000);
    put("zdrive/store/analysis-events/2026-10-28.jsonl", 600);
    const varRoot = path.join(root, "var"), dataRoot = path.join(varRoot, "data");
    let storageAt = path.join(dataRoot, "historical");
    // Z:\ is another disk: its paths are read from <root>/zdrive, and its size is its own.
    const onZ = (p) => /^z:/i.test(String(p));
    const zdrive = (p) => (onZ(p) ? path.join(root, "zdrive", String(p).slice(3)) : p);
    const fsImpl = { promises: { readdir: (p, o) => fs.promises.readdir(zdrive(p), o), stat: (p) => fs.promises.stat(zdrive(p)),
      statfs: (p) => (!onZ(p) ? fs.promises.statfs(p) : fs.existsSync(zdrive(p)) ? Promise.resolve({ bsize: 1, blocks: 9000, bavail: 4000 })
        : Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }))) } };
    let t = 0;
    const usage = new StorageUsage({ varRoot, dataRoot, storagePaths: () => storagePaths(storageAt), fsImpl, now: () => t, logger: { warn() {} } });
    assert.equal(usage.current().availability, "NO_SAMPLE");
    const walk = await usage.walk();
    assert.deepEqual(walk.parts.map((p) => [p.id, p.label, p.bytes]),
      [["historical", "歷史資料", 1000], ["events", "分析事件", 400], ["model", "模型訓練", 70], ["wal", "WAL", 300], ["analysis", "分析", 200],
        ["market", "行情", 50], ["other", "其他", 25]], "the storage children are counted once: not in 歷史資料, not in 其他");
    assert.equal(walk.total_bytes, 2045);
    // The disk the storage location is on (user 10-28): here VAR_ROOT's own.
    assert.equal(walk.disk.root.toLowerCase(), path.parse(path.resolve(varRoot)).root.toLowerCase());
    assert.ok(walk.disk.total_bytes > 0 && walk.disk.free_bytes >= 0 && walk.disk.free_bytes <= walk.disk.total_bytes);
    // The storage location on another disk (設定 → 資料儲存): its parts are counted where they are now, the card's disk is
    // that one with its own size, and 其他 holds the old folder.
    storageAt = "Z:\\store";
    const moved = await usage.walk();
    assert.deepEqual(moved.parts.map((p) => [p.id, p.bytes]),
      [["historical", 4000], ["events", 600], ["model", 0], ["wal", 300], ["analysis", 200], ["market", 50], ["other", 1495]]);
    assert.deepEqual([moved.disk.root.toLowerCase(), moved.disk.total_bytes, moved.disk.free_bytes], ["z:\\", 9000, 4000]);
    storageAt = path.join(dataRoot, "historical");

    // refreshIfDue: one walk per minute; the snapshot carries the last finished one.
    usage.refreshIfDue();
    await usage.walking;
    assert.equal(usage.current().availability, "OK");
    const first = usage.current().sampled_at;
    t += 30_000;
    usage.refreshIfDue();
    assert.equal(usage.walking, null, "not again within the minute");
    t += 30_000;
    usage.refreshIfDue();
    assert.ok(usage.walking, "again after a minute");
    await usage.walking;
    assert.notEqual(usage.current().sampled_at, first);

    // A walk that fails is reported, not a zero.
    const denied = { promises: { ...fs.promises, statfs: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) } };
    const broken = new StorageUsage({ varRoot, dataRoot, storagePaths: () => storagePaths(storageAt), fsImpl: denied, now: () => t, logger: { warn() {} } });
    broken.refreshIfDue();
    await broken.walking;
    assert.equal(broken.current().availability, "TEMPORARILY_UNAVAILABLE");

    // The collector walks only while a page wants detail.
    let walks = 0;
    const storage = { refreshIfDue: () => { walks += 1; }, current: () => ({ availability: "OK", total_bytes: 1 }) };
    const collector = new MonitoringCollector({ services: {}, effective, manifest, configStore: null, resources: null,
      logger: { warn() {} }, storage });
    let snap = await collector.collect();
    assert.equal(walks, 0);
    assert.equal(snap.storage.availability, "TEMPORARILY_UNAVAILABLE", "hidden without a page");
    collector.requestDetail();
    snap = await collector.collect();
    assert.equal(walks, 1);
    assert.equal(snap.storage.total_bytes, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("monitoring: OpenD reports the endpoint it knocked on; an API's start time is not in the descriptor", async () => {
  let open = false;
  const services = {
    external_futu_opend: { host: { reachable: async () => open } },
    app_api: { host: { supervisorProbe: async () => ({ alive: true, verified: true, pid: 12, instance_id: "a-1", started_at: "2026-10-03T01:00:00+08:00" }) },
      state: () => "RUNNING" },
  };
  const collector = collectorWith(services);
  let snap = await collector.collect();
  let opend = snap.services.find((s) => s.service_id === "external_futu_opend");
  assert.equal(opend.state_reason, "unreachable");
  assert.deepEqual(opend.addresses.observed, { host: opend.addresses.effective.host, port: opend.addresses.effective.port, verified: false });
  open = true;
  snap = await collector.collect();
  opend = snap.services.find((s) => s.service_id === "external_futu_opend");
  assert.equal(opend.state_reason, "reachable");
  assert.equal(opend.addresses.observed.verified, true);
  // A service descriptor carries no start time: a probe's started_at is not relayed.
  assert.equal("started_at" in snap.services.find((s) => s.service_id === "app_api"), false);
});

test("health main: the OpenD knock reads the endpoint at probe time, not at boot", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "health", "main.js"), "utf8");
  assert.ok(/reachable: \(\) => \{\s*const \{ host, port \} = effective\.services\.external_futu_opend/.test(source));
});

test("python service host: no started_at in its probe", async () => {
  const { PythonServiceHost } = require("../health/services/python_service_host.js");
  const host = Object.create(PythonServiceHost.prototype);
  Object.assign(host, { serviceId: "app_api", child: null });
  Object.defineProperty(host, "endpoint", { value: { host: "127.0.0.1", port: 1 } });
  host.portPresent = async () => true;
  host.identity = async () => ({ answered: true, verified: true, body: { pid: 5, instance_id: "a", started_at: "2026-10-03T01:00:00Z" } });
  assert.equal((await host.supervisorProbe()).started_at, undefined);
});

test("hosts: a closed port is known by the TCP knock alone; an open one must prove its identity", async () => {
  // The identity request (1.5 s) / authenticated WebSocket health waited out its timeout on a port nothing listened on,
  // at every start of every service (2026-10-14).
  const { PythonServiceHost } = require("../health/services/python_service_host.js");
  const api = Object.create(PythonServiceHost.prototype);
  Object.assign(api, { serviceId: "app_api", child: null });
  Object.defineProperty(api, "endpoint", { value: { host: "127.0.0.1", port: 1 } });
  let asked = 0, open = false;
  api.portPresent = async () => open;
  api.identity = async () => { asked += 1; return { answered: true, verified: false, reason: "identity does not match" }; };
  const closed = await api.supervisorProbe();
  assert.deepEqual([closed.occupied, closed.verified, closed.reason, asked], [false, false, "port closed", 0], "no identity call on a closed port");
  open = true;
  const foreign = await api.supervisorProbe();
  assert.deepEqual([foreign.occupied, foreign.verified, asked], [true, false, 1], "an open port is asked who it is");
  await assert.rejects(api.ensure(), /unverified occupant.*not killed/, "a foreign listener is neither adopted nor killed");

  // A verified instance is asked directly at the next probe (no knock: A logged each one as a failed handshake);
  // the knock comes back only when that identity fails.
  let knocks = 0;
  api.portPresent = async () => { knocks += 1; return true; };
  api.identity = async () => ({ answered: true, verified: true, body: { pid: 5, instance_id: "a" } });
  await api.supervisorProbe();
  const before = knocks;
  await api.supervisorProbe();
  assert.equal(knocks, before, "no knock for an instance verified last time");
  api.identity = async () => ({ answered: false, verified: false, reason: "timeout" });
  const lost = await api.supervisorProbe();
  assert.deepEqual([lost.verified, lost.occupied, knocks], [false, true, before + 1], "an unanswered identity is followed by the knock");

  const runtime = runtimeHost(null).host;
  let wsAsked = 0;
  runtime.portPresent = async () => false;
  runtime.health = async () => { wsAsked += 1; return null; };
  const none = await runtime.supervisorProbe();
  assert.deepEqual([none.occupied, none.verified, wsAsked], [false, false, 0]);
  runtime.portPresent = async () => true;
  const silent = await runtime.supervisorProbe();
  assert.deepEqual([silent.occupied, silent.verified, wsAsked], [true, false, 1], "an open port that does not answer health is an occupant");
});
