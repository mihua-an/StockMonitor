// The view store's parts driven alone: the subscription lifecycle (view_subscriptions.js) with a fake socket, clock
// and recovery log, and the sequence gate's pure verdicts (sequence_gate.js) -- no RealtimeViewStore is built.
import assert from "node:assert/strict";
import { ViewSubscriptions } from "../ui/renderer/js/market_data/view_subscriptions.js";
import { deltaVerdict, foreignIdentity, resetSequenceSpace, snapshotEpoch } from "../ui/renderer/js/market_data/sequence_gate.js";
import { DeliveryBatch, applyBatchItems } from "../ui/renderer/js/market_data/delivery_batch.js";

function entry(key = "STK:2330", over = {}) {
  return { key, spec: { market: "STK", code: "2330", session: "DAY", trading_date: "2026-10-27", channels: ["summary"] },
    request_id: "", subscription_id: "", stream_id: "", daemon_instance_id: "", session_generation: 0, watermark: 0,
    last_sequence: 0, last_received_sequence: 0, last_applied_sequence: 0, last_rendered_sequence: 0,
    baseline_subscription_id: "", state: null, callbacks: new Map([[() => {}, {}]]), status: "UNSUBSCRIBED",
    resync_required: false, resync_request_id: "", recoveries: new Map(), last_resync_at: 0, subscribe_sent_at: 0,
    accepted_at: 0, error_at: 0, retry_count: 0, last_error: null, ...over };
}

function harness() {
  const sent = [];
  const recorded = [];
  let clock = 1_000_000;
  const recovery = {
    begin: (e, kind, mechanismId, trigger) => { recorded.push(["begin", kind, mechanismId, trigger]); e.recoveries.set(kind, {}); },
    end: (e, outcome, _detail, kinds) => { for (const kind of [...e.recoveries.keys()]) if (!kinds || kinds.includes(kind)) { e.recoveries.delete(kind); recorded.push(["end", kind, outcome]); } },
    record: (_e, mechanismId, trigger, outcome, detail) => recorded.push(["record", mechanismId, trigger, outcome, detail]),
  };
  const entries = new Map();
  const metrics = { client_subscription_created: 0, reconnect_snapshot_count: 0, cancelled_reply_count: 0, resync_count: 0,
    subscription_timeout_count: 0, subscription_retry_count: 0 };
  const subscriptions = new ViewSubscriptions({ entries, send: (m) => { sent.push(m); return true; }, now: () => clock,
    recovery, metrics, subscriptionTimeoutMs: 55000 });
  return { subscriptions, entries, sent, recorded, metrics, tick: (ms) => { clock += ms; return clock; } };
}

// Subscribe -> accept -> the subscription is bound; the request it replaced was cancelled by its request id the moment
// it was replaced, so its late accept is known to answer a closed view: nothing more is sent and nothing is recorded.
{
  const { subscriptions, entries, sent, recorded, metrics } = harness();
  const view = entry();
  entries.set(view.key, view);
  subscriptions.onConnected("conn-1");
  assert.equal(view.status, "SUBSCRIBING");
  const first = sent.at(-1).payload.request_id;
  assert.equal(sent.at(-1).type, "view.subscribe");
  assert.equal(sent.at(-1).payload.delta_batch, true);
  subscriptions.subscribe(view);                       // superseded before any reply
  const second = sent.at(-1).payload.request_id;
  assert.notEqual(first, second);
  assert.deepEqual(sent.at(-2), { type: "view.unsubscribe", payload: { request_id: first } }, "the replaced request is cancelled first");
  const sentBefore = sent.length;
  assert.deepEqual(subscriptions.accept({ request_id: first, subscription_id: "sub-old" }), { cancelled: true });
  assert.equal(sent.length, sentBefore, "the cancelled request's view is not closed a second time");
  assert.ok(subscriptions.isRecentlyClosed("sub-old"), "its in-flight deltas are late frames of a closed view");
  assert.equal(subscriptions.settle(first), true, "its snapshot is the last reply");
  assert.equal(subscriptions.settle(first), false, "and drops the record");
  assert.equal(metrics.cancelled_reply_count, 1);
  assert.equal(recorded.filter((r) => r[0] === "record").length, 0);
  const bound = subscriptions.accept({ request_id: second, subscription_id: "sub-1", stream_id: "s", watermark: 4 });
  assert.equal(bound.entry, view);
  assert.equal(view.status, "SNAPSHOT_PENDING");
  assert.equal(subscriptions.entryFor("sub-1"), view);
  assert.equal(subscriptions.entryFor("", second), view, "a reply that names only the request finds it too");
}

