// The 即時報價 page's session state: the session authority's display context (the equity trading date, PREOPEN, the
// 期貨走勢 tabs' identities), the Market Runtime view specs those name, and the dock's freshness indicator.
import { subscribeRealtimeConnectionState } from "../../market_data/realtime.js";
import { normalizeTxfDisplayIdentity as normalizeTxfIdentity, txfCanonicalStateKey, txfDisplayIdentityKey, txfIdentityMatchesDisplay, txfSessionPartitions, txfTickMatchesDisplayWindow as txfTickMatchesWindow } from "./txf_session_identity.js";
import { computeFreshnessBanner, createFreshnessBannerDebouncer, recordFreshnessTransitions } from "../../core/realtime_freshness_banner.js";
import { setWebSocketFreshness } from "../../core/status.js";
import { eventEpochMs } from "../../market_data/realtime_market_math.js";
import { industryIndexStore } from "./industry_index_store.js";
import { benchmarkViewSpec, stockCanonicalViewSpec as sharedStockCanonicalViewSpec } from "../../market_data/stock_view_spec.js";
import { industryIndexViewSpec } from "./industry_index_view_model.js";
import { detailTargetCode, liveMarketDataGateway, realtimePageVisible, restoredMarketPanelState, viewResources } from "./live_page_state.js";

export let activeTxfSession = ["day", "night", "full"].includes(restoredMarketPanelState.futuresSession) ? restoredMarketPanelState.futuresSession : "full";
// The 期貨走勢 tab the user chose (日盤／夜盤／全日): restored at mount, changed by its buttons.
export function setActiveTxfSession(session) { activeTxfSession = session; }
// Market Runtime's session (session.current / session.rollover), written by session_controller.js applyRealtimeSession.
export let realtimeDisplayContext = null;
export function setRealtimeDisplayContext(context) { realtimeDisplayContext = context; }
// Told when the equity trading date the session authority names changes (first known at App start, or a new day):
// the readiness transition a view keyed by that date binds on, instead of looking every few seconds.
export const equityDateListeners = new Set();
// Whether the provider reports market data ready (session_controller.js applies the status).
export let marketDataAvailable = true;
export function setMarketDataAvailable(available) { marketDataAvailable = Boolean(available); }
// The status facts marketDataAvailable was last read from, so the freshness record names which one held it false.
export let marketDataFacts = null;
export function setMarketDataFacts(facts) { marketDataFacts = facts; }
let realtimeConnectionState = "DISCONNECTED";
let freshnessBannerTicker = null;
let freshnessBannerConnectionUnsubscribe = null;

// TXF visible panels must share one atomic display identity.  Do not derive
// session/trading_date/actual_contract independently from status, trend and
// canonical snapshots while startup requests are racing.
const txfDisplayIdentityBySession = new Map();

export function equityTradingDate() {
  return String(realtimeDisplayContext?.equity?.trading_date || "").slice(0, 10);
}


function normalizeTxfDisplayIdentity(raw = {}, session = activeTxfSession, source = "FALLBACK") {
  return normalizeTxfIdentity(raw, session, source);
}

export function txfTickMatchesDisplayWindow(row = {}, identity = currentTxfDisplayIdentity(activeTxfSession)) {
  return txfTickMatchesWindow(row, identity, eventEpochMs);
}

// Deltas have to be narrowed exactly like the snapshot they extend. Filtering only the snapshot
// left the live path unfiltered, and because one point array was shared by all three tabs,
// every delta that arrived while 夜盤 was open also became 日盤's series -- a tab showing another
// session's points, which then read as if 日盤 worked.
// A canonical minute trend point is stamped `minute_timestamp`; eventEpochMs() (built for ticks)
// reads datetime/timestamp/received_at and therefore returned null for every one of them, which
// silently turned the whole window comparison into "accept everything". txfTickMatchesDisplayWindow
// takes the epoch resolver as a parameter precisely so each kind of row can supply its own.
export function trendPointEpochMs(point = {}) {
  const stamped = String(point?.minute_timestamp || "").trim();
  if (stamped) {
    const parsed = Date.parse(stamped.includes("T") ? stamped : stamped.replace(" ", "T"));
    if (Number.isFinite(parsed)) return parsed;
  }
  return eventEpochMs(point);
}

