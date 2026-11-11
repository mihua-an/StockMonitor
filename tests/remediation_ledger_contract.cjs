"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The remediation event contract (docs/BACKLOG.md): one schema, one registry, one writer (Health), reached through one pipe.
// Proves, over a real local pipe: admission against the registry, the started/result linkage, at-least-once delivery
// with dedupe, the client's loss marker, the writer's own loss marker, rotation, the terminal marker, today's counts
// surviving a writer restart, daily summaries equal to their raw events, and Health's Supervisor emission.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contract = require("../config/js/remediation_contract.js");
const { createRemediationClient, createEmitter } = require("../service/platform/js/remediation_client.js");
const { RemediationLedger, HEADER_SCHEMA, MARKER_SCHEMA, localDay } = require("../health/remediation/ledger.js");
const { Supervisor } = require("../health/supervisor.js");

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 8000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}
const proc = (service_id) => ({ service_id, instance_id: `${service_id}-1`, pid: process.pid, runtime: "node" });
const uniquePipe = (logs, tag) => contract.pipePath({ logsRoot: path.join(logs, `${tag}-${process.pid}`) });

function readLines(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith("remediation-")).sort()
    .flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}
function events(dir) { return readLines(dir).filter((r) => r.schema === contract.loadRegistry().event_schema); }

function newLedger(root, extra = {}) {
  const logs = path.join(root, "logs");
  return new RemediationLedger({ logsRoot: logs, sessionDir: path.join(logs, "20261009_090000-abcdef"),
    summaryDir: path.join(root, "output", "remediation", "daily"), logger: quiet,
    writer: { service_id: "service_controller", instance_id: "health-1", pid: process.pid }, ...extra });
}

