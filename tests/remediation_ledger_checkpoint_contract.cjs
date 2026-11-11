"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The remediation ledger's start (health/remediation/ledger.js restore): a checkpoint plus only the raw files it does
// not cover gives exactly what re-reading every raw file gives -- today's counts, the open operations, the day
// summaries -- and a checkpoint that cannot be trusted is never used: everything is re-read once and that is recorded.
// Re-reading ~330 MiB at every start held Health's control API for 15-80 s (2026-10-14).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contract = require("../config/js/remediation_contract.js");
const { createEmitter } = require("../service/platform/js/remediation_client.js");
const { RemediationLedger, HEADER_SCHEMA } = require("../health/remediation/ledger.js");

const quiet = { log() {}, warn() {}, error() {} };
const clock = new Date(2026, 9, 14, 10, 0, 0);
const at = (day, hour) => contract.localIso(new Date(2026, 9, day, hour, 0, 0));
const proc = { service_id: "provider_futu", instance_id: "provider_futu-1", pid: 1, runtime: "python" };

// Events as a producer builds them, re-dated onto the test days.
const built = [];
const emitter = createEmitter({ process: proc, deliver: (event) => { built.push(event); return true; } });
function oneShot(mechanismId, triggerReason, when, identity = {}) {
  emitter.emit({ component: "t", mechanismId, triggerReason, identity, outcome: "succeeded" });
  const event = built.pop();
  event.at = when;
  return event;
}
function operation(mechanismId, triggerReason, startedAt, identity = {}) {
  const op = emitter.begin({ component: "t", mechanismId, triggerReason, identity });
  const started = built.pop();
  started.at = startedAt;
  return { started, finish(outcome, when) { op.finish(outcome, { attempt: 2 }); const terminal = built.pop(); terminal.at = when; return terminal; } };
}