export function currentTxfDisplayIdentity(session = activeTxfSession) {
  const requested = String(session || "full").toLowerCase();
  const committed = txfDisplayIdentityBySession.get(requested);
  if (committed) return { ...committed };

  const futures = realtimeDisplayContext?.futures || {};
  const resolved = futures?.[requested.toUpperCase()] || {};
  const fallback = normalizeTxfDisplayIdentity(resolved, requested, "FALLBACK");
  return fallback;
}



export function commitTxfDisplayIdentity(raw = {}, session = activeTxfSession, source = "CANONICAL") {
  const next = normalizeTxfDisplayIdentity(raw, session, source);
  if (!["day", "night", "full"].includes(next.session)) return { accepted: false, changed: false, identity: null };

  const previous = txfDisplayIdentityBySession.get(next.session) || null;
  if (previous) {
    // A lower-ranked async response must never move the visible session back to
    // a different trading date/contract after STATUS/ROLLOVER has resolved it.
    const lowerRank = Number(next.source_rank || 0) < Number(previous.source_rank || 0);
    const dateConflict = Boolean(previous.trading_date && next.trading_date && previous.trading_date !== next.trading_date);
    const contractConflict = Boolean(previous.actual_contract && next.actual_contract && previous.actual_contract !== next.actual_contract);
    if (lowerRank && (dateConflict || contractConflict)) {
      return { accepted: false, changed: false, identity: { ...previous }, stale: true };
    }

    // Never let an incomplete response erase already committed identity fields.
    if (!next.trading_date) next.trading_date = previous.trading_date || "";
    if (!next.actual_contract) {
      next.actual_contract = previous.actual_contract || "";
      next.contract_code = previous.contract_code || previous.actual_contract || "";
    }
    if (next.live == null) next.live = previous.live;
    if (!next.window_start) next.window_start = previous.window_start || null;
    if (!next.window_end) next.window_end = previous.window_end || null;
    // display_date is the WAL partition this tab reads (txfCanonicalStateKey). Only the display
    // context carries it, so a canonical commit -- which never does -- would otherwise erase it and
    // send 夜盤 back to its BUSINESS date, a partition that holds nothing.
    if (!next.display_date) next.display_date = previous.display_date || "";
    // The partitions come only from the display context; a canonical commit carries none.
    if (!next.partitions.length) next.partitions = previous.partitions || [];
  }

  const previousKey = previous ? txfDisplayIdentityKey(previous) : "";
  const nextKey = txfDisplayIdentityKey(next);
  const changed = previousKey !== nextKey;
  txfDisplayIdentityBySession.set(next.session, Object.freeze({ ...next }));
  return { accepted: true, changed, identity: { ...next }, previous };
}

export function commitTxfDisplayContext(context = {}, source = "STATUS") {
  const futures = context?.futures || {};
  let activeChanged = false;
  for (const session of ["day", "night", "full"]) {
    const raw = futures?.[session.toUpperCase()] || {};
    if (!raw || typeof raw !== "object") continue;
    const result = commitTxfDisplayIdentity(raw, session, source);
    if (session === activeTxfSession && result.changed) activeChanged = true;
  }
  return activeChanged;
}

export function txfIdentityMatches(identity = {}, session = activeTxfSession) {
  // Comparison lives in features/realtime/txf_session_identity.js: it has to reconcile the WAL
  // identity (FUT is always session FULL on a calendar day) with the business tab the user is
  // looking at (日盤/夜盤/全日, with business dates); the two are never compared field-by-field.
  return txfIdentityMatchesDisplay(
    currentTxfDisplayIdentity(session),
    normalizeTxfDisplayIdentity(identity, session, "FALLBACK"),
  );
}

