// The 即時報價 page's canonical view owner: which Market Runtime views this window holds (declared from the session
// authority's dates, the product page, the detail target, 產業指數 and the 期貨走勢 tab), and how each view's snapshot
// and deltas reach the product rows, the analysis rows and the detail panels.
//
import { selectionComponentPaint, selectionMark } from "../../core/selection_latency_trace.js";
import { notifyMarketBreadthChanged, setMarketBreadthReader } from "../../core/market_breadth_store.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { sourceEnabled } from "../../core/source_settings.js";
import { replaceRealtimeWorkspace, reportFirstMeaningfulRender, selectRealtimeView } from "../../market_data/realtime.js";
import { TXF_WAL_SESSION, txfTickMatchesDisplayWindow as txfTickMatchesWindow } from "./txf_session_identity.js";
import { setProductSummaryReader } from "./product_summary_reader.js";
import { normalizeMinuteTrendSeries } from "../../market_data/minute_trend.js";
import { displayQuote } from "../../core/auction_price.js";
import { positiveNumberOrNull } from "../../core/numbers.js";
import { mergeCanonicalStockSummary } from "../../market_data/stock_market_summary.js";
import { windowSummaryFields } from "../../market_data/rolling_window_fields.js";
import { orderbookDiffEventToken } from "../../market_data/realtime_market_math.js";
import { updateRealtimeQuoteRows } from "./realtime_presentation.js";
import { replaceSignalRows } from "./live_signals.js";
import { signalRowFields } from "./signal_row.js";
import { industryIndexStore } from "./industry_index_store.js";
import { activeTrendTarget, detailTargetCode, liveMarketDataGateway, realtimePageVisible, realtimeVisibleEpoch, requestAnimationFrame, selectedStockCode, setTimeout } from "./live_page_state.js";
import { activeTxfSession, commitTxfDisplayIdentity, currentTxfDisplayIdentity, detailBookViewSpec, equityTradingDate, futuresMonthTrendSpecs, industryIndexCanonicalViewSpec, stockCanonicalViewSpec, taiexCanonicalViewSpec, trendPointEpochMs, txfBenchmarkViewSpec, txfCanonicalViewSpec, txfIdentityMatches, txfViewSpecs } from "./session_state.js";
import { activePage } from "./product_pages.js";
import { instrumentOf, isIndexFutureMonth, productOfInstrument } from "./product_sides.js";
import { shioajiMarketOf } from "../../market_data/futures_symbol.js";
import { invalidateLiveTrendComponents, renderTaiexAsPrimary, renderTxfAsPrimary, scheduleLiveComponentInvalidation } from "./live_redraw.js";
// The canonical state key the TXF view is currently bound to. The subscription is built from this
// key, so this -- not the display identity's key -- is what has to trigger a rebind.
// Why the 期貨走勢 series is (or is not) filling. Counted, not inferred: the canonical view can
// hold every bar while the chart still shows none, and only the rejection point says which stage
// dropped them.
export const txfIngestCounters = {
  snapshot_events: 0, snapshot_rejected_session: 0, snapshot_rejected_identity: 0,
  snapshot_rejected_commit: 0, snapshot_hydrated: 0, snapshot_points_in: 0, snapshot_points_kept: 0,
  delta_events: 0, delta_points_in: 0, delta_points_kept: 0,
  last_reject: "",
};

// The token of the last orderbook DELTA per stock: presentation only (a snapshot never flashes a level). The book
// itself is the view's.
export const orderbookDeltaTokens = new Map();

// 加權指數: its canonical view's summary and minute trend, read as the view holds them. It had a copy with its
// own ordering rule for a "direct IX0001 lane" that no longer exists, and so did the breadth counts.
function taiexViewState() {
  const spec = taiexCanonicalViewSpec();
  return spec.trading_date ? (liveMarketDataGateway.snapshot(spec) || {}) : {};
}

// 期貨 benchmark (個股走勢's 期貨 overlay): the DAY partition of the stock's trading date, read as the view holds it.
export function currentTxfBenchmarkView() {
  const spec = txfBenchmarkViewSpec();
  const state = spec.trading_date ? (liveMarketDataGateway.snapshot(spec) || {}) : {};
  // `reference`: the partition's 參考價 (Market Runtime's comparison price), the baseline the overlay is drawn from.
  return { reference: displayQuote(state.summary || {}).reference, points: Array.isArray(state.trend) ? state.trend : [] };
}

