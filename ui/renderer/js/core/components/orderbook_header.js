// The book's shell and its header rows: product title, price / change, the review centre, depth totals and the
// trade-side ratio.

import { signedValueClass } from "../market_color_policy.js";
import { numberOrNull } from "../numbers.js";
import { byRole as role, escapeHtml, formatQuantity, syncText } from "../utility.js";
import { ioRatioMarkup, ioRatioNodes, patchIoRatio } from "./io_ratio.js";
import { productQuoteHeaderShell, setProductQuoteCenter } from "./product_quote_header.js";
import { titleBarMarkup } from "./title_bar.js";

export function genericShell({
  title = "買賣報價",
  depth = 5,
  showInsideOutside = true,
  showPriceVolume = true,
  showDepthTotals = true,
  showExtremeMarkers = true,
} = {}) {
  const colgroup = showExtremeMarkers
    ? '<colgroup><col class="orderbook-col-bid-extreme"><col class="orderbook-col-bid-vol"><col class="orderbook-col-bid-price"><col class="orderbook-col-ask-price"><col class="orderbook-col-ask-vol"><col class="orderbook-col-ask-extreme"></colgroup>'
    : '<colgroup><col class="orderbook-col-bid-vol"><col class="orderbook-col-bid-price"><col class="orderbook-col-ask-price"><col class="orderbook-col-ask-vol"></colgroup>';
  const colspan = showExtremeMarkers ? 6 : 4;
  return `<div class="orderbook${showExtremeMarkers ? "" : " orderbook-simple-depth"}" data-role="orderbook-root">
    ${titleBarMarkup({ title })}
    <div class="orderbook-scroll-body">
      ${productQuoteHeaderShell({ className: "compact orderbook-header", primaryRole: "summary-code", secondaryRole: "summary-secondary-code", centerRole: "summary-center", priceRole: "summary-price", changeRole: "summary-change" })}
      ${showInsideOutside ? ioRatioMarkup({ className: "orderbook-io-ratio" }) : ""}
      ${showPriceVolume ? '<div data-role="price-volume" class="pv-imbalance"><div class="empty">等待逐價內外盤資料</div></div>' : ""}
      <div class="table-wrap-plain orderbook-table-wrap"><table class="orderbook-table">${colgroup}<tbody data-role="orderbook-body"><tr><td colspan="${colspan}" class="empty">尚無${Math.max(1, Number(depth) || 5)}檔資料</td></tr></tbody></table></div>
    </div>
    ${showDepthTotals ? '<div data-role="depth-totals" class="orderbook-total-section"><div class="orderbook-total-bar-wrap"><div data-role="bid-total-bar" class="orderbook-total-bar bid"></div><div data-role="ask-total-bar" class="orderbook-total-bar ask"></div></div><div class="orderbook-total-labels"><div class="orderbook-total-label bid">(<span data-role="bid-total">--</span>)</div><div class="orderbook-total-label ask">(<span data-role="ask-total">--</span>)</div></div></div>' : ""}
  </div>`;
}

export function renderOrderbookTitle(element, vm = {}) {
  if (!element) return;
  const primary = String(vm.titlePrimary || vm.displayLabel || vm.code || "----");
  const secondary = String(vm.titleSecondary || vm.code || "").trim();
  const suspended = vm.suspended === true ? `<span class="orderbook-suspend-badge">暫停</span>` : "";
  syncText(element, primary);
  const secondaryElement = element._secondaryCode ??= role(element.closest?.(".product-quote-header"), "summary-secondary-code");
  // The code box mirrors the code itself, never the 暫停 badge beside it. A provider whose identity code is not the
  // one people type (Futu "US.NOK" shown as "NOK", like its 個股走勢 and product list) passes `inputCode`.
  if (secondaryElement) {
    const code = String(vm.inputCode || vm.code || secondary || "").trim();
    if (secondaryElement.dataset.code !== code) secondaryElement.dataset.code = code;
    const markup = `${escapeHtml(secondary)}${suspended}`;
    if (secondaryElement._markup !== markup) { secondaryElement.innerHTML = markup; secondaryElement._markup = markup; }
  }
}

// The order book card's summary, ratio and table nodes.
export function orderbookNodes(root) {
  return {
    code: role(root, "summary-code"), price: role(root, "summary-price"), change: role(root, "summary-change"), center: role(root, "summary-center"),
    ratio: ioRatioNodes(root),
    bidTotal: role(root, "bid-total"), askTotal: role(root, "ask-total"), bidBar: role(root, "bid-total-bar"), askBar: role(root, "ask-total-bar"),
    totals: role(root, "depth-totals"), body: role(root, "orderbook-body"),
  };
}

// 現價 / 參考價 / 漲跌 / 漲跌幅 of the header.
export function quoteChange(vm) {
  const currentRaw = Number(vm.lastPrice);
  const current = Number.isFinite(currentRaw) && currentRaw > 0 ? currentRaw : null;
  const prevRaw = Number(vm.prevClose);
  const prev = Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null;
  const referenceRaw = Number(vm.priceReference);
  const reference = Number.isFinite(referenceRaw) && referenceRaw > 0 ? referenceRaw : prev;
  // 漲跌 / 漲跌幅 are the view model's (Market Runtime's, D01-04): shown, never derived here.
  const diff = numberOrNull(vm.priceChange);
  const pct = numberOrNull(vm.pctChange);
  return { current, reference, diff, pct };
}

// The header's centre cell: the replay review P&L while a trade is under review (the shared error state owns the
// cell until recovery).
export function renderReviewCenter(center, vm, headerFailed) {
  if (headerFailed) return;
  const review = vm.reviewPnl;
  if (!review?.active) {
    setProductQuoteCenter(center);
    return;
  }
  const signed = (v) => Number.isFinite(Number(v)) ? Math.abs(Math.round(Number(v))).toLocaleString("zh-TW") : "--";
  const html = review.inside
    ? `<span class="orderbook-review-live-pnl ${signedValueClass(review.estimated)}">${escapeHtml(signed(review.estimated))}</span>`
    : `<span class="orderbook-review-actual-pnl ${signedValueClass(review.actual)}">${escapeHtml(signed(review.actual))}</span><span class="orderbook-review-estimated-pnl">(${escapeHtml(signed(review.estimated))})</span>`;
  setProductQuoteCenter(center, { active: true, html, className: "orderbook-review-pnl" });
}

export function renderDepthTotals({ bidTotal, askTotal, bidBar, askBar }, bidSum, askSum) {
  const depthTotal=bidSum+askSum;
  const bidPct = depthTotal ? bidSum/depthTotal*100 : 50, askPct = 100-bidPct;
  syncText(bidTotal, formatQuantity(bidSum)); syncText(askTotal, formatQuantity(askSum));
  // Each side's share as --bar-share: the CSS scales a full-width bar (a composited transform, never a layout).
  bidBar?.style.setProperty("--bar-share", (bidPct / 100).toFixed(4)); askBar?.style.setProperty("--bar-share", (askPct / 100).toFixed(4));
}

// 內外盤 ratio from the broker's aggressor volumes (outside = ask side, inside = bid side).
export function renderTradeSideRatio(ratio, vm) {
  patchIoRatio(ratio, { outside: vm.outsideTradeVolume, inside: vm.insideTradeVolume, neutral: vm.neutralTradeVolume, unknown: vm.unknownTradeVolume });
}
