"use strict";

// The remediation ledger (docs/BACKLOG.md): the ONE durable record of every retry, reconnect,
// resend, rebuild, fallback and rollback in the system, so the rule "every remediation is an error; count it, keep it,
// show it") can be checked across processes and across days.
//
// Health owns it, not Electron main: Health, Rust A/B and the provider daemons outlive the window ("close UI only"),
// and the remediations that matter most happen while nobody is looking. Everyone else hands events in through one
// local pipe (config/js/remediation_contract.js pipePath, exported to every child as STOCK_MONITOR_REMEDIATION_PIPE):
// Electron main and its renderers, the Python services, Rust A and B. Health's own mechanisms call accept() directly.
//
// Raw file:  <logs>/<log session>/remediation-YYYYMMDD-NNN.jsonl -- a header line, then one event per line; a new file
//            per local day and past 64 MiB. A clean close appends a terminal marker.
// Summary:   <summaries>/YYYYMMDD.json, one per finished day, folded from the raw events of every log session, so a
//            summary always equals its raw events.
// Checkpoint: <summaries>/../ledger_checkpoint.json -- what the raw files read so far folded into (per-day stats,
//            open operations, the dedupe tail) and the identity (size, mtime) of each file it covers. A file is only
//            ever appended to by the Health that created it, and never again once that Health ended, so a start reads
//            only the files the checkpoint does not cover; a covered file that changed, or no usable checkpoint while
//            raw files exist, re-reads everything once and is recorded (`sink.ledger_rebuild`). Re-reading ~330 MiB
//            on every start held Health's control API, and every service behind it, for 15-80 s (2026-10-14).
//
// Admission: the event must satisfy the contract (registered mechanism and trigger reason, complete identity, no
// credential-like detail); a refused event is counted and its refusal reason recorded, never written as an event.
// Durability: lines are appended in order and fsync'd; flush() resolves true only after an fsync. A write failure
// keeps the lines queued (bounded); what overflows is counted and, once writing works again, recorded as one
// `sink.writer_loss` event.
//
// This file is the facade; each part is its own module and they exchange plain state and results:
//   ledger_records.js   record schemas and the pure day folds
//   ledger_ingress.js   RemediationIngress: the pipe, framing and durable acknowledgements
//   ledger_writer.js    LedgerWriter: the ordered queue, rotation, fsync and writer-loss accounting
//   ledger_recovery.js  LedgerRecovery: raw-file replay and the checkpoint
//   ledger_summary.js   SummaryIndex: day counts, daily summaries, late rewrites and the 7/30-day windows
// The facade admits events (contract, dedupe), keeps the open operations and answers status(); the event schema is
// unchanged.

const fs = require("fs");
const path = require("path");
const contract = require("../../config/js/remediation_contract.js");
const { createEmitter } = require("../../service/platform/js/remediation_client.js");
const { processAliveFast } = require("../../service/platform/js/process_utils.js");
const { HEADER_SCHEMA, MARKER_SCHEMA, SUMMARY_SCHEMA, CHECKPOINT_SCHEMA, localDay, isOccurrence, boundedAdd } = require("./ledger_records.js");
const { RemediationIngress } = require("./ledger_ingress.js");
const { LedgerWriter, ROTATE_BYTES, MAX_QUEUE_LINES } = require("./ledger_writer.js");
const { LedgerRecovery } = require("./ledger_recovery.js");
const { SummaryIndex } = require("./ledger_summary.js");

const RECENT_LIMIT = 100;