// Whether the session's market data is available, from the DAEMON'S projection of the link in a /api/status payload.
//
// `broker.shioaji_connected` is the broker-LOGIN flag. It is legitimately false whenever the daemon's authoritative
// callback source is not the broker SDK, so it reported fresh, fully-populated data as stale: 74/74 rows priced with
// ticks and book, banner 「資料停滯」. `readiness.connected` is the daemon-owned projection of the same question -- "is
// the configured callback source up?" -- and is the SAME code path in every mode, see provider_link_online() in
// service/market/shared/provider_contract.py. In live it is exactly `shioaji_connected`, so this is not a mode branch.
// A status that carries no broker block at all means "nobody has claimed this authority, so do not suppress the UI"
// (`brokerKnown`). It is deliberately NOT spelled as a comparison against `broker.authority`:
// api/source_diagnostics.py returns that authority unconditionally (the daemon owns this truth in BOTH modes), so
// comparing against it could only ever be re-armed by mistake into a second truth model.
export function marketDataAvailableFromStatus(status) {
  const broker = status?.broker_status || {};
  const readiness = broker?.readiness && typeof broker.readiness === "object" ? broker.readiness : null;
  const readinessKnown = Boolean(readiness && Object.prototype.hasOwnProperty.call(readiness, "market_data_ready"));
  const brokerKnown = Boolean(status?.broker_status && typeof status.broker_status === "object");
  const linkOnline = readiness && Object.prototype.hasOwnProperty.call(readiness, "connected")
    ? readiness.connected === true
    : Boolean(broker.shioaji_connected);
  return !brokerKnown ? true : Boolean(
    broker.daemon_reachable
    && linkOnline
    // CONNECTED_WAITING_SESSION / STARTING must not keep yesterday's trades, book, or chart visible. They become
    // available again only after the provider explicitly reports market_data_ready=true.
    && (!readinessKnown || readiness.market_data_ready === true),
  );
}

export function marketDataFactsFromStatus(status) {
  const broker = status?.broker_status || {};
  const readiness = broker?.readiness && typeof broker.readiness === "object" ? broker.readiness : {};
  return { state: broker.state ?? null, daemon_reachable: broker.daemon_reachable ?? null, connected: readiness.connected ?? null,
    market_data_ready: readiness.market_data_ready ?? null, canonical_ready: readiness.canonical_ready ?? null,
    readiness_state: readiness.state ?? null, reason: readiness.reason ?? null, callback_age_seconds: broker.callback_age_seconds ?? null };
}

