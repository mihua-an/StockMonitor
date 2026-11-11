"use strict";

// Node side of remediation event emission (the remediation event contract in docs/BACKLOG.md). Two layers:
//
//   createEmitter({ process, deliver })  builds contract events (config/js/remediation_contract.js) and hands each
//                                        to `deliver`. emit() records a one-shot remediation; begin() announces one
//                                        that runs over time and returns a handle whose finish() records its single
//                                        terminal outcome under the same operation_id.
//   createRemediationClient(...)         an emitter whose deliver is Health's ledger pipe: a bounded queue, frames
//                                        written in order, a cumulative ack from the writer, unacknowledged frames
//                                        sent again after a reconnect (the writer drops duplicates by event_id).
//
// Nothing here ever throws into the caller or blocks it: a remediation path must not fail because its record could
// not be written. What could not be delivered is counted, and once delivery works again a `sink.client_loss` event
// says how many were lost, since when, and why.

const crypto = require("crypto");
const net = require("net");
const contract = require("../../../config/js/remediation_contract.js");

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

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

function createRemediationClient({ process: proc, pipePath = process.env[contract.PIPE_ENV] || "", connect = net.connect,
  setTimer = setTimeout, clearTimer = clearTimeout, logger = console } = {}) {
  const { client_queue_events: limit, client_ack_timeout_ms: ackTimeoutMs } = contract.loadRegistry().limits;
  const queue = [];          // frames not yet written: { event_id, frame, event }
  const inflight = [];       // frames written on the current connection, not yet acknowledged
  let socket = null;
  let connected = false;
  let connecting = false;
  let reconnectTimer = null;
  let backoff = RECONNECT_MIN_MS;
  let ackBuffer = Buffer.alloc(0);
  let ackedOnConnection = 0;
  let closed = false;
  let warnedUnconfigured = false;
  const stats = { emitted: 0, delivered: 0, dropped_total: 0, reconnects: 0, ack_timeouts: 0 };
  let lastAckAt = null;
  // A writer that took frames but stopped acknowledging is treated as gone: the socket is dropped, the unacknowledged
  // frames go back to the queue and are sent again after a reconnect.
  let ackTimer = null;
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
    if (!pipePath) {
      recordLoss("sink_unconfigured");
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        logger.warn?.(`[REMEDIATION] ${contract.PIPE_ENV} is not set; remediation events of ${proc.service_id} are counted, not recorded`);
      }
      return;
    }
    let frame;
    try { frame = contract.encodeFrame(event); } catch (error) { recordLoss("frame_too_large", error.message); return; }
    if (queue.length + inflight.length >= limit) { recordLoss(connected ? "queue_full" : "sink_unreachable", lastError); return; }
    queue.push({ event_id: event.event_id, frame, event });
    pump();
  }

  const emitter = createEmitter({ process: proc, deliver: enqueue });

  function settleWaiters() {
    if (queue.length || inflight.length) return;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  }

  function pump() {
    if (closed) return;
    if (!connected) { ensureConnected(); return; }
    // The loss marker goes first, once delivery works again; it is itself a frame like any other.
    if (loss) {
      const marker = contract.createEvent({ process: proc, component: "remediation_client", mechanismId: "sink.client_loss",
        triggerReason: loss.reason, identity: {}, outcome: "failed",
        detail: { lost_events: loss.count, lost_since: loss.since, last_error: loss.last_error } });
      loss = null;
      try { queue.unshift({ event_id: marker.event_id, frame: contract.encodeFrame(marker), event: marker }); } catch (error) { console.warn("[queueing the remediation loss marker] failed", error); }
    }
    while (queue.length && connected) {
      const item = queue.shift();
      inflight.push(item);
      socket.write(item.frame);
    }
    armAckTimer();
  }

  function armAckTimer() {
    if (ackTimer || !inflight.length || !socket) return;
    const waitingOn = socket;
    ackTimer = setTimer(() => {
      ackTimer = null;
      if (waitingOn !== socket || !inflight.length) return;
      stats.ack_timeouts += 1;
      lastError = `remediation ledger did not acknowledge within ${ackTimeoutMs} ms`;
      try { waitingOn.destroy(); } catch (error) { console.warn("[dropping the unacknowledging remediation socket] failed", error); }
      lostConnection(waitingOn, null);
    }, ackTimeoutMs);
    ackTimer?.unref?.();
  }

  function disarmAckTimer() {
    if (ackTimer) clearTimer(ackTimer);
    ackTimer = null;
  }

  function onAck(chunk) {
    ackBuffer = ackBuffer.length ? Buffer.concat([ackBuffer, chunk]) : chunk;
    while (ackBuffer.length >= 8) {
      const total = Number(ackBuffer.readBigUInt64LE(0));
      ackBuffer = ackBuffer.subarray(8);
      const newly = Math.max(0, Math.min(inflight.length, total - ackedOnConnection));
      ackedOnConnection = Math.max(ackedOnConnection, total);
      inflight.splice(0, newly);
      stats.delivered += newly;
      if (newly) {
        lastAckAt = contract.localIso();
        disarmAckTimer();       // progress: the deadline restarts for what is still in flight
      }
    }
    armAckTimer();
    settleWaiters();
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
    reconnectTimer = setTimer(() => { reconnectTimer = null; ensureConnected(); }, delay);
    reconnectTimer?.unref?.();
  }

  function ensureConnected() {
    if (closed || connected || connecting || !pipePath || reconnectTimer) return;
    connecting = true;
    let candidate;
    try { candidate = connect(pipePath); } catch (error) {
      connecting = false;
      // not an error: the same failure again on a retry was logged at its first occurrence
      if (lastError !== error.message) logger.warn?.(`[REMEDIATION] connecting to ${pipePath} failed: ${error.message}; retrying`);
      lastError = error.message;
      scheduleReconnect();
      return;
    }
    socket = candidate;
    candidate.unref?.();
    candidate.on("connect", () => {
      if (candidate !== socket) return;
      connecting = false;
      connected = true;
      backoff = RECONNECT_MIN_MS;
      ackBuffer = Buffer.alloc(0);
      ackedOnConnection = 0;
      pump();
    });
    candidate.on("data", (chunk) => { if (candidate === socket) onAck(chunk); });
    candidate.on("error", (error) => { lostConnection(candidate, error); try { candidate.destroy(); } catch (error) { console.warn("[destroying the failed remediation socket] failed", error); } });
    candidate.on("close", () => lostConnection(candidate, null));
  }

  function lostConnection(candidate, error) {
    if (candidate !== socket) return;
    if (error) lastError = String(error.message || error);
    disarmAckTimer();
    const wasConnected = connected;
    socket = null;
    connected = false;
    connecting = false;
    // Written but never acknowledged: the writer may or may not have them. Sent again; it drops duplicates.
    queue.unshift(...inflight.splice(0));
    if (wasConnected) stats.reconnects += 1;
    if (queue.length) scheduleReconnect();
  }

  return {
    ...emitter,
    // An event built elsewhere (Electron main stamps a renderer's events with the sending page's process identity).
    forward(event) { enqueue(event); },
    status() {
      return { configured: Boolean(pipePath), connected, queued: queue.length, inflight: inflight.length, ...stats,
        unreported_loss: loss ? loss.count : 0, last_error: lastError, last_ack_at: lastAckAt };
    },
    // Resolves true when every event emitted so far was acknowledged by the writer, false on timeout.
    flush(timeoutMs = 2000) {
      if (!queue.length && !inflight.length) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimer(() => { waiters.delete(done); resolve(false); }, timeoutMs);
        const done = (value) => { clearTimer(timer); resolve(value); };
        waiters.add(done);
      });
    },
    // Every event not acknowledged by the writer yet (written but unacknowledged ones too: the writer drops an event
    // it already has), oldest first, and a loss marker for what was dropped and not yet reported. For a process that
    // is about to end without its writer: what it hands on elsewhere is not lost with it.
    undelivered() {
      const events = [...inflight, ...queue].map((item) => item.event).filter(Boolean);
      if (loss) {
        events.unshift(contract.createEvent({ process: proc, component: "remediation_client", mechanismId: "sink.client_loss",
          triggerReason: loss.reason, identity: {}, outcome: "failed",
          detail: { lost_events: loss.count, lost_since: loss.since, last_error: loss.last_error } }));
      }
      return events;
    },
    close() {
      closed = true;
      disarmAckTimer();
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      try { socket?.end(); } catch (error) { console.warn("[closing the remediation socket] failed", error); }
    },
  };
}

module.exports = { createEmitter, createRemediationClient };