class RemediationLedger {
  constructor({ logsRoot, sessionDir, summaryDir, writer, pipePath = null, fsImpl = fs, now = () => new Date(),
    logger = console, rotateBytes = ROTATE_BYTES, maxQueueLines = MAX_QUEUE_LINES, checkpointPath = null,
    processAlive = processAliveFast }) {
    this.logsRoot = logsRoot;
    this.sessionDir = sessionDir;
    this.summaryDir = summaryDir;
    this.checkpointPath = checkpointPath || path.join(path.dirname(summaryDir), "ledger_checkpoint.json");
    this.processAlive = processAlive;
    this.writer = writer;            // { service_id, instance_id, pid }
    this.pipePath = pipePath;
    this.fs = fsImpl;
    this.now = now;
    this.logger = logger;
    this.registry = contract.loadRegistry();
    this.closed = false;
    // The dedupe window: a Set iterates in insertion order, so its first entry is the oldest (evicted in O(1); an
    // array's shift() per event cost 18 s over a day's 450k events).
    this.seen = new Set();
    this.stats = { accepted: 0, rejected: 0, duplicates: 0, written: 0, rotations: 0, dropped: 0, write_errors: 0,
      last_error: null, last_fsync_at: null, last_rejection: null, clients_connected: 0, listening: false };
    this.total = {};                 // mechanism -> outcome -> count, since this writer started
    this.last = {};                  // mechanism -> { at, reason, identity, outcome }
    this.active = new Map();         // operation_id -> { mechanism_id, started_at, trigger_reason, identity, process }
    // Operations whose terminal event was read before their started one (a resent started event lands in a later
    // file): the started event then opens nothing. Bounded like the dedupe window.
    this.closedOps = new Set();
    this.files = new Map();          // raw file (relative to logsRoot) -> { size, mtime_ms, corrupt } read so far
    this.replay = null;              // what the last start read: { source, reason, files_*, bytes_read, events_read, duration_ms }
    this.recent = [];
    const shared = { fs: fsImpl, now, logger, stats: this.stats };
    this.ingress = new RemediationIngress({ pipePath, fs: fsImpl, logger, stats: this.stats,
      admit: (event) => this.admit(event), refuse: (reason, event) => this.refuse(reason, event),
      durableLines: () => this.writerPart.durableLines });
    this.writerPart = new LedgerWriter({ ...shared, sessionDir, writer, eventSchema: this.registry.event_schema, rotateBytes,
      maxQueueLines, onDurable: () => this.ingress.durable(), onLossReported: (loss) => this.reportWriterLoss(loss) });
    this.recovery = new LedgerRecovery({ ...shared, logsRoot, checkpointPath: this.checkpointPath, eventSchema: this.registry.event_schema });
    this.summary = new SummaryIndex({ ...shared, summaryDir, registry: this.registry, flush: () => this.flush(),
      isClosed: () => this.closed });
    this.local = createEmitter({ process: { ...writer, runtime: "node" }, deliver: (event) => this.accept(event) });
  }

  // What the parts hold, under the names the ledger always had.
  get queue() { return this.writerPart.queue; }
  get file() { return this.writerPart.file; }
  get unreportedLoss() { return this.writerPart.unreportedLoss; }
  get days() { return this.summary.days; }
  get history() { return this.summary.history; }
  get today() { return this.summary.today; }
  set today(value) { this.summary.today = value; }
  get pendingDays() { return this.summary.pendingDays; }
  set pendingDays(value) { this.summary.pendingDays = value; }
  get pendingTimer() { return this.summary.pendingTimer; }
  set pendingTimer(value) { this.summary.pendingTimer = value; }

  // ---------------------------------------------------------------- startup
  // Today's counts, the open operations, the dedupe window and every finished day's summary are restored before the
  // pipe opens: from the checkpoint plus the raw files it does not cover, or -- when it cannot be used -- from every
  // retained raw file (recorded). A new checkpoint is written for what was read.
  async start() {
    this.fs.mkdirSync(this.sessionDir, { recursive: true });
    this.fs.mkdirSync(this.summaryDir, { recursive: true });
    this.restore();
    this.dayTimer = setInterval(() => { this.checkDay(); this.closeEndedOperations(); }, 30_000);
    this.dayTimer.unref?.();
    if (this.pipePath) await this.ingress.listen();
    return this;
  }

  // ---------------------------------------------------------------- admission
  refuse(reason, event) {
    this.stats.rejected += 1;
    this.stats.last_rejection = { at: contract.localIso(this.now()), reason: String(reason).slice(0, 300),
      mechanism_id: typeof event?.mechanism_id === "string" ? event.mechanism_id.slice(0, 80) : null,
      service_id: typeof event?.process?.service_id === "string" ? event.process.service_id.slice(0, 80) : null };
    return false;
  }

  // An event of Health's own (nobody resends it: a full queue is a counted loss). True when taken (written or a
  // duplicate of one). Client frames go through admit() from the ingress.
  accept(event) {
    const admitted = this.admit(event, { fromClient: false });
    return Boolean(admitted.line || admitted.duplicate);
  }