export function currentTaiexView() {
  const state = taiexViewState();
  // The view's trend is already the minute series (the store normalizes the snapshot and every upsert keeps it so);
  // it is read as it is, so an unchanged series is the same array and the same points.
  return { ...(state.summary || {}), points: Array.isArray(state.trend) ? state.trend : [] };
}

setMarketBreadthReader(() => taiexViewState().summary || null);

// ---------------------------------------------------------------------- canonical view owner
// The one owner of this window's canonical views. What is subscribed is DECLARED from prerequisites -- the session
// authority's dates, the watch page, the detail target, the 期貨走勢 tab -- and reconcileCanonicalViews() applies the
// difference: a view that stays wanted is never re-created. Mount, connection and session authority only change the
// prerequisites. The views outlive the page (switching away and back re-creates nothing; the transport re-subscribes
// them after a reconnect); the page attaches presentation only.
//
// It replaces five independent subscribe paths (watch-page rows, the detail stock, TAIEX, the TXF primary and its
// secondary partitions), each with its own force/latch/generation rules, re-created on every page switch.
export const heldCanonicalViews = new Map();
let declaredWorkspaceCodes = "";

// The view store's own identity of a spec (contract enrichment and identity_key are not part of it).
function canonicalViewKey(spec = {}) {
  return [spec.source || "", spec.market, spec.code, spec.trading_date, spec.session, (spec.channels || []).join(","),
    spec.replay_id || ""].join("|");
}

function pageProductCodes() {
  return [...new Set((activePage()?.codes || []).map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))];
}

// What the page's rows show: each product's chosen side -- the stock, or a futures month (product_sides.js).
function pageInstrumentCodes() {
  return [...new Set(pageProductCodes().map(instrumentOf))];
}

function desiredCanonicalViews() {
  const views = new Map();
  if (!sourceEnabled("shioaji")) return views;
  const add = (kind, spec, code = "") => { if (spec?.trading_date) views.set(canonicalViewKey(spec), { kind, spec, code }); };
  for (const code of pageInstrumentCodes()) add("stock", stockCanonicalViewSpec(code), code);
  const detail = detailTargetCode();
  if (detail && detail !== "TXFR1") add("stock", stockCanonicalViewSpec(detail), detail);
  // 零股 shown: 買賣報價 and 成交明細 read the detail stock's 盤中零股 view (the stock's own stays for everything else).
  const book = detail && detail !== "TXFR1" ? detailBookViewSpec(detail) : null;
  if (book?.market === "ODD") add("odd-lot", book, detail);
  // 台指期／小台指 in 個股走勢: the partitions of its 日／夜／全 (the one trading now is the detail view above).
  if (isIndexFutureMonth(detail)) {
    for (const spec of futuresMonthTrendSpecs(detail)) if (!views.has(canonicalViewKey(spec))) add("futures-part", spec, detail);
  }
  add("taiex", taiexCanonicalViewSpec());
  // Before the 期貨走勢 tab's views: when the 日盤 tab shows the same partition, the tab's kind is the one kept.
  add("txf-benchmark", txfBenchmarkViewSpec());
  const industry = industryIndexCanonicalViewSpec();
  if (industry) add("industry", industry, industry.code);
  for (const spec of txfViewSpecs(activeTxfSession)) add("txf", spec);
  return views;
}

function onCanonicalViewEvent(key, held, event) {
  if (held.kind === "stock") {
    applyStockCanonicalEvent(held.code, event);
    return;
  }
  if (held.kind === "odd-lot") {
    applyOddLotCanonicalEvent(held.code, event);
    return;
  }
  if (held.kind === "futures-part") {
    if (event.type !== "error") invalidateLiveTrendComponents({ symbol: held.code }, ["stockTrend"]);
    return;
  }
  if (held.kind === "taiex") {
    notifyMarketBreadthChanged();
    if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
    else invalidateLiveTrendComponents({ symbol: "TAIEX" }, ["marketTrend"]);
    return;
  }
  if (held.kind === "txf-benchmark") {
    invalidateLiveTrendComponents({ symbol: "TXFR1", session: "day" }, ["futuresTrend"]);
    return;
  }
  if (held.kind === "industry") {
    scheduleLiveComponentInvalidation("industryIndexTrend", { symbol: held.code });
    return;
  }
  // TXF: which partition is the tab's primary is decided now, by the tab shown now (a night's partition is the 夜盤
  // tab's primary and 全日's secondary).
  if (event.type === "error") return;
  const primary = key === canonicalViewKey(txfCanonicalViewSpec(activeTxfSession));
  if (event.type === "snapshot") {
    if (primary && !enrichTxfIdentityFromView(event.state || {}, activeTxfSession)) return;
  } else {
    txfIngestCounters.delta_events += 1;
  }
  redrawTxf();
}

