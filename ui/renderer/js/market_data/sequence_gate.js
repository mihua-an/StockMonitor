// The view store's gates, as pure decisions over one entry: which snapshot may re-baseline a view and which delta may
// continue it. Each returns a verdict; the store (realtime_view_store.js) applies it -- records, resyncs, notifies.

const IDENTITY_FIELDS = ["market", "logical_code", "session", "trading_date"];

// Sequence numbers belong to ONE subscription. Market Runtime opens a new view per view.subscribe and numbers
// its snapshot and deltas in that view's own space, starting again at 1 (server.rs View::sent_sequence) -- on the
// same daemon and in the same session. So whenever this entry stops being bound to the subscription its counters
// came from (a re-subscribe, a reconnect, an error, a release), the counters and any resync it was waiting for
// describe a sequence space that no longer exists and must go with it.
//
// Kept across a plain WebSocket reconnect, they make the new subscription's snapshot (watermark 1) read as
// STALE_SNAPSHOT against the old view's 263254, every delta as DUPLICATE_OR_OLD_SEQUENCE / AWAITING_RESYNC_SNAPSHOT,
// and the 55 s re-subscribe start at 1 again: every view stuck for good (Shioaji and Futu alike). The state itself is
// kept as a stale display cache; only a snapshot of the new subscription re-establishes a baseline.
export function resetSequenceSpace(entry) {
  entry.watermark = 0;
  entry.last_sequence = 0;
  entry.last_received_sequence = 0;
  entry.last_applied_sequence = 0;
  entry.last_rendered_sequence = 0;
  entry.baseline_subscription_id = "";
  entry.resync_required = false;
  entry.resync_request_id = "";
  entry.last_resync_at = 0;
  if (entry.state?.resync_required) entry.state = { ...entry.state, resync_required: false };
}

// The spec is the entry's identity authority: it is what view.subscribe asked for. Compared field by field, and only
// where BOTH sides carry a value -- an absent field means the sender did not state it, which is not evidence of a
// mismatch, and treating it as one would reject legitimate payloads. Returns the first disagreeing field (with both
// values, so a rejected view is diagnosable) or null.
export function foreignIdentity(spec, payload = {}) {
  if (!spec) return null;
  const identity = payload.session_key || {};
  const pairs = [
    ["market", spec.market, identity.market],
    ["logical_code", spec.code, identity.logical_code],
    ["session", spec.session, identity.session],
    ["trading_date", spec.trading_date, String(identity.trading_date || "").slice(0, 10)],
  ];
  for (const [field, expected, actual] of pairs) {
    const left = String(expected ?? "").trim().toUpperCase();
    const right = String(actual ?? "").trim().toUpperCase();
    if (left && right && left !== right) {
      return { field, expected: String(expected), actual: String(actual) };
    }
  }
  return null;
}

// A snapshot of another daemon instance, session generation or session identity starts a new sequence epoch; an
// older one is refused. Returns { refuse: { reason, detail, fault? } } (`fault`: a protocol fault to record), or
// { reset: reason | null } (null: same epoch).
export function snapshotEpoch(entry, payload, subscriptionId, requestId) {
  const incomingDaemon = String(payload.daemon_instance_id || "");
  const incomingGeneration = Number(payload.session_generation || 0);
  const sequence = Number(payload.watermark ?? payload.sequence ?? 0);
  const daemonChanged = Boolean(
    entry.daemon_instance_id && incomingDaemon && incomingDaemon !== entry.daemon_instance_id
  );
  // A snapshot that named a DIFFERENT session than the applied baseline, yet agreed with the spec (the foreign-snapshot
  // gate already refused anything that did not), is a re-baseline onto another partition of the same subscription --
  // exactly what an identity recovery asks the daemon for. Sequence and generation numbers are per session state, so
  // the new partition legitimately starts lower than the old one, and the OLD_SESSION_GENERATION / STALE_SNAPSHOT
  // guards would have refused it -- which is why the recovery could never converge even once its resync reply was
  // routable.
  const previousIdentity = entry.state?.session_key || null;
  const incomingIdentity = payload.session_key || null;
  const identityChanged = Boolean(previousIdentity && incomingIdentity
    && IDENTITY_FIELDS.some((field) => {
      const before = String(previousIdentity[field] ?? "").trim().toUpperCase();
      const after = String(incomingIdentity[field] ?? "").trim().toUpperCase();
      return before && after && before !== after;
    }));
  // A spec with no trading_date (every Futu wildcard view) accepts ANY session, so a snapshot of an older one -- a late
  // answer to a request this entry has already replaced -- could re-baseline the view back onto yesterday. The
  // renderer's own request ids are the fence: they are generated here, only ever increase, and every older one was
  // already refused (SUPERSEDED_SNAPSHOT). So a snapshot moves the view to an EARLIER trading date only when it answers
  // the entry's current request -- the subscribe/snapshot or the identity-recovery resync just sent; an unsolicited one
  // (a rollover's re-snapshot) only ever moves forward.
  if (identityChanged && !String(entry.spec?.trading_date || "")) {
    const before = String(previousIdentity?.trading_date || "").slice(0, 10);
    const after = String(incomingIdentity?.trading_date || "").slice(0, 10);
    const answersNewest = Boolean(requestId) && (requestId === entry.request_id || requestId === entry.resync_request_id);
    if (before && after && after < before && !answersNewest) {
      return { refuse: { reason: "SUPERSEDED_SESSION_SNAPSHOT", detail: { expected: before, actual: after,
        sequence, actual_subscription: subscriptionId, event_type: "snapshot" } } };
    }
  }
  // Market Runtime never sends a view an older generation (it refuses them at ingest, and a replay view carries the
  // replay's own, which rises at every seek): one is the producer's fault, recorded as such.
  if (!identityChanged && entry.session_generation && incomingGeneration && incomingGeneration < entry.session_generation) {
    const detail = { sequence, event_type: "snapshot", expected: entry.session_generation, actual: incomingGeneration };
    return { refuse: { reason: "OLD_SESSION_GENERATION", detail,
      fault: { trigger: "old_session_generation", detail } } };
  }
  const generationChanged = Boolean(
    entry.session_generation && incomingGeneration && incomingGeneration > entry.session_generation
  );
  if (daemonChanged) return { reset: "DAEMON_INSTANCE_CHANGED" };
  if (generationChanged) return { reset: "SESSION_GENERATION_CHANGED" };
  if (identityChanged) return { reset: "SESSION_IDENTITY_CHANGED" };
  return { reset: null };
}

