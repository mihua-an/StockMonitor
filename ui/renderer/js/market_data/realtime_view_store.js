import { beginRemediation, emitRemediation } from "../core/remediation.js";
import { normalizeSpec, specKey } from "./view_identity.js";
import { normalizeMinuteTrendSeries } from "./minute_trend.js";
import { applyDeltaToState, clone, nowIso, presentationState } from "./view_state_reducer.js";
import { deliverToConsumer } from "./consumer_delivery.js";
import { createViewRecovery } from "./view_recovery.js";
import { deltaVerdict, foreignIdentity, resetSequenceSpace, snapshotEpoch } from "./sequence_gate.js";
import { ViewSubscriptions } from "./view_subscriptions.js";
import { DeliveryBatch, applyBatchItems } from "./delivery_batch.js";
import { applyViewDiff } from "./view_diff.js";

// The live views' store: the facade the transport (realtime.js) and the views' consumers talk to. It holds the
// entries and applies what its parts decide -- view_identity.js (what a view is), view_subscriptions.js (which
// subscription a view is bound to, and binding / re-binding / releasing it), sequence_gate.js (which snapshot may
// re-baseline a view and which delta may continue it), view_state_reducer.js (what a delta does to the state),
// view_recovery.js (the recorded recoveries), delivery_batch.js (one notification per view for a delta batch) and
// consumer_delivery.js (handing one event to one consumer, isolated).
export class RealtimeViewStore {
  constructor({
    send = null,
    onMetric = null,
    resyncCooldownMs = 10000,
    subscriptionTimeoutMs = 55000,
    errorRetryBaseMs = 2000,
    errorRetryMaxMs = 15000,
    cacheRetentionMs = 5 * 60 * 1000,
    maxCachedEntries = 64,
    // Where this store records its recoveries and protocol faults (Health's ledger through core/remediation.js).
    remediation = { begin: beginRemediation, emit: emitRemediation },
  } = {}) {
    this.send = typeof send === "function" ? send : () => false;
    // A per-delta metric consumer (tests, diagnostics tools). Without one no metric payload is built at all.
    this.onMetric = typeof onMetric === "function" ? onMetric : null;
    this.entries = new Map();
    this.cacheRetentionMs = Math.max(10000, Number(cacheRetentionMs) || 5 * 60 * 1000);
    this.maxCachedEntries = Math.max(8, Number(maxCachedEntries) || 64);
    // The delta batch being applied (handleDeltaBatch), or null.
    this.batch = null;
    this.metrics = {
      client_subscription_count: 0,
      client_subscription_created: 0,
      client_subscription_closed: 0,
      snapshot_count: 0,
      // Replay seeks applied as what changed (view.replay_diff) instead of a whole view.
      replay_diff_count: 0,
      delta_count: 0,
      duplicate_delta_count: 0,
      sequence_gap_count: 0,
      resync_count: 0,
      // Market Runtime dropped this connection's queue (slow consumer) and re-baselined every view.
      server_resync_count: 0,
      last_server_resync_reason: null,
      reconnect_snapshot_count: 0,
      stale_snapshot_count: 0,
      renderer_delta_received: 0,
      renderer_delta_accepted: 0,
      renderer_delta_rejected: 0,
      renderer_delta_applied: 0,
      renderer_notified: 0,
      renderer_delta_batch_received: 0,
      renderer_delta_batch_items: 0,
      renderer_delta_batch_aborted: 0,
      stale_view_count: 0,
      protocol_fault_count: 0,
      subscription_timeout_count: 0,
      subscription_retry_count: 0,
      cancelled_reply_count: 0,
      late_closed_delta_count: 0,
      late_closed_snapshot_count: 0,
      last_reject_reason: "",
    };
    this.subscriptions = new ViewSubscriptions({
      entries: this.entries,
      // Read at each send: a caller may replace `send` after construction.
      send: (message) => this.send(message),
      recovery: createViewRecovery({ remediation, connectionId: () => this.subscriptions.connectionId }),
      emitMetric: (entry, name, detail) => this._emitMetric(entry, name, detail),
      metrics: this.metrics,
      resyncCooldownMs, subscriptionTimeoutMs, errorRetryBaseMs, errorRetryMaxMs,
    });
    this.recovery = this.subscriptions.recovery;
  }

  get connected() { return this.subscriptions.connected; }