export function reconcileCanonicalViews(_reason = "") {
  const desired = desiredCanonicalViews();
  for (const [key, held] of heldCanonicalViews) {
    if (desired.has(key)) continue;
    held.unsubscribe?.();
    heldCanonicalViews.delete(key);
  }
  for (const [key, want] of desired) {
    if (heldCanonicalViews.has(key)) continue;
    const held = { ...want, unsubscribe: null };
    // The caller reads the view when it draws; nothing is replayed into it synchronously.
    held.unsubscribe = liveMarketDataGateway.subscribe(want.spec, (event) => onCanonicalViewEvent(key, held, event),
      { stateDelivery: "snapshot-only", replayCached: false });
    heldCanonicalViews.set(key, held);
    const existing = liveMarketDataGateway.snapshot(want.spec);
    if (existing) onCanonicalViewEvent(key, held, { type: "snapshot", state: existing });
  }
  // The page's products are this window's workspace demand (the transport holds it across reconnects).
  // A futures month is named in full (source:MARKET:CODE): the workspace's bare codes are stocks.
  const codes = pageInstrumentCodes().map((code) => (shioajiMarketOf(code) === "FUT" ? `shioaji:FUT:${code}` : code));
  if (codes.join("|") !== declaredWorkspaceCodes) {
    declaredWorkspaceCodes = codes.join("|");
    replaceRealtimeWorkspace(codes);
  }
}

// The product rows' summary, read clone-free from the same view (summary + B's rolling windows). The view state is
// immutable, so the merge is redone only when the view's summary or windows object is replaced; every dirty row,
// header and panel read it again each frame.
const productSummaryMerges = new WeakMap();
function productSummaryProjection(state, code) {
  const summary = state?.summary;
  const windows = state?.windows;
  const merge = () => mergeCanonicalStockSummary({}, { ...windowSummaryFields(windows || {}), ...(summary || {}) }, code);
  if (!summary || typeof summary !== "object") return merge();
  const known = productSummaryMerges.get(summary);
  if (known && known.windows === windows && known.code === code) return known.value;
  const value = merge();
  productSummaryMerges.set(summary, { windows, code, value });
  return value;
}
setProductSummaryReader((code) => selectRealtimeView(stockCanonicalViewSpec(code), (state) => productSummaryProjection(state, code)));

// The current industry index changed (a pick on 「Shioaji產業指數」 or a stock's): its view replaces the last one and
// 「產業指數」 draws the new index at once (a view still cold draws its name and the empty state until it arrives).
industryIndexStore.subscribe(() => {
  reconcileCanonicalViews("INDUSTRY_INDEX");
  realtimeContext.dataSource.invalidate("industryIndexTrend", { symbol: industryIndexStore.snapshot().index?.code || "" });
});

