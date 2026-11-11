"use strict";

// Health's shared monitoring snapshot (docs/system-architecture/07).
//
// Every 2 s (versioned default) Health probes each managed service through its own protocol, reads its metrics,
// samples OS resources per unique PID, and publishes ONE snapshot that Electron main shares with every settings
// window -- renderers never scan services themselves. Detail (metrics + resources) is only collected while some
// window has asked within the last few seconds; liveness probing continues regardless. The last 5 minutes are
// kept as a compact trend. A failed metric read marks only that service's metrics stale and keeps the last values.

const { serviceDescriptor, staleMetric } = require("../../config/js/observability_contract.js");

const PUBLISH_MS = 2000;
const TREND_MS = 5 * 60 * 1000;
const DETAIL_TTL_MS = 8000;
// With no page open, CPU / memory are still sampled this often -- for the trend only -- so a page that opens has
// the last 2 minutes to draw instead of a line that starts at the moment it opened. One CIM query per 10 s.
const BACKGROUND_RESOURCE_MS = 10_000;
// Electron's own processes (main, renderers, GPU, utility) are reported by Electron main on its own lease, page open or
// not (the background trend needs them for a total), and with each detail request; a set not renewed within the trend's
// span is dropped, so a reused PID is never counted long after the App's process ended.
const APP_PIDS_TTL_MS = TREND_MS;
const MAX_APP_PIDS = 64;
const HIDDEN_DETAIL = Object.freeze({ availability: "TEMPORARILY_UNAVAILABLE", reason: "detail is collected only while a monitoring page is visible" });

