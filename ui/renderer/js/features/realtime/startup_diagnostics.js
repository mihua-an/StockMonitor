// The 即時報價 page's startup progress units and startup acceptance: what the page measures on screen and in its views
// for getLiveMarketDataDiagnostics().
import { appState } from "../../core/state.js";
import { getRealtimeTransportHealth, getRealtimeViewStats } from "../../market_data/realtime.js";
import { rendererTelemetryDiagnostics } from "../../core/renderer_runtime_health.js";
import { productSummaryOf } from "./product_summary_reader.js";
import { trendFrameRecord } from "../../core/components/trend_canvas_frames.js";
import { getRealtimeSignalCoverage } from "./live_signals.js";
import { getLiveMonitorEvents } from "./live_monitor_events.js";
import { positiveNumberOrNull } from "../../core/numbers.js";
import { liveMarketDataGateway, realtimePageVisible, selectionIntentStore, viewResources } from "./live_page_state.js";
import { activePage } from "./product_pages.js";
import { activeTxfSession, currentTxfDisplayIdentity, txfCanonicalViewSpec, txfViewSpecs } from "./session_state.js";
import { canonicalSessionMismatchDiagnostics, heldCanonicalViews, txfDisplay, txfIngestCounters } from "./canonical_view_owner.js";
import { columnSettingsEditorDiagnostics } from "../../core/components/column_settings_editor.js";
import { liveTradePager } from "./live_view_models.js";
import { realtimeSessionLifecycle } from "./session_controller.js";

// The startup progress steps this page reports (only on the startup fast path) and a runner that brackets one.
export function startupUnitReporter({ startupFastPath, reportStartupUnit, mountToken }) {
  const report = async (stepId, action, detail = null) => {
    if (!startupFastPath || typeof reportStartupUnit !== "function") return null;
    try {
      return await reportStartupUnit(stepId, action, detail);
    } catch (error) {
      console.warn(`[STARTUP UNIT] ${stepId}/${action}`, error);
      return null;
    }
  };
  const runUnit = async (stepId, detail, executor, successDetail = null) => {
    await report(stepId, "start", detail);
    if (!viewResources.current(mountToken)) return null;
    try {
      const result = await executor();
      const finalDetail = typeof successDetail === "function" ? successDetail(result) : successDetail;
      await report(stepId, "complete", finalDetail);
      return result;
    } catch (error) {
      await report(stepId, "failed", String(error?.message || error));
      throw error;
    }
  };
  return { report, runUnit };
}

// What the product list shows: rows on screen, and how many listed codes already carry a numeric quote/market datum.
function measureProductRows() {
  const productBody = document.querySelector('[data-role="product-list-body"][data-provider="shioaji"]');
  const productRows = productBody?.querySelectorAll("tr:not(:has(.empty))").length || 0;
  const productCodes = activePage().codes || [];
  const signalByCode = appState.signalsByCode;
  const productDataRows = productCodes.filter((rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    const sources = [productSummaryOf(code), signalByCode.get(code) || {}];
    return sources.some((item) => [
      item.current, item.price, item.last_price, item.prev_close, item.reference_price,
      item.open, item.day_high, item.high, item.day_low, item.low,
      item.total_volume, item.volume,
      item.best_bid_price, item.best_bid, item.best_ask_price, item.best_ask,
    ].some((value) => value !== null && value !== "" && Number.isFinite(Number(value))));
  }).length;
  return { productRows, productDataRows };
}

// The 期貨走勢 canvas as drawn: its frame and the reference it was drawn against.
function measureFuturesCanvas(txfShown) {
  const visibleTrendCanvases = [...document.querySelectorAll("canvas[data-trend-view]")].filter((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(canvas).visibility !== "hidden";
  });
  // Address the 期貨走勢 canvas by the panel that actually shows TXFR1, and fall back to the view
  // label. The label is now authoritative again -- trend_surface_state.js parks a surface per
  // slot+variant so no surface can be adopted by another slot, and mount re-stamps
  // data-trend-view/data-trend-surface and drops frame state belonging to another variant -- but
  // these checks decide whether the futures panel is acceptable, so they name the panel directly
  // rather than trusting one attribute to have stayed correct.
  const canvas = visibleTrendCanvases.find((item) => {
    const panel = item.closest?.("[data-component-slot]") || null;
    const code = panel?.querySelector?.('[data-role="product-code"]')?.textContent?.trim().toUpperCase();
    return code === "TXFR1";
  }) || visibleTrendCanvases.find((item) => item.dataset.trendView === "futures") || null;
  // txfDisplay's reference is Market Runtime's comparison price (displayQuote().reference).
  const reference = { price: txfShown?.reference_price ?? null, source: txfShown?.reference_source ?? null };
  const frame = trendFrameRecord(canvas);
  const drawnReference = positiveNumberOrNull(frame?.reference);
  return {
    canvas, reference, drawnReference,
    framePoints: Number(frame?.pointCount || 0),
    frameWidth: Number(frame?.width || 0),
    frameHeight: Number(frame?.height || 0),
    referenceChanges: Number(frame?.referenceChanges || 0),
    referenceDelta: reference.price != null && drawnReference != null
      ? Math.abs(reference.price - drawnReference) : Number.POSITIVE_INFINITY,
  };
}