(async () => {
  const root = makeTempDir("remediation-ledger-");
  try {
    // ---- the contract's admission rules
    const good = contract.createEvent({ process: proc("electron_main"), component: "test", mechanismId: "health.service_restart",
      triggerReason: "service_not_alive", identity: { code: "2330" }, outcome: "succeeded", detail: { api_key: "x", n: 1 } });
    assert.equal(contract.validateEvent(good), null);
    assert.equal(good.detail.api_key, undefined, "credential-like detail is dropped when built");
    assert.deepEqual(Object.keys(good.identity), contract.loadRegistry().identity_fields);
    assert.match(contract.validateEvent({ ...good, mechanism_id: "made.up" }), /unregistered mechanism_id/);
    assert.match(contract.validateEvent({ ...good, trigger_reason: "free text" }), /not registered/);
    const { code: _code, ...partialIdentity } = good.identity;
    assert.match(contract.validateEvent({ ...good, identity: partialIdentity }), /identity\.code missing/);
    assert.match(contract.validateEvent({ ...good, detail: { session_key: "x" } }), /credential/);
    assert.match(contract.validateEvent({ ...good, outcome: "started" }), /started event must carry the operation_id/);
    assert.match(contract.validateEvent({ ...good, operation_id: "op-1" }), /together/);
    assert.match(contract.validateEvent({ ...good, at: "yesterday" }), /ISO-8601/);
    assert.throws(() => contract.encodeFrame({ ...good, detail: { big: "x".repeat(70000) } }), /exceeds/);

    // ---- a client and the writer over a real pipe
    const ledger = newLedger(root, { pipePath: uniquePipe(root, "main") });
    await ledger.start();
    assert.equal(ledger.stats.listening, true);
    const client = createRemediationClient({ process: proc("electron_main"), pipePath: ledger.pipePath, logger: quiet });
    const op = client.begin({ component: "supervisor", mechanismId: "health.service_restart", triggerReason: "service_not_alive",
      identity: {}, detail: { service_id: "app_api" } });
    assert.equal(ledger.status().active_operations.length, 0, "not delivered yet");
    await until(() => client.flush(200), 8000, "started event delivered");
    assert.equal(ledger.status().active_operations.length, 1);
    op.finish("succeeded", { attempt: 1, detail: { pid: 42 } });
    op.finish("failed", { attempt: 2 });   // a second terminal outcome is ignored
    client.emit({ component: "x", mechanismId: "not.registered", triggerReason: "x", identity: {}, outcome: "failed" });
    assert.equal(await client.flush(4000), true);
    await ledger.flush();
    const written = events(ledger.sessionDir);
    assert.equal(written.length, 2, "started + one terminal; the unregistered event is refused, not written");
    assert.equal(written[1].related_upstream_event_id, written[0].event_id);
    assert.equal(written[1].operation_id, written[0].operation_id);
    assert.equal(ledger.stats.rejected, 1);
    assert.match(ledger.stats.last_rejection.reason, /unregistered/);
    const status = ledger.status();
    assert.equal(status.active_operations.length, 0);
    const restart = status.mechanisms.find((m) => m.mechanism_id === "health.service_restart");
    assert.equal(restart.today, 1);
    assert.deepEqual(restart.total, { started: 1, succeeded: 1 });
    assert.ok(status.zero_expected_violations.includes("health.service_restart"));
    assert.equal(status.recent[0].outcome, "succeeded");
    assert.equal(readLines(ledger.sessionDir)[0].schema, HEADER_SCHEMA);

    // A resent frame (the ack was lost) is written once.
    assert.equal(ledger.accept(written[0]), true);
    assert.equal(ledger.stats.duplicates, 1);

    // ---- the client's loss marker: the writer is unreachable, its queue overflows, delivery resumes
    const lateLedger = newLedger(path.join(root, "late"), { pipePath: uniquePipe(root, "late") });
    const late = createRemediationClient({ process: proc("electron_main"), pipePath: lateLedger.pipePath, logger: quiet });
    const limit = contract.loadRegistry().limits.client_queue_events;
    for (let i = 0; i <= limit + 1; i += 1) {
      late.emit({ component: "t", mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" });
    }
    assert.equal(late.status().dropped_total, 2);
    assert.equal(late.status().unreported_loss, 2);
    await lateLedger.start();
    await until(async () => (await late.flush(300)) && late.status().queued === 0, 20000, "late delivery");
    await lateLedger.flush();
    const lateEvents = events(lateLedger.sessionDir);
    const marker = lateEvents.find((e) => e.mechanism_id === "sink.client_loss");
    assert.ok(marker, "the loss is recorded once delivery works again");
    assert.equal(marker.trigger_reason, "sink_unreachable");
    assert.equal(marker.detail.lost_events, 2);
    assert.equal(lateEvents.filter((e) => e.mechanism_id === "market.wal_tail_repair").length, limit);
    late.close();
    await lateLedger.close("test");

    // An unconfigured client counts what it cannot record.
    const unconfigured = createRemediationClient({ process: proc("t"), pipePath: "", logger: quiet });
    unconfigured.emit({ component: "t", mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" });
    assert.equal(unconfigured.status().configured, false);
    assert.equal(unconfigured.status().unreported_loss, 1);

    // ---- the writer's own loss: a failed write keeps the lines, the overflow is counted and recorded afterwards
    let failOpens = 1;
    const flakyFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
      if (failOpens > 0) { failOpens -= 1; throw new Error("disk unavailable"); }
      return fs.promises.open(...args);
    } } };
    const flaky = newLedger(path.join(root, "flaky"), { fsImpl: flakyFs, maxQueueLines: 2 });
    await flaky.start();
    const emitFlaky = createEmitter({ process: proc("service_controller"), deliver: (e) => flaky.accept(e) });
    for (let i = 0; i < 3; i += 1) {
      emitFlaky.emit({ component: "t", mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" });
    }
    await until(() => flaky.stats.write_errors === 1, 3000, "the first write fails");
    assert.equal(flaky.stats.dropped, 1, "the third line overflowed the bounded queue");
    assert.equal(await flaky.flush(), true);
    const flakyEvents = events(flaky.sessionDir);
    const writerLoss = flakyEvents.find((e) => e.mechanism_id === "sink.writer_loss");
    assert.ok(writerLoss);
    assert.equal(writerLoss.outcome, "failed");
    assert.equal(writerLoss.trigger_reason, "queue_full", "the line lost is the one that overflowed the queue during the failed write");
    assert.equal(writerLoss.detail.lost_events, 1);
    assert.match(writerLoss.detail.last_error, /disk unavailable/);
    assert.equal(flakyEvents.filter((e) => e.mechanism_id === "market.wal_tail_repair").length, 2);
    await flaky.close("test");

    // ---- rotation past the size limit, and the terminal marker
    const small = newLedger(path.join(root, "rotate"), { rotateBytes: 600 });
    await small.start();
    const emitSmall = createEmitter({ process: proc("service_controller"), deliver: (e) => small.accept(e) });
    for (let i = 0; i < 4; i += 1) {
      emitSmall.emit({ component: "t", mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" });
      await small.flush();
    }
    await small.close("test_shutdown");
    const rotated = fs.readdirSync(small.sessionDir).filter((n) => n.startsWith("remediation-")).sort();
    assert.ok(rotated.length >= 2, `rotated into ${rotated.length} files`);
    assert.match(rotated[1], /-002\.jsonl$/);
    const lastRecord = readLines(small.sessionDir).at(-1);
    assert.equal(lastRecord.schema, MARKER_SCHEMA);
    assert.equal(lastRecord.kind, "terminal");
    assert.equal(lastRecord.flushed, true);
    assert.equal(lastRecord.written, 4);

    // ---- today's counts survive a writer restart; a finished day's summary equals its raw events
    let clock = new Date(2026, 9, 9, 23, 59, 0);
    const dayRoot = path.join(root, "days");
    const first = newLedger(dayRoot, { now: () => clock });
    await first.start();
    const emitDay = createEmitter({ process: proc("service_controller"), deliver: (e) => first.accept(e) });
    const dayOp = emitDay.begin({ component: "t", mechanismId: "health.service_restart", triggerReason: "service_not_alive", identity: { code: "A" },
      detail: { service_id: "market_runtime" } });
    dayOp.finish("failed", { attempt: 3 });
    emitDay.emit({ component: "t", mechanismId: "health.service_restart", triggerReason: "restart_budget_exhausted", identity: { code: "B" }, outcome: "abandoned",
      detail: { service_id: "provider_futu" } });
    await first.close("test");
    // The events carry the real time; the writer's clock is the test's. Re-stamp them onto the test day.
    for (const name of fs.readdirSync(first.sessionDir)) {
      const file = path.join(first.sessionDir, name);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").map((line) => {
        if (!line) return line;
        const record = JSON.parse(line);
        if (record.schema === contract.loadRegistry().event_schema) record.at = contract.localIso(clock);
        return JSON.stringify(record);
      }).join("\n"));
    }
    const second = newLedger(dayRoot, { now: () => clock });
    await second.start();
    assert.equal(second.status().mechanisms.find((m) => m.mechanism_id === "health.service_restart").today, 2,
      "today's count comes back from the raw files");
    // Which service each restart was about (detail.service_id), for 系統拓樸's Health (user 10-19).
    assert.deepEqual(second.status().mechanisms.find((m) => m.mechanism_id === "health.service_restart").today_by_service,
      { market_runtime: 1, provider_futu: 1 });
    clock = new Date(2026, 9, 10, 0, 0, 30);
    second.checkDay();
    await until(() => fs.existsSync(path.join(second.summaryDir, "20261009.json")), 3000, "the finished day's summary");
    const summary = JSON.parse(fs.readFileSync(path.join(second.summaryDir, "20261009.json"), "utf8"));
    const day = summary.mechanisms["health.service_restart"];
    assert.equal(day.attempts, 2);
    assert.equal(day.failures, 1);
    assert.equal(day.abandoned, 1);
    assert.equal(day.unique_identity_count, 2);
    assert.equal(day.max_attempt, 3);
    assert.equal(day.zero_expected_violation, true);
    assert.deepEqual(day.top_trigger_reasons, [{ reason: "restart_budget_exhausted", count: 1 }, { reason: "service_not_alive", count: 1 }]);
    assert.deepEqual(summary.mechanisms, second.buildSummary("20261009").mechanisms, "a summary is its raw events");
    const after = second.status().mechanisms.find((m) => m.mechanism_id === "health.service_restart");
    assert.equal(after.today, 0);
    assert.equal(after.last_7_days, 2);
    assert.deepEqual(day.by_service, { market_runtime: 1, provider_futu: 1 }, "the day's summary keeps the services");
    assert.deepEqual(after.today_by_service, {});
    assert.deepEqual(after.last_7_days_by_service, { market_runtime: 1, provider_futu: 1 }, "7 days read the finished day's summary");

    // An event of 10-09 resent two days later (written into a 10-11 file) counts in 10-09's summary -- the
    // running writer rewrites it, and so does the next start.
    clock = new Date(2026, 9, 11, 9, 0, 0);
    second.checkDay();
    const lateEvent = contract.createEvent({ process: proc("electron_main"), component: "t", mechanismId: "health.service_restart",
      triggerReason: "service_not_alive", identity: { code: "C" }, outcome: "succeeded" });
    lateEvent.at = contract.localIso(new Date(2026, 9, 9, 23, 59, 30));
    assert.equal(second.accept(lateEvent), true);
    await until(() => JSON.parse(fs.readFileSync(path.join(second.summaryDir, "20261009.json"), "utf8"))
      .mechanisms["health.service_restart"].attempts === 3, 10000, "the late event in its day's summary");
    await second.close("test");

    // An operation started before a restart is still open after it, whatever day it started.
    const third = newLedger(dayRoot, { now: () => clock });
    await third.start();
    const openOp = createEmitter({ process: proc("service_controller"), deliver: (e) => third.accept(e) })
      .begin({ component: "t", mechanismId: "health.service_restart", triggerReason: "service_not_alive", identity: { code: "D" } });
    await third.close("test");
    clock = new Date(2026, 9, 12, 9, 0, 0);
    const fourth = newLedger(dayRoot, { now: () => clock });
    await fourth.start();
    assert.equal(fourth.status().active_operations.length, 1, "the open operation is rebuilt from the raw events");
    assert.equal(JSON.parse(fs.readFileSync(path.join(fourth.summaryDir, "20261009.json"), "utf8"))
      .mechanisms["health.service_restart"].attempts, 3, "the summary stays its raw events after a start");
    void openOp;
    await fourth.close("test");
    assert.equal(localDay(new Date(2026, 0, 2)), "20260102");

    // ---- Health's Supervisor: a restart is started -> succeeded; an exhausted budget is abandoned, once
    const recorded = [];
    const supEmitter = createEmitter({ process: proc("service_controller"), deliver: (e) => recorded.push(e) });
    let alive = false;
    const host = { supervisorProbe: async () => ({ alive, verified: alive, instance_id: alive ? "svc-2" : null, reason: "process exited" }), ensure: async () => { alive = true; return { pid: 7 }; }, stop: async () => ({ ok: true }) };
    const sup = new Supervisor({ entries: { svc: { host, autostart: true, stage: 0, watch: true } }, logger: quiet, remediation: supEmitter });
    sup.desired.set("svc", "running");
    await sup.tickOnce();
    await until(() => recorded.length === 2, 2000, "restart result");
    assert.deepEqual(recorded.map((e) => [e.mechanism_id, e.outcome, e.trigger_reason]),
      [["health.service_restart", "started", "service_not_alive"], ["health.service_restart", "succeeded", "service_not_alive"]]);
    assert.equal(recorded[0].detail.service_id, "svc");
    assert.equal(recorded.every((e) => contract.validateEvent(e) === null), true);
    recorded.length = 0;
    alive = false;
    host.ensure = async () => { throw new Error("cannot start"); };
    for (let i = 0; i < 8; i += 1) { await sup.tickOnce(); await sleep(5); }
    const abandoned = recorded.filter((e) => e.outcome === "abandoned");
    assert.equal(abandoned.length, 1, "the exhausted budget is recorded once, not on every pass");
    assert.equal(abandoned[0].trigger_reason, "restart_budget_exhausted");
    assert.ok(recorded.filter((e) => e.outcome === "failed").length >= 1);

    client.close();
    await ledger.close("test");

    // ---- a frame is acknowledged only once its line is written and fsync'd. A Health that dies
    // before the fsync leaves the event with the client, which resends it.
    let releaseSync;
    const syncGate = new Promise((resolve) => { releaseSync = resolve; });
    const gatedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args);
      return { write: (...a) => handle.write(...a), close: () => handle.close(), sync: async () => { await syncGate; return handle.sync(); } };
    } } };
    const gated = newLedger(path.join(root, "gated"), { pipePath: uniquePipe(root, "gated"), fsImpl: gatedFs });
    await gated.start();
    const net = require("node:net");
    const socket = net.connect(gated.pipePath);
    const acks = [];
    socket.on("data", (chunk) => { for (let i = 0; i + 8 <= chunk.length; i += 8) acks.push(chunk.readBigUInt64LE(i)); });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(contract.encodeFrame(contract.createEvent({ process: proc("electron_main"), component: "t",
      mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" })));
    await sleep(300);
    assert.deepEqual(acks, [], "no ack while the line is not fsync'd");
    releaseSync();
    await until(() => acks.length > 0, 4000, "ack after fsync");
    assert.equal(acks.at(-1), 1n);
    socket.destroy();
    await gated.close("test");

    // ---- only a torn LAST line (no newline after it) is a crash's cut-off write; a complete line
    // that does not parse is corruption -- counted, the ledger degraded -- never skipped silently.
    const corruptRoot = path.join(root, "corrupt");
    const writer = newLedger(corruptRoot, { pipePath: uniquePipe(root, "corrupt") });
    await writer.start();
    for (let i = 0; i < 3; i += 1) {
      writer.local.emit({ component: "t", mechanismId: "market.wal_tail_repair", triggerReason: "unfinished_append", identity: {}, outcome: "succeeded" });
    }
    assert.equal(await writer.flush(), true);
    await writer.close("test");
    const sessionDir = path.join(corruptRoot, "logs", "20261009_090000-abcdef");
    const rawName = fs.readdirSync(sessionDir).find((n) => n.startsWith("remediation-"));
    const rawPath = path.join(sessionDir, rawName);
    const lines = fs.readFileSync(rawPath, "utf8").split("\n").filter(Boolean);
    const eventLines = lines.map((l, i) => [l, i]).filter(([l]) => JSON.parse(l).schema === contract.loadRegistry().event_schema);
    lines[eventLines[1][1]] = lines[eventLines[1][1]].slice(0, 40);   // a complete line, damaged
    fs.writeFileSync(rawPath, `${lines.join("\n")}\n{"schema":"torn`);  // plus a torn last write
    const reader = newLedger(corruptRoot);
    fs.mkdirSync(reader.summaryDir, { recursive: true });
    reader.restore();
    assert.equal(reader.replay.reason, "raw_file_changed", "the damaged file is not the one the checkpoint covered");
    assert.equal(reader.today.byMechanism.get("market.wal_tail_repair").attempts, 2);
    assert.equal(reader.stats.degraded, true, "a damaged complete line degrades the ledger");
    assert.equal(Object.values(reader.stats.corrupt_lines)[0].lines, 1, "the torn last line is not counted as corruption");
    // The finding survives a start that reads nothing (the checkpoint keeps it while the file is retained).
    await reader.close("test");
    const rereader = newLedger(corruptRoot);
    rereader.restore();
    assert.equal(rereader.replay.files_read, 0);
    assert.equal(rereader.stats.degraded, true, "still degraded from the checkpoint");

    // ---- a late day stays pending until its flush succeeded and its summary is written; a failure retries.
    const summaryLedger = newLedger(path.join(root, "late-summary"));
    summaryLedger.today = { day: "20261012", byMechanism: new Map() };
    summaryLedger.pendingDays = new Set(["20261009"]);
    fs.mkdirSync(summaryLedger.summaryDir, { recursive: true });
    const realFlush = summaryLedger.flush.bind(summaryLedger);
    summaryLedger.flush = async () => false;
    await summaryLedger.writePendingSummaries();
    assert.deepEqual([...summaryLedger.pendingDays], ["20261009"], "kept while the ledger is not flushed");
    assert.equal(summaryLedger.stats.summary_failures, 1);
    clearTimeout(summaryLedger.pendingTimer); summaryLedger.pendingTimer = null;
    summaryLedger.flush = realFlush;
    await summaryLedger.writePendingSummaries();
    assert.deepEqual([...summaryLedger.pendingDays], [], "removed once the summary is written");
    assert.ok(fs.existsSync(summaryLedger.summaryPath("20261009")));
    console.log("remediation ledger contract: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