// A view released before its reply (10-27: 2303 let go of 169 ms after the subscribe) is cancelled by its request id at
// once, exactly once; its accept, deltas and snapshot then answer a closed view. A request already answered is closed
// by its subscription; one that was never open is refused as a fault of the reply, and nothing is closed for it.
{
  const { subscriptions, entries, sent, recorded } = harness();
  const view = entry();
  entries.set(view.key, view);
  subscriptions.onConnected("conn-1");
  const request = sent.at(-1).payload.request_id;
  subscriptions.release(view);
  assert.deepEqual(sent.at(-1), { type: "view.unsubscribe", payload: { request_id: request } });
  subscriptions.release(view);
  assert.equal(sent.filter((m) => m.type === "view.unsubscribe").length, 1, "one request is closed once");
  assert.deepEqual(subscriptions.accept({ request_id: request, subscription_id: "sub-9" }), { cancelled: true });
  assert.ok(subscriptions.isRecentlyClosed("sub-9"));
  assert.equal(subscriptions.settle(request), true);
  assert.equal(sent.filter((m) => m.type === "view.unsubscribe").length, 1);
  assert.equal(recorded.filter((r) => r[0] === "record").length, 0, "a known cancel is no remediation");

  const answered = entry("STK:2317");
  entries.set(answered.key, answered);
  subscriptions.subscribe(answered);
  const answeredRequest = sent.at(-1).payload.request_id;
  subscriptions.accept({ request_id: answeredRequest, subscription_id: "sub-10" });
  subscriptions.release(answered);
  assert.deepEqual(sent.at(-1), { type: "view.unsubscribe", payload: { subscription_id: "sub-10" } });
  assert.equal(subscriptions.settle(answeredRequest), true, "its snapshot, still in flight, answers a closed view");

  const before = sent.length;
  const stray = subscriptions.accept({ request_id: "view-never-sent", subscription_id: "sub-11" });
  assert.equal(stray.refused.reason, "UNKNOWN_REQUEST");
  assert.equal(sent.length, before);
}

// A request of a dropped connection is never cancelled on the next one (the daemon closed its view with the socket).
{
  const { subscriptions, entries, sent } = harness();
  const view = entry();
  entries.set(view.key, view);
  subscriptions.onConnected("conn-1");
  subscriptions.onDisconnected();
  subscriptions.onConnected("conn-2");
  assert.deepEqual(sent.map((m) => m.type), ["view.subscribe", "view.subscribe"]);
  subscriptions.release(view);
  assert.deepEqual(sent.at(-1), { type: "view.unsubscribe", payload: { request_id: sent[1].payload.request_id } });
}

// A disconnect unbinds every view without unsubscribing (the daemon dropped them); its late frames are known as late.
{
  const { subscriptions, entries, sent, recorded } = harness();
  const view = entry("STK:2330", { subscription_id: "sub-1", baseline_subscription_id: "sub-1", last_sequence: 9, status: "LIVE" });
  entries.set(view.key, view);
  subscriptions.connected = true;
  subscriptions.subscriptionToKey.set("sub-1", view.key);
  view.recoveries.set("resync", {});
  subscriptions.onDisconnected();
  assert.equal(sent.length, 0, "nothing is sent on a closed socket");
  assert.equal(view.status, "UNSUBSCRIBED");
  assert.equal(view.last_sequence, 0, "the sequence space went with the subscription");
  assert.ok(subscriptions.isRecentlyClosed("sub-1"));
  assert.deepEqual(recorded.at(-1), ["end", "resync", "abandoned"]);
}

// A request nobody answers is re-subscribed after the timeout, as one recorded recovery; an error retries with backoff.
{
  const { subscriptions, entries, sent, recorded, metrics, tick } = harness();
  const view = entry();
  entries.set(view.key, view);
  subscriptions.onConnected("c");
  subscriptions.revisit(tick(54_000));
  assert.equal(sent.length, 1, "inside the timeout nothing is sent again");
  subscriptions.revisit(tick(2_000));
  assert.deepEqual(sent.map((m) => m.type), ["view.subscribe", "view.unsubscribe", "view.subscribe"],
    "the unanswered request is cancelled by its id before the new one is sent");
  assert.equal(sent[1].payload.request_id, sent[0].payload.request_id);
  assert.equal(metrics.subscription_timeout_count, 1);
  assert.deepEqual(recorded.find((r) => r[0] === "begin"), ["begin", "resubscribe", "renderer.view_resubscribe", "request_timeout"]);
  subscriptions.accept({ request_id: sent.at(-1).payload.request_id, subscription_id: "sub-2" });
  subscriptions.fail(view, "boom");
  assert.equal(view.status, "ERROR");
  assert.equal(view.subscription_id, "");
  // The backoff doubles with the view's retries: the timeout above was its first, so this one waits 4 s.
  subscriptions.revisit(tick(3_999));
  assert.equal(sent.length, 3, "the error waits out its backoff");
  subscriptions.revisit(tick(1));
  assert.equal(sent.length, 4, "a request answered by an error has nothing left to cancel");
  assert.equal(sent.at(-1).type, "view.subscribe");
  assert.equal(metrics.subscription_retry_count, 1);
}

