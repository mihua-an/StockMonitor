import { selectionContext, selectionMark } from "../core/selection_latency_trace.js";
import { resetSequenceSpace } from "./sequence_gate.js";

// The view store's subscription lifecycle: which request and which Market Runtime subscription each view is bound to,
// what it sends to bind, re-bind and release them, and how it revisits a view whose request went unanswered or failed.
// It owns the request / subscription maps and the connection flag; the entries themselves are the store's, handed in
// as the map it reads.
//
// Narrow collaborators, so it can be driven alone: `send` (the socket), `now` (the clock), `recovery` (recorded
// recoveries, view_recovery.js), `emitMetric` (the store's per-view metric) and `metrics` (the store's counters).
export class ViewSubscriptions {
  constructor({
    entries,
    send,
    now = () => Date.now(),
    recovery,
    emitMetric = () => {},
    metrics,
    resyncCooldownMs = 10000,
    subscriptionTimeoutMs = 55000,
    errorRetryBaseMs = 2000,
    errorRetryMaxMs = 15000,
  }) {
    this.entries = entries;
    this.send = send;
    this.now = now;
    this.recovery = recovery;
    this.emitMetric = emitMetric;
    this.metrics = metrics;
    this.requestToKey = new Map();
    // view.subscribe requests whose last reply (the snapshot, or an error) has not arrived yet.
    this.openRequests = new Set();
    // Open requests this store let go of (view released, or re-subscribed) -> { view, why }. Market Runtime was told to
    // close their views, so their remaining replies are known to answer a closed view; the last one drops the record.
    this.cancelledRequests = new Map();
    this.subscriptionToKey = new Map();
    this.closedSubscriptions = new Map();
    this.requestSeq = 0;
    this.connected = false;
    this.connectionId = "";
    this.resyncCooldownMs = Math.max(3000, Number(resyncCooldownMs) || 10000);
    this.subscriptionTimeoutMs = Math.max(10000, Number(subscriptionTimeoutMs) || 55000);
    this.errorRetryBaseMs = Math.max(500, Number(errorRetryBaseMs) || 2000);
    this.errorRetryMaxMs = Math.max(this.errorRetryBaseMs, Number(errorRetryMaxMs) || 15000);
  }

  /** The entry a reply names: by its subscription, else by the request it answers. */
  entryFor(subscriptionId = "", requestId = "") {
    const key = (subscriptionId && this.subscriptionToKey.get(subscriptionId)) || (requestId && this.requestToKey.get(requestId));
    return key ? this.entries.get(key) || null : null;
  }

  rememberClosed(subscriptionId) {
    const normalized = String(subscriptionId || "");
    if (!normalized) return;
    const now = this.now();
    this.closedSubscriptions.set(normalized, now);
    for (const [id, closedAt] of this.closedSubscriptions) {
      if (now - closedAt > 60000 || this.closedSubscriptions.size > 256) this.closedSubscriptions.delete(id);
    }
  }

  isRecentlyClosed(subscriptionId) {
    const closedAt = this.closedSubscriptions.get(String(subscriptionId || ""));
    return Boolean(closedAt && this.now() - closedAt <= 60000);
  }

  // Unbinds the entry from its subscription: Market Runtime is told (while connected), late frames of it are known as
  // late, and its sequence space goes with it. A request still waiting for its reply is let go of here too: the view
  // it opens is closed by naming the request (Market Runtime reads one connection's commands in order, so the cancel
  // always finds the view the subscribe opened), and its replies are then known to answer a closed view.
  _unbind(entry, why, { unsubscribe = true } = {}) {
    const subscriptionId = entry.subscription_id;
    const requestId = String(entry.request_id || "");
    const open = this.openRequests.has(requestId);
    if (unsubscribe && this.connected) {
      if (subscriptionId) this.send({ type: "view.unsubscribe", payload: { subscription_id: subscriptionId } });
      else if (open) this.send({ type: "view.unsubscribe", payload: { request_id: requestId } });
    }
    if (unsubscribe && open) {
      this.openRequests.delete(requestId);
      this.cancelledRequests.set(requestId, { view: String(entry.key || "").slice(0, 120), why });
    }
    this.rememberClosed(subscriptionId);
    this.subscriptionToKey.delete(subscriptionId);
    if (why) this.requestToKey.delete(requestId);
    entry.subscription_id = "";
    entry.stream_id = "";
    resetSequenceSpace(entry);
  }

  // The last reply of a request (its snapshot, or an error) arrived. Answers whether it was a request this store let
  // go of, i.e. the reply is for a view already closed.
  settle(requestId) {
    const id = String(requestId || "");
    this.openRequests.delete(id);
    const cancelled = this.cancelledRequests.delete(id);
    if (cancelled) this.metrics.cancelled_reply_count += 1;
    return cancelled;
  }