const maxDatasetCount = (selector, field) => Math.max(0, ...[...document.querySelectorAll(selector)]
  .map((node) => Number(node.dataset[field] || 0)));

// Every measurement the startup acceptance reads, taken once.
function measureLiveMarketData() {
  const txfShown = txfDisplay();
  const transportHealth = getRealtimeTransportHealth();
  const activeViews = (getRealtimeViewStats()?.subscriptions || []).filter((view) => view?.active);
  const boundViews = activeViews.filter((view) => {
    const state = String(view?.view_state || view?.status || "").toUpperCase();
    return state === "LIVE" || state === "READY";
  });
  const tradeFlow = liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession))?.tradeflow || {};
  return {
    ...measureProductRows(),
    txfShown,
    txfTrendPoints: txfShown?.points?.length || 0,
    futures: measureFuturesCanvas(txfShown),
    eventRows: document.querySelectorAll('[data-component-slot="liveInfo"] [data-role="event-body"] tr:not(:has(.empty))').length,
    orderbookRows: document.querySelectorAll('[data-component-slot="analysisSecondary"] [data-role="orderbook-body"] tr:not(:has(.empty))').length,
    tradeRows: document.querySelectorAll("[data-role='tick-body'] tr:not(:has(.empty))").length,
    largeOrderSamples: Number(tradeFlow?.sample_count || tradeFlow?.sampleCount || 0),
    realtimeEvents: getLiveMonitorEvents().length,
    trendTopologyCommits: Math.max(0, ...[...document.querySelectorAll("canvas[data-trend-view]")].map((node) => trendFrameRecord(node)?.topologyCommits || 0)),
    priceVolumeTopologyCommits: maxDatasetCount("[data-role='price-volume']", "priceVolumeTopologyCommitCount"),
    transportHealth, activeViews, boundViews,
    telemetry: rendererTelemetryDiagnostics(),
  };
}

// Startup-acceptance contract: process/service, realtime ingress, canonical state, renderer,
// required market panels, health. Monitor ALERT events are deliberately NOT part of it --
// "no alert fired" is a legitimate business state, and requiring one would make this aggregate
// false on any quiet session. realtime_info is
// still measured and reported as advisory rather than bending the readiness contract around it.
function startupAcceptanceChecks(m) {
  const { transportHealth, telemetry, futures } = m;
  return {
    // renderer ready -- the page it was asked to show is mounted and its resources are live.
    renderer_ready: Boolean(realtimePageVisible) && Boolean(viewResources.active),
    // realtime ingress ready -- connected, and not silently discarding frames it cannot parse.
    realtime_ingress_ready: Boolean(transportHealth?.connected)
      && Number(transportHealth?.frame_parse_errors || 0) === 0
      && Number(transportHealth?.frame_shape_errors || 0) === 0,
    // canonical state ready -- every view this page subscribed to has actually bound.
    canonical_state_ready: m.activeViews.length > 0 && m.boundViews.length === m.activeViews.length,
    // health ready -- this renderer's telemetry is flowing AND is within the bounds main enforces,
    // which is the exact condition whose silent violation froze Health's view of the renderer.
    health_ready: Boolean(telemetry?.sampling) && telemetry?.within_bounds !== false,
    // A code-only placeholder row is not acceptance. At least one visible
    // product must already carry a numeric quote/market datum.
    product_rows: m.productRows > 0 && m.productDataRows > 0,
    futures_trend: m.txfTrendPoints > 0 && futures.reference.price != null,
    futures_trend_rendered: Boolean(futures.canvas)
      && futures.framePoints > 0
      && futures.frameWidth >= 100
      && futures.frameHeight >= 100
      && futures.referenceDelta < 0.001,
    futures_reference_stable: futures.referenceChanges === 0,
    // TXFR1 is intentionally Quote-only. Five-level depth, transaction-detail
    // and Tick-derived large-order flow are not startup requirements anymore.
    best_five: true,
    trade_details: true,
    large_order_flow: true,
    futures_trend_stable: m.trendTopologyCommits <= 1,
    price_volume_stable: m.priceVolumeTopologyCommits <= 1,
  };
}

// The contract this aggregate implements, named so a reader can see which check answers which
// requirement without re-deriving it from the names.
const STARTUP_ACCEPTANCE_CONTRACT = Object.freeze({
  service_ready: ["renderer_ready"],
  realtime_ingress_ready: ["realtime_ingress_ready"],
  canonical_state_ready: ["canonical_state_ready"],
  renderer_ready: ["renderer_ready"],
  market_panels_ready: [
    "product_rows", "futures_trend", "futures_trend_rendered", "futures_reference_stable",
    "best_five", "trade_details", "large_order_flow", "futures_trend_stable",
    "price_volume_stable",
  ],
  health_ready: ["health_ready"],
});