// What a 期貨走勢 tab shows, composed on read from its partitions' views as they are now -- no page copy per tab
// with its own "keep the earlier points" and "keep the older price" rules: the views hold the series, so the tab is a
// projection of them:
//   points    -- every partition's minutes, narrowed to the tab's window;
//   price     -- the partition that traded last (after midnight, the next calendar day's);
//   reference -- the partition that carries one with its source (a night and its day share one 基準價);
//   open / high / low -- the tab's own session(s): 開盤 is the partition that opened first (全日's night), 最高 / 最低
//              the extremes of every partition's Market Runtime summary (each partition is one business session).
export function txfDisplay(session = activeTxfSession) {
  const expected = String(session || "full").toLowerCase();
  const identity = currentTxfDisplayIdentity(expected);
  const specs = txfViewSpecs(expected);
  const states = specs.map((spec) => liveMarketDataGateway.snapshot(spec)).filter(Boolean);
  if (!states.length) return null;
  const primary = liveMarketDataGateway.snapshot(specs[0]) || {};
  const primarySummary = primary.summary || {};
  const key = primary.session_key || {};
  const windowed = expected !== TXF_WAL_SESSION || Boolean(identity.window_start && identity.window_end);
  const points = normalizeMinuteTrendSeries(states.flatMap((state) => (Array.isArray(state.trend) ? state.trend : [])))
    .filter((point) => !windowed || txfTickMatchesWindow(point, identity, trendPointEpochMs));
  // 現價 as every surface shows it (displayQuote): during 試撮 the auction's indicative price, marked "#".
  let priced = null;
  for (const state of states) {
    const summary = state.summary || {};
    const shown = displayQuote(summary);
    const at = Number(summary.price_exchange_ts_ns || 0);
    if (shown.current != null && (!priced || at > priced.at)) priced = { summary, shown, at };
  }
  // Market Runtime's comparison price (displayQuote().reference) of the first partition that has one.
  const referenced = states.map((state) => ({ summary: state.summary || {}, reference: displayQuote(state.summary || {}).reference }))
    .find((item) => item.reference != null);
  const sessionOf = (state) => String(state.session_key?.session || state.summary?.session || "").toUpperCase();
  const openedFirst = [...states].sort((a, b) => Number(sessionOf(b) === "NIGHT") - Number(sessionOf(a) === "NIGHT"));
  const tabOpen = openedFirst.map((state) => positiveNumberOrNull(state.summary?.open)).find((value) => value != null) ?? null;
  const highs = states.map((state) => positiveNumberOrNull(state.summary?.high)).filter((value) => value != null);
  const lows = states.map((state) => positiveNumberOrNull(state.summary?.low)).filter((value) => value != null);
  return {
    ok: true, code: "TXFR1",
    contract_code: identity.actual_contract || primarySummary.contract_code || key.contract_code || null,
    trading_date: identity.trading_date || key.trading_date || null,
    // The tab; `wal_session` is the identity the partition arrived under.
    session: expected,
    wal_session: String(key.session || "").toLowerCase(),
    reference_price: referenced?.reference ?? null,
    reference_source: referenced?.summary.reference_source ?? null,
    open: tabOpen,
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    current: priced?.shown.current ?? null,
    indicative: Boolean(priced?.shown.indicative),
    // Market Runtime's 漲跌 of that price (wire.rs `summary`).
    change: priced?.shown.change ?? null,
    change_pct: priced?.shown.changePct ?? null,
    price_exchange_ts_ns: priced?.at || null,
    coverage: primary.coverage || {},
    points,
    last_update_at: primary.last_update_at || primarySummary.last_update_at || null,
    watermark: primary.watermark || 0,
    stream_id: primary.stream_id || "",
  };
}

// A partition snapshot ENRICHES the tab's display identity with the actual contract; session and trading date stay
// the business tab's own (committing the WAL's FULL/calendar day flipped the identity key every poll and recreated the
// subscription every 5 s). Returns false when the snapshot is not this tab's.
function enrichTxfIdentityFromView(state = {}, expectedSession = activeTxfSession) {
  const summary = state?.summary || {};
  const sessionKey = state?.session_key || {};
  const incomingSession = String(sessionKey.session || summary.session || expectedSession || "full").toLowerCase();
  const expected = String(expectedSession || activeTxfSession || "full").toLowerCase();
  txfIngestCounters.snapshot_events += 1;
  if (incomingSession !== expected && incomingSession !== TXF_WAL_SESSION && incomingSession !== "day" && incomingSession !== "night") {
    txfIngestCounters.snapshot_rejected_session += 1;
    txfIngestCounters.last_reject = `session:${incomingSession}!=${expected}`;
    return false;
  }
  const incoming = {
    ...sessionKey,
    trading_date: sessionKey.trading_date || summary.trading_date || null,
    actual_contract: sessionKey.actual_contract || sessionKey.contract_code || summary.actual_contract || summary.contract_code || null,
    contract_code: sessionKey.contract_code || summary.contract_code || sessionKey.actual_contract || summary.actual_contract || null,
    session: incomingSession,
  };
  if (!txfIdentityMatches(incoming, expected)) {
    txfIngestCounters.snapshot_rejected_identity += 1;
    txfIngestCounters.last_reject = `identity:${JSON.stringify(incoming).slice(0, 90)}`;
    return false;
  }
  const commit = commitTxfDisplayIdentity({ actual_contract: incoming.actual_contract, contract_code: incoming.contract_code,
    session: expected }, expected, "CANONICAL");
  if (!commit.accepted) {
    txfIngestCounters.snapshot_rejected_commit += 1;
    txfIngestCounters.last_reject = `commit:${JSON.stringify(commit).slice(0, 90)}`;
    return false;
  }
  txfIngestCounters.snapshot_hydrated += 1;
  return true;
}