  subscribe(entry, { reconnect = false, recovery = false } = {}) {
    // A new subscription replaces whatever the old one was being repaired for.
    this.recovery.end(entry, "abandoned", { reason: "resubscribed" }, recovery ? ["resync"] : null);
    this.requestSeq += 1;
    const requestId = `view-${this.now()}-${this.requestSeq}`;
    const selection = selectionContext(entry.spec.code);
    if (selection) {
      selection.requests.push(requestId);
      if (selection.requests.length > 256) selection.requests.shift();
      selectionMark(entry.spec.code, "renderer_request_sent", selection);
      selectionMark(entry.spec.code, "subscribe_requested", selection);
    }
    this._unbind(entry, "resubscribed");
    entry.request_id = requestId;
    entry.status = "SUBSCRIBING";
    entry.last_error = null;
    entry.subscribe_sent_at = this.now();
    entry.accepted_at = 0;
    this.requestToKey.set(requestId, entry.key);
    this.openRequests.add(requestId);
    // delta_batch: this connection reads view.delta.batch (the store's handleDeltaBatch), so Market Runtime may
    // coalesce one drain of deltas into a single frame instead of one frame per delta.
    this.send({ type: "view.subscribe", payload: { ...entry.spec, request_id: requestId, delta_batch: true,
      ...(selection ? {selection_generation:selection.selection_generation, selection_request_id:selection.request_id,
        selection_started_ns:selection.selection_started_ns,from_code:selection.from_code} : {}) } });
    // The initial state is the snapshot Market Runtime sends right after view.subscription.accepted (snapshot_follows):
    // one contract, one baseline; a second, independent view.snapshot here would race it.
    // view.snapshot stays a one-shot read for clients that hold no view (rust_view_client).
    this.emitMetric(entry, "subscribe_sent", { request_id: requestId, reconnect: Boolean(reconnect) });
    this.metrics.client_subscription_created += 1;
    if (reconnect) this.metrics.reconnect_snapshot_count += 1;
  }

  // The view's last consumer left: no live subscription survives (the store keeps the state as display cache).
  release(entry) {
    this._unbind(entry, "view_released");
    entry.request_id = "";
    this.recovery.end(entry, "abandoned", { reason: "view_released" });
  }

  // The store dropped a cached entry.
  forget(entry) {
    this.requestToKey.delete(String(entry.request_id || ""));
    this.subscriptionToKey.delete(entry.subscription_id);
  }

  onConnected(connectionId = "") {
    this.connected = true;
    this.connectionId = String(connectionId || "");
    for (const entry of this.entries.values()) {
      if (!entry.callbacks.size) continue;
      this.subscriptionToKey.delete(entry.subscription_id);
      entry.subscription_id = "";
      entry.stream_id = "";
      entry.status = "SUBSCRIBING";
      const reconnect = Boolean(entry.state);
      this.subscribe(entry, { reconnect });
      // A view that had a baseline is re-subscribed on the new connection: one recorded recovery, ended by the
      // snapshot that re-baselines it. Only a metric marked it, so a view left without a snapshot after a
      // reconnect had no record, and the 55 s re-subscribe that followed could not be tied to the connection.
      if (reconnect) this.recovery.begin(entry, "resubscribe", "renderer.view_resubscribe", "reconnect");
    }
  }

  onDisconnected() {
    this.connected = false;
    // The daemon dropped every view of the connection: no reply to its requests can come any more.
    this.openRequests.clear();
    this.cancelledRequests.clear();
    for (const entry of this.entries.values()) {
      // The daemon drops every view of a closed connection, so their late frames cannot arrive -- but remember them
      // anyway: a frame already in flight on this socket is then counted as late, never as an unknown subscription.
      this._unbind(entry, "", { unsubscribe: false });
      entry.status = "UNSUBSCRIBED";
      // The connection's own reconnect is the recovery now (renderer.live_ws_reconnect).
      this.recovery.end(entry, "abandoned", { reason: "disconnected" });
    }
  }

  // view.subscription.accepted: binds the entry whose current request it answers. Returns the entry; { cancelled }
  // for a request this store let go of; or a refusal { reason, detail } for a request it never had open -- a fault
  // of the reply, since every request this store stops waiting for is cancelled.
  accept(payload = {}) {
    const requestId = String(payload.request_id || "");
    const subscriptionId = String(payload.subscription_id || "");
    if (this.cancelledRequests.has(requestId)) {
      // not an error: the view was let go of before this reply and its cancel is already sent. Deltas it streams
      // before Market Runtime reads the cancel are late frames of a closed view.
      this.rememberClosed(subscriptionId);
      return { cancelled: true };
    }
    const key = this.requestToKey.get(requestId);
    const entry = key ? this.entries.get(key) : null;
    if (!entry || requestId !== entry.request_id) {
      return { entry, refused: { reason: "UNKNOWN_REQUEST", detail: { request_id: requestId, actual_subscription: subscriptionId, stream_id: payload.stream_id || "" } } };
    }
    const previousSubscription = entry.subscription_id;
    if (previousSubscription && previousSubscription !== subscriptionId) {
      this.subscriptionToKey.delete(previousSubscription);
      if (this.connected) this.send({ type: "view.unsubscribe", payload: { subscription_id: previousSubscription } });
      this.rememberClosed(previousSubscription);
    }
    if (entry.baseline_subscription_id && entry.baseline_subscription_id !== subscriptionId) resetSequenceSpace(entry);
    entry.subscription_id = subscriptionId;
    entry.stream_id = String(payload.stream_id || "");
    entry.watermark = Number(payload.watermark || 0);
    entry.status = "SNAPSHOT_PENDING";
    entry.accepted_at = this.now();
    if (entry.subscription_id) this.subscriptionToKey.set(entry.subscription_id, entry.key);
    this.emitMetric(entry, "subscription_accepted", { sequence: entry.watermark });
    return { entry };
  }