// A race against a timer that is always cleared: a successful probe must not leave its losing 2-2.5 s timer
// alive.
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class MonitoringCollector {
  constructor({ services, effective, manifest, configStore, resources, logger = console, now = Date.now, publishMs = PUBLISH_MS,
    extraStatus = () => ({}), storage = null, jobPids = () => ({}) }) {
    this.services = services;        // service_id -> { host, enabled(), managed, kind, state() }
    this.effective = effective;
    this.manifest = manifest;
    this.configStore = configStore;
    this.resources = resources;
    this.logger = logger;
    this.now = now;
    this.publishMs = publishMs;
    this.extraStatus = extraStatus;
    this.storage = storage;
    this.jobPids = jobPids;          // () -> { job name -> PIDs of Health's running job children }
    this.appPids = [];
    this.appPidsAt = 0;
    this.timer = null;
    this.snapshot = null;
    this.trend = [];
    this.lastMetrics = new Map();
    this.failing = new Set();        // "probe:<sid>" / "metrics:<sid>" whose current failure streak is already logged
    this.detailRequestedAt = 0;
    this.lastResourceAt = now();
    this.running = false;
    this.again = false;
    this.costs = [];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.publishMs);
    this.timer.unref?.();
    void this.tick();
  }

  // One pass at a time; a pass asked for while one runs (detail just turned on) runs right after it.
  async tick() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        try { await this.collect(); } catch (error) { this.logger.warn(`[HEALTH] monitoring collect failed: ${error?.message || error}`); }
      } while (this.again && this.timer);
    } finally { this.running = false; }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.resources?.stop?.();
  }

  // A monitoring page that just opened gets its numbers from a pass run now, not the next timed one: the snapshot it
  // first reads was collected without detail, so its cards would wait up to a whole interval more (user 10-19).
  requestDetail() {
    const wasWanted = this.detailWanted();
    this.detailRequestedAt = this.now();
    if (!wasWanted && this.timer) void this.tick();
  }

  // 系統 CPU counts the App's own Electron processes beside the services (user 10-20).
  setAppProcesses(pids) {
    const valid = (Array.isArray(pids) ? pids : []).filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, MAX_APP_PIDS);
    this.appPids = [...new Set(valid)];
    this.appPidsAt = this.now();
    return this.appPids.length;
  }

  currentAppPids() {
    if (this.appPids.length && this.now() - this.appPidsAt > APP_PIDS_TTL_MS) this.appPids = [];
    return this.appPids;
  }

  detailWanted() { return this.now() - this.detailRequestedAt < DETAIL_TTL_MS; }

  savedAddress(sid) {
    const latest = this.configStore?.latest?.();
    const entry = latest?.values?.services?.[sid];
    return entry ? { revision: latest.revision, ...entry } : null;
  }

  async describe(sid, spec, entry) {
    const eff = this.effective.services[sid] || {};
    const addresses = {
      default: spec.default_port === null ? null : { host: this.manifest.loopback_host, port: spec.default_port },
      saved: this.savedAddress(sid),
      effective: eff.port === null ? null : { host: eff.host, port: eff.port, source: eff.source, revision: this.effective.revision },
      observed: null,
    };
    if (spec.kind === "external") {
      const reachable = entry?.host ? await entry.host.reachable().catch(() => /* not an error: an unreachable endpoint is the probe's answer (false) */ false) : null;
      // The endpoint that was actually knocked on, and whether it answered (連線診斷 OpenD 端點 / TCP 探測).
      if (reachable !== null && addresses.effective) addresses.observed = { host: eff.host, port: eff.port, verified: Boolean(reachable) };
      return serviceDescriptor({ serviceId: sid, displayName: spec.display_name, addresses, state: "EXTERNAL",
        stateReason: reachable === null ? "not probed" : (reachable ? "reachable" : "unreachable"), observedAt: new Date(this.now()).toISOString() });
    }
    if (!entry) {
      return serviceDescriptor({ serviceId: sid, displayName: spec.display_name, addresses, state: "UNKNOWN",
        stateReason: "no host registered", observedAt: new Date(this.now()).toISOString() });
    }
    if (entry.enabled && entry.enabled() === false) {
      return serviceDescriptor({ serviceId: sid, displayName: spec.display_name, addresses, state: "DISABLED",
        stateReason: "disabled by source settings", observedAt: new Date(this.now()).toISOString() });
    }
    let probe = null;
    let state = entry.state ? entry.state() : null;
    if (state === "STARTING") {
      // Its start is under way and the Supervisor says how far (a host reports its own progress): probing a port the
      // process is still binding tells nothing more, and doubled every start's identity requests.
      probe = { alive: false, reason: entry.stateReason?.() || "starting" };
    } else {
      try {
        probe = await withTimeout(entry.host.supervisorProbe(), 2500, "probe timeout");
        this.failing.delete(`probe:${sid}`);
      } catch (error) {
        this.recordFailureOnce(`probe:${sid}`, error);
        probe = { alive: false, reason: String(error?.message || error), timeout: true };
      }
    }
    if (!state) state = probe.alive ? "RUNNING" : (probe.timeout ? "STALE" : (probe.occupied ? "UNKNOWN" : "FAILED"));
    if (probe.alive && eff.port !== null && eff.port !== undefined) addresses.observed = { host: eff.host, port: probe.port ?? eff.port, verified: true };
    const pending = this.configStore ? ((this.configStore.pointer().latest || 0) !== (this.configStore.pointer().active || 0) ? "network revision pending apply" : null) : null;
    const descriptor = serviceDescriptor({ serviceId: sid, displayName: spec.display_name, instanceId: probe.instance_id || null, pid: probe.pid || null,
      protocol: spec.protocol, addresses, configRevision: probe.config_revision ?? null, pendingOperation: pending,
      state, stateReason: probe.reason || entry.stateReason?.() || null, observedAt: new Date(this.now()).toISOString() });
    // The child's output log is part of what this service can be audited by: its sink health travels with it.
    const logSink = entry.host?.logSinkHealth?.() ?? null;
    return logSink ? { ...descriptor, log_sink: logSink } : descriptor;
  }

  // A service that stays down fails every cycle: its streak is logged at the first failure, again only after a success.
  recordFailureOnce(key, error) {
    if (this.failing.has(key)) return;
    this.failing.add(key);
    this.logger.warn(`[HEALTH] monitoring ${key} failed: ${error?.message || error}`);
  }

  async collect() {
    const started = Date.now();
    const detail = this.detailWanted();
    const descriptors = [];
    const table = this.manifest.services;
    for (const spec of table) {
      if (spec.kind === "worker") continue;
      descriptors.push(this.describe(spec.service_id, spec, this.services[spec.service_id]));
    }
    const described = await Promise.all(descriptors);
    const metrics = {};
    if (detail) {
      await Promise.all(described.map(async (d) => {
        const entry = this.services[d.service_id];
        if (!entry?.host?.metrics || d.state !== "RUNNING") return;
        try {
          const doc = await withTimeout(entry.host.metrics(), 2000, "metrics timeout");
          metrics[d.service_id] = { availability: "OK", sampled_at: new Date(this.now()).toISOString(), document: doc };
          this.lastMetrics.set(d.service_id, metrics[d.service_id]);
          this.failing.delete(`metrics:${d.service_id}`);
        } catch (error) {
          this.recordFailureOnce(`metrics:${d.service_id}`, error);
          const last = this.lastMetrics.get(d.service_id);
          // The last values stay, marked stale (07 section 2); never replaced by zeros.
          metrics[d.service_id] = last ? staleMetric(last, { reason: String(error?.message || error), sampledAt: new Date(this.now()).toISOString() })
            : { availability: "TEMPORARILY_UNAVAILABLE", reason: String(error?.message || error) };
        }
      }));
    }
    let resources = new Map();
    const background = !detail && this.now() - this.lastResourceAt >= BACKGROUND_RESOURCE_MS;
    const appPids = this.currentAppPids();
    const jobs = Object.entries(this.jobPids() || {}).map(([name, pids]) => [name, (pids || []).filter((pid) => Number.isInteger(pid) && pid > 0)])
      .filter(([, pids]) => pids.length);
    if (detail) this.storage?.refreshIfDue();
    const sampledResources = Boolean((detail || background) && this.resources);
    if (sampledResources) {
      const pids = described.map((d) => d.pid).filter(Boolean);
      pids.push(process.pid, ...appPids, ...jobs.flatMap(([, jobPids]) => jobPids));
      resources = await this.resources.sample(pids);
      this.lastResourceAt = this.now();
    }
    const seenPids = new Set();
    let totalCpu = 0;
    let totalWs = 0;
    const services = described.map((d) => {
      const res = detail && d.pid ? resources.get(d.pid) : null;
      if (d.pid && res?.availability === "OK" && !seenPids.has(d.pid)) {
        seenPids.add(d.pid);
        totalCpu += res.cpu_percent || 0;
        totalWs += res.working_set_bytes || 0;
      }
      return { ...d, resources: res || (detail ? { availability: d.pid ? "NO_SAMPLE" : "NOT_APPLICABLE" } : HIDDEN_DETAIL),
        metrics: metrics[d.service_id] || (detail ? { availability: d.state === "RUNNING" ? "NO_SAMPLE" : "NOT_APPLICABLE" } : HIDDEN_DETAIL) };
    });
    const cost = Date.now() - started;
    this.costs.push(cost);
    if (this.costs.length > 150) this.costs.shift();
    const healthRes = detail ? resources.get(process.pid) : null;
    const system = appProcesses(resources, described, appPids, jobs, this.resources?.cpus ?? null);
    const pointer = this.configStore?.pointer?.() || null;
    this.snapshot = {
      schema: "stock-monitor-monitoring-snapshot-v1", sampled_at: new Date(this.now()).toISOString(), publish_interval_ms: this.publishMs,
      trend_retention_ms: TREND_MS, detail_collected: detail,
      services,
      reserved_ports: this.effective.reserved_ports.map((port) => ({ port, state: "RESERVED", note: "unassigned: no listener" })),
      totals: { cpu_percent_unique_pids: detail ? totalCpu : null, working_set_bytes_unique_pids: detail ? totalWs : null, unique_pids: seenPids.size,
        note: "summed over the unique PID set; a shared PID is counted once" },
      // 系統 CPU and 記憶體: every StockMonitor process (services, Health, Electron, Health's jobs), one part each.
      system: detail ? system : HIDDEN_DETAIL,
      storage: detail ? (this.storage?.current() ?? { availability: "NOT_APPLICABLE" }) : HIDDEN_DETAIL,
      health: { pid: process.pid, collection_cost_ms: cost, resource_query_ms: this.resources?.lastCostMs ?? null,
        collection_cost_p95_ms: [...this.costs].sort((a, b) => a - b)[Math.floor(this.costs.length * 0.95)] ?? null,
        resources: healthRes || null, ...this.extraStatus() },
      config: { network: pointer, pending_apply: pointer ? (pointer.latest || 0) !== (pointer.active || 0) : false,
        effective_revision: this.effective.revision ?? null },
    };
    // A point per pass that sampled resources: a pass between two background samples measured nothing, so it adds no
    // point rather than an empty one that would read as a missing sample.
    if (sampledResources) this.trend.push({ t: this.now(), system: { cpu: system.cpu_percent, mem: system.working_set_bytes }, services: Object.fromEntries(services.map((s) => {
      const sampled = s.pid ? resources.get(s.pid) : null;
      return [s.service_id, { state: s.state, cpu: sampled?.cpu_percent ?? null, ws: sampled?.working_set_bytes ?? null }];
    })) });
    const floor = this.now() - TREND_MS;
    while (this.trend.length && this.trend[0].t < floor) this.trend.shift();
    return this.snapshot;
  }

  // Reading the snapshot does not turn detail on: only a visible monitoring page does (ui-scope -> requestDetail).
  // The trend is Health's alone: a reader passes the time of the last point it holds (0 for none) and gets the points
  // sampled after it, so it only ever draws points Health took -- never one of its own per snapshot it read.
  current({ trendSince = null } = {}) {
    if (trendSince === null || !this.snapshot) return this.snapshot;
    return { ...this.snapshot, trend: this.trend.filter((point) => point.t > trendSince) };
  }
}