  // { line } -- queued as that line number (durable once the writer's durableLines reaches it); { duplicate } --
  // already taken; { refused }; { dropped } -- the write queue is full and a client event was not taken (the client
  // resends it).
  admit(event, { fromClient = true } = {}) {
    const problem = contract.validateEvent(event);
    if (problem) { this.refuse(problem, event); return { refused: true }; }
    if (this.seen.has(event.event_id)) { this.stats.duplicates += 1; return { duplicate: true }; }
    const line = this.writerPart.append(JSON.stringify(event), { lossIfFull: !fromClient });
    if (!line) return { dropped: true };
    boundedAdd(this.seen, event.event_id);
    this.stats.accepted += 1;
    this.checkDay();
    this.observe(event);
    return { line };
  }

  observe(event) {
    const mech = event.mechanism_id;
    this.total[mech] = this.total[mech] || {};
    this.total[mech][event.outcome] = (this.total[mech][event.outcome] || 0) + 1;
    this.foldEvent(event);
    if (isOccurrence(event)) {
      this.last[mech] = { at: event.at, reason: event.trigger_reason, identity: event.identity, outcome: event.outcome,
        service_id: event.process.service_id };
    }
    this.summary.noteEvent(event);
    this.recent.push(event);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
  }

  dayStats(day) { return this.summary.dayStats(day); }

  // One event into its day's counts and the open operations: the same fold for a live event and a replayed one.
  foldEvent(event) {
    this.summary.fold(event);
    this.trackOperation(event);
  }

  // ---------------------------------------------------------------- writing
  append(line, options) { return this.writerPart.append(line, options); }

  kick() { return this.writerPart.kick(); }

  // Writing works again: say how many events were lost while it did not (or that none were, after a failure).
  reportWriterLoss(loss) {
    this.local.emit({ component: "remediation_ledger", mechanismId: "sink.writer_loss", triggerReason: loss.reason, identity: {},
      outcome: loss.count ? "failed" : "succeeded", detail: { lost_events: loss.count, lost_since: loss.since, last_error: loss.last_error } });
  }

  // True only when everything accepted so far is written and fsync'd.
  flush() { return this.writerPart.flush(); }

  async close(reason = "shutdown") {
    if (this.closed) return this.stats;
    clearInterval(this.dayTimer);
    this.summary.stop();
    await this.ingress.close();
    const flushed = await this.flush();
    this.closed = true;
    try {
      await this.writerPart.writeTerminal({ reason, at: contract.localIso(this.now()), flushed, accepted: this.stats.accepted,
        written: this.stats.written, dropped: this.stats.dropped, rejected: this.stats.rejected, active_operations: this.active.size });
      // Everything this writer accepted is on disk: the next start reads none of it again.
      if (flushed) this.writeCheckpoint();
    } catch (error) {
      this.stats.last_error = `terminal marker: ${error.message}`;
      this.logger.error?.(`[REMEDIATION] writing the terminal marker failed (the ledger file may end without one): ${error?.stack || error}`);
    }
    return this.stats;
  }

  // ---------------------------------------------------------------- recovery
  // Restore the ledger's state (see start()). Unchanged covered files are not opened past their last bytes; a covered
  // file that is gone was pruned with its log session -- its events stay counted in the days they happened.
  restore() {
    const { replay, reason, error, dirty } = this.recovery.restore(this, (event) => this.foldEvent(event));
    this.summary.resetToday();
    this.summary.summarizeFinishedDays(dirty);
    this.replay = replay;
    this.stats.replay = replay;
    this.writeCheckpoint();
    this.closeEndedOperations();
    if (reason) {
      this.logger.warn?.(`[REMEDIATION] ledger checkpoint not usable (${reason}): rebuilt from ${replay.files_read} raw files, ${replay.bytes_read} bytes`);
      this.local.emit({ component: "remediation_ledger", mechanismId: "sink.ledger_rebuild", triggerReason: reason, identity: {},
        outcome: "succeeded", detail: { ...replay, checkpoint: this.checkpointPath, error } });
    }
    return replay;
  }

  writeCheckpoint() { return this.recovery.writeCheckpoint(this, this.writerPart.ownFiles); }

  // ---------------------------------------------------------------- days and summaries
  buildSummary(day) { return this.summary.buildSummary(day); }

  summaryPath(day) { return this.summary.summaryPath(day); }

  writeSummary(day) { return this.summary.writeSummary(day); }

  summarizeFinishedDays(dirty) { return this.summary.summarizeFinishedDays(dirty); }

  writePendingSummaries() { return this.summary.writePendingSummaries(); }

