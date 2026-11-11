// The markup of every trend surface the component builds: the Taiwan and replay shells, their control row, the
// secondary information rows (stock facts, exchange breadth), the prediction tape and the event switch.

import { benchmarkOverlayControlsMarkup } from "../benchmark_overlay_controls.js";
import { stockTrendEventMarkersVisible } from "../event_markers.js";
import { getTrendFooterHorizons } from "../trend_footer_horizons.js";
import { productQuoteHeaderShell } from "./product_quote_header.js";
import { directionGlyphHtml } from "./direction_glyph.js";

// A manual surface: the chart alone, for a page that draws into it (帳務's pair replay). The Futu 個股走勢
// ("us-stock") is a complete surface of its own: the shared header with the Futu code box, the session buttons in the
// control row, the chart, and the two lines of four of the Taiwan 個股走勢 -- a US stock has no 漲停／跌停, so those two
// places show 總量 and 均價.
export function shell(variant = "auto") {
  if (variant === "us-stock") {
    return `<div class="trend-chart trend-variant-us-stock">
    ${productQuoteHeaderShell({ className: "trend-titlebar trend-us-titlebar", primaryRole: "trend-name", secondaryRole: "trend-code", centerRole: "trend-center", priceRole: "trend-price", changeRole: "trend-change", search: "futu" })}
    ${controlRowShell(variant)}
    <div class="trend-chart-stage trend-area">
      <canvas data-role="trend-canvas"></canvas>
    </div>
    <div class="trend-info-lines trend-us-info">
      <div class="trend-info-row trend-stock-metrics">
        <div>昨收 <b data-metric="prev">--</b></div><div>最高 <b data-metric="high">--</b></div><div>漲幅 <b data-metric="change-pct">--</b></div><div>總量 <b data-metric="volume">--</b></div>
        <div>開盤 <b data-metric="open">--</b></div><div>最低 <b data-metric="low">--</b></div><div>振幅 <b data-metric="amplitude">--</b></div><div>均價 <b data-metric="avg">--</b></div>
      </div>
    </div>
  </div>`;
  }
  return `<div class="trend-chart trend-variant-${variant}">
    <div class="trend-chart-stage trend-area">
      <canvas data-role="trend-canvas"></canvas>
    </div>
  </div>`;
}

/**
 * The information rows under the chart belong to the VARIANT, not to the slot.
 *
 * 個股走勢 and 技術分析 (which wraps 個股走勢) share one order:
 *   prediction -- A分上漲 | A分下跌 | B分上漲 | B分下跌 (the two horizons chosen in settings)
 *   stock      -- 昨收 最高 漲幅 漲停 / 開盤 最低 振幅 跌停 (two lines of four), 個股走勢
 *   session    -- 昨收 最高 漲幅 / 開盤 最低 振幅 (two lines of three), 期貨走勢 and 加權走勢: no limit prices
 *   market     -- 上漲 下跌 漲停 跌停 平盤, the exchange-wide breadth every Shioaji trend shows
 * 期貨走勢 and 加權走勢 have no model predictions (the models are per stock): their session facts, then the
 * breadth row. 產業指數 ("sector") has the same two rows, but its breadth row shows the counts of that index's own
 * constituents, from its own quote (ownBreadth): never the exchange-wide figure.
 *
 * data-secondary-row is what lets _syncSecondaryInfoRow() tell an adopted set of rows of the wrong
 * shape (a reused slot, or a hydrated static surface) from a correct one. "market" names the row's
 * KIND -- the exchange breadth tape -- not the variant that may display it.
 */
export function secondaryRowKinds(variant = "auto") {
  if (variant === "stock") return ["prediction", "stock", "market"];
  if (variant === "futures" || variant === "market" || variant === "sector") return ["session", "market"];
  return ["market"];
}

// The variants whose breadth row is their own index's counts (carried by their view model), not the exchange's.
export function ownBreadth(variant = "auto") {
  return variant === "sector";
}

export function secondaryInfoRowShell(kind = "market") {
  if (kind === "prediction") return predictionTapeHtml();
  if (kind === "stock") return stockInfoTapeHtml();
  if (kind === "session") return sessionInfoTapeHtml();
  return `<div class="trend-market-metrics" data-secondary-row="market">
        <div>上漲 <b data-role="breadth-up" class="metric-breadth-up">--</b></div><div>下跌 <b data-role="breadth-down" class="metric-breadth-down">--</b></div><div>漲停 <b data-role="breadth-limit-up" class="metric-breadth-limit-up">--</b></div><div>跌停 <b data-role="breadth-limit-down" class="metric-breadth-limit-down">--</b></div><div>平盤 <b data-role="breadth-flat" class="metric-breadth-flat">--</b></div>
      </div>`;
}

