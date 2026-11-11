// A product list too narrow for its table draws its rows as 歷史回放's stock cards (K棒, code, name, price, change),
// with a product's 現／月份 picker as in the table. Both broker lists use it; they say when (watchProductListWidth) and
// hand over the same rows they give the table.
import { displayQuote, priceText } from "../../../core/auction_price.js";
import { expandPickerHtml } from "../../../core/components/expand_picker.js";
import { morphInto } from "../../../core/dom_morph.js";
import { productReadView } from "../../../core/market_read_model.js";
import { signedValueClass } from "../../../core/market_color_policy.js";
import { numberOrNull } from "../../../core/numbers.js";
import { stockCardInnerMarkup } from "../../../core/stock_card.js";
import { escapeHtml } from "../../../core/utility.js";

// Below this many CSS px the list's columns no longer fit (the 專業 screen's side lists, a narrowed pane).
export const PRODUCT_LIST_CARD_WIDTH = 320;

/** `onChange(narrow)` now and whenever the host crosses the width. A hidden host (no width) says nothing. */
export function watchProductListWidth(host, onChange) {
  const read = () => { if (host.clientWidth > 0) onChange(host.clientWidth < PRODUCT_LIST_CARD_WIDTH); };
  read();
  const observer = new ResizeObserver(read);
  observer.observe(host);
  return () => observer.disconnect();
}

/**
 * A product row's 現價 and 漲跌 as its card shows them: the header of 技術分析's window reads the same. 漲跌 and 漲跌幅
 * are both Market Runtime's (displayQuote), measured from its comparison price -- futures from the settlement.
 */
export function productQuoteFigures(row) {
  const item = productReadView(row);
  const quote = item ? displayQuote(item) : { current: null, change: null, changePct: null, indicative: false };
  const current = numberOrNull(quote.current);
  const indicative = Boolean(quote.indicative);
  return {
    item, current, change: numberOrNull(quote.change), changePct: numberOrNull(quote.changePct), indicative,
    priceText: priceText(current, { indicative }), name: String(item?.name ?? row?.name ?? ""),
  };
}

function cardInner(row) {
  const { item, current, change, changePct, priceText: shownPrice } = productQuoteFigures(row);
  return stockCardInnerMarkup({
    candle: item ? { open: item.open, high: item.day_high ?? item.high, low: item.day_low ?? item.low, close: current } : {},
    code: String(item?.display_code ?? row?.code ?? ""), name: String(item?.name ?? row?.name ?? ""),
    // 現價 as the table shows it: 試撮 puts the indicative price, marked "#", in its place, and that price is what is
    // compared with the official limits (Market Runtime's, carried on the row).
    price: current, limitUp: item?.limit_up ?? null, limitDown: item?.limit_down ?? null,
    priceText: shownPrice,
    changeText: change === null || changePct === null ? "--" : `${Math.abs(change).toFixed(2)}(${Math.abs(changePct).toFixed(2)}%)`,
    moveClass: signedValueClass(change),
    titleExtra: row?.side_picker ? expandPickerHtml({ ...row.side_picker, corner: true }) : "",
  });
}

const states = new WeakMap();

/** The cards of one list: every row when the rows themselves changed, else only `changedCodes`. */
/** `draggableCards`: a card can be dragged out (draggable until dimmed); `dimmedCodes`: the codes whose cards are grey. */
export function renderProductCards({ root, rows = [], selectedCode = "", onSelect = null, onPick = null, emptyText = "尚無商品", changedCodes = null, topologyChanged = false, draggableCards = false, dimmedCodes = null }) {
  const list = root?.querySelector?.('[data-role="product-list-cards"]');
  if (!list) return;
  let state = states.get(list);
  if (!state) {
    state = { order: null, onSelect: null, onPick: null };
    states.set(list, state);
    list.addEventListener("click", (event) => {
      const card = event.target?.closest?.("[data-card-code]");
      if (!card) return;
      const pick = event.target?.closest?.("[data-pick]");
      if (pick) state.onPick?.(card.dataset.cardCode, pick.dataset.pick || "");
      else state.onSelect?.(card.dataset.cardCode);
    });
  }
  state.onSelect = onSelect;
  state.onPick = onPick;
  const selected = String(selectedCode || "");
  const order = rows.map((row) => String(row?.code || "")).join("|");
  if (!rows.length) {
    state.order = "";
    morphInto(list, `<div class="history-stock-list-empty">${escapeHtml(emptyText)}</div>`);
    return;
  }
  if (!changedCodes || topologyChanged || order !== state.order) {
    state.order = order;
    // A <div>: the card holds the picker's buttons.
    morphInto(list, rows.map((row) => {
      const code = String(row?.code || "");
      const active = code === selected;
      const dimmed = Boolean(dimmedCodes?.has(code));
      return `<div class="history-stock-item${active ? " active" : ""}${dimmed ? " is-dimmed" : ""}"${draggableCards && !dimmed ? ' draggable="true"' : ""} data-morph-key="${escapeHtml(code)}" data-card-code="${escapeHtml(code)}" role="option" aria-selected="${active}">${cardInner(row)}</div>`;
    }).join(""));
    return;
  }
  const byCode = new Map([...list.children].map((element) => [element.dataset.cardCode, element]));
  for (const row of rows) {
    const code = String(row?.code || "");
    if (!changedCodes.has(code)) continue;
    const element = byCode.get(code);
    if (!element) continue;
    morphInto(element, cardInner(row));
    element.classList.toggle("active", code === selected);
    element.setAttribute("aria-selected", String(code === selected));
  }
}