// A resync carries its own request id and reason, and is refused inside its cooldown unless forced.
{
  const { subscriptions, entries, sent, tick } = harness();
  const view = entry("STK:2330", { subscription_id: "sub-1", last_sequence: 7, state: { summary: {} } });
  entries.set(view.key, view);
  subscriptions.connected = true;
  assert.ok(subscriptions.resync(view, { reason: "sequence_gap" }));
  assert.equal(sent.at(-1).type, "view.resync");
  assert.equal(sent.at(-1).payload.reason, "sequence_gap");
  assert.equal(view.resync_request_id, sent.at(-1).payload.request_id);
  assert.equal(view.state.resync_required, true);
  assert.equal(subscriptions.resync(view, { reason: "sequence_gap" }), false, "inside the cooldown");
  assert.ok(subscriptions.resync(view, { reason: "client_request", force: true }));
  tick(1);
}

// The sequence gate's verdicts.
{
  const live = entry("STK:2330", { subscription_id: "sub", baseline_subscription_id: "sub", stream_id: "s", last_sequence: 5,
    daemon_instance_id: "d1", session_generation: 3, status: "LIVE",
    state: { session_key: { market: "STK", logical_code: "2330", session: "DAY", trading_date: "2026-10-27" } } });
  assert.deepEqual(deltaVerdict(live, { sequence: 6, stream_id: "s" }, "sub"), { accept: true });
  assert.equal(deltaVerdict(live, { sequence: 5 }, "sub").reason, "DUPLICATE_OR_OLD_SEQUENCE");
  const gap = deltaVerdict(live, { sequence: 8 }, "sub");
  assert.equal(gap.then, "gap");
  assert.equal(gap.expected, 6);
  assert.equal(deltaVerdict(live, { sequence: 6 }, "other").reason, "SNAPSHOT_NOT_APPLIED");
  assert.equal(deltaVerdict(live, { sequence: 6, session_key: { trading_date: "2026-10-28" } }, "sub").then, "protocol_fault");
  assert.equal(deltaVerdict(live, { sequence: 6, daemon_instance_id: "d2" }, "sub").status, "RESYNC_REQUIRED");
  assert.equal(deltaVerdict(live, { sequence: 6, session_generation: 2 }, "sub").resyncReason, "session_generation_changed");
  assert.deepEqual(deltaVerdict(live, { sequence: 6, session_generation: 4 }, "sub"), { accept: true }, "a newer provider generation continues the view");

  assert.equal(foreignIdentity(live.spec, { session_key: { trading_date: "2026-10-27T00:00:00" } }), null);
  assert.equal(foreignIdentity(live.spec, { session_key: { session: "NIGHT" } }).field, "session");
  assert.deepEqual(snapshotEpoch(live, { daemon_instance_id: "d2" }, "sub", ""), { reset: "DAEMON_INSTANCE_CHANGED" });
  const older = snapshotEpoch(live, { session_generation: 2 }, "sub", "").refuse;
  assert.equal(older.reason, "OLD_SESSION_GENERATION");
  assert.equal(older.fault.trigger, "old_session_generation", "an older generation is the producer's fault, recorded");
  assert.deepEqual(snapshotEpoch(live, { session_generation: 3 }, "sub", ""), { reset: null });

  resetSequenceSpace(live);
  assert.equal(live.last_sequence, 0);
  assert.equal(live.baseline_subscription_id, "");
}

// A batch: a view left waiting for its resync refuses its later items; one notification per view at the end.
{
  const views = { a: { key: "a", status: "LIVE", resync_required: false, last_sequence: 0 } };
  const refused = [];
  const result = applyBatchItems([{ subscription_id: "a", sequence: 1 }, { subscription_id: "a", sequence: 3 }, { sequence: 4 }], "a", {
    apply: (delta) => { if (delta.sequence === 3) { views.a.status = "RESYNC_REQUIRED"; views.a.resync_required = true; return false; } views.a.last_sequence = delta.sequence; return true; },
    entryOf: (id) => views[id],
    refuseBlocked: (_entry, delta) => refused.push(delta.sequence),
  });
  assert.deepEqual({ ...result, failure: undefined }, { accepted: 1, aborted: true, abortPositions: [1], failure: undefined });
  assert.deepEqual(refused, [4], "the inherited-subscription item after the gap is refused, not applied");

  const batch = new DeliveryBatch();
  batch.addNotification(views.a, { type: "delta", delta: { channels: ["trades"] } });
  batch.addNotification(views.a, { type: "delta", delta: { channel: "summary" } });
  batch.addMetric(views.a, "delta_applied", { reason: "" });
  batch.addMetric(views.a, "delta_applied", { reason: "" });
  const out = [];
  batch.flush({ emitMetric: (_e, name, detail) => out.push([name, detail.count]), notify: (_e, event) => out.push([event.type, event.changedChannels, event.deltas.length]) }, {});
  assert.deepEqual(out, [["delta_applied", 2], ["gap", ["trades", "summary"], 2]]);
}

console.log("view subscriptions / sequence gate / delivery batch contract passed");
