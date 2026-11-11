import { materializedTradeToLiveTick } from "./trade_detail/live_tick_projection.js";
import { logTradePagePerfTrace, logTradePagePerfFailure, recordPageCountRead } from "./trade_detail/perf_trace.js";
import { createOptimisticCountTracker } from "./trade_detail/optimistic_count.js";
import { TRADE_DETAIL_PAGE_SIZE, tradePageQuery } from "./trade_detail/page_query.js";
import { LatestIntentGate } from "./latest_intent_gate.js";
import { numberOrNull } from "../core/numbers.js";

// Page 1 and every new trade come over the WS (the view snapshot carries the newest 100, deltas the rest); only the
// pages behind them are FastAPI's. The page count is read ONCE per symbol when its page 1
// opens and is then advanced by the optimistic per-trade count -- no metadata re-read follows each
// trade. Opening an older page re-reads the count with it.
export function createLiveTradePager({ apiGet, pageGet = apiGet, getQuery, getEquityDate, futuresIdentityMatches,
  invalidateDetails }) {
let liveTickMetadataRefreshInFlight = null;
let liveTickMetadataLoadedFor = "";
// Advanced by every reset (a new target, a new session): what a page-count read is current against. A page request
// claims a new page generation, but it does not make the target's page count stale.
let resetEpoch = 0;
// Every page read is numbered when it is sent; a count is applied only from a read sent after the one whose count is
// shown (a count read that left before a page read must not overwrite that page's newer count when it lands later).
let countReadsSent = 0;
let countShownFrom = 0;
const optimisticCount = createOptimisticCountTracker({ pageSize: TRADE_DETAIL_PAGE_SIZE, limit: 20000 });
// Staleness guard for foreground page loads vs. the background metadataRefresh
// lane. Foreground loads and target resets each intent.issue(target) a new
// generation; metadataRefresh peeks the current generation (intent.generation)
// without claiming one, so its response validates against whatever generation
// is currently active rather than superseding it.
const intent = new LatestIntentGate();

  let active = true;
  const requests = new Set(), frames = new Set();
  function traceFrame(callback) {
    const frame = requestAnimationFrame(() => { frames.delete(frame); if (active) callback(); });
    frames.add(frame);
  }
const liveTickPageState = {
  target: "", page: 1, rows: [], totalCount: 0, totalPages: 1, snapshotWatermark: 0,
  loading: false, loaded: false, bootstrapReady: false, latencyMs: 0,
  lastLoadedAt: 0, lastError: null,
  identityKey: "",
};

function resetLiveTickPageState(target = "") {
  for (const request of requests) request.abort();
  requests.clear();
  for (const frame of frames) cancelAnimationFrame(frame);
  frames.clear();
  liveTickPageState.target = String(target || "");
  liveTickPageState.page = 1;
  liveTickPageState.rows = [];
  liveTickPageState.totalCount = 0;
  liveTickPageState.totalPages = 1;
  liveTickPageState.snapshotWatermark = 0;
  liveTickPageState.loading = false;
  liveTickPageState.loaded = false;
  liveTickPageState.bootstrapReady = false;
  liveTickPageState.latencyMs = 0;
  liveTickPageState.lastLoadedAt = 0;
  liveTickPageState.lastError = null;
  liveTickPageState.identityKey = "";
  liveTickMetadataRefreshInFlight = null;
  liveTickMetadataLoadedFor = "";
  resetEpoch += 1;
  countShownFrom = 0;
  optimisticCount.clear();
  // Claim a new generation last, after every other field has been reset, so
  // that any in-flight request for the old target is invalidated only once
  // the full reset has synchronously completed (no async callback can
  // observe a partially-reset state in between).
  intent.issue(liveTickPageState.target);
  // The new target's page count is asked at once, in the background: every path that changes the target resets the
  // pager, but not every one opens page 1 (a product-list click did not, and its page count stayed 1). Asked after
  // the caller has finished switching, so the query reads the new target's day.
  const resetTarget = liveTickPageState.target;
  if (resetTarget) queueMicrotask(() => { if (active && liveTickPageState.target === resetTarget) loadLiveTickPageMetadataOnce(); });
}

function applyOptimisticTradePageCount(code, row = {}) {
  return optimisticCount.apply(code, row, liveTickPageState);
}

// The symbol's page count, read once per target (single-flight, no timer): asked by the reset that set the target and
// by a page-1 open. A failed read is retried by the next of those, never by a loop.
function loadLiveTickPageMetadataOnce() {
  if (!active) return null;
  const target = getQuery().target;
  if (!target || liveTickMetadataLoadedFor === target || liveTickMetadataRefreshInFlight) return liveTickMetadataRefreshInFlight;
  const flight = loadLiveTickPage({ page: 1, latest: true, metadataRefresh: true })
    // Marked loaded only where the count was applied (applyTradePage); an answer dropped by a reset is followed by
    // the read that reset asks for.
    .catch((error) => { console.warn("[live trades: refreshing the page metadata] failed", error); return null; })
    .finally(() => { if (liveTickMetadataRefreshInFlight === flight) liveTickMetadataRefreshInFlight = null; });
  liveTickMetadataRefreshInFlight = flight;
  return flight;
}

// Page 1 is the live screen, not a durable-history page: the bounded canonical hot snapshot (latest 100 rows) owns
// it, and returning from page 2/3 is a synchronous renderer-cache operation that never waits for FastAPI, SQLite or
// Parquet. Reading the same 100 rows from Parquet delayed first paint and could overwrite a newer WebSocket view
// with an older materialized page while the recorder was catching up. Only the pagination envelope is read, in the
// background.
function openHotFirstPage() {
  liveTickPageState.page = 1;
  liveTickPageState.loading = false;
  liveTickPageState.loaded = true;
  liveTickPageState.bootstrapReady = true;
  liveTickPageState.lastError = null;
  invalidateDetails();
  loadLiveTickPageMetadataOnce();
  return {
    ok: true,
    rows: [],
    page: 1,
    page_size: TRADE_DETAIL_PAGE_SIZE,
    total_rows: Number(liveTickPageState.totalCount || 0),
    total_pages: Math.max(1, Number(liveTickPageState.totalPages || 1)),
    snapshot_watermark: Number(liveTickPageState.snapshotWatermark || 0),
    classification: "PASS_CANONICAL_HOT_PAGE1",
  };
}

// Whether an answer still belongs to what is shown: the same target and generation -- for a page-count read, the same
// reset (an in-flight previous-session count must not land after a reset, but a page-1 open meanwhile changes
// nothing about the count; dropping it then left the count at 1 for good) -- the same futures identity or equity
// trading date.
// The answer is "" when it is current, otherwise why it is not (the page-count trace records it).
function staleTradePageReason(result, { target, generation, epoch, market, tradingDate, requestIdentityKey, metadataRefresh }) {
  if (!active) return "inactive";
  if (liveTickPageState.target !== target) return `target ${target} -> ${liveTickPageState.target}`;
  if (metadataRefresh ? epoch !== resetEpoch : !intent.isCurrent(generation)) return metadataRefresh ? "reset since sent" : "newer page request";
  if (!metadataRefresh && liveTickPageState.identityKey && liveTickPageState.identityKey !== requestIdentityKey) return "identity changed";
  if (market === "FUT") {
    const currentIdentityKey = getQuery().requestIdentityKey;
    if (requestIdentityKey && currentIdentityKey !== requestIdentityKey) return "futures identity changed";
    return !result?.identity || futuresIdentityMatches(result.identity) ? "" : "futures identity of the answer";
  }
  const currentDate = getEquityDate();
  const responseDate = String(result?.identity?.trading_date || "").slice(0, 10);
  if (tradingDate && currentDate && tradingDate !== currentDate) return `date asked ${tradingDate}, shown ${currentDate}`;
  return responseDate && currentDate && responseDate !== currentDate ? `date answered ${responseDate}, shown ${currentDate}` : "";
}

// A current answer into the pager state: the page's rows (a user page) or only the pagination bounds (metadata).
function applyTradePage(result, { target, nextPage, frozenWatermark, metadataRefresh, countTicket }) {
  if (!metadataRefresh) {
    liveTickPageState.page = Math.max(1, Number(result?.page) || nextPage);
    const sourceRows = Array.isArray(result?.rows) ? result.rows : [];
    liveTickPageState.rows = sourceRows.map((row) => materializedTradeToLiveTick(row, target));
  }
  if (countTicket > countShownFrom) {
    countShownFrom = countTicket;
    optimisticCount.rebase(liveTickPageState, { totalRows: result?.total_rows, totalPages: result?.total_pages,
      watermark: Number(result?.snapshot_watermark) || frozenWatermark || 0 });
  }
  if (!metadataRefresh) {
    optimisticCount.addKnownKeys(liveTickPageState.rows);
  } else {
    // Background metadata is allowed to update only pagination bounds. Never jump the user's current selection back
    // to result.page (the metadata endpoint is intentionally queried with page=1).
    const currentPage = Math.max(1, Number(liveTickPageState.page) || 1);
    if (currentPage > liveTickPageState.totalPages) liveTickPageState.page = liveTickPageState.totalPages;
  }
  liveTickPageState.snapshotWatermark = Math.max(
    Number(liveTickPageState.snapshotWatermark || 0),
    Number(result?.snapshot_watermark) || frozenWatermark || 0,
  );
  liveTickPageState.latencyMs = numberOrNull(result?.latency_ms) ?? liveTickPageState.latencyMs ?? 0;
  if (!metadataRefresh) {
    liveTickPageState.bootstrapReady = true;
    liveTickPageState.loaded = Boolean(result?.ok);
  }
  liveTickPageState.lastLoadedAt = Date.now();
  liveTickPageState.lastError = null;
  // A trade page is durable trades only: the book and the minute trend are the live view's. The page used
  // to apply a REST book and trend into the page caches -- fields this read has not returned for a while.
  // Any durable page read carries the count: page 1 then needs no read of its own for this symbol.
  if (result?.ok) liveTickMetadataLoadedFor = target;
}

async function loadLiveTickPage({ page = 1, latest = false, metadataRefresh = false } = {}) {
  // TradeDetail page performance trace deliberately separates:
  //   API round-trip -> row mapping/state -> renderer/paint.
  // metadata-only background reconciliation is excluded from visible-page timing.
  const perfStartedAt = !metadataRefresh ? performance.now() : 0;
  const target = getQuery().target;
  if (!active || !target) return null;
  if (liveTickPageState.target !== target) resetLiveTickPageState(target);

  // Metadata refresh is a separate state lane. It must never supersede an
  // explicit user page request or toggle the visible table into loading state.
  const generation = metadataRefresh ? intent.generation : intent.issue(target).generation;
  const epoch = resetEpoch;
  const countTicket = ++countReadsSent;
  const nextPage = Math.max(1, Number(page) || 1);
  if (!metadataRefresh && nextPage === 1) return openHotFirstPage();

  const { market, session, tradingDate, actualContract, requestIdentityKey } = getQuery();
  // A stock's trades are one trading day's, and FastAPI answers only a read that names it. Before Market Runtime's
  // session has named the day there is nothing to read; the session naming it resets this pager, which reads then.
  if (market === "STK" && !tradingDate) return null;
  if (!metadataRefresh) {
    liveTickPageState.loading = true;
    liveTickPageState.lastError = null;
    if (!liveTickPageState.rows.length) invalidateDetails();
  }
  if (!metadataRefresh) liveTickPageState.identityKey = requestIdentityKey;
  const frozenWatermark = latest || nextPage === 1 ? 0 : Number(liveTickPageState.snapshotWatermark || 0);
  const params = tradePageQuery({ market, code: target, session, tradingDate, actualContract, page: nextPage, watermark: frozenWatermark, metadataOnly: metadataRefresh });
  const controller = new AbortController();
  requests.add(controller);
  try {
    // Exactly one HTTP request per invocation. The daemon returns the existing
    // sparse-index page immediately and repairs any missing Evidence tail in a
    // background same-key single-flight. Repeated 8s client timeouts must never
    // start duplicate pandas/Parquet catch-up jobs during restart.
    const result = await pageGet(`/api/trade-detail/page?${params.toString()}`, {
      signal: controller.signal,
      query: params.toString(),
    });
    const perfApiDoneAt = !metadataRefresh ? performance.now() : 0;
    const stale = staleTradePageReason(result, { target, generation, epoch, market, tradingDate, requestIdentityKey, metadataRefresh });
    const countRead = metadataRefresh ? { target, trading_date: tradingDate, ok: Boolean(result?.ok),
      answered_pages: Number(result?.total_pages) || 0, coverage: result?.coverage || null, error: result?.ok ? null : result?.error || null } : null;
    if (stale) {
      if (countRead) recordPageCountRead({ ...countRead, outcome: "dropped", reason: stale });
      return metadataRefresh ? null : result;
    }
    const shownBounds = `${liveTickPageState.totalCount}|${liveTickPageState.totalPages}|${liveTickPageState.page}`;
    applyTradePage(result, { target, nextPage, frozenWatermark, metadataRefresh, countTicket });
    // A page-count read changes only the page selector, and nothing else redraws the list for it: after hours no trade
    // arrives, so a count landing after the list was drawn (a UI-only reopen, where every service answers at once)
    // stayed at 1 / 1. A page read redraws in its finally block.
    if (metadataRefresh && shownBounds !== `${liveTickPageState.totalCount}|${liveTickPageState.totalPages}|${liveTickPageState.page}`) invalidateDetails();
    if (countRead) recordPageCountRead({ ...countRead, outcome: "applied", held_pages: liveTickPageState.totalPages, ticket_newer: countTicket >= countShownFrom });
    const perfMapDoneAt = !metadataRefresh ? performance.now() : 0;

    if (!metadataRefresh) {
      // Tick details is invalidated once in the finally block after the
      // request has completed and loading has been cleared.
      logTradePagePerfTrace({
        target, identityKey: requestIdentityKey,
        page: Math.max(1, Number(liveTickPageState.page) || nextPage),
        rowsCount: liveTickPageState.rows.length, result,
        perfStartedAt, perfApiDoneAt, perfMapDoneAt, perfInvalidateAt: performance.now(), traceFrame,
      });
    }
    return result;
  } catch (error) {
    // A read this pager aborted itself (resetLiveTickPageState: another symbol or session) was dropped, not failed.
    if (metadataRefresh) {
      recordPageCountRead(controller.signal.aborted
        ? { target, outcome: "dropped", reason: "pager_reset" }
        : { target, outcome: "failed", reason: error?.name || null, error: error?.message || String(error) });
    }
    if (!active || !intent.isCurrent(generation) || target !== liveTickPageState.target) {
      // not an error: a read this pager aborted itself, or a page-count read (recorded above); a superseded page read
      // that failed on its own is still recorded.
      if (!controller.signal.aborted && !metadataRefresh) console.warn("[TRADE PAGE] a superseded load failed", { target }, error);
      return null;
    }
    if (!metadataRefresh) {
      logTradePagePerfFailure({ target, page: Math.max(1, Number(page) || 1), perfStartedAt, error });
    }
    console.warn("[TRADE PAGE] load failed", error);
    if (!metadataRefresh) {
      liveTickPageState.lastError = error?.message || String(error);
    }
    return null;
  } finally {
    requests.delete(controller);
    if (active && !metadataRefresh && intent.isCurrent(generation)) {
      liveTickPageState.loading = false;
      invalidateDetails();
    }
  }
}



  return {
    state: liveTickPageState, reset: resetLiveTickPageState, load: loadLiveTickPage,
    count: applyOptimisticTradePageCount,
    activate() { active = true; },
    dispose() { active = false; resetLiveTickPageState(); },
    hydrateClosed(target, trades, metadata = {}) {
      resetLiveTickPageState(target);
      Object.assign(liveTickPageState, { rows: trades.slice(0, TRADE_DETAIL_PAGE_SIZE),
        totalCount: Number(metadata.total_rows ?? trades.length),
        totalPages: Math.max(1, Math.ceil(Number(metadata.total_rows ?? trades.length) / TRADE_DETAIL_PAGE_SIZE)),
        snapshotWatermark: Number(metadata.snapshot_watermark ?? 0), loaded: true, bootstrapReady: true });
    },
    diagnostics() { return { active, requests: requests.size, frames: frames.size, countedKeys: optimisticCount.size }; },
  };
}
export { TRADE_DETAIL_PAGE_SIZE };