// Any change of a tab's partitions: the tab is re-read when drawn.
function redrawTxf() {
  if (realtimePageVisible && activeTrendTarget() === "TXF") renderTxfAsPrimary();
  else invalidateLiveTrendComponents({ symbol: "TXFR1", session: activeTxfSession }, ["trendChart", "futuresTrend"]);
}

// Declared by the tab shown (activeTxfSession) and read as it is now: the view's own snapshot and deltas redraw the
// tab when they arrive (onCanonicalViewEvent); no fixed wait stands in for that first snapshot.
function ensureTxfCanonicalView(session = activeTxfSession) {
  reconcileCanonicalViews("TXF");
  return Promise.resolve(txfDisplay(String(session || "full").toLowerCase()));
}


export async function loadTxfTrendSnapshot(session = activeTxfSession) {
  const requested = String(session || "full").toLowerCase();
  const canonicalReady = ensureTxfCanonicalView(requested);
  await canonicalReady.catch((error) => console.warn("[realtime: preparing the TXF view] failed", error));
  // The reference comes with the partition's own summary (Market Runtime holds each TXF session's reference):
  // nothing to fetch here.
  return txfDisplay(requested);
}

// Product rows follow every summary/window change; updateRealtimeQuoteRows coalesces them to one repaint per frame.
function scheduleProductRowUpdate(code) {
  if (realtimePageVisible) updateRealtimeQuoteRows(new Set([productOfInstrument(code)]));
}

// Snapshots refused because they carry a different trading date than the session being displayed: counted for the
// startup acceptance (getLiveMarketDataDiagnostics), and each new pair of dates is a [realtime session mismatch] record
// in error.log, so an all-"--" product list is attributable instead of looking like an empty market (a 10-19 19:57
// window opened with every 實際庫存 row "--" for a minute and left no record of why).
const canonicalSessionMismatch = { count: 0, codes: new Set(), expected: null, incoming: null, at: null };

function recordCanonicalSessionMismatch(code, expectedDate, incomingDate) {
  const newPair = canonicalSessionMismatch.expected !== expectedDate || canonicalSessionMismatch.incoming !== incomingDate;
  canonicalSessionMismatch.count += 1;
  canonicalSessionMismatch.codes.add(code);
  canonicalSessionMismatch.expected = expectedDate;
  canonicalSessionMismatch.incoming = incomingDate;
  canonicalSessionMismatch.at = Date.now();
  if (newPair) {
    console.warn("[realtime session mismatch] snapshot dropped", {
      code, expected_trading_date: expectedDate, served_trading_date: incomingDate, dropped_so_far: canonicalSessionMismatch.count,
    });
  }
}

export function canonicalSessionMismatchDiagnostics() {
  return {
    dropped_snapshot_count: canonicalSessionMismatch.count,
    affected_code_count: canonicalSessionMismatch.codes.size,
    expected_trading_date: canonicalSessionMismatch.expected,
    served_trading_date: canonicalSessionMismatch.incoming,
    last_at: canonicalSessionMismatch.at,
  };
}