  // view.error for the entry's subscription or request: the subscription is gone; revisit() retries it.
  fail(entry, error) {
    this.openRequests.delete(String(entry.request_id || ""));
    entry.status = "ERROR";
    entry.last_error = String(error || "view subscription error");
    entry.error_at = this.now();
    this._unbind(entry, "view_error", { unsubscribe: false });
  }

  // `reason` is what the view needs re-baselining for; the request opens (or adds an attempt to) the view's recorded
  // resync, which the snapshot answering it ends.
  resync(entry, { force = false, nowMs = this.now(), reason = "client_request", detail = {} } = {}) {
    if (!entry || !entry.subscription_id || !this.connected) return false;
    if (!force && entry.last_resync_at && nowMs - entry.last_resync_at < this.resyncCooldownMs) return false;
    entry.status = "RESYNCING";
    entry.resync_required = true;
    if (entry.state) entry.state = { ...entry.state, resync_required: true };
    entry.last_resync_at = nowMs;
    this.metrics.resync_count += 1;
    this.recovery.begin(entry, "resync", "renderer.view_resync", reason, { sequence: entry.last_sequence, ...detail });
    this.requestSeq += 1;
    const requestId = `view-resync-${this.now()}-${this.requestSeq}`;
    // The daemon echoes this request_id on the view.snapshot it answers with (market_runtime_daemon.rs "view.resync"),
    // and the store refuses any snapshot whose request_id is not one the entry is waiting for. It is recorded as a
    // second accepted id rather than overwriting entry.request_id, which accept() still matches subscribe acceptances
    // against.
    entry.resync_request_id = requestId;
    this.emitMetric(entry, "view_resyncing", { sequence: entry.last_sequence, request_id: requestId });
    // `reason` travels with the request: Market Runtime records every client resync by view and reason.
    return this.send({ type: "view.resync", payload: { subscription_id: entry.subscription_id, last_sequence: entry.last_sequence,
      request_id: requestId, reason } });
  }

  // Revisits views waiting on a request (subscribe/snapshot/resync) or in RESYNC_REQUIRED / ERROR. Never a LIVE one.
  revisit(nowMs = this.now()) {
    if (!this.connected) return;
    for (const entry of this.entries.values()) {
      if (!entry.callbacks.size) continue;
      if (["SUBSCRIBING", "SNAPSHOT_PENDING", "RESYNCING"].includes(entry.status)) {
        const startedAt = entry.status === "SNAPSHOT_PENDING"
          ? (entry.accepted_at || entry.subscribe_sent_at)
          : entry.status === "RESYNCING" ? entry.last_resync_at : entry.subscribe_sent_at;
        if (startedAt && nowMs - startedAt > this.subscriptionTimeoutMs) {
          this.metrics.subscription_timeout_count += 1;
          entry.retry_count += 1;
          this.emitMetric(entry, "subscription_timeout", { reason: entry.status, stale_ms: nowMs - startedAt });
          this.recovery.begin(entry, "resubscribe", "renderer.view_resubscribe", "request_timeout",
            { waited_ms: nowMs - startedAt, status: entry.status });
          this.subscribe(entry, { reconnect: true, recovery: true });
        }
        continue;
      }
      // A gap (or a daemon/generation change) marks the view RESYNC_REQUIRED and asks for a resync, but resync()
      // refuses inside its cooldown -- and deltas are then rejected until a snapshot arrives. Nothing else revisits
      // this state, so a second gap within the cooldown froze the view until the user happened to resubscribe it (a tab
      // switch). Ask again here; the cooldown still bounds the rate, and an accepted resync moves the entry to RESYNCING.
      if (entry.status === "RESYNC_REQUIRED") {
        this.resync(entry, { nowMs, reason: "resync_retry" });
        continue;
      }
      if (entry.status === "ERROR") {
        const delay = Math.min(this.errorRetryMaxMs, this.errorRetryBaseMs * (2 ** Math.min(entry.retry_count, 4)));
        if (!entry.error_at || nowMs - entry.error_at >= delay) {
          entry.retry_count += 1;
          this.metrics.subscription_retry_count += 1;
          this.recovery.begin(entry, "resubscribe", "renderer.view_resubscribe", "view_error", { error: entry.last_error });
          this.subscribe(entry, { reconnect: true, recovery: true });
        }
        continue;
      }
      // A LIVE view that is merely quiet is left alone: a product with no trades is not a broken view. The
      // connection's health is the socket heartbeat (realtime.js), a lost delta is a sequence gap (RESYNC_REQUIRED
      // above), and a wrong identity is handled where the delta is gated.
    }
  }
}