// Single page-level "this is not live data" indicator. Reuses the
// same three authorities other code already computes -- WS transport state
// (subscribeRealtimeConnectionState), backend-reported data availability
// (marketDataAvailable, above), and the focused symbol's own RealtimeViewStore
// presentation_state (already consumed by canonicalDisplayFrame() for the
// each component's data-view-lifecycle) -- rather than tracking a new "is stale"
// flag anywhere. See core/realtime_freshness_banner.js for the pure decision
// logic and the flicker-guarding debounce. Rendering target: the existing
// bottom-dock WebSocket status dot/text (core/status.js's
// setWebSocketFreshness()), consolidated there instead of a separate
// top-of-page banner element -- one place for connection/freshness state,
// matching how setBrokerConnectionStatus()/setMoomooConnectionStatus()
// already fold their own staleness nuance into that same dock.
// What the freshness record (realtime_freshness_banner.js recordFreshnessTransitions) says caused the dock's state.
function freshnessCause() {
  const focused = focusedViewSnapshotForBanner();
  return { connection: realtimeConnectionState, market_data_available: marketDataAvailable, market_data: marketDataFacts, symbol: detailTargetCode() || null,
    view_status: focused?.view_status ?? null, presentation_state: focused?.presentation_state ?? null, view_error: focused?.view_error || null };
}
const applyFreshnessBannerState = recordFreshnessTransitions((next) => {
  setWebSocketFreshness({ tone: next.visible ? next.tone : null });
}, { cause: freshnessCause });
const freshnessBannerDebouncer = createFreshnessBannerDebouncer({
  apply: applyFreshnessBannerState,
  delayMs: 1500,
  schedule: (fn, delay) => viewResources.timeout(fn, delay),
  cancel: (token) => viewResources.clearTimeout(token),
});
function focusedViewSnapshotForBanner() {
  const target = detailTargetCode();
  if (!target) return null;
  const spec = target === "TXFR1" ? txfCanonicalViewSpec(activeTxfSession) : stockCanonicalViewSpec(target);
  return liveMarketDataGateway.snapshot(spec);
}
export function recomputeFreshnessBanner() {
  if (!realtimePageVisible) return;
  const focused = focusedViewSnapshotForBanner();
  freshnessBannerDebouncer.update(computeFreshnessBanner({
    connectionState: realtimeConnectionState,
    marketDataAvailable,
    focusedPresentationState: focused?.presentation_state,
    focusedViewError: focused?.view_error || null,
  }));
}
function stopFreshnessBannerWatch() {
  freshnessBannerConnectionUnsubscribe?.();
  freshnessBannerConnectionUnsubscribe = null;
  if (freshnessBannerTicker != null) { viewResources.clearTimeout(freshnessBannerTicker); freshnessBannerTicker = null; }
  // reset() (not dispose()+apply()) keeps the debouncer's own bookkeeping of
  // "what's currently on screen" in sync with the forced hide, so the next
  // mount's first recompute reapplies correctly even if it happens to compute
  // the same state that was showing right before this unmount.
  freshnessBannerDebouncer.reset({ visible: false, tone: null, text: "" });
}
// Returns its own disposer, matching this file's existing
// `viewResources.own(someController.mount())` convention.
export function startFreshnessBannerWatch() {
  if (freshnessBannerConnectionUnsubscribe) return stopFreshnessBannerWatch;
  freshnessBannerConnectionUnsubscribe = subscribeRealtimeConnectionState((detail) => {
    realtimeConnectionState = String(detail?.state || "DISCONNECTED").toUpperCase();
    recomputeFreshnessBanner();
  });
  const tick = () => {
    recomputeFreshnessBanner();
    freshnessBannerTicker = viewResources.timeout(tick, 2000);
  };
  freshnessBannerTicker = viewResources.timeout(tick, 2000);
  recomputeFreshnessBanner();
  return stopFreshnessBannerWatch;
}

// There is no batch handler here: the transport has no batch buffer, nothing feeds a TAIEX/TXF "direct broker
// hot lane", and no `market.session.rollover` frame reaches this renderer.
//
// The live session-boundary detector is the status path above (a changed equity trading_date, or
// the PREOPEN transition) calling clearEquitySessionEphemeralState(), which is what actually
// resets trend/book/ticks/TAIEX and now the analysis rows as well.


export function txfCanonicalViewSpec(session = activeTxfSession) {
  const requestedLower = String(session || "full").toLowerCase();
  const requested = requestedLower.toUpperCase();
  const identity = currentTxfDisplayIdentity(requestedLower);
  // A canonical view is addressed by the WAL identity, never by the business tab. FUT's WAL
  // session is always FULL, partitioned by the exchange-time CALENDAR day, so asking Market
  // Runtime for session=DAY/NIGHT named a state key that can never exist: the subscription bound
  // to nothing, the 日盤 and 夜盤 tabs stayed permanently empty (0 trend points, price "--"),
  // and only 全日 worked -- because only 全日's business session happens to equal the WAL one.
  // The business window is what narrows the FULL series for display (see the point filter in
  // txfDisplay); it is not part of the state key.
  //
  // NIGHT's business trading_date is the NEXT business day, which is likewise not a WAL
  // partition, so the calendar day the window opens on is the partition to read.
  const stateKey = txfCanonicalStateKey(identity);
  return {
    market: "FUT",
    code: "TXFR1",
    logical_code: "TXFR1",
    trading_date: stateKey.trading_date,
    session: stateKey.session,
    actual_contract: String(identity?.actual_contract || "").toUpperCase(),
    contract_code: String(identity?.actual_contract || "").toUpperCase(),
    identity_key: txfDisplayIdentityKey(identity),
    // Match TAIEX semantics: TXFR1 owns only summary/trend. TradeDetail,
    // five-level orderbook and Tick-derived flow are intentionally not live
    // subscription channels.
    channels: ["summary", "trend"],
  };
}