// The analysis projection arrives as two channels on the ordinary per-symbol view, so it gets
// the view protocol's guarantees for free: ordered, de-duplicated, gap-detected, resynced on
// reconnect and pinned to a session identity. All this has to do is shape one row for the
// application path that already exists.
//
// Wire percentages are already plain numbers (Rust carries them in the price fixed point and
// divides on the way out); the field projection (量變's rename, provenance) is signalRowFields(),
// shared with the Futu rows.
// `authoritative` separates the two ways a row arrives, and they mean opposite things when there
// is no `signals` block.
//
// A delta without a `signals` block is simply nothing to do (another channel changed). A view SNAPSHOT is the complete current state of that instrument in the
// CURRENT session -- it is what a fresh subscribe, a resync and a session rollover all deliver --
// so a snapshot with no signals is a positive statement that this code has no analysis row now.
// Returning early on both left the previous session's numbers sitting in the product row (and, in
// the signal map, silently counted as "has a row" so 尚無訊號 read 0).
//
// Only the signal store is written here; the return says whether the row changed, and the caller folds that into the
// event's changed channels ("signals") so the product row and the detail panels are redrawn once per event.
function applyCanonicalSignalRow(code, signals, { authoritative = false } = {}) {
  const fields = signalRowFields(signals);
  if (!fields) {
    if (authoritative) replaceSignalRows({ removedCodes: [code] });
    return authoritative;
  }
  // Market Runtime sends the instrument's whole signals object (snapshot and frame alike): the row is replaced, so
  // a value the analysis no longer holds disappears with it. The stamp rides ON the row: the
  // displayed 更新時間 is "the newest exchange time any applied row can account for".
  const dirty = replaceSignalRows({ rows: [{ code, fields }] });

  // first_meaningful_render means the user has SEEN analysis numbers, so all three conditions are
  // required: the monitor is visible, this batch actually changed a row, and a frame has been
  // painted since. Reporting it here unconditionally -- which is what it did at first -- fired
  // while the page was still hidden and the row write had touched no DOM at all, so the metric
  // recorded "state exists", under a name that claims a render happened.
  if (realtimePageVisible && dirty && dirty.size) {
    const paint = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    paint(() => reportFirstMeaningfulRender({ page: "realtime" }));
  }
  return dirty.size > 0;
}

// What the detail panels were last handed from a snapshot of the detail symbol, per channel: a snapshot or resync
// that repeats it (no other notice in between) redraws nothing. Any other notice of the symbol, a page show or hide,
// a market-data reconnect and another detail symbol start it over.
let detailSnapshotFingerprint = { code: "", epoch: -1, channels: new Map() };

function changedSnapshotChannels(code, state) {
  if (detailSnapshotFingerprint.code !== code || detailSnapshotFingerprint.epoch !== realtimeVisibleEpoch) {
    detailSnapshotFingerprint = { code, epoch: realtimeVisibleEpoch, channels: new Map() };
  }
  // The view state is immutable: a channel that changed is a new value, an unchanged one is the same value. It was
  // a JSON.stringify of every channel (the whole trend and trade tape) per snapshot.
  // A snapshot without `signals` states that the instrument has no analysis row (applyCanonicalSignalRow), so that
  // channel is compared even when absent: a row that disappeared is a change.
  const changed = new Set();
  for (const channel of ["summary", "trades", "orderbook", "tradeflow", "trend", "price_volume", "signals"]) {
    if (channel !== "signals" && !Object.hasOwn(state, channel)) continue;
    const value = state[channel] ?? null;
    if (!detailSnapshotFingerprint.channels.has(channel) || detailSnapshotFingerprint.channels.get(channel) !== value) changed.add(channel);
    detailSnapshotFingerprint.channels.set(channel, value);
  }
  return changed;
}