// The product's own session facts, two lines of four that keep their places:
//   昨收 | 最高 | 漲幅 | 漲停
//   開盤 | 最低 | 振幅 | 跌停
export function stockInfoTapeHtml() {
  return `<div class="trend-info-row trend-stock-metrics" data-secondary-row="stock">
        <div>昨收 <b data-role="stock-prev-close" class="price-flat">--</b></div><div>最高 <b data-role="stock-high" class="price-flat">--</b></div><div>漲幅 <b data-role="metric-change">--</b></div><div>漲停 <b data-role="metric-limit-up">--</b></div>
        <div>開盤 <b data-role="stock-open" class="price-flat">--</b></div><div>最低 <b data-role="stock-low" class="price-flat">--</b></div><div>振幅 <b data-role="metric-amplitude">--</b></div><div>跌停 <b data-role="metric-limit-down">--</b></div>
      </div>`;
}

// 期貨走勢 / 加權走勢: the same facts without limit prices, two lines of three:
//   昨收 | 最高 | 漲幅
//   開盤 | 最低 | 振幅
export function sessionInfoTapeHtml() {
  return `<div class="trend-info-row trend-stock-metrics trend-session-info" data-secondary-row="session">
        <div>昨收 <b data-role="stock-prev-close" class="price-flat">--</b></div><div>最高 <b data-role="stock-high" class="price-flat">--</b></div><div>漲幅 <b data-role="metric-change">--</b></div>
        <div>開盤 <b data-role="stock-open" class="price-flat">--</b></div><div>最低 <b data-role="stock-low" class="price-flat">--</b></div><div>振幅 <b data-role="metric-amplitude">--</b></div>
      </div>`;
}

function escapeText(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return String(value ?? "").replace(/[&<>]/g, (ch) => entities[ch]).split("\"").join("&quot;").split("'").join("&#39;");
}

// The prediction row: four fixed cells, A分上漲 | A分下跌 | B分上漲 | B分下跌, each shown as its minutes and a trend glyph
// (components/direction_glyph.js). A and B are the two model horizons chosen in
// settings (core/trend_footer_horizons.js). A cell whose horizon the symbol carries no prediction for shows "--"
// rather than disappearing, so nothing shifts.
function predictionCellHtml(slot, direction, horizons = getTrendFooterHorizons()) {
  return `<div data-role="prediction-cell" data-slot="${slot}" data-direction="${direction}">`
    + `<span data-role="prediction-name"><span data-role="prediction-label">${horizons[slot]}</span>${directionGlyphHtml(direction)}</span>`
    + ` <b data-role="metric-${direction}-${horizons[slot]}m" class="prediction-${direction}">--</b></div>`;
}

export function predictionTapeHtml() {
  const horizons = getTrendFooterHorizons();
  return `<div class="trend-info-row trend-stock-metrics" data-secondary-row="prediction">
        ${predictionCellHtml(0, "up", horizons)}${predictionCellHtml(0, "down", horizons)}${predictionCellHtml(1, "up", horizons)}${predictionCellHtml(1, "down", horizons)}
      </div>`;
}

// The event switch, bottom-right of the chart: 個股走勢's 「盤中事件」 and 歷史回放's 「交易時段事件 / 盤中時段事件」
// are this one control.
export function eventMarkerToggleHtml(visible = stockTrendEventMarkersVisible(), {
  role: roleName = "event-marker-toggle", label = "事件", wide = false,
} = {}) {
  // `wide`: as wide as its row, the label at the start and the switch at the end (Workspace's dock tools).
  return `<button type="button" data-role="${escapeText(roleName)}" class="trend-event-marker-toggle${wide ? " wide" : ""}${visible ? " active" : ""}" `
    + `aria-pressed="${visible ? "true" : "false"}">`
    + `<span class="trend-event-marker-toggle-label">${escapeText(label)}</span>`
    + `<span class="trend-event-marker-toggle-track" aria-hidden="true"><span class="trend-event-marker-toggle-thumb"></span></span></button>`;
}

