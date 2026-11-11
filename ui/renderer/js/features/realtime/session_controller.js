// The 即時報價 page's session controller: applies Market Runtime's session (session.current / session.rollover: the
// equity date and phase, the 期貨走勢 identities) and the status's market-data availability, and makes the resets a
// session boundary needs; the 期貨走勢 tab buttons.
import { createRealtimeSessionLifecycle } from "./session_lifecycle.js";
import { appState } from "../../core/state.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { sharedStatusGet } from "../../core/api.js";
import { runUiTask } from "../../core/ui_task.js";
import { setRealtimeFocusSymbol, subscribeRealtimeConnectionState, subscribeRealtimeSession, subscribeRealtimeSessionRollover } from "../../market_data/realtime.js";
import { renderRealtimeQuoteTable } from "./realtime_presentation.js";
import { replaceSignalRows } from "./live_signals.js";
import { loadTxfTrendSnapshot, orderbookDeltaTokens, reconcileCanonicalViews } from "./canonical_view_owner.js";
import { activeTrendTarget, marketPanelUiState, nextRealtimeVisibleEpoch, realtimePageVisible, selectedStockCode, viewResources } from "./live_page_state.js";
import { resetLiveTickPageState } from "./live_view_models.js";
import { invalidateLiveTrendComponents, renderTxfAsPrimary } from "./live_redraw.js";
import { activeTxfSession, commitTxfDisplayContext, equityDateListeners, equityTradingDate, marketDataAvailable, marketDataAvailableFromStatus, marketDataFactsFromStatus, realtimeDisplayContext, recomputeFreshnessBanner, setActiveTxfSession, setMarketDataAvailable, setMarketDataFacts, setRealtimeDisplayContext, setStockFuturesSession } from "./session_state.js";
import { applyWatchPageToRealtime } from "./selection_controller.js";

function clearEquitySessionEphemeralState(reason = "EQUITY_SESSION_RESET") {
  // The stocks' trades, book, trend and summary are their views' (rebound on the new date); nothing to clear here.
  orderbookDeltaTokens.clear();
  // The analysis rows are session state too: if a rollover left them, the new session's snapshots would
  // merge on top, and any code that had a row yesterday and none today would keep displaying
  // yesterday's 量變 / 1m3m5m indefinitely.
  const staleSignalCodes = [...appState.signalsByCode.keys()]
    .map((code) => String(code || "").trim().toUpperCase())
    .filter((code) => code && code !== "TXFR1");
  if (staleSignalCodes.length) {
    replaceSignalRows({ removedCodes: staleSignalCodes, render: false });
  }
  // TAIEX rolls with stocks: its view is rebound on the new date and holds the new session (nothing cached here).
  // The selected stock's 成交明細 pages were reset with the date (applyRealtimeSession).
  const selected = String(selectedStockCode() || "").trim().toUpperCase();
  if (realtimePageVisible) {
    renderRealtimeQuoteTable();
    realtimeContext.dataSource.invalidate("tickDetails", { symbol: selected, reason });
    realtimeContext.dataSource.invalidate("orderbook", { symbol: selected, reason });
    realtimeContext.dataSource.invalidate("tradeFlow", { symbol: selected, reason });
    realtimeContext.dataSource.invalidate("priceFlow", { symbol: selected, reason });
    invalidateLiveTrendComponents({ symbol: "TAIEX", reason }, ["marketTrend"]);
    if (selected) invalidateLiveTrendComponents({ symbol: selected, reason }, ["stockTrend"]);
  }
  return true;
}

// 個股走勢's 日／夜／全 (台指期／小台指): the partitions it draws follow, and it redraws.
export function bindStockFuturesSessionControl() {
  if (document.documentElement.dataset.stockFuturesSessionDelegation === "1") return;
  viewResources.mark(document.documentElement, "stockFuturesSessionDelegation");
  viewResources.listen(document, "click", (event) => {
    const button = event.target.closest?.("[data-stock-futures-session]");
    if (!button) return;
    setStockFuturesSession(String(button.dataset.stockFuturesSession || ""));
    reconcileCanonicalViews("STOCK_FUTURES_SESSION");
    invalidateLiveTrendComponents({ symbol: selectedStockCode() }, ["stockTrend"]);
  });
}

export function bindTxfSessionControl() {
  if (document.documentElement.dataset.txfSessionDelegation === "1") return;
  viewResources.mark(document.documentElement, "txfSessionDelegation");
  viewResources.listen(document, "click", (event) => {
    const button = event.target.closest?.("[data-txf-session]");
    if (!button) return;
    const session = String(button.dataset.txfSession || "full").toLowerCase();
    if (!["day", "night", "full"].includes(session)) return;
    if (session === activeTxfSession) return;
    setActiveTxfSession(session);
    // TXFR1 is Quote-only. DAY/NIGHT/FULL switch only the futures trend
    // identity; it must never steal/reset the selected stock's orderbook or
    // TradeDetail owner.
    marketPanelUiState.setFuturesSession(session, { reason: "USER_CLICK", source: "txf_session_control", trigger: "session_button" });
    invalidateLiveTrendComponents({ symbol: "TXFR1", session }, ["futuresTrend"]);
    void runUiTask("REALTIME_TXF_SESSION_SWITCH", async () => {
      await syncRealtimeSessionOwnershipFromStatus();
      if (session !== activeTxfSession) return;
      await loadTxfTrendSnapshot(session);
      if (session !== activeTxfSession) return;
      if (activeTrendTarget() === "TXF") renderTxfAsPrimary();
      else invalidateLiveTrendComponents({ symbol: "TXFR1", session: activeTxfSession }, ["futuresTrend"]);
    });
  });
}