  _emitMetric(entry, name, detail = {}) {
    if (!this.onMetric) {
      // Only the entry's own receive / apply times are kept (describe() reports them).
      if (entry && (name === "snapshot_received" || name === "delta_received")) entry.last_received_at = nowIso();
      if (entry && (name === "snapshot_applied" || name === "delta_applied")) entry.last_applied_at = nowIso();
      return;
    }
    if (this.batch) {
      this.batch.addMetric(entry, name, detail);
      return;
    }
    const payload = {
      name,
      subscription_id: entry?.subscription_id || "",
      stream_id: entry?.stream_id || detail.stream_id || "",
      sequence: Number(detail.sequence ?? entry?.last_sequence ?? 0),
      state: entry?.status || "UNKNOWN",
      reason: detail.reason || "",
      expected_stream: detail.expected_stream || "",
      actual_stream: detail.actual_stream || "",
      expected_subscription: detail.expected_subscription || "",
      actual_subscription: detail.actual_subscription || "",
      symbol: entry?.spec?.code || detail.symbol || "",
      at: nowIso(),
      ...detail,
    };
    if (entry && (name === "snapshot_received" || name === "delta_received")) entry.last_received_at = payload.at;
    if (entry && (name === "snapshot_applied" || name === "delta_applied")) entry.last_applied_at = payload.at;
    try { this.onMetric(payload); } catch (error) { console.warn("[view store: metric callback] failed", error); }
  }

  // Market Runtime binds a view to one partition and rebinds it itself (with a fresh snapshot) when that partition
  // moves (server.rs view rebind), so a delta or snapshot of another identity is a protocol fault of the producer
  // side, not something to guess about. It is refused, the view shows stale, and the fault is recorded
  // once per baseline; the next snapshot that applies (A's rebind) clears it.
  _protocolFault(entry, triggerReason, detail) {
    entry.status = "STALE";
    if (entry.protocol_fault) return false;
    entry.protocol_fault = { trigger: triggerReason, ...detail, at: Date.now() };
    this.metrics.protocol_fault_count += 1;
    this.metrics.stale_view_count += 1;
    this._emitMetric(entry, "view_protocol_fault", { reason: triggerReason, ...detail });
    this.recovery.record(entry, "renderer.view_protocol_fault", triggerReason, "suppressed", detail);
    return false;
  }

  // A reply to a view.subscribe this window never had open. Every request the window stops waiting for is cancelled
  // by its request id and its replies are known, so this is a fault of the reply: recorded with the view it names.
  _unknownReply(path, payload) {
    const subscriptionId = String(payload.subscription_id || "");
    const detail = { path, request_id: String(payload.request_id || ""), actual_subscription: subscriptionId };
    this.metrics.protocol_fault_count += 1;
    this._emitMetric(null, "view_protocol_fault", { reason: "unknown_request_reply", ...detail });
    this.recovery.record(null, "renderer.view_protocol_fault", "unknown_request_reply", "suppressed", detail,
      { subscription_id: subscriptionId, connection_id: this.subscriptions.connectionId || "" });
  }

  _reject(entry, reason, detail = {}) {
    this.metrics.renderer_delta_rejected += 1;
    this.metrics.last_reject_reason = String(reason || "unknown");
    if (entry) {
      entry.rejected_count += 1;
      entry.last_reject_reason = String(reason || "unknown");
      entry.last_reject_at = Date.now();
      // Retained, not just emitted: a frozen view has to be diagnosable from the telemetry Health
      // already collects.
      entry.last_reject_field = String(detail?.field || "");
      entry.last_reject_expected = detail?.expected === undefined ? "" : String(detail.expected);
      entry.last_reject_actual = detail?.actual === undefined ? "" : String(detail.actual);
    }
    const metricName = detail?.event_type === "delta" ? "delta_rejected" : detail?.event_type === "snapshot" ? "snapshot_rejected" : "view_rejected";
    this._emitMetric(entry, metricName, { reason, ...detail });
    return false;
  }