// The controls a chart needs, never on top of the chart: 個股走勢 -- 盤中事件 and 疊圖 (加權 / 期貨); 期貨走勢 -- 日 / 夜 /
// 全; Futu 個股走勢 -- its sessions. 加權走勢 has none. data-trend-controls names which set it is: a reconfigured surface
// swaps the whole set for the one its new variant builds. Where the set sits is _placeControlRow()'s (user 10-16):
// 期貨走勢 in its header, the others in the slot's tab bar, and a surface without a tab bar in a row above the chart.
export function controlRowShell(variant = "auto", showToolbar = false) {
  const row = (key, content) => `<div class="trend-control-row" data-role="trend-control-row" data-trend-controls="${key}">${content}</div>`;
  if (variant === "stock") {
    // 日／夜／全 shows only for 台指期／小台指 (the view model's futuresSessionControl): its buttons are drawn when synced.
    return row(showToolbar ? "stock-overlay" : "stock", `<div data-role="stock-futures-session" class="pill-switch trend-session-control trend-session-control-short" role="group" aria-label="期貨走勢時段" hidden></div>`
      + `${eventMarkerToggleHtml()}${showToolbar ? benchmarkOverlayControlsMarkup() : ""}`);
  }
  if (variant === "futures") {
    // The buttons are the session rail's (core/trend_session_control.js), rendered when the surface syncs it.
    return row("futures", `<div data-role="txf-session-control" class="pill-switch trend-session-control trend-session-control-short" role="group" aria-label="台指期走勢時段"></div>`);
  }
  if (variant === "us-stock") {
    return row("us-stock", `<div data-role="session-control" class="pill-switch trend-session-control" role="group" aria-label="Futu 個股走勢時段"></div>`);
  }
  return "";
}

export function taiwanTrendShell(variant = "auto", showToolbar = false) {
  const [primary, secondary] = variant === "sector" ? ["產業指數", "--"] : ["加權指數", "TAIEX"];
  return `<div class="trend-chart trend-variant-${variant}">
    ${productQuoteHeaderShell({ className: "trend-titlebar", primary, secondary, primaryRole: "product-name", secondaryRole: "product-code", centerRole: "product-center", priceRole: "product-price", changeRole: "product-change" })}
    ${controlRowShell(variant, showToolbar)}
    <div class="trend-chart-stage trend-area">
      <!-- Ids are assigned per surface at mount time, not baked in: this shell builds every
           trend surface, so a hard-coded id duplicated it across every slot that hosts one. -->
      <canvas data-role="trend-canvas"></canvas>
    </div>
    <div class="trend-info-lines">
      ${secondaryRowKinds(variant).map((kind) => secondaryInfoRowShell(kind)).join("")}
    </div>
  </div>`;
}

// 歷史回放's surface, laid out as 個股走勢: the shared product header (its code box queries the replayed day), the chart
// with a loading veil, then 個股走勢's prediction and stock rows. The exchange breadth row is not there: a replay is one
// stock's recorded day, and the breadth store holds today's live counts.
export const REPLAY_SECONDARY_ROWS = Object.freeze(["prediction", "stock"]);

export function replayTrendShell() {
  return `<div class="trend-chart">
    ${productQuoteHeaderShell({ className: "trend-titlebar product-quote-replay", search: "history" })}
    <div class="trend-chart-stage trend-area">
      <canvas data-role="trend-canvas"></canvas>
      <div data-role="trend-loading" class="trend-loading" hidden>
        <span class="loading-spinner" aria-hidden="true"></span><b data-role="trend-loading-text">資料抓取中</b>
      </div>
    </div>
    <div class="trend-info-lines">
      ${REPLAY_SECONDARY_ROWS.map((kind) => secondaryInfoRowShell(kind)).join("")}
    </div>
  </div>`;
}

// 歷史回放's controls, where 個股走勢 has its 盤中事件 and 疊圖 (the slot's tab bar): 交易時段事件 / 盤中時段事件 and the
// 加權 / 期貨 benchmark toolbar. The page binds them (pages/history.js).
export function replayControlRowShell() {
  return `<div class="trend-control-row" data-role="trend-control-row" data-trend-controls="replay">`
    + eventMarkerToggleHtml(true, { role: "history-trade-event-toggle", label: "交易時段事件" })
    + eventMarkerToggleHtml(true, { role: "history-all-event-toggle", label: "盤中時段事件" })
    + benchmarkOverlayControlsMarkup()
    + "</div>";
}