function bindEquityViews() {
  const selected = String(selectedStockCode() || "").trim().toUpperCase();
  setRealtimeFocusSymbol(selected, { force: true });
  // The session authority is a prerequisite of every equity view: the owner binds what it now names.
  reconcileCanonicalViews("SESSION_AUTHORITY");
  if (realtimePageVisible) applyWatchPageToRealtime();
  return selected;
}

// Market Runtime's session (pushed on every connection and with every rollover): commit the identity before any
// view subscribes on it. Its equity date moves when A takes the new session on its first print -- the 盤前 the
// status line shows -- and that is when the previous session's 量變, 1m3m5m and 成交明細 leave the page.
function applyRealtimeSession(session) {
  const previousEquityDate = equityTradingDate();
  setRealtimeDisplayContext(session && typeof session === "object" ? session : null);
  const nextEquityDate = equityTradingDate();
  const dateMoved = Boolean(nextEquityDate) && previousEquityDate !== nextEquityDate;
  if (dateMoved) {
    for (const listener of [...equityDateListeners]) {
      try { listener(nextEquityDate); } catch (error) { console.warn("[SESSION AUTHORITY] listener failed", error); }
    }
  }
  const identityChanged = commitTxfDisplayContext(realtimeDisplayContext || {}, "ROLLOVER");
  if (dateMoved) {
    // The selected stock's 成交明細 pages are the shown day's: a new day (or the first one named, after the pager
    // waited without one) resets them, and the reset reads the day's page count.
    const shown = String(selectedStockCode() || "").trim().toUpperCase();
    if (shown && shown !== "TXFR1") resetLiveTickPageState(shown);
    if (previousEquityDate) clearEquitySessionEphemeralState("SESSION_ROLLOVER");
    const selected = bindEquityViews();
    if (marketDataAvailable) {
      // Every panel's view was rebound: each redraws its lifecycle (reconnecting -> live) as well as its data.
      nextRealtimeVisibleEpoch();
      realtimeContext.dataSource.invalidateAll({ symbol: selected, reason: previousEquityDate ? "SESSION_ROLLOVER" : "SESSION_AUTHORITY" });
    }
  }
  // DAY/NIGHT buttons are explicit presentation state: only the selected session moving to another trading date or
  // contract resets the page state bound to it.
  if (identityChanged && activeTxfSession !== "full") resetLiveTickPageState("TXFR1");
  // The owner rebinds exactly when the partitions the TXF identity names change, and keeps a view still wanted.
  reconcileCanonicalViews("TXF_IDENTITY");
  recomputeFreshnessBanner();
}

function applyRealtimeStatus(status) {
  const available = marketDataAvailableFromStatus(status);
  setMarketDataFacts(marketDataFactsFromStatus(status));
  if (!available) {
    // A transport/daemon outage is not a session boundary: the last valid frame stays until a real rollover or an
    // explicit symbol/session change.
    setMarketDataAvailable(false);
  } else if (!marketDataAvailable) {
    setMarketDataAvailable(true);
    if (equityTradingDate()) {
      const selected = bindEquityViews();
      nextRealtimeVisibleEpoch();
      realtimeContext.dataSource.invalidateAll({ symbol: selected, reason: "MARKET_DATA_RECONNECTED" });
    }
  }
  recomputeFreshnessBanner();
}

export const realtimeSessionLifecycle = createRealtimeSessionLifecycle({
  // The same /api/status read the dock uses (core/api.js sharedStatusGet): one request serves both.
  getStatus: () => sharedStatusGet("/api/status", 1500), applyStatus: applyRealtimeStatus,
  onDisconnected: () => { setMarketDataAvailable(false); recomputeFreshnessBanner(); },
  isVisible: () => realtimePageVisible, subscribeConnection: subscribeRealtimeConnectionState,
  // The session is Market Runtime's push; readiness in between from the dock's own status read (app.js).
  subscribeSession: subscribeRealtimeSession, applySession: applyRealtimeSession,
  subscribeRollover: subscribeRealtimeSessionRollover,
  subscribeStatus: (listener) => {
    const handler = (event) => listener(event?.detail);
    window.addEventListener("stock-monitor:status", handler);
    return () => window.removeEventListener("stock-monitor:status", handler);
  },
});
export const syncRealtimeSessionOwnershipFromStatus = realtimeSessionLifecycle.sync;
export const startRealtimeSessionSync = realtimeSessionLifecycle.start;

function invalidateTxfEphemeralLiveState(reason = "SESSION_ROLLOVER") {
  resetLiveTickPageState("TXFR1");
  invalidateLiveTrendComponents({ symbol: "TXFR1", reason }, ["trendChart", "futuresTrend"]);
  realtimeContext.dataSource.invalidate("tickDetails", { symbol: "TXFR1", reason });
  realtimeContext.dataSource.invalidate("orderbook", { symbol: "TXFR1", reason });
  realtimeContext.dataSource.invalidate("tradeFlow", { symbol: "TXFR1", reason });
  realtimeContext.dataSource.invalidate("priceFlow", { symbol: "TXFR1", reason });
}