  _entry(spec) {
    const normalized = normalizeSpec(spec);
    const key = specKey(normalized);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        spec: normalized,
        request_id: "",
        subscription_id: "",
        stream_id: "",
        daemon_instance_id: "",
        session_generation: 0,
        watermark: 0,
        last_sequence: 0,
        last_received_sequence: 0,
        last_applied_sequence: 0,
        last_rendered_sequence: 0,
        // The subscription whose snapshot the sequence fields above count from (sequence_gate.js resetSequenceSpace).
        baseline_subscription_id: "",
        state: null,
        callbacks: new Map(),
        status: "UNSUBSCRIBED",
        resync_required: false,
        last_error: null,
        duplicate_count: 0,
        rejected_count: 0,
        // A delta/snapshot that broke the view's identity contract, recorded once until a new baseline.
        protocol_fault: null,
        // Open recoveries of this view: kind -> { handle, attempts } (each recorded, with its reason).
        recoveries: new Map(),
        resync_request_id: "",
        last_reject_reason: "",
        last_snapshot_at: 0,
        last_delta_at: 0,
        last_render_at: 0,
        last_receive_at: 0,
        last_apply_at: 0,
        last_reject_at: 0,
        last_resync_at: 0,
        subscribe_sent_at: 0,
        accepted_at: 0,
        error_at: 0,
        retry_count: 0,
        retained_at: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  _activeCount() {
    return [...this.entries.values()].filter((item) => item.callbacks.size > 0).length;
  }

  subscribe(spec, callback, options = {}) {
    const entry = this._entry(spec);
    if (typeof callback === "function") entry.callbacks.set(callback, {
      stateDelivery: String(options?.stateDelivery || "always"),
      // Who consumes the view (a component id), for the consumer-fault record.
      consumer: String(options?.consumer || ""),
      faulted: false,
    });
    entry.retained_at = 0;
    if (this.connected && !entry.subscription_id && entry.status !== "SUBSCRIBING") this.subscriptions.subscribe(entry);
    this.metrics.client_subscription_count = this._activeCount();
    // replayCached:false -- the caller still holds what the cache would replay and waits for the fresh snapshot the
    // re-subscribe requests. Returning to 即時報價 re-subscribes every product row; replaying 74 cached views
    // synchronously (a full clone + apply each) blocked the page switch for about a second.
    let released = false;
    const release = () => {
      // A repeated component destroy can arrive after a page with the same spec
      // has mounted again. Never let an old handle remove the new store entry.
      if (released) return;
      released = true;
      if (this.entries.get(entry.key) !== entry) return;
      if (typeof callback === "function") entry.callbacks.delete(callback);
      if (!entry.callbacks.size) {
        this.subscriptions.release(entry);
        // Keep the last authoritative snapshot for fast A/B/A tab and symbol
        // switches. It is display cache only: no live subscription survives.
        entry.status = entry.state ? "CACHED" : "CLOSED";
        entry.retained_at = Date.now();
        this._pruneCachedEntries();
        this.metrics.client_subscription_closed += 1;
        this.metrics.client_subscription_count = this._activeCount();
      }
    };
    // The cached view goes through the same isolated delivery as every notification: a callback that throws on it is
    // recorded as a consumer fault and the caller still gets its handle.
    if (entry.state && typeof callback === "function" && options?.replayCached !== false) {
      const event = { type: "snapshot" };
      this._deliverToConsumer(entry, callback, entry.callbacks.get(callback), event, () => this.snapshot(entry.key), () => this.describe(entry.key));
    }
    return release;
  }

  _pruneCachedEntries(nowMs = Date.now()) {
    const cached = [...this.entries.values()]
      .filter((entry) => !entry.callbacks.size)
      .sort((a, b) => Number(a.retained_at || 0) - Number(b.retained_at || 0));
    for (const entry of cached) {
      const expired = !entry.retained_at || nowMs - entry.retained_at > this.cacheRetentionMs;
      const overLimit = this.entries.size > this.maxCachedEntries;
      if (!expired && !overLimit) continue;
      this.subscriptions.forget(entry);
      this.entries.delete(entry.key);
    }
  }

  _notify(entry, event) {
    if (this.batch) {
      this.batch.addNotification(entry, event);
      return;
    }
    const renderStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    let projected = false;
    let cachedSnapshot;
    // The entry's description is built only for a consumer that reads it (the workspace's control state); building
    // it for every notification copied the spec each time.
    let cachedDescription;
    const describeOnce = () => (cachedDescription ??= this.describe(entry.key));
    const snapshotOnce = () => (cachedSnapshot ??= this.snapshot(entry.key));
    for (const [callback, delivery] of entry.callbacks) {
      if (this._deliverToConsumer(entry, callback, delivery, event, snapshotOnce, describeOnce)) projected = true;
    }
    if (projected) {
      const renderDuration = (typeof performance !== "undefined" ? performance.now() : Date.now()) - renderStarted;
      const sequence = Number(event.sequence ?? event.watermark ?? entry.last_applied_sequence ?? 0);
      entry.last_notified_sequence = sequence;
      entry.last_render_at = Date.now();
      this.metrics.renderer_notified += 1;
      this._emitMetric(entry, "subscriber_notified", { sequence, event_type: event.type, render_callback_ms: renderDuration });
    }
  }

  // One consumer, one event: the state attached as the consumer asked for it, isolated so a consumer that throws leaves
  // the data right and the screen stale -- recorded with the view and the consumer, once per fault streak. Answers
  // whether the consumer took it.
  _deliverToConsumer(entry, callback, delivery, event, snapshotOf, describeOf) {
    return deliverToConsumer({ callback, delivery, event, snapshotOf, describeOf, onFault: (error, firstOfStreak) => {
      this.metrics.consumer_fault_count = (this.metrics.consumer_fault_count || 0) + 1;
      if (!firstOfStreak) return;
      this.recovery.record(entry, "renderer.view_consumer_fault", "callback_threw", "suppressed", {
        consumer: delivery?.consumer || "unnamed", event_type: event.type,
        error: String(error?.stack || error?.message || error).slice(0, 400) });
    } });
  }

  onConnected(connectionId = "") {
    this._pruneCachedEntries();
    this.subscriptions.onConnected(connectionId);
  }

  onDisconnected() {
    this.subscriptions.onDisconnected();
  }

  handleAccepted(payload = {}) {
    const { entry, refused, cancelled } = this.subscriptions.accept(payload);
    if (cancelled) return false;
    if (!refused) return true;
    this._unknownReply("accepted", payload);
    return this._reject(entry, refused.reason, refused.detail);
  }

  handleSnapshot(payload = {}) {
    const subscriptionId = String(payload.subscription_id || "");
    const requestId = String(payload.request_id || "");
    const routed = this._routeSnapshot(payload, subscriptionId, requestId);
    if (!routed.entry) return routed.result;
    const { entry } = routed;
    const epoch = snapshotEpoch(entry, payload, subscriptionId, requestId);
    if (epoch.refuse) {
      this._reject(entry, epoch.refuse.reason, epoch.refuse.detail);
      if (epoch.refuse.fault) return this._protocolFault(entry, epoch.refuse.fault.trigger, epoch.refuse.fault.detail);
      return false;
    }
    if (epoch.reset) this._resetEpoch(entry, payload, epoch.reset);
    return this._applySnapshot(entry, payload, subscriptionId);
  }

  // Which entry a snapshot belongs to, through every transport and identity gate. { entry } or { result } (refused).
  _routeSnapshot(payload, subscriptionId, requestId) {
    // A subscribe's snapshot is its last reply; one for a request this window let go of answers a closed view.
    if (requestId && this.subscriptions.settle(requestId)) return { result: false };
    const entry = this.subscriptions.entryFor(subscriptionId, requestId);
    if (!entry) {
      if (this.subscriptions.isRecentlyClosed(subscriptionId)) {
        // not an error: Market Runtime cut it (a rebind or resync of its own) before it read this window's unsubscribe.
        this.metrics.late_closed_snapshot_count += 1;
        this._emitMetric(null, "late_closed_snapshot_ignored", { actual_subscription: subscriptionId, stream_id: payload.stream_id || "", event_type: "snapshot" });
        return { result: false };
      }
      if (requestId) this._unknownReply("snapshot", payload);
      return { result: this._reject(null, "UNKNOWN_SUBSCRIPTION", { actual_subscription: subscriptionId, stream_id: payload.stream_id || "" }) };
    }
    if (requestId && requestId !== entry.request_id && requestId !== entry.resync_request_id) {
      return { result: this._reject(entry, "SUPERSEDED_SNAPSHOT", { actual_subscription: subscriptionId, stream_id: payload.stream_id || "" }) };
    }
    if (entry.subscription_id && subscriptionId !== entry.subscription_id) {
      return { result: this._reject(entry, "WRONG_SUBSCRIPTION", { expected_subscription: entry.subscription_id, actual_subscription: subscriptionId, stream_id: payload.stream_id || "" }) };
    }
    const incomingStream = String(payload.stream_id || "");
    if (entry.stream_id && incomingStream && incomingStream !== entry.stream_id) {
      return { result: this._reject(entry, "WRONG_STREAM", { expected_stream: entry.stream_id, actual_stream: incomingStream, sequence: payload.watermark || 0 }) };
    }
    // Snapshots had every transport gate above (subscription, stream, daemon instance, session
    // generation, watermark) but no *identity* gate, so a snapshot naming another market/session
    // was accepted unconditionally and became entry.state. That is worse than a blank panel: it
    // is displayable wrong data, and because handleDelta below compares incoming deltas against
    // entry.state.session_key, a foreign snapshot also silently re-baselines the delta gate, so
    // the rest of that session's deltas pass too. The snapshot must be held to the same identity
    // rule its deltas are.
    //
    // This gate deliberately does NOT resync, unlike the delta gate. Its authority is entry.spec,
    // so reaching it means the daemon answered our own view.subscribe/view.snapshot with a
    // different session than the one we asked for: resyncing carries only the subscription_id and
    // would ask the same subscription the same question. The entry is also still supervised at
    // this point -- it is SUBSCRIBING/SNAPSHOT_PENDING/RESYNCING, which checkStaleness resubscribes
    // after subscriptionTimeoutMs, or it is LIVE with its own deltas still flowing and its state
    // untouched.
    const foreignSnapshot = foreignIdentity(entry.spec, payload);
    if (foreignSnapshot) {
      this._reject(entry, "WRONG_SESSION_IDENTITY", {
        ...foreignSnapshot, event_type: "snapshot",
        sequence: Number(payload.watermark ?? payload.sequence ?? 0),
        actual_subscription: subscriptionId, stream_id: incomingStream,
      });
      return { result: this._protocolFault(entry, "foreign_snapshot_identity", { ...foreignSnapshot, event_type: "snapshot" }) };
    }
    return { entry };
  }

  // Sequence numbers are local to one daemon/session generation. A daemon restart can legitimately return a lower
  // snapshot watermark; retaining the previous epoch's sequence would reject the recovery snapshot and leave the
  // visible quote frozen forever.
  _resetEpoch(entry, payload, reason) {
    entry.watermark = 0;
    entry.last_sequence = 0;
    entry.last_received_sequence = 0;
    entry.last_applied_sequence = 0;
    entry.last_rendered_sequence = 0;
    entry.state = null;
    entry.resync_required = false;
    this._emitMetric(entry, "view_epoch_reset", {
      reason,
      previous_daemon_instance_id: entry.daemon_instance_id,
      daemon_instance_id: String(payload.daemon_instance_id || ""),
      previous_session_generation: entry.session_generation,
      session_generation: Number(payload.session_generation || 0),
    });
  }

  _applySnapshot(entry, payload, subscriptionId) {
    const incomingStream = String(payload.stream_id || "");
    const incomingDaemon = String(payload.daemon_instance_id || "");
    const incomingGeneration = Number(payload.session_generation || 0);
    const watermark = Number(payload.watermark || 0);
    // A watermark is only comparable within the subscription that numbered it. The first snapshot of a subscription
    // starts its sequence space; only later snapshots of the SAME subscription (a resync, a slow-consumer or rollover
    // re-cut) can be older than what was already applied.
    const sameSequenceSpace = Boolean(subscriptionId) && entry.baseline_subscription_id === subscriptionId;
    if (sameSequenceSpace && entry.last_sequence > watermark) {
      this.metrics.stale_snapshot_count += 1;
      return this._reject(entry, "STALE_SNAPSHOT", { sequence: watermark, actual_subscription: subscriptionId, event_type: "snapshot" });
    }
    if (!sameSequenceSpace) resetSequenceSpace(entry);
    entry.baseline_subscription_id = subscriptionId;
    entry.stream_id = incomingStream || entry.stream_id || "";
    entry.daemon_instance_id = incomingDaemon;
    entry.session_generation = incomingGeneration;
    entry.watermark = watermark;
    entry.last_sequence = watermark;
    entry.last_received_sequence = watermark;
    entry.last_applied_sequence = watermark;
    const state = clone(payload);
    if (Array.isArray(state?.trend)) state.trend = normalizeMinuteTrendSeries(state.trend);
    state.resync_required = false;
    entry.state = state;
    entry.resync_required = false;
    entry.resync_request_id = "";
    entry.status = "SNAPSHOT_APPLIED";
    entry.last_error = null;
    entry.retry_count = 0;
    entry.error_at = 0;
    entry.protocol_fault = null;
    // The snapshot that re-baselines the view ends whatever recovery asked for it.
    this.recovery.end(entry, "succeeded", { watermark });
    entry.last_snapshot_at = Date.now();
    entry.last_receive_at = entry.last_snapshot_at;
    entry.last_apply_at = entry.last_snapshot_at;
    this.metrics.snapshot_count += 1;
    this._emitMetric(entry, "snapshot_received", { sequence: watermark, event_type: "snapshot" });
    this._emitMetric(entry, "snapshot_applied", { sequence: watermark, event_type: "snapshot" });
    this._notify(entry, { type: "snapshot", watermark, sequence: watermark });
    entry.status = "LIVE";
    return true;
  }

  // A replay view moved by a seek, as what changed from the view this window holds (Market Runtime sends one only
  // when the view held is the one it sent last: that sequence, that generation, nothing since). One that does not
  // fit is the producer's fault, recorded, and the view is asked for whole.
  handleReplayDiff(payload = {}) {
    const subscriptionId = String(payload.subscription_id || "");
    const entry = this.subscriptions.entryFor(subscriptionId);
    const sequence = Number(payload.sequence || 0);
    if (!entry) {
      if (this.subscriptions.isRecentlyClosed(subscriptionId)) {
        // not an error: the seek's answer crossed this window's unsubscribe.
        this.metrics.late_closed_delta_count += 1;
        this._emitMetric(null, "late_closed_delta_ignored", { actual_subscription: subscriptionId, sequence, event_type: "replay_diff" });
        return false;
      }
      return this._reject(null, "UNKNOWN_SUBSCRIPTION", { actual_subscription: subscriptionId, sequence, event_type: "replay_diff" });
    }
    const base = { sequence: Number(payload.base_sequence || 0), generation: payload.base_generation ?? null };
    const held = { sequence: entry.last_sequence, generation: entry.state?.generation ?? null, subscription: entry.baseline_subscription_id };
    let state = null, unfit = "";
    if (held.subscription !== subscriptionId || held.sequence !== base.sequence || held.generation !== base.generation) unfit = "base_mismatch";
    else {
      try { state = applyViewDiff(entry.state, payload.ops); } catch (error) { unfit = String(error?.message || error).slice(0, 300); }
    }
    if (unfit) {
      const detail = { reason: unfit, sequence, base_sequence: base.sequence, held_sequence: held.sequence,
        base_generation: base.generation, held_generation: held.generation, actual_subscription: subscriptionId };
      this._reject(entry, "REPLAY_DIFF_UNFIT", { ...detail, event_type: "replay_diff" });
      this._protocolFault(entry, "replay_diff_unfit", detail);
      this.requestResync(entry.key, { reason: "replay_diff_unfit", detail });
      return false;
    }
    const channels = Array.isArray(payload.channels) ? payload.channels.map(String) : [];
    if (channels.includes("trend") && Array.isArray(state.trend)) state.trend = normalizeMinuteTrendSeries(state.trend);
    state.resync_required = false;
    // The replay's generation, as a snapshot's is read (realtime.js normalizeCanonicalPayload): it rises at every seek.
    state.session_generation = Number(state.generation || 0);
    entry.session_generation = state.session_generation;
    entry.state = state;
    entry.watermark = sequence;
    entry.last_sequence = sequence;
    entry.last_received_sequence = sequence;
    entry.last_applied_sequence = sequence;
    entry.last_receive_at = Date.now();
    entry.last_apply_at = entry.last_receive_at;
    this.metrics.replay_diff_count += 1;
    this._emitMetric(entry, "replay_diff_applied", { sequence, event_type: "replay_diff" });
    this._notify(entry, { type: "patch", watermark: sequence, sequence, changedChannels: channels });
    return true;
  }

  handleDelta(payload = {}) {
    const subscriptionId = String(payload.subscription_id || "");
    const entry = this.subscriptions.entryFor(subscriptionId);
    const sequence = Number(payload.sequence || 0);
    this.metrics.renderer_delta_received += 1;
    if (!entry) {
      if (this.subscriptions.isRecentlyClosed(subscriptionId)) {
        this.metrics.late_closed_delta_count += 1;
        this._emitMetric(null, "late_closed_delta_ignored", { actual_subscription: subscriptionId, stream_id: payload.stream_id || "", sequence, event_type: "delta" });
        return false;
      }
      return this._reject(null, "UNKNOWN_SUBSCRIPTION", { actual_subscription: subscriptionId, stream_id: payload.stream_id || "", sequence, event_type: "delta" });
    }
    entry.last_received_sequence = Math.max(entry.last_received_sequence, sequence);
    entry.last_receive_at = Date.now();
    this._emitMetric(entry, "delta_received", { sequence, actual_stream: payload.stream_id || "", event_type: "delta" });
    const verdict = deltaVerdict(entry, payload, subscriptionId);
    if (!verdict.accept) return this._refuseDelta(entry, verdict);
    this.metrics.renderer_delta_accepted += 1;
    this._emitMetric(entry, "delta_accepted", { sequence, event_type: "delta" });
    const next = applyDeltaToState(entry.state, payload);
    const incomingGeneration = Number(payload.session_generation || 0);
    if (incomingGeneration > entry.session_generation) entry.session_generation = incomingGeneration;
    entry.last_sequence = sequence;
    entry.last_applied_sequence = sequence;
    entry.last_delta_at = Date.now();
    entry.last_apply_at = entry.last_delta_at;
    next.watermark = sequence;
    next.last_sequence = sequence;
    next.trace = {...(payload.trace || {}), trace_id:entry.request_id,
      renderer_receive_ms:payload.trace?.renderer_receive_ms ?? entry.last_receive_at,renderer_apply_ms:entry.last_apply_at};
    entry.state = next;
    entry.status = "LIVE";
    this.metrics.delta_count += 1;
    this.metrics.renderer_delta_applied += 1;
    this._emitMetric(entry, "delta_applied", { sequence, delta_type: payload.delta_type || "", event_type: "delta" });
    this._notify(entry, { type: "delta", delta: payload, sequence });
    if (["snapshot.required", "stream.reset"].includes(payload.delta_type)) this.requestResync(entry.key, { reason: "server_reset" });
    return true;
  }

  // Applies a refused delta's verdict (sequence_gate.js deltaVerdict): the refusal is recorded, then what follows it.
  _refuseDelta(entry, verdict) {
    if (verdict.then === "gap") {
      entry.resync_required = true;
      entry.status = "RESYNC_REQUIRED";
      if (entry.state) entry.state = { ...entry.state, resync_required: true };
      this.metrics.sequence_gap_count += 1;
      this._reject(entry, verdict.reason, verdict.detail);
      this._notify(entry, { type: "gap", expected_sequence: verdict.expected, received_sequence: verdict.sequence, sequence: verdict.sequence });
      this.requestResync(entry.key, { reason: "sequence_gap", detail: { expected_sequence: verdict.expected, received_sequence: verdict.sequence } });
      return false;
    }
    if (verdict.status) entry.status = verdict.status;
    if (verdict.duplicate) {
      entry.duplicate_count += 1;
      this.metrics.duplicate_delta_count += 1;
    }
    this._reject(entry, verdict.reason, verdict.detail);
    if (verdict.then === "protocol_fault") return this._protocolFault(entry, verdict.fault.trigger, verdict.fault.detail);
    if (verdict.then === "resync") this.requestResync(entry.key, { reason: verdict.resyncReason });
    return false;
  }

  handleDeltaBatch(payload = {}) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) return false;
    this.metrics.renderer_delta_batch_received += 1;
    this.metrics.renderer_delta_batch_items += items.length;
    this._emitMetric(null, "renderer_delta_batch_received", { count: 1, items: items.length, event_type: "delta_batch" });
    const batch = new DeliveryBatch();
    this.batch = batch;
    // The batch mode always ends: whatever an item throws, the store leaves batch mode here, so later notifications
    // and metrics are delivered instead of piling up in a batch nobody flushes.
    let result;
    try {
      result = applyBatchItems(items, String(payload?.subscription_id || ""), {
        apply: (delta) => this.handleDelta(delta),
        entryOf: (subscriptionId) => this.subscriptions.entryFor(subscriptionId),
        // A later item of a view the batch already left waiting for its resync.
        refuseBlocked: (entry, delta) => {
          this.metrics.renderer_delta_received += 1;
          if (entry) entry.last_received_sequence = Math.max(entry.last_received_sequence, Number(delta.sequence || 0));
          this._reject(entry, "BATCH_ABORTED_AFTER_GAP", { sequence: Number(delta.sequence || 0), event_type: "delta" });
        },
      });
    } finally {
      this.batch = null;
    }
    const { accepted, aborted, abortPositions, failure } = result;
    if (failure) {
      // The items applied before the failure changed the views: their notifications still go out below.
      this.metrics.renderer_delta_batch_failed = (this.metrics.renderer_delta_batch_failed || 0) + 1;
      this._emitMetric(null, "renderer_delta_batch_failed", { items: items.length, accepted, event_type: "delta_batch" });
      console.error("[realtime view store] a delta batch failed part-way", failure);
    }
    if (aborted) {
      this.metrics.renderer_delta_batch_aborted += 1;
      this._emitMetric(null, "renderer_delta_batch_aborted", { items: items.length, event_type: "delta_batch" });
    }
    const summary = {first_sequence:items[0]?.sequence, last_sequence:items.at(-1)?.sequence,
      accepted, rejected:items.length-accepted, abort_positions:abortPositions};
    this.lastBatch = summary;
    batch.flush({ emitMetric: (entry, name, detail) => this._emitMetric(entry, name, detail),
      notify: (entry, event) => this._notify(entry, event) }, summary);
    if (failure) throw failure;
    return accepted > 0;
  }

  handleError(payload = {}) {
    // An error is a subscribe's last reply too; one for a request this window let go of needs nothing.
    if (payload.request_id && this.subscriptions.settle(payload.request_id)) return false;
    const entry = this.subscriptions.entryFor(String(payload.subscription_id || ""), String(payload.request_id || ""));
    if (!entry) return this._reject(null, "UNKNOWN_SUBSCRIPTION_ERROR", { actual_subscription: String(payload.subscription_id || ""), reason: payload.error || "" });
    this.subscriptions.fail(entry, payload.error);
    this._notify(entry, { type: "error", error: entry.last_error });
    return true;
  }

  // The runtime sends a fresh snapshot for every listed subscription right after this notice; this only records
  // that data was dropped and the views re-baselined, which was invisible before.
  handleServerResync(payload = {}) {
    const ids = Array.isArray(payload.subscription_ids) ? payload.subscription_ids.map(String) : [];
    this.metrics.server_resync_count += 1;
    this.metrics.last_server_resync_reason = String(payload.reason || "UNKNOWN");
    for (const id of ids) {
      const entry = this.subscriptions.entryFor(id);
      if (!entry) continue;
      entry.status = "RESYNCING";
      entry.resync_required = true;
      entry.last_resync_at = Date.now();
      if (entry.state) entry.state = { ...entry.state, resync_required: true };
    }
    return ids.length;
  }

  // `reason` is what the view needs re-baselining for (view_subscriptions.js resync).
  requestResync(keyOrSpec, options = {}) {
    const key = typeof keyOrSpec === "string" ? keyOrSpec : specKey(keyOrSpec);
    return this.subscriptions.resync(this.entries.get(key), options);
  }

  // Revisits views waiting on a request (subscribe/snapshot/resync) or in RESYNC_REQUIRED / ERROR. Never a LIVE one.
  checkStaleness(nowMs = Date.now()) {
    this.subscriptions.revisit(nowMs);
  }

  // The presentation/status facts every view consumer reads, independent of how much of the
  // underlying state it wanted. Shared by snapshot() and select() so the two cannot drift.
  _presentationFields(entry) {
    const visibleState = presentationState(entry);
    return {
      view_status: entry.status,
      presentation_state: visibleState,
      loading: visibleState === "loading",
      stale: visibleState === "stale" || visibleState === "resyncing",
      resyncing: visibleState === "resyncing",
      empty: visibleState === "empty",
      view_error: entry.last_error || null,
    };
  }

  snapshot(keyOrSpec) {
    const key = typeof keyOrSpec === "string" ? keyOrSpec : specKey(keyOrSpec);
    const entry = this.entries.get(key);
    if (!entry?.state) return null;
    // A shallow view of the immutable state (see applyDeltaToState): its channels are shared, read-only values.
    return Object.assign({}, entry.state, this._presentationFields(entry));
  }

  // A projection of the view for consumers that need a handful of facts: `project` is handed the immutable state and
  // must only read it.
  select(keyOrSpec, project) {
    if (typeof project !== "function") return null;
    const key = typeof keyOrSpec === "string" ? keyOrSpec : specKey(keyOrSpec);
    const entry = this.entries.get(key);
    if (!entry?.state) return null;
    return Object.assign({}, project(entry.state) || {}, this._presentationFields(entry));
  }

  describe(keyOrSpec) {
    const key = typeof keyOrSpec === "string" ? keyOrSpec : specKey(keyOrSpec);
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      key: entry.key,
      active: entry.callbacks.size > 0,
      // The normalized spec is flat strings plus the channel list: a copy of those is the whole copy.
      spec: { ...entry.spec, channels: [...entry.spec.channels] },
      request_id: entry.request_id,
      subscription_id: entry.subscription_id,
      baseline_subscription_id: entry.baseline_subscription_id || "",
      stream_id: entry.stream_id,
      daemon_instance_id: entry.daemon_instance_id,
      session_generation: entry.session_generation,
      watermark: entry.watermark,
      last_sequence: entry.last_sequence,
      last_received_sequence: entry.last_received_sequence,
      last_received_at: entry.last_received_at || null,
      last_applied_at: entry.last_applied_at || null,
      last_applied_sequence: entry.last_applied_sequence,
      last_rendered_sequence: entry.last_rendered_sequence,
      last_notified_sequence: entry.last_notified_sequence || 0,
      status: entry.status,
      view_state: entry.status,
      presentation_state: presentationState(entry),
      resync_required: entry.resync_required,
      last_error: entry.last_error,
      duplicate_count: entry.duplicate_count,
      last_reject_field: entry.last_reject_field || "",
      last_reject_expected: entry.last_reject_expected || "",
      last_reject_actual: entry.last_reject_actual || "",
      rejected_count: entry.rejected_count,
      // Health has to be able to see a view that gave up re-binding, and how many attempts it took.
      protocol_fault: entry.protocol_fault ? { ...entry.protocol_fault } : null,
      recovering: [...entry.recoveries.keys()],
      last_reject_reason: entry.last_reject_reason,
      last_snapshot_at: entry.last_snapshot_at ? new Date(entry.last_snapshot_at).toISOString() : null,
      last_delta_at: entry.last_delta_at ? new Date(entry.last_delta_at).toISOString() : null,
      last_render_at: entry.last_render_at ? new Date(entry.last_render_at).toISOString() : null,
      last_notify_at: entry.last_render_at ? new Date(entry.last_render_at).toISOString() : null,
    };
  }

  stats() {
    return {
      ...this.metrics,
      client_subscription_count: this._activeCount(),
      subscriptions: [...this.entries.values()].map((entry) => {
        const state = entry.state || {}, summary = state.summary || {};
        // Diagnostics only: existing per-channel ingress timestamps, not a new
        // event counter. A BidAsk update is not evidence a trade must redraw.
        return { ...this.describe(entry.key), channel_arrival_ns: {
          trades: state.trades?.at(-1)?.arrival_ns ?? summary.arrival_ns ?? null,
          trend: state.trend?.at(-1)?.arrival_ns ?? summary.arrival_ns ?? null,
          orderbook: state.orderbook?.arrival_ns ?? state.orderbook?.book?.arrival_ns ?? null,
        } };
      }),
    };
  }
}

export { normalizeSpec as normalizeRealtimeViewSpec, specKey as realtimeViewSpecKey, applyDeltaToState };
