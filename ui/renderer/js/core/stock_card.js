// One row of the card-style stock list (K棒 beside code, name, price and change): 歷史回放's list and a product list
// too narrow for its table. Styled by pages/history.css (.history-stock-item ...). `titleExtra`: markup after the name
// (a product's 現／月份 picker); `loadSpinner`: the row's spinner at its right end, always in the row and shown by the row's own state (.history-stock-item-loading). `price` is the number `priceText` shows; at the official `limitUp` / `limitDown` (none:
// no mark, never derived from 昨收) it gets base.css's 紅底白字 / 綠底白字.
import { limitPriceClass } from "./components/orderbook_depth_table.js";
import { escapeHtml } from "./utility.js";
import { miniCandleMarkup } from "./mini_candle.js";

export function stockCardInnerMarkup({ candle, code, name, price = null, limitUp = null, limitDown = null, priceText, changeText, moveClass, titleExtra = "", loadSpinner = false }) {
  const limitClass = limitPriceClass(price, limitUp, limitDown);
  return `<div class="history-stock-kline">${miniCandleMarkup(candle)}</div>
    <div class="history-stock-meta">
      <div class="history-stock-row history-stock-title-row${titleExtra ? " history-stock-title-row-reserved" : ""}">
        <b class="history-stock-code">${escapeHtml(code)}</b>
        <span class="history-stock-name">${escapeHtml(name)}</span>${titleExtra}${loadSpinner ? '<span class="loading-spinner history-stock-loading-spinner" aria-hidden="true"></span>' : ""}
      </div>
      <div class="history-stock-row history-stock-price-row">
        <b class="history-stock-close ${escapeHtml(moveClass)}${limitClass ? ` ${limitClass}` : ""}">${escapeHtml(priceText)}</b>
        <span class="history-stock-change ${escapeHtml(moveClass)}">${escapeHtml(changeText)}</span>
      </div>
    </div>`;
}
