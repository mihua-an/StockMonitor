// The 即時報價 page's redraw scheduling: which trend and panel components a change invalidates, coalesced to one draw
// per frame on the shared render scheduler.
import { realtimeContext } from "../../core/dashboard_context.js";
import { sendRealtimeClientMetric } from "../../market_data/realtime.js";
import { realtimeRenderScheduler } from "./realtime_render_scheduler.js";
import { activeTxfSession } from "./session_state.js";
import { activeTrendTarget, requestAnimationFrame, selectedStockCode } from "./live_page_state.js";



export function renderTxfAsPrimaryNow() {
  // The active TrendChartComponent is the sole owner of the futures title,
  // price and change DOM.  The former imperative writes here raced the
  // component update and alternated `change / pct` with `change (pct)`.
  invalidateLiveTrendComponents({ symbol: "TXFR1", session: activeTxfSession }, ["trendChart", "futuresTrend"]);
}

export function renderTxfAsPrimary() { scheduleLiveTrendDraw(); }

export function renderTaiexAsPrimaryNow() {
  invalidateLiveTrendComponents({ symbol: "TAIEX" }, ["trendChart", "marketTrend"]);
}

function scheduleLiveTrendDraw(force = false) {
  realtimeRenderScheduler.scheduleFrame("shioaji-live-trend", () => {
    if (activeTrendTarget() === "TAIEX") {
      renderTaiexAsPrimaryNow();
      return;
    }
    if (activeTrendTarget() === "TXF") {
      renderTxfAsPrimaryNow();
      return;
    }
    invalidateLiveTrendComponents({ symbol: selectedStockCode() }, ["trendChart", "stockTrend"]);
  }, { force });
}

/** Coalesce DOM-heavy widgets and reserve main-thread time for pointer/hover. */
export function scheduleLiveComponentInvalidation(componentId, request = {}) {
  const id = String(componentId || "");
  if (!id || realtimeContext.dataSource.listenerCount(id) <= 0) return;
  realtimeRenderScheduler.scheduleFrame(
    `shioaji-component:${id}`,
    () => {
      const started = performance.now();
      realtimeContext.dataSource.invalidate(id, request);
      const renderMs = performance.now() - started;
      const detail = { component: id, symbol: String(request?.symbol || "").toUpperCase(), source: "shared_render_scheduler", scheduler_pending_count: realtimeRenderScheduler.pendingCount() };
      sendRealtimeClientMetric("component_render", renderMs, detail);
      requestAnimationFrame(() => {
        sendRealtimeClientMetric("component_paint", performance.now() - started, detail);
      });
    },
  );
}

export function renderTaiexAsPrimary() {
  scheduleLiveTrendDraw();
}

export function invalidateLiveTrendComponents(request = {}, componentIds = ["trendChart", "marketTrend", "futuresTrend", "stockTrend"]) {
  for (const componentId of componentIds) {
    scheduleLiveComponentInvalidation(componentId, request);
  }
}