// 系統 CPU and 記憶體 (user 10-20, 10-22): every StockMonitor process, counted once per PID, as one list of parts --
// each service PID (services sharing a PID are one part), Health's own, Electron's processes together as "app", and the
// jobs Health is running (training, materializer) one part per job name, its processes together -- each with its CPU
// (a share of the whole computer, 100% = every core busy) and working set; the totals are the parts' sums. Grouping
// them is the screen's. Without Electron's main process sampled (no window has asked yet, the first pass, a CIM failure)
// the parts would read as the App's whole: none are given then.
function appProcesses(resources, described, appPids, jobs, cores) {
  // cores: 目前無使用，之後要刪除（連線診斷不再顯示核心數，使用者 10-20）。
  const base = { cores, app_processes: appPids.length };
  if (!appPids.length || resources.get(appPids[0])?.availability !== "OK") {
    return { ...base, availability: "NO_SAMPLE", reason: appPids.length ? "no sample for this pass yet" : "Electron has not reported its processes",
      cpu_percent: null, working_set_bytes: null };
  }
  const servicesOf = new Map();
  for (const d of described) if (d.pid) servicesOf.set(d.pid, [...(servicesOf.get(d.pid) || []), d.service_id]);
  if (!servicesOf.has(process.pid)) servicesOf.set(process.pid, ["service_controller"]);
  const part = (id, service_ids, pids) => {
    const sampled = [...new Set(pids)].map((pid) => resources.get(pid)).filter((res) => res?.availability === "OK");
    return sampled.length ? { id, service_ids, cpu_percent: sampled.reduce((sum, res) => sum + (res.cpu_percent || 0), 0),
      bytes: sampled.reduce((sum, res) => sum + (res.working_set_bytes || 0), 0) } : null;
  };
  const parts = [...servicesOf].filter(([pid]) => !appPids.includes(pid)).map(([pid, ids]) => part(ids[0], ids, [pid]));
  parts.push(part("app", [], appPids));
  for (const [name, pids] of jobs) parts.push(part(name, [], pids.filter((pid) => !servicesOf.has(pid) && !appPids.includes(pid))));
  const sampled = parts.filter(Boolean);
  return { ...base, availability: "OK", cpu_percent: Math.min(100, sampled.reduce((sum, p) => sum + p.cpu_percent, 0)),
    working_set_bytes: sampled.reduce((sum, p) => sum + p.bytes, 0), parts: sampled };
}

module.exports = { MonitoringCollector, PUBLISH_MS, TREND_MS };
