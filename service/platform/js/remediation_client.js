"use strict";

// Node side of remediation event emission (the remediation event contract in docs/BACKLOG.md). Two layers:
//
//   createEmitter({ process, deliver })  builds contract events (config/js/remediation_contract.js) and hands each
//                                        to `deliver`. emit() records a one-shot remediation; begin() announces one
//                                        that runs over time and returns a handle whose finish() records its single
//                                        terminal outcome under the same operation_id.
//   createRemediationClient(...)         an emitter whose deliver is Health's ledger, reached through Health's
//                                        control API: a bounded queue, batches sent in order, Health answering how
//                                        many it settled, the rest sent again (the writer drops duplicates by
//                                        event_id).
//
// Nothing here ever throws into the caller or blocks it: a remediation path must not fail because its record could
// not be written. What could not be delivered is counted, and once delivery works again a `sink.client_loss` event
// says how many were lost, since when, and why.

const crypto = require("crypto");
const contract = require("../../../config/js/remediation_contract.js");

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;

function createEmitter({ process: proc, deliver }) {
  function emit({ component, mechanismId, triggerReason, identity, attempt = null, outcome, operationId = null,
    relatedUpstreamEventId = null, detail = {} }) {
    const event = contract.createEvent({ process: proc, component, mechanismId, triggerReason, identity, attempt, outcome,
      operationId, relatedUpstreamEventId, detail });
    try { deliver(event); } catch (error) { console.warn("[delivering a remediation event] failed", error); }
    return event;
  }

  // One remediation operation: started now, exactly one terminal outcome later (a second finish() is ignored).
  function begin({ component, mechanismId, triggerReason, identity, detail = {} }) {
    const operationId = crypto.randomUUID();
    const started = emit({ component, mechanismId, triggerReason, identity, attempt: 0, outcome: "started", operationId, detail });
    let finished = null;
    return {
      operationId,
      startedEvent: started,
      get finished() { return finished !== null; },
      finish(outcome, { attempt = null, detail: resultDetail = {}, identity: resultIdentity = identity } = {}) {
        if (finished) return finished;
        finished = emit({ component, mechanismId, triggerReason, identity: resultIdentity, attempt, outcome, operationId,
          relatedUpstreamEventId: started.event_id, detail: resultDetail });
        return finished;
      },
    };
  }

  return { emit, begin, process: proc };
}