function applyStockCanonicalSnapshot(code, state = {}) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return false;
  // The partition this window binds the code to: the equity date, or a futures month's own partition.
  const expectedDate = stockCanonicalViewSpec(normalized).trading_date || equityTradingDate();
  const incomingDate = String(state?.session_key?.trading_date || state?.summary?.trading_date || "").slice(0, 10);
  // A late snapshot from an unsubscribed previous-day view must never restore
  // yesterday's trades/book after the session rollover reset.
  if (expectedDate && incomingDate && incomingDate !== expectedDate) {
    // Dropping silently made this look exactly like an empty market. Market Runtime can
    // legitimately hold a different session than the one being displayed -- its view commands
    // key on source:market:code and always answer with the CURRENT session, so the renderer
    // cannot ask for the session it is showing and can only discard the answer. When that
    // happens for every symbol, the whole product list reads "--" while the WebSocket is
    // connected and nothing anywhere reports why. Count it instead.
    recordCanonicalSessionMismatch(normalized, expectedDate, incomingDate);
    return false;
  }
  // The projection's row rides the same snapshot, so a fresh subscribe or a resync restores the analysis row together
  // with the market state -- no separate catch-up.
  const signalsChanged = applyCanonicalSignalRow(normalized, state.signals, { authoritative: true });
  // A snapshot re-baselines the book: no level flashes for it.
  orderbookDeltaTokens.delete(normalized);
  const canonicalSummary = state.summary && typeof state.summary === "object" ? state.summary : {};
  const hasSummary = Object.keys(canonicalSummary).length > 0;
  // The product row shows the summary and the analysis row: one update for both. Canonical snapshots arrive per
  // symbol, so only the affected row is updated; rebuilding the whole watchlist replaced every <tr> and made the row
  // controller re-fit scroll geometry. The arrival is the SUMMARY projection's: the last event that changed the row's
  // market numbers (a Shioaji Tick arrives as Payload::Trade, so a quote-named stamp is never written for it).
  if (realtimePageVisible && (hasSummary || signalsChanged)) {
    updateRealtimeQuoteRows(new Set([productOfInstrument(normalized)]), { arrivalUs: hasSummary ? state.channel_arrival_us?.summary ?? null : null });
  }
  if (hasSummary) {
    selectionMark(normalized, "summary_invalidated");
    const row = document.querySelector(`[data-role="product-list-body"][data-provider="shioaji"] tr[data-realtime-code="${CSS.escape(productOfInstrument(normalized))}"]`);
    if (row) selectionComponentPaint(normalized, "summary", row);
  }
  const ownsVisibleDetail = detailTargetCode() === normalized;
  if (realtimePageVisible && ownsVisibleDetail) {
    const request = { symbol: normalized, canonicalSnapshot: true };
    const changed = changedSnapshotChannels(normalized, state);
    // 成交明細's 大單 badges are the tradeflow's large prints, which Rust B publishes after the prints themselves.
    if (changed.has("trades") || changed.has("tradeflow")) realtimeContext.dataSource.invalidate("tickDetails", request);
    // 五檔 and the trend header read the selected symbol's analysis row (getSelectedRealtimeSignal) too.
    if (changed.has("orderbook") || changed.has("price_volume") || changed.has("summary") || changed.has("signals")) realtimeContext.dataSource.invalidate("orderbook", request);
    if (changed.has("tradeflow")) realtimeContext.dataSource.invalidate("tradeFlow", request);
    if (changed.has("price_volume") || changed.has("summary")) realtimeContext.dataSource.invalidate("priceFlow", request);
    if (changed.has("trend") || changed.has("summary") || changed.has("signals")) invalidateLiveTrendComponents(request, ["trendChart", "stockTrend"]);
    for (const channel of ["trades", "orderbook", "tradeflow", "trend", "price_volume"])
      if (changed.has(channel)) selectionMark(normalized, `${channel}_invalidated`);
  }
  return true;
}

function applyStockCanonicalEvent(normalized, event = {}) {
  // Anything but a snapshot (a delta, a gap, a status or error notice) changes what the panels show or how they
  // label it: the next snapshot of the symbol is compared from scratch.
  if (event.type !== "snapshot" && detailSnapshotFingerprint.code === normalized) detailSnapshotFingerprint.channels.clear();
  if (event.type === "batch") {
    for (const delta of Array.isArray(event.deltas) ? event.deltas : []) {
      applyStockCanonicalEvent(normalized, {
        type: "delta",
        delta,
        changedChannel: delta?.channel || delta?.delta_type,
        changedChannels: delta?.channels || [delta?.channel || delta?.delta_type],
      });
    }
    return;
  }
  if (event.type === "snapshot") {
    applyStockCanonicalSnapshot(normalized, event.state || {});
    return;
  }
  if (event.type !== "delta") return;
  const delta = event.delta || {};
  const payload = delta.payload || {};
  const type = String(delta.delta_type || "");
  // Shown = the selected stock OR the symbol the detail panels currently follow (before any click they follow the
  // fallback detail target). Gating on the selection alone left 買賣報價 / 成交明細 frozen on that fallback symbol
  // at startup: its deltas arrived and were applied, but the panels were never invalidated.
  const visible = realtimePageVisible
    && (String(selectedStockCode() || "") === normalized || detailTargetCode() === normalized);
  const changed = new Set(event.changedChannels || [event.changedChannel]);
  if (type === "signals.frame") {
    if (!applyCanonicalSignalRow(normalized, payload.signals)) return;
    changed.add("signals");
    scheduleProductRowUpdate(normalized);
  }
  if (type === "windows.updated") {
    scheduleProductRowUpdate(normalized);
    return;
  }
  if (type === "meta.updated") return;
  if (type === "trade.append" || type === "trade.frame") {
    const trade = { ...((type === "trade.frame" ? payload.trade : payload) || {}), code: normalized };
    // A new trade advances the trade pager's page count (no FastAPI re-read); page 1 itself is the view's trades.
    if (visible) links.onTradeAppended(normalized, trade);
  } else if (type === "orderbook.latest") {
    orderbookDeltaTokens.set(normalized, orderbookDiffEventToken(payload));
  }
  if (["trade.frame", "quote.frame", "summary.updated"].includes(type)) scheduleProductRowUpdate(normalized);

  if (!visible) return;
  const request = { symbol: normalized, canonicalDelta: true };
  // B's day block carries the price/volume projection too (the view store merges it into price_volume).
  if (type === "day.updated" && payload.price_volume) changed.add("price_volume");
  if (changed.has("trades") || changed.has("tradeflow")) scheduleLiveComponentInvalidation("tickDetails", request);
  if (changed.has("trend")) invalidateLiveTrendComponents(request, ["trendChart", "stockTrend"]);
  if (changed.has("orderbook") || changed.has("price_volume")) scheduleLiveComponentInvalidation("orderbook", request);
  if (changed.has("price_volume")) scheduleLiveComponentInvalidation("priceFlow", request);
  if (changed.has("tradeflow")) scheduleLiveComponentInvalidation("tradeFlow", request);
  if (changed.has("summary") || changed.has("signals")) {
    // The trend components of this symbol, in this frame -- one path only. A second one through
    // invalidateSelectedRealtimeTrend drew the same trend again a frame later. 五檔 and the trend header read the
    // analysis row too, so a signals.frame takes the same path.
    scheduleLiveComponentInvalidation("orderbook", request);
    invalidateLiveTrendComponents(request, ["trendChart", "stockTrend"]);
  }
}