  checkDay() { return this.summary.checkDay(); }

  // ---------------------------------------------------------------- operations
  // An operation is open while its started event has no terminal one, whatever day it started and in whichever order
  // the two were read (a resent started event can land in a later file than its result).
  trackOperation(event) {
    if (event.outcome === "started") {
      if (this.closedOps.has(event.operation_id)) return;
      this.active.set(event.operation_id, { mechanism_id: event.mechanism_id, started_at: event.at, trigger_reason: event.trigger_reason,
        identity: event.identity, service_id: event.process.service_id, instance_id: event.process.instance_id,
        pid: event.process.pid ?? null, started_event_id: event.event_id });
    } else if (event.operation_id && !this.active.delete(event.operation_id)) {
      boundedAdd(this.closedOps, event.operation_id);
    }
  }

  // An operation whose writer process has ended can never be finished by it: Health records it as abandoned on that
  // writer's behalf (process = Health, detail names the writer). Every App close left some open forever -- a window
  // reconnecting while the backend stopped under it, a provider retry begun during its own stop, a process killed --
  // and "open operations" only grew (41 on 10-14, the oldest from 10-10). A writer whose pid cannot be judged (none
  // recorded) or still answers is left open; a reused pid keeps its operation open until that process ends too.
  closeEndedOperations() {
    let closed = 0;
    for (const [operationId, op] of [...this.active]) {
      if (!(Number(op.pid) > 0) || this.processAlive(Number(op.pid))) continue;
      if (!op.started_event_id) {
        this.logger.warn?.(`[REMEDIATION] open operation ${operationId} (${op.mechanism_id}) of ended pid ${op.pid} names no started event; left open`);
        continue;
      }
      const taken = this.accept(contract.createEvent({ process: { ...this.writer, runtime: "node" }, component: "remediation_ledger",
        mechanismId: op.mechanism_id, triggerReason: op.trigger_reason, identity: op.identity, outcome: "abandoned",
        operationId, relatedUpstreamEventId: op.started_event_id,
        detail: { reason: "writer_ended", writer_service_id: op.service_id, writer_instance_id: op.instance_id, writer_pid: op.pid,
          started_at: op.started_at } }));
      if (taken) closed += 1;
      else this.logger.warn?.(`[REMEDIATION] abandoning operation ${operationId} of ended pid ${op.pid} was not taken (${this.stats.last_rejection?.reason || "queue full"})`);
    }
    if (closed) this.stats.closed_for_ended_writers = (this.stats.closed_for_ended_writers || 0) + closed;
    return closed;
  }

  // ---------------------------------------------------------------- read side (Health monitoring snapshot)
  windowCounts(mechanismId, days) { return this.summary.windowCounts(mechanismId, days); }

  windowServiceCounts(mechanismId, days) { return this.summary.windowServiceCounts(mechanismId, days); }

  status() {
    const mechanisms = Object.entries(this.registry.mechanisms).map(([id, spec]) => {
      const today = this.today.byMechanism.get(id);
      // label: what happened, in the user's words (config/remediation_registry.json), shown by 系統拓樸 補救事件.
      return { mechanism_id: id, label: spec.label || null, s1: spec.s1, owner: spec.owner, zero_expected: spec.zero_expected, today: today?.attempts || 0,
        last_7_days: this.windowCounts(id, 7), last_30_days: this.windowCounts(id, 30), total: this.total[id] || {},
        today_by_service: Object.fromEntries(today?.services || []), last_7_days_by_service: this.windowServiceCounts(id, 7),
        last: this.last[id] || null };
    });
    return {
      schema: "stock-monitor-remediation-status-v1", today: this.today.day,
      sink: { ...this.stats, queue_depth: this.queue.length, file: this.file?.path || null, pipe: this.pipePath,
        unreported_loss: this.unreportedLoss?.count || 0 },
      mechanisms,
      zero_expected_violations: mechanisms.filter((m) => m.zero_expected && m.today > 0).map((m) => m.mechanism_id),
      active_operations: [...this.active.entries()].map(([operation_id, op]) => ({ operation_id, ...op })),
      recent: [...this.recent].reverse(),
    };
  }
}

module.exports = { RemediationLedger, HEADER_SCHEMA, MARKER_SCHEMA, SUMMARY_SCHEMA, CHECKPOINT_SCHEMA, isOccurrence, localDay };
