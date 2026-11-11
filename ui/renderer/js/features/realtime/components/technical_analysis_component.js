import { TrendChartComponent } from "../../../core/components/trend_chart_component.js";
import { expandPickerHtml } from "../../../core/components/expand_picker.js";
import { popoutButtonHtml } from "../../../core/components/popout_button.js";
import { detachedWindowFor } from "../../../core/detached_windows.js";
import { TECHNICAL_TIMEFRAMES as TIMEFRAMES } from "../technical_series.js";
import { candleStageHtml, storedTimeframe, TechnicalCandles } from "../technical_candles.js";

/**
 * 技術分析: the 個股走勢 surface -- same header, info rows and 上漲/下跌 breadth, because it IS a mounted
 * 個股走勢 component -- with candlesticks in place of the line: minute, daily, weekly and monthly timeframes, the focused
 * bar's 開/高/低/收/量 beside it, wheel to scroll, Ctrl + wheel to zoom, a crosshair and a volume overlay.
 *
 * The candles are technical_candles.js, the same as the detached window's (technical_window_component.js).
 */

function toolbarHtml(timeframe, popout) {
  return `<div class="technical-analysis-toolbar" data-role="ta-toolbar">
    ${expandPickerHtml({ options: TIMEFRAMES, current: timeframe }, 'data-role="ta-timeframe" aria-label="K 棒時間尺度"')}
    <div class="technical-analysis-ohlcv" data-role="ta-ohlcv"></div>${popout}
  </div>`;
}

export class TechnicalAnalysisComponent {
  constructor() {
    this.surface = null;
    this.host = null; this.context = null; this.candles = null; this.cleanup = [];
  }

  // The chart and history live in the candles; the tests and the page read them here.
  get chart() { return this.candles?.chart || null; }
  get history() { return this.candles?.history || null; }

  mount({ host, hostType = "inline", context, actionsHost = null }) {
    this.host = host; this.context = context;
    // The 個股走勢 surface (歷史回放: the replay's own trend view), on a slot id of its own. The candles come from
    // context.services.technicalAnalysis in both modes.
    this.dataKey = context?.mode === "replay" ? "trendChart" : "stockTrend";
    // The surface without its line chart: the candles below are the only chart here (N03).
    this.surface = new TrendChartComponent({ dataKey: this.dataKey, variant: "stock", lineChart: false });
    this.surface.mount({ host, context, hydrate: false, slotId: "technicalAnalysis" });
    const root = host.querySelector(".trend-chart");
    root?.classList.add("technical-analysis");
    const stage = root?.querySelector?.(".trend-chart-stage");
    if (!stage) return;
    // A remount may get back the parked surface of the last one, K-line nodes included.
    root.querySelectorAll('[data-role^="ta-"]').forEach((node) => node.remove());
    const canPopOut = (context?.mode || "live") === "live" && hostType === "inline" && detachedWindowFor("technicalWindow") !== null;
    const popout = canPopOut ? popoutButtonHtml("ta-popout") : "";
    stage.insertAdjacentHTML("beforebegin", toolbarHtml(storedTimeframe(), popout));
    stage.insertAdjacentHTML("beforeend", candleStageHtml());
    this.candles = new TechnicalCandles({ root, stage, service: context?.services?.technicalAnalysis });
    const button = root.querySelector('[data-role="ta-popout"]');
    if (button) {
      const open = () => this.#openDetached();
      button.addEventListener("click", open);
      this.cleanup.push(() => button.removeEventListener("click", open));
      if (actionsHost) actionsHost.replaceChildren(button);
    }
    // The selected symbol, else the code of the 個股走勢 view this tab wraps: a stock restored at App start can be
    // drawn by 個股走勢 before anything publishes it to the symbol store, and this tab then followed "" -- it never
    // subscribed and showed 尚無 K 棒資料 until it was mounted a second time.
    let viewCode = "";
    const follow = () => this.candles?.follow(String(context?.symbolStore?.getSelectedSymbol?.() || viewCode || "").trim().toUpperCase());
    this.cleanup.push(context?.symbolStore?.subscribe?.(follow) || (() => {}));
    this.cleanup.push(context?.dataSource?.subscribe?.(this.dataKey, (vm) => {
      viewCode = String(vm?.symbol || vm?.displayCode || viewCode || "");
      follow();
    }) || (() => {}));
    // The session authority naming (or changing) the trading date is the readiness transition this tab binds on.
    // It replaces a 2 s look that ran until bound.
    this.cleanup.push(context?.services?.technicalAnalysis?.onKeyChange?.(follow) || (() => {}));
    follow();
  }

  #openDetached() {
    const symbol = String(this.candles?.code || "").trim();
    if (!symbol || typeof window.desktopAPI?.openDetachedView !== "function") return;
    window.desktopAPI.openDetachedView({
      version: 1, componentId: "technicalWindow", contextMode: "live",
      contextId: String(this.context?.id || "live:realtime"), symbolMode: "pinned", symbol,
    }).catch((error) => console.warn("[technical analysis: opening the detached window] failed", error));
  }

  update(vm) { this.surface?.update(vm); }
  resize() { this.surface?.resize?.(); this.candles?.resize(); }

  destroy() {
    for (const fn of this.cleanup.splice(0)) try { fn(); } catch (error) { console.warn("[technical analysis: cleanup] failed", error); }
    this.candles?.destroy(); this.candles = null;
    this.surface?.destroy(); this.surface = null;
    this.host = null; this.context = null;
  }
}