// The book's flash token of a stock's 盤中零股 (orderbookDeltaTokens holds the stock's own under its bare code).
export function oddLotBookTokenKey(code) {
  return `ODD:${String(code || "").trim().toUpperCase()}`;
}

// A 盤中零股 view's events: 買賣報價 and 成交明細 redraw while they show it (only the detail stock's is held).
function applyOddLotCanonicalEvent(code, event = {}) {
  const deltas = event.type === "batch" ? (Array.isArray(event.deltas) ? event.deltas : []) : event.type === "delta" ? [event.delta || {}] : [];
  if (event.type === "snapshot") orderbookDeltaTokens.delete(oddLotBookTokenKey(code));
  const changed = new Set(event.type === "snapshot" ? ["trades", "orderbook"] : []);
  for (const delta of deltas) {
    const type = String(delta?.delta_type || "");
    if (type === "orderbook.latest") {
      orderbookDeltaTokens.set(oddLotBookTokenKey(code), orderbookDiffEventToken(delta.payload || {}));
      changed.add("orderbook");
    } else if (type === "trade.append" || type === "trade.frame") {
      changed.add("trades");
    } else if (type === "summary.updated" || type === "quote.frame") {
      changed.add("orderbook");
    }
  }
  if (!realtimePageVisible || detailTargetCode() !== code || !changed.size) return;
  const request = { symbol: code, canonicalDelta: event.type !== "snapshot" };
  if (changed.has("trades")) scheduleLiveComponentInvalidation("tickDetails", request);
  if (changed.has("orderbook")) scheduleLiveComponentInvalidation("orderbook", request);
}

export function ensureStockCanonicalView(code) {
  // The detail target is part of the declared set (desiredCanonicalViews); this only marks the selection trace.
  const normalized = String(code || "").trim().toUpperCase();
  selectionMark(normalized, "ensure_view_begin");
  reconcileCanonicalViews("SELECTION");
  selectionMark(normalized, "ensure_view_complete");
}

export function ensureTxfBenchmarkView() {
  reconcileCanonicalViews("TXF_BENCHMARK");
  return Promise.resolve(currentTxfBenchmarkView());
}

export function ensureTaiexCanonicalView() {
  reconcileCanonicalViews("TAIEX");
  return Promise.resolve(currentTaiexView());
}

// What a view's delta tells the detail target's trade pager (a new trade advances its page count). The pager sits above
// this owner (live_view_models.js), so the page connects the two when it assembles them (pages/realtime.js).
const links = { onTradeAppended: null };
export function connectCanonicalViewOwner({ onTradeAppended }) { links.onTradeAppended = onTradeAppended; }

// Whether a stock's view is held by this owner or already cached by the gateway (the dashboard asks before it
// subscribes a component's own view of the code).
export function stockViewWarmOrSubscribed(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return false;
  const spec = stockCanonicalViewSpec(normalized);
  return heldCanonicalViews.has(canonicalViewKey(spec)) || Boolean(liveMarketDataGateway.snapshot(spec));
}