function startupAcceptanceCounts(m) {
  const { transportHealth, telemetry, futures } = m;
  return {
    product_rows: m.productRows,
    product_data_rows: m.productDataRows,
    realtime_info_events: m.realtimeEvents,
    realtime_info_rows: m.eventRows,
    active_canonical_views: m.activeViews.length,
    bound_canonical_views: m.boundViews.length,
    telemetry_payload_bytes: telemetry?.payload_bytes ?? null,
    telemetry_within_bounds: telemetry?.within_bounds ?? null,
    telemetry_reject_reason: telemetry?.reason || "",
    transport_connected: Boolean(transportHealth?.connected),
    futures_trend_points: m.txfTrendPoints,
    futures_frame_points: futures.framePoints,
    futures_frame_width: futures.frameWidth,
    futures_frame_height: futures.frameHeight,
    futures_reference_price: futures.reference.price,
    futures_reference_source: futures.reference.source,
    futures_drawn_reference: futures.drawnReference,
    futures_reference_changes: futures.referenceChanges,
    orderbook_rows: m.orderbookRows,
    trade_rows: m.tradeRows,
    large_order_samples: m.largeOrderSamples,
    futures_trend_topology_commits: m.trendTopologyCommits,
    price_volume_topology_commits: m.priceVolumeTopologyCommits,
  };
}

// These already existed and nothing could read them, which is why a stuck 期貨走勢 panel had
// to be diagnosed by inference. The acceptance surface is read-only and already the place
// the restart harness looks.
function txfAcceptanceDiagnostics(m) {
  const { txfShown } = m;
  return {
    active_session: activeTxfSession,
    identity: currentTxfDisplayIdentity(activeTxfSession),
    spec: txfCanonicalViewSpec(activeTxfSession),
    partitions: txfViewSpecs(activeTxfSession).map((spec) => `${spec.trading_date}:${spec.session}`),
    snapshot_points: (txfShown?.points || []).length,
    snapshot_session: txfShown?.session || "",
    snapshot_reference: txfShown?.reference_price ?? null,
    snapshot_reference_source: txfShown?.reference_source || "",
    points_buffer: m.txfTrendPoints,
    ingest: { ...txfIngestCounters },
    resolved_reference: m.futures.reference,
    // What the canonical view store actually holds for this spec, so a blank chart can be
    // attributed to the store, the hydrate, or the display filter without guessing.
    view: txfViewDiagnostics(),
  };
}

function txfViewDiagnostics() {
  const state = liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession));
  if (!state) return { present: false };
  return {
    present: true,
    keys: Object.keys(state).slice(0, 24),
    trend_length: Array.isArray(state.trend) ? state.trend.length : null,
    trend_sample: Array.isArray(state.trend) && state.trend.length ? state.trend[0] : null,
    summary_current: state.summary?.current ?? null,
    session_key: state.session_key || null,
    view_status: state.view_status || null,
    presentation_state: state.presentation_state || null,
  };
}

export function getLiveMarketDataDiagnostics() {
  const measured = measureLiveMarketData();
  const checks = startupAcceptanceChecks(measured);
  return {
    ...liveMarketDataGateway.diagnostics(),
    pageResources: viewResources.diagnostics(),
    columnEditor: columnSettingsEditorDiagnostics(),
    tradePager: liveTradePager.diagnostics(),
    sessionLifecycle: realtimeSessionLifecycle.diagnostics(),
    selectionIntent: selectionIntentStore.diagnostics(),
    canonicalSessionMismatch: canonicalSessionMismatchDiagnostics(),
    // Why the 期貨走勢 series is (or is not) filling, with what the active tab holds right now.
    txfIngest: { ...txfIngestCounters, active_session: activeTxfSession, held_views: heldCanonicalViews.size,
      series_points: measured.txfTrendPoints,
      identity: currentTxfDisplayIdentity(activeTxfSession) },
    startupAcceptance: {
      ok: Object.values(checks).every(Boolean),
      checks,
      // Measured, reported, never gating. Keep this separate from `checks` so nothing can quietly
      // promote an advisory signal back into the readiness aggregate.
      advisory: {
        realtime_info: measured.realtimeEvents > 0,
      },
      contract: STARTUP_ACCEPTANCE_CONTRACT,
      // Analysis-projection coverage of the visible page, recomputed on read. There is no
      // on-screen summary of this (see getRealtimeSignalCoverage in features/realtime/live_signals.js on why);
      // diagnostics is where it belongs, and it is the caller that keeps both helpers live.
      signal_coverage: getRealtimeSignalCoverage(),
      counts: startupAcceptanceCounts(measured),
      active_txf_session: activeTxfSession,
      txf: txfAcceptanceDiagnostics(measured),
    },
  };
}
