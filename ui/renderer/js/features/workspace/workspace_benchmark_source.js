import { numberOrNull } from "../../core/numbers.js";
import { benchmarkViewSpec } from "../../market_data/stock_view_spec.js";
// One Rust-backed TAIEX/TXF benchmark subscription shared by all workspace columns.

// ensure() starts a benchmark and settles with its data, or is rejected when the source is disposed. There is no
// deadline: a fixed 15 s one called a slow source failed and dropped the waiter, so a snapshot that came
// later was never drawn. Every arrival is announced through subscribe(); the overlays redraw from that.
export function createWorkspaceBenchmarkSource({ subscribeView, tradingDate = () => "" }) {
  const state = {
    taiex: { points: [], reference: null, loadedAt: 0, loading: false, error: null },
    txf: { points: [], reference: null, loadedAt: 0, loading: false, error: null },
  };
  const waiters = { taiex: [], txf: [] };
  const listeners = new Set();
  const subscriptions = { taiex: null, txf: null };
  let disposed = false;

  function resolveWaiters(kind) {
    for (const waiter of waiters[kind].splice(0)) waiter.resolve();
  }

  function rejectWaiters(kind, reason) {
    for (const waiter of waiters[kind].splice(0)) waiter.reject(new Error(reason));
  }

  function notify(kind) {
    for (const listener of [...listeners]) {
      try { listener(kind); } catch (error) { console.warn("[workspace benchmark listener] failed", error); }
    }
  }

  // Only snapshot / delta / batch carry data. An error leaves the drawn data in place and records why the view is
  // failing (the store re-binds it, and the waiters settle with the snapshot that follows); a gap is the store's
  // own resync, which it records and answers with a fresh snapshot.
  function receive(kind, event) {
    if (disposed) return;
    const type = event?.type;
    if (type === "snapshot" || type === "delta" || type === "batch") {
      apply(kind, event);
      return;
    }
    if (type === "error") {
      const message = String(event.error || event.entry?.last_error || "benchmark view error");
      console.error("[workspace benchmark] view error", { kind, error: message });
      state[kind].error = message;
      state[kind].loading = false;
      notify(kind);
      return;
    }
    if (type === "gap") return;
    console.error("[workspace benchmark] unknown view event", { kind, type });
  }

  function apply(kind, event) {
    const snapshot = event?.state || {};
    // A batch carries every delta of one transport drain; reading only the last one would drop
    // the trend minutes the earlier items closed.
    const frames = (event?.type === "batch" ? (event.deltas || []) : [event?.delta])
      .map((delta) => delta?.payload || {});
    let summary = snapshot.summary || {};
    if (Array.isArray(snapshot.trend)) state[kind].points = snapshot.trend;
    else {
      for (const frame of frames) {
        if (frame.summary) summary = frame.summary;
        if (!frame.trend?.point) continue;
        const point = frame.trend.point;
        const minute = Number(point.minute);
        const next = state[kind].points.filter((row) => Number(row?.minute) !== minute);
        next.push(point);
        state[kind].points = next.sort((a, b) => Number(a?.minute || 0) - Number(b?.minute || 0));
      }
    }
    state[kind].reference = numberOrNull(summary.reference_price ?? state[kind].reference);
    state[kind].loadedAt = Date.now();
    state[kind].loading = false;
    state[kind].error = null;
    resolveWaiters(kind);
    notify(kind);
  }

  // Which subscription is current per kind: a callback of a replaced one (the previous trading date) is dropped.
  const generations = { taiex: 0, txf: 0 };

  function start(kind) {
    if (subscriptions[kind] || disposed) return;
    const generation = ++generations[kind];
    state[kind].loading = true;
    subscriptions[kind] = subscribeView(benchmarkViewSpec(kind, tradingDate()),
      (event) => { if (generation === generations[kind]) receive(kind, event); }, { stateDelivery: "snapshot-only" });
  }

  // The workspace crossed into another trading day: every benchmark that was started is dropped and
  // subscribed again on the new date; one that was never asked for stays off until it is.
  function rebind() {
    if (disposed) return;
    for (const kind of ["taiex", "txf"]) {
      if (!subscriptions[kind]) continue;
      subscriptions[kind]();
      subscriptions[kind] = null;
      generations[kind] += 1;
      state[kind] = { points: [], reference: null, loadedAt: 0, loading: false, error: null };
      start(kind);
    }
  }

  return {
    ensure(kind) {
      const normalized = kind === "txf" ? "txf" : "taiex";
      start(normalized);
      if (state[normalized].loadedAt) return Promise.resolve();
      if (disposed) return Promise.reject(new Error("benchmark source disposed"));
      return new Promise((resolve, reject) => { waiters[normalized].push({ resolve, reject }); });
    },
    // Called with the kind on every snapshot or delta applied; returns its unsubscribe.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    points(kind) { return kind === "txf" ? state.txf.points : state.taiex.points; },
    referencePrice(kind) { return kind === "txf" ? state.txf.reference : state.taiex.reference; },
    snapshot() { return { taiex: { ...state.taiex }, txf: { ...state.txf } }; },
    rebind,
    dispose() {
      disposed = true;
      listeners.clear();
      for (const kind of ["taiex", "txf"]) {
        subscriptions[kind]?.();
        subscriptions[kind] = null;
        rejectWaiters(kind, "benchmark source disposed");
      }
    },
  };
}
