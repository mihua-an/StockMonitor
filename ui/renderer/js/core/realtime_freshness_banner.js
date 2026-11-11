// AA-01 minimal fix: a single, page-level "this is not live data" indicator
// for the 即時報價 page. Deliberately reuses existing authorities instead
// of inventing a new one:
//   - WS transport state: REALTIME_CONNECTION_STATE via subscribeRealtimeConnectionState()
//   - Backend-reported data availability: the page's existing marketDataAvailable flag
//   - Per-view staleness: RealtimeViewStore's existing presentation_state
//     (already computed by realtime_view_store.js's checkStaleness()/onDisconnected(),
//     already consumed by canonicalDisplayFrame() and each component's
//     data-view-lifecycle -- this module only aggregates it for a page-level banner).
export const FRESHNESS_TONE = Object.freeze({ DISCONNECTED: "disconnected", RECONNECTING: "reconnecting", STALE: "stale" });

const MESSAGES = Object.freeze({
  [FRESHNESS_TONE.DISCONNECTED]: "連線已中斷，目前畫面為最後收到的行情，非即時資料",
  [FRESHNESS_TONE.RECONNECTING]: "重新連線中，目前畫面為最後收到的行情，非即時資料",
  [FRESHNESS_TONE.STALE]: "行情資料未同步，目前畫面可能不是最新資料",
});

const HIDDEN_STATE = Object.freeze({ visible: false, tone: null, text: "" });

// Pure decision function -- no DOM, no timers. `focusedPresentationState` is
// whatever the currently-selected symbol's own live snapshot reports right
// now (RealtimeViewStore's presentation_state: "loading"/"ready"/"stale"/
// "resyncing"/"error"/"empty"); passing a freshly-read value here (rather
// than caching it across symbol switches) is what keeps a symbol switch from
// inheriting the previous symbol's stale state -- there is nothing to reset,
// the caller simply always reads the CURRENT symbol's CURRENT snapshot.
export function computeFreshnessBanner({
  connectionState,
  marketDataAvailable = true,
  focusedPresentationState = "ready",
  focusedViewError = null,
} = {}) {
  const state = String(connectionState || "DISCONNECTED").toUpperCase();
  if (state === "DISCONNECTED") return { visible: true, tone: FRESHNESS_TONE.DISCONNECTED, text: MESSAGES[FRESHNESS_TONE.DISCONNECTED] };
  if (state === "RECONNECTING") return { visible: true, tone: FRESHNESS_TONE.RECONNECTING, text: MESSAGES[FRESHNESS_TONE.RECONNECTING] };
  const focused = String(focusedPresentationState || "ready").trim().toLowerCase();
  const focusedStale = ["stale", "resyncing", "error"].includes(focused) || Boolean(focusedViewError);
  if (!marketDataAvailable || focusedStale) return { visible: true, tone: FRESHNESS_TONE.STALE, text: MESSAGES[FRESHNESS_TONE.STALE] };
  return HIDDEN_STATE;
}

// The dock saying 資料未同步 / 重新連線中 / 未連線 is a fault the user sees: every time it is shown and when it goes away
// leaves a record (a warning, kept in error.log) with what caused it -- `cause()` reads the socket state, the broker's
// data availability and the selected stock's own view. On screen it lasts a few seconds; without a record nothing said
// why (10-19 19:15). Wraps the debouncer's `apply`, so only states that were really shown are recorded.
// The state is applied first and the record written after it: reading the cause or writing the record failing must
// never keep the dock from showing the connection state, and is itself recorded.
export function recordFreshnessTransitions(apply, { cause = () => ({}), log = (...args) => console.warn(...args), now = () => Date.now() } = {}) {
  let shownAt = null;
  const record = (message) => {
    let detail;
    try { detail = cause(); } catch (error) {
      detail = { cause_unreadable: String(error?.message || error) };
      console.warn("[realtime freshness] reading the cause failed", error);
    }
    try { log(message, detail); } catch (error) {
      console.warn("[realtime freshness] writing the record failed", message, error);
    }
  };
  return (next) => {
    apply(next);
    if (next?.visible) {
      shownAt ??= now();
      record(`[realtime freshness] ${next.tone} shown`);
    } else if (shownAt !== null) {
      const shownFor = now() - shownAt;
      shownAt = null;
      record(`[realtime freshness] cleared after ${shownFor} ms`);
    }
  };
}

function sameBannerState(a, b) {
  return Boolean(a) && Boolean(b) && a.visible === b.visible && a.tone === b.tone && a.text === b.text;
}

// Debounces showing a notice or changing its wording; hiding is applied at once,
// because the data is good again and the notice is now the wrong thing on screen.
// The delay is what prevents a rapid disconnect/reconnect blip from flickering
// the banner: if the computed state flips back to the currently-applied state
// before the pending timer fires, the timer is simply cancelled and nothing
// ever painted. `schedule`/`cancel` are injected so the real app can use the
// page's own lifecycle-scoped timer (viewResources.timeout/clearTimeout,
// which is cancelled automatically on page unmount) and tests can use a fake
// clock instead of real timers.
export function createFreshnessBannerDebouncer({ apply, delayMs = 1500, schedule, cancel }) {
  if (typeof apply !== "function") throw new Error("createFreshnessBannerDebouncer requires apply()");
  if (typeof schedule !== "function" || typeof cancel !== "function") {
    throw new Error("createFreshnessBannerDebouncer requires schedule()/cancel()");
  }
  let pendingToken = null;
  let applied = HIDDEN_STATE;
  function update(next) {
    if (pendingToken != null) { cancel(pendingToken); pendingToken = null; }
    if (sameBannerState(next, applied)) return;
    if (!next.visible) {
      applied = next;
      apply(next);
      return;
    }
    pendingToken = schedule(() => {
      pendingToken = null;
      applied = next;
      apply(next);
    }, delayMs);
  }
  // Synchronously (no debounce) forces a state and records it as `applied`,
  // instead of calling `apply()` directly from the outside -- bypassing this
  // module's own bookkeeping would desync `applied` from what's actually on
  // screen (e.g. a forced hide-on-unmount that `update()` later compares
  // against would think the banner was already hidden and skip reapplying it
  // on the next mount).
  function reset(state = HIDDEN_STATE) {
    if (pendingToken != null) { cancel(pendingToken); pendingToken = null; }
    applied = state;
    apply(state);
  }
  function dispose() {
    if (pendingToken != null) { cancel(pendingToken); pendingToken = null; }
  }
  return { update, reset, dispose, getApplied: () => applied };
}
