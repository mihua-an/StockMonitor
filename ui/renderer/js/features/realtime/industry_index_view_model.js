// 「產業指數」's trend: the current industry index (industry_index_store.js) drawn by the shared trend component (variant
// "sector") from that index's Market Runtime view (market IDX, its Shioaji code). The breadth row is the index's own
// constituents -- 上漲／下跌／平盤／漲停／跌停 from its QuoteIdxV1 summary -- never the exchange-wide counts.
import { breadthFromSummary } from "../../core/market_breadth_store.js";
import { numberOrNull } from "../../core/numbers.js";
import { withMarketRead } from "../../core/market_read_adapters.js";
import { trendMetrics } from "../../core/trend_metrics.js";
import { displayQuote } from "../../core/auction_price.js";

/** The view the current index is read from; null without an index or before the session authority names the date. */
export function industryIndexViewSpec(current, tradingDate) {
  const code = current?.status === "index" ? String(current.index?.code || "").trim().toUpperCase() : "";
  const date = String(tradingDate || "").slice(0, 10);
  if (!code || !date) return null;
  return { market: "IDX", code, trading_date: date, session: "DAY", channels: ["summary", "trend"] };
}

function emptyText(current, hasPoints) {
  if (current?.status === "unmapped") return "無對應產業指數";
  if (current?.status === "failed") return "讀取產業指數失敗";
  if (current?.status !== "index") return "請在「Shioaji產業指數」選擇產業指數";
  return hasPoints ? "" : "尚無產業指數走勢資料";
}

/**
 * The trend component's view model. `state` is the view's snapshot ({ summary, trend }), `frame` the page's display
 * frame for it (canonicalDisplayFrame), `marketRead` the read model of the same view.
 */
export function industryIndexTrendViewModel({ current = null, state = null, marketRead = null, frame = {} } = {}) {
  const indexed = current?.status === "index";
  const summary = indexed ? (state?.summary || {}) : {};
  const points = indexed && Array.isArray(state?.trend) ? state.trend : [];
  const reference = displayQuote(summary).reference;
  const current_ = numberOrNull(summary.current ?? summary.price);
  const high = numberOrNull(summary.high);
  const low = numberOrNull(summary.low);
  const open = numberOrNull(summary.open);
  const stock = String(current?.stock || "");
  // Without an index there is no view: the model is built from this view model's own (empty) channels.
  return withMarketRead({
    ...(indexed ? frame : {}),
    marketRead: indexed ? marketRead : null,
    points,
    prevClose: reference,
    openPrice: open,
    currentPrice: current_,
    displayName: indexed ? current.index.name : current?.status === "unmapped" ? `${stock} 無對應產業指數`
      : current?.status === "failed" ? `${stock} 產業指數` : "產業指數",
    displayCode: indexed ? current.index.code : "--",
    symbol: indexed ? current.index.code : "",
    breadth: indexed ? breadthFromSummary(summary) : {},
    stockInfo: { prevClose: reference, open, high, low },
    metrics: {
      limitUp: null,
      limitDown: null,
      ...trendMetrics({ change: summary.change, changePct: summary.change_pct, amplitude: summary.amplitude }),
    },
    emptyOverlayText: emptyText(current, points.length > 0),
    options: { adapterType: "index" },
  });
}
