// 歷史回放 商品清單: the day's products with their mini candles (split out of pages/history.js).
import { $, escapeHtml, formatPrice } from "../../core/utility.js";
import { morphInto } from "../../core/dom_morph.js";
import { stockCardInnerMarkup } from "../../core/stock_card.js";
import { historyPage, historyState } from "./history_state.js";
import { formatChangeNumber } from "./history_values.js";
import { numberOrNull } from "../../core/numbers.js";
import { signedValueClass } from "../../core/market_color_policy.js";

// The list is in one of three named states, all read from historyState: no history to list (historyUnavailable says
// why: no recorded dates, or the read failed), a day without stocks, or the day's stocks -- the selected one active and
// the one whose replay is loading (loadingCode) spinning at its edge.
export function historyStockListState() {
  if (historyState.historyUnavailable) return { kind: "unavailable", message: historyState.historyUnavailable };
  if (!historyState.stocks.length) return { kind: "noStocks", message: "該日無股票資料" };
  return { kind: "stocks", stocks: historyState.stocks, selectedCode: historyState.selectedCode, loadingCode: historyState.loadingCode };
}

// The list owns #historyStockList: the page changes historyState and calls this, and only the rows' data, the active
// row and the loading mark are written (morphInto, rows keyed by code).
export function renderHistoryStockList() {
  const list = $("historyStockList");
  if (!list) return;
  const state = historyStockListState();
  if (state.kind !== "stocks") {
    morphInto(list, `<div class="history-stock-list-empty">${escapeHtml(state.message)}</div>`);
    return;
  }

  morphInto(list, state.stocks.map((stock) => {
    const code = String(stock?.code || "");
    const name = String(stock?.name || "");
    const close = numberOrNull(stock?.close);
    const change = numberOrNull(stock?.change);
    const changePct = numberOrNull(stock?.change_pct);
    const moveClass = signedValueClass(change);
    const active = code === state.selectedCode ? " active" : "";
    const loading = code && code === state.loadingCode ? " history-stock-item-loading" : "";
    const closeText = Number.isFinite(close) ? formatPrice(close) : "--";
    const changeText = Number.isFinite(change) && Number.isFinite(changePct)
      ? `${formatChangeNumber(Math.abs(change))}(${Math.abs(changePct).toFixed(2)}%)`
      : "--";

    return `
      <button class="history-stock-item${active}${loading}" type="button" data-morph-key="${escapeHtml(code)}" data-history-code="${escapeHtml(code)}" role="option" aria-selected="${active ? "true" : "false"}">
        ${stockCardInnerMarkup({ candle: stock, code, name, price: close, limitUp: stock?.limit_up, limitDown: stock?.limit_down, priceText: closeText, changeText, moveClass, loadSpinner: true })}
      </button>
    `;
  }).join(""));
  historyPage.stockRowSnap?.measure?.();
}

/** Brings the selected stock's row into the list (the row-snap list scrolls by whole rows, never smoothly). */
export function scrollSelectedHistoryStockIntoView() {
  requestAnimationFrame(() => {
    const index = historyState.stocks.findIndex((item) => String(item?.code || "") === String(historyState.selectedCode || ""));
    if (index < 0) return;
    if (historyPage.stockRowSnap) {
      historyPage.stockRowSnap.measure();
      const start = Math.max(0, index - Math.floor(Math.max(1, historyPage.stockRowSnap.visibleRows) / 2));
      historyPage.stockRowSnap.scrollToIndex(start);
      return;
    }
    $("historyStockList")?.querySelector(".history-stock-item.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
}