function writeRaw(logs, session, name, records, { torn = false } = {}) {
  const dir = path.join(logs, session);
  fs.mkdirSync(dir, { recursive: true });
  const header = { schema: HEADER_SCHEMA, day: name.slice(12, 20), opened_at: at(13, 9), writer: {}, log_session: session,
    event_schema: contract.loadRegistry().event_schema };
  const text = [header, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n" + (torn ? '{"schema":"tor' : "");
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

function ledgerAt(root, extra = {}) {
  const logs = path.join(root, "logs");
  return new RemediationLedger({ logsRoot: logs, sessionDir: path.join(logs, "20261014_100000-cccccc"),
    summaryDir: path.join(root, "output", "remediation", "daily"), logger: quiet, now: () => clock,
    // The test's producers (pid 1) are taken as running: closing the operations of ended writers is tested apart.
    processAlive: () => true,
    writer: { service_id: "service_controller", instance_id: "health-1", pid: process.pid }, ...extra });
}

// What a start restored, in a form two ledgers can be compared by. Without sink.ledger_rebuild: a full replay records
// its own (asserted separately).
function restored(ledger) {
  const days = Object.fromEntries([...ledger.days].map(([day]) => {
    const { "sink.ledger_rebuild": _own, ...mechanisms } = ledger.buildSummary(day).mechanisms;
    return [day, mechanisms];
  }).filter(([, m]) => Object.keys(m).length));
  return { today: ledger.today.day, days, active: [...ledger.active.keys()].sort() };
}

async function fullReplay(root) {
  const copy = makeTempDir("ledger-full-");
  fs.cpSync(path.join(root, "logs"), path.join(copy, "logs"), { recursive: true });
  const ledger = ledgerAt(copy);
  fs.mkdirSync(ledger.summaryDir, { recursive: true });
  ledger.restore();
  assert.equal(ledger.replay.source, "raw_files");
  const result = restored(ledger);
  await ledger.close("test");
  fs.rmSync(copy, { recursive: true, force: true });
  return result;
}

(async () => {
  const root = makeTempDir("ledger-checkpoint-");
  try {
    const logs = path.join(root, "logs");
    // ---- session 1 (yesterday into today): one-shots, an operation left open across the day, one closed
    const crossDay = operation("health.service_restart", "service_not_alive", at(13, 23), { code: "X" });
    const closed = operation("health.service_restart", "service_not_alive", at(13, 10), { code: "Y" });
    const dup = oneShot("market.wal_tail_repair", "unfinished_append", at(14, 9));
    writeRaw(logs, "20261013_090000-aaaaaa", "remediation-20261013-001.jsonl", [
      oneShot("market.wal_tail_repair", "unfinished_append", at(13, 9)), closed.started, closed.finish("succeeded", at(13, 11)),
      crossDay.started, dup,
    ], { torn: true });

    const first = ledgerAt(root);
    await first.start();
    assert.deepEqual([first.replay.source, first.replay.reason], ["raw_files", "checkpoint_absent"]);
    assert.equal(first.replay.files_read, 1);
    assert.deepEqual([...first.active.keys()], [crossDay.started.operation_id], "the open operation across the day");
    assert.ok(fs.existsSync(first.checkpointPath), "a checkpoint is written for what was read");
    await first.flush();
    const rebuildEvents = fs.readdirSync(first.sessionDir).flatMap((n) => fs.readFileSync(path.join(first.sessionDir, n), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.mechanism_id === "sink.ledger_rebuild");
    assert.equal(rebuildEvents.length, 1, "re-reading everything is recorded");
    assert.equal(rebuildEvents[0].trigger_reason, "checkpoint_absent");
    assert.equal(rebuildEvents[0].detail.files_read, 1);
    // first "crashes": no close, so its own file is not in a checkpoint. Its rebuild event is read by the next start.

    // ---- session 2: a late event of a finished day, a duplicate of a covered event, the cross-day operation's end,
    // and a result whose started event is resent only in session 3
    const lateResult = operation("health.service_restart", "service_not_alive", at(13, 15), { code: "Z" });
    const lateTerminal = lateResult.finish("failed", at(13, 16));
    const s2 = writeRaw(logs, "20261014_090000-bbbbbb", "remediation-20261014-001.jsonl", [
      oneShot("market.wal_tail_repair", "unfinished_append", at(12, 22)), dup, crossDay.finish("succeeded", at(14, 9)), lateTerminal,
      oneShot("health.service_restart", "restart_budget_exhausted", at(14, 9), { code: "W" }),
    ]);

    const second = ledgerAt(root);
    await second.start();
    assert.equal(second.replay.source, "checkpoint", `the checkpoint is used (${second.replay.reason})`);
    const ownFirst = fs.readdirSync(first.sessionDir).map((n) => path.join(first.sessionDir, n));
    assert.equal(second.replay.files_read, 1 + ownFirst.length, "only session 2 and the crashed writer's own file are read");
    assert.equal(second.replay.bytes_read, fs.statSync(s2).size + ownFirst.reduce((n, f) => n + fs.statSync(f).size, 0),
      "no covered byte is read again");
    assert.equal(second.replay.files_skipped, 1, "session 1 is not opened");
    assert.deepEqual([...second.active.keys()], [], "the cross-day operation ended in a later file");
    assert.equal(second.today.byMechanism.get("market.wal_tail_repair").attempts, 1, "a duplicate of a covered event counts once");
    assert.equal(JSON.parse(fs.readFileSync(second.summaryPath("20261012"), "utf8")).mechanisms["market.wal_tail_repair"].attempts, 1,
      "a late event's day gets its summary");
    assert.deepEqual(restored(second), await fullReplay(root), "checkpoint + tail == every raw file");
    await second.close("test");

    // ---- session 3: the started event of a result read earlier opens nothing
    writeRaw(logs, "20261014_093000-dddddd", "remediation-20261014-001.jsonl", [lateResult.started]);
    const third = ledgerAt(root);
    await third.start();
    assert.equal(third.replay.source, "checkpoint");
    assert.equal(third.replay.files_read, 1, "second closed cleanly: its own file is covered");
    assert.deepEqual([...third.active.keys()], [], "a started event read after its result is not open");
    assert.deepEqual(restored(third), await fullReplay(root));
    await third.close("test");

    // ---- a covered file a writer still appends to (a torn last write completed after it): only what was added is read
    const appended = JSON.stringify(oneShot("market.wal_tail_repair", "unfinished_append", at(14, 9))) + "\n";
    const s2Size = fs.statSync(s2).size;
    fs.appendFileSync(s2, '{"schema":"half');
    const growing = ledgerAt(root);
    await growing.start();
    assert.equal(growing.replay.source, "checkpoint");
    assert.equal(growing.replay.bytes_read, fs.statSync(s2).size - s2Size, "only the appended bytes");
    assert.equal(growing.files.get("20261014_090000-bbbbbb/remediation-20261014-001.jsonl").offset, s2Size, "a torn tail is not past the offset");
    await growing.close("test");
    fs.writeFileSync(s2, fs.readFileSync(s2, "utf8").slice(0, s2Size) + appended);
    const tail = ledgerAt(root);
    await tail.start();
    assert.equal(tail.replay.source, "checkpoint");
    assert.deepEqual(restored(tail), await fullReplay(root), "checkpoint + an appended tail == every raw file");
    await tail.close("test");

    // ---- a covered file rewritten in place or cut short: everything is re-read, and that is recorded
    const original = fs.readFileSync(s2, "utf8");
    fs.writeFileSync(s2, original.replace(/"unfinished_append"/g, '"unfinished_appenX"').replace('"unfinished_appenX"', '"unfinished_append"'));
    const changed = ledgerAt(root);
    await changed.start();
    assert.deepEqual([changed.replay.source, changed.replay.reason], ["raw_files", "raw_file_changed"]);
    await changed.close("test");
    fs.writeFileSync(s2, original.slice(0, original.length - appended.length));
    const shorter = ledgerAt(root);
    await shorter.start();
    assert.deepEqual([shorter.replay.source, shorter.replay.reason], ["raw_files", "raw_file_changed"]);
    assert.deepEqual(restored(shorter), await fullReplay(root));
    await shorter.close("test");
    fs.writeFileSync(s2, original);
    const restoredFile = ledgerAt(root);
    await restoredFile.start();
    assert.equal(restoredFile.replay.source, "checkpoint", "the cut-off line written again is an append");
    assert.deepEqual(restored(restoredFile), await fullReplay(root));
    await restoredFile.close("test");

    // ---- a torn or foreign checkpoint is never used
    const good = fs.readFileSync(changed.checkpointPath, "utf8");
    fs.writeFileSync(changed.checkpointPath, good.slice(0, Math.floor(good.length / 2)));
    const torn = ledgerAt(root);
    await torn.start();
    assert.deepEqual([torn.replay.source, torn.replay.reason], ["raw_files", "checkpoint_unreadable"]);
    assert.deepEqual(restored(torn), await fullReplay(root));
    await torn.close("test");
    fs.writeFileSync(torn.checkpointPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(torn.checkpointPath, "utf8")), event_schema: "another-event-schema" }));
    const foreignSchema = ledgerAt(root);
    await foreignSchema.start();
    assert.equal(foreignSchema.replay.reason, "checkpoint_incompatible");
    await foreignSchema.close("test");

    // ---- a pruned log session: nothing is re-read, its events stay counted where they happened
    const before = ledgerAt(root);
    before.restore();
    const counted = restored(before);
    fs.rmSync(path.join(logs, "20261013_090000-aaaaaa"), { recursive: true, force: true });
    const pruned = ledgerAt(root);
    pruned.restore();
    assert.equal(pruned.replay.source, "checkpoint");
    assert.equal(pruned.replay.files_read, 0);
    assert.deepEqual(restored(pruned).days, counted.days, "a pruned session's events stay in their days");
    assert.ok(!Object.keys(JSON.parse(fs.readFileSync(pruned.checkpointPath, "utf8")).files).some((k) => k.startsWith("20261013_090000")),
      "the pruned files leave the checkpoint");

    // ---- an operation whose writer has ended is abandoned by Health on its behalf; one whose writer runs stays open
    {
      const sweepRoot = path.join(root, "sweep");
      const gone = operation("renderer.live_ws_reconnect", "remote_close", at(14, 9), {});
      gone.started.process = { ...gone.started.process, pid: 4242 };
      const running = operation("health.service_restart", "service_not_alive", at(14, 9), { code: "R" });
      writeRaw(path.join(sweepRoot, "logs"), "20261014_090000-eeeeee", "remediation-20261014-001.jsonl", [gone.started, running.started]);
      let alive = new Set([1]);
      const sweeping = ledgerAt(sweepRoot, { processAlive: (pid) => alive.has(pid) });
      await sweeping.start();
      assert.deepEqual([...sweeping.active.keys()], [running.started.operation_id], "the ended writer's operation is closed");
      await sweeping.flush();
      const own = fs.readdirSync(sweeping.sessionDir).flatMap((n) => fs.readFileSync(path.join(sweeping.sessionDir, n), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.outcome === "abandoned");
      assert.equal(own.length, 1);
      assert.deepEqual([own[0].operation_id, own[0].related_upstream_event_id, own[0].mechanism_id, own[0].process.service_id,
        own[0].detail.reason, own[0].detail.writer_pid], [gone.started.operation_id, gone.started.event_id, "renderer.live_ws_reconnect",
        "service_controller", "writer_ended", 4242]);
      assert.equal(contract.validateEvent(own[0]), null);
      alive = new Set();
      assert.equal(sweeping.closeEndedOperations(), 1, "the running one is closed once its writer ends too");
      assert.equal(sweeping.closeEndedOperations(), 0, "never twice");
      await sweeping.close("test");
      const after = ledgerAt(sweepRoot, { processAlive: () => false });
      await after.start();
      assert.deepEqual([after.active.size, after.queue.length], [0, 0], "a restart finds nothing left to close");
      await after.close("test");
    }

    // ---- nothing ever written: no rebuild to record
    const empty = ledgerAt(path.join(root, "empty"));
    await empty.start();
    assert.deepEqual([empty.replay.source, empty.replay.reason, empty.queue.length], ["raw_files", null, 0]);
    await empty.close("test");
    for (const ledger of [first, before, pruned]) await ledger.close("test");
    console.log("remediation ledger checkpoint contract: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