// A futures month (個股期貨, 台指期／小台指 months) binds the futures partition trading now: the NIGHT one while the night
// session is live, else the DAY one -- the same partitions 期貨走勢's 夜盤 and 日盤 tabs read (txfCanonicalStateKey).
export function futuresLivePartition() {
  const night = currentTxfDisplayIdentity("night");
  return txfCanonicalStateKey(night?.live === true ? night : currentTxfDisplayIdentity("day"));
}

// 個股走勢's 日／夜／全 for 台指期／小台指 (a futures month of a product with no spot side): null follows the session
// trading now. A new selection starts from null again.
export let stockFuturesSession = null;
export function setStockFuturesSession(session) {
  stockFuturesSession = ["day", "night", "full"].includes(session) ? session : null;
}
export function stockFuturesSessionShown() {
  return stockFuturesSession || futuresLivePartition().session.toLowerCase();
}

/** The partitions 個股走勢 draws of a futures month for a session: 日盤 its DAY, 夜盤 its NIGHT, 全日 the night before
 *  and the day -- the partitions 期貨走勢's tabs read (txfSessionPartitions). */
export function futuresMonthTrendSpecs(code, session = stockFuturesSessionShown()) {
  const identity = currentTxfDisplayIdentity(session);
  const parts = txfSessionPartitions(identity);
  return (parts.length ? parts : [txfCanonicalStateKey(identity)])
    .map((part) => Object.freeze(sharedStockCanonicalViewSpec(code, "", part)));
}

// One frozen spec per product and trading date (a futures month: per futures partition): every frame reads each
// product's view through it, and the view store keys a frozen spec once instead of normalizing a new object on every
// read. The date is the session authority's, never the wall clock's: on a weekend or holiday the authority resolves an
// earlier trading date, and a wall-clock date would bind the view to a partition that holds nothing.
const stockViewSpecs = { key: null, byCode: new Map() };
export function stockCanonicalViewSpec(code) {
  const tradingDate = String(realtimeDisplayContext?.equity?.trading_date || "").slice(0, 10);
  const futures = futuresLivePartition();
  const key = `${tradingDate}|${futures.trading_date}|${futures.session}`;
  const normalized = String(code || "").trim().toUpperCase();
  if (stockViewSpecs.key !== key) { stockViewSpecs.key = key; stockViewSpecs.byCode.clear(); }
  let spec = stockViewSpecs.byCode.get(normalized);
  if (!spec) { spec = Object.freeze(sharedStockCanonicalViewSpec(normalized, tradingDate, futures)); stockViewSpecs.byCode.set(normalized, spec); }
  return spec;
}

export function taiexCanonicalViewSpec() {
  // TAIEX rolls with the stocks: the equity session's date (authority only, no wall-clock fallback).
  return benchmarkViewSpec("taiex", equityTradingDate());
}

// The 期貨 benchmark drawn over a stock's trend, whatever 期貨走勢 tab is shown: one view with the 日盤 tab.
export function txfBenchmarkViewSpec() {
  return benchmarkViewSpec("txf", taiexCanonicalViewSpec().trading_date);
}

// 產業指數: the current industry index's view, on the equity session's date (TAIEX's); none without a current index.
export function industryIndexCanonicalViewSpec() {
  return industryIndexViewSpec(industryIndexStore.snapshot(), taiexCanonicalViewSpec().trading_date);
}

// The canonical views a 期貨走勢 tab reads: its primary partition (txfCanonicalViewSpec) and the window's other calendar
// partitions -- 全日 spans the night before its day and the day (txfSessionPartitions).
export function txfViewSpecs(session = activeTxfSession) {
  const spec = txfCanonicalViewSpec(session);
  const specs = [spec];
  for (const part of txfSessionPartitions(currentTxfDisplayIdentity(String(session || "full").toLowerCase()))) {
    if (!part || (part.trading_date === spec.trading_date && part.session === spec.session)) continue;
    specs.push({ ...spec, trading_date: part.trading_date, session: part.session,
      identity_key: `${spec.identity_key}|partition:${part.trading_date}:${part.session}` });
  }
  return specs;
}