// Electron main's delivery to Health's ledger: batches over Health's control API (POST /control/remediation), not the
// pipe -- Node cannot open a named pipe at identification level or check which user serves it, and the control API is
// a connection Electron main already authenticates. `post(events, timeoutMs)` resolves the count of leading events
// Health has settled (refused, a duplicate, or written and fsync'd); anything after it is sent again.
function createRemediationClient({ process: proc, post = null, setTimer = setTimeout, clearTimer = clearTimeout,
  logger = console } = {}) {
  const { client_queue_events: limit, client_ack_timeout_ms: ackTimeoutMs } = contract.loadRegistry().limits;
  // Health answers within its ack deadline; the request gets that plus time to arrive and return.
  const requestTimeoutMs = ackTimeoutMs + 2000;
  const queue = [];          // events not yet settled by Health, oldest first: { event_id, event }
  let inflight = 0;          // how many at the head of the queue the current request carries
  let sending = false;
  let reachable = false;     // the last request was answered
  let retryTimer = null;
  let backoff = RETRY_MIN_MS;
  let closed = false;
  let warnedUnconfigured = false;
  const stats = { emitted: 0, delivered: 0, dropped_total: 0, reconnects: 0, ack_timeouts: 0 };
  let lastAckAt = null;
  // Loss not yet reported: { count, since, reason, last_error }.
  let loss = null;
  let lastError = null;
  const waiters = new Set();

  function recordLoss(reason, error = null) {
    stats.dropped_total += 1;
    if (!loss) loss = { count: 0, since: contract.localIso(), reason, last_error: null };
    loss.count += 1;
    loss.reason = reason;
    if (error) loss.last_error = String(error).slice(0, 300);
  }

  function enqueue(event) {
    stats.emitted += 1;
    if (!post) {
      recordLoss("sink_unconfigured");
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        logger.warn?.(`[REMEDIATION] no delivery to Health is configured; remediation events of ${proc.service_id} are counted, not recorded`);
      }
      return;
    }
    try { contract.encodeFrame(event); } catch (error) { recordLoss("frame_too_large", error.message); return; }
    if (queue.length >= limit) { recordLoss(reachable ? "queue_full" : "sink_unreachable", lastError); return; }
    queue.push({ event_id: event.event_id, event });
    pump();
  }

  const emitter = createEmitter({ process: proc, deliver: enqueue });

  function settleWaiters() {
    if (queue.length) return;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  }

  function lossMarker() {
    return contract.createEvent({ process: proc, component: "remediation_client", mechanismId: "sink.client_loss",
      triggerReason: loss.reason, identity: {}, outcome: "failed",
      detail: { lost_events: loss.count, lost_since: loss.since, last_error: loss.last_error } });
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    const delay = backoff;
    backoff = Math.min(RETRY_MAX_MS, backoff * 2);
    retryTimer = setTimer(() => { retryTimer = null; pump(); }, delay);
    retryTimer?.unref?.();
  }

  function pump() {
    if (closed || sending || retryTimer || !queue.length || !post) return;
    // The loss marker goes first, once delivery works again; it is itself an event like any other.
    if (loss && reachable) {
      const marker = lossMarker();
      loss = null;
      queue.unshift({ event_id: marker.event_id, event: marker });
    }
    sending = true;
    inflight = Math.min(queue.length, contract.HTTP_BATCH_EVENTS);
    const batch = queue.slice(0, inflight).map((item) => item.event);
    let timedOut = false;
    const deadline = setTimer(() => { timedOut = true; }, requestTimeoutMs);
    deadline?.unref?.();
    Promise.resolve().then(() => post(batch, requestTimeoutMs)).then((settled) => {
      const count = Math.max(0, Math.min(inflight, Math.floor(Number(settled) || 0)));
      queue.splice(0, count);
      stats.delivered += count;
      if (count) lastAckAt = contract.localIso();
      reachable = true;
      backoff = RETRY_MIN_MS;
      if (count < inflight) {
        // Health could not settle the rest within its deadline (its write queue full, or the disk slow): later.
        stats.ack_timeouts += 1;
        lastError = `remediation ledger settled ${count} of ${inflight} within ${ackTimeoutMs} ms`;
        sending = false;
        inflight = 0;
        scheduleRetry();
        return;
      }
      sending = false;
      inflight = 0;
      settleWaiters();
      pump();
    }, (error) => {
      if (timedOut) stats.ack_timeouts += 1;
      // not an error to log again: the same failure on each retry was logged at its first occurrence
      if (lastError !== String(error?.message || error)) logger.warn?.(`[REMEDIATION] delivering to Health failed: ${error?.message || error}; retrying`);
      lastError = String(error?.message || error).slice(0, 300);
      if (reachable) stats.reconnects += 1;
      reachable = false;
      sending = false;
      inflight = 0;
      scheduleRetry();
    }).finally(() => clearTimer(deadline));
  }

  return {
    ...emitter,
    // An event built elsewhere (Electron main stamps a renderer's events with the sending page's process identity).
    forward(event) { enqueue(event); },
    status() {
      return { configured: Boolean(post), connected: reachable, queued: queue.length - inflight, inflight, ...stats,
        unreported_loss: loss ? loss.count : 0, last_error: lastError, last_ack_at: lastAckAt };
    },
    // Resolves true when every event emitted so far was settled by Health, false on timeout.
    flush(timeoutMs = 2000) {
      if (!queue.length) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimer(() => { waiters.delete(done); resolve(false); }, timeoutMs);
        const done = (value) => { clearTimer(timer); resolve(value); };
        waiters.add(done);
      });
    },
    // Every event Health has not settled yet (one being sent too: Health drops an event it already has), oldest
    // first, and a loss marker for what was dropped and not yet reported. For a process that is about to end without
    // Health: what it hands on elsewhere is not lost with it.
    undelivered() {
      const events = queue.map((item) => item.event).filter(Boolean);
      if (loss) events.unshift(lossMarker());
      return events;
    },
    close() {
      closed = true;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
    },
  };
}

module.exports = { createEmitter, createRemediationClient };