// Whether a delta of the entry's bound subscription continues its baseline. Returns { accept: true }, or a refusal:
// { reason, detail, then } where `then` is what the store does next -- "resync" (ask for a new baseline, the view
// marked RESYNC_REQUIRED when `status` says so), "gap" (the sequence broke: mark, notify, resync), "protocol_fault"
// (another identity: the producer's fault, recorded) or "" (refused only).
export function deltaVerdict(entry, payload, subscriptionId) {
  const sequence = Number(payload.sequence || 0);
  if (!entry.state || entry.baseline_subscription_id !== subscriptionId) {
    // No snapshot of THIS subscription has been applied, so there is no baseline its sequence can continue (a retained
    // state from an earlier subscription is display cache, not a baseline). Market Runtime sends the snapshot before any
    // delta of a view, so this is a lost or refused snapshot: ask for it again.
    return { reason: "SNAPSHOT_NOT_APPLIED", detail: { sequence, event_type: "delta", actual_subscription: subscriptionId },
      then: "resync", resyncReason: "snapshot_not_applied" };
  }
  if (entry.resync_required || entry.status === "RESYNCING" || entry.status === "RESYNC_REQUIRED") {
    return { reason: "AWAITING_RESYNC_SNAPSHOT", detail: { sequence, event_type: "delta" }, then: "" };
  }
  const identity = payload.session_key || {};
  for (const field of ["market", "logical_code", "contract_code", "session", "trading_date"]) {
    if (!identity[field] || !entry.state.session_key?.[field]) continue;
    if (identity[field] === entry.state.session_key[field]) continue;
    const expected = String(entry.state.session_key[field]);
    const actual = String(identity[field]);
    return { reason: "WRONG_SESSION_IDENTITY", detail: { sequence, field, event_type: "delta", expected, actual },
      then: "protocol_fault", fault: { trigger: "wrong_session_identity", detail: { field, expected, actual, sequence, event_type: "delta" } } };
  }
  const incomingStream = String(payload.stream_id || "");
  if (entry.stream_id && incomingStream && incomingStream !== entry.stream_id) {
    return { reason: "WRONG_STREAM", detail: { expected_stream: entry.stream_id, actual_stream: incomingStream, sequence, event_type: "delta" }, then: "" };
  }
  const incomingDaemon = String(payload.daemon_instance_id || "");
  if (entry.daemon_instance_id && incomingDaemon && incomingDaemon !== entry.daemon_instance_id) {
    return { reason: "DAEMON_INSTANCE_CHANGED", detail: { sequence, event_type: "delta" },
      then: "resync", status: "RESYNC_REQUIRED", resyncReason: "daemon_instance_changed" };
  }
  // `session_generation` is the provider connection's number. A newer one (a broker reconnect, an App restart) does
  // not reset the state in Market Runtime: the day's state stays and this view's own sequence carries on, so the
  // sequence check below decides whether this delta follows. Resyncing on it re-snapshotted every view the providers
  // touched at each App start (4 records a start, sequence 2 -> 3 on an unchanged session). An older one cannot come
  // from Market Runtime (it refuses older generations at ingest, and a replay view carries the replay's own
  // generation, which only rises): that is a fault, resynced.
  const incomingGeneration = Number(payload.session_generation || 0);
  if (entry.session_generation && incomingGeneration && incomingGeneration < entry.session_generation) {
    return { reason: "SESSION_GENERATION_CHANGED", detail: { sequence, event_type: "delta" },
      then: "resync", status: "RESYNC_REQUIRED", resyncReason: "session_generation_changed" };
  }
  if (sequence <= entry.last_sequence) {
    return { reason: "DUPLICATE_OR_OLD_SEQUENCE", detail: { sequence, event_type: "delta" }, then: "", duplicate: true };
  }
  const expected = entry.last_sequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence !== expected) {
    return { reason: "SEQUENCE_GAP", detail: { sequence, expected_sequence: expected, event_type: "delta" },
      then: "gap", expected, sequence };
  }
  return { accept: true };
}
