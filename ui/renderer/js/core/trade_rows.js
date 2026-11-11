import { MarketPriceColorPolicy, TradeSideColorPolicy } from "./market_color_policy.js";
import { tradeRowDisplayTime } from "./trade_row_order.js";
import { formatQuantity, formatTradePrice } from "./utility.js";
import { numberOrNull } from "./numbers.js";
import { limitPriceClass } from "./components/orderbook_depth_table.js";

// One trade row of the 成交明細 tables (main page, workspace): 時間, 成交, 單量, and Market Runtime's 漲跌, 漲跌幅 and
// 總量, each in the columns the table shows. tradeRowModel() is what a row shows; the row is built from it once, and an update compares it field by field and
// writes only what differs (no markup, no parse).
function signed(value, text) { return value > 0 ? `+${text}` : text; }

export function tradeRowModel(tick, vm, identity, { anchored = true } = {}) {
  const tradeSide = TradeSideColorPolicy.normalize(tick?.tradeSide ?? tick?.trade_side ?? tick?.side);
  const number = Number(tick?.price);
  const priced = Number.isFinite(number) && number > 0;
  // A print at 漲停 / 跌停 is marked like everywhere else: 紅底白字 / 綠底白字 on the price.
  const limitClass = limitPriceClass(number, vm?.limitUp, vm?.limitDown);
  // 大單: two stacked characters, 紅底 for a buy and 綠底 for a sell, as tall as a 漲停/跌停 price box.
  const side = String(tradeSide || "").toUpperCase();
  const volume = numberOrNull(tick?.volume);
  const change = numberOrNull(tick?.change), changePct = numberOrNull(tick?.change_pct), total = numberOrNull(tick?.total_volume);
  return {
    identity, anchored, side: String(tradeSide || ""),
    ingest: String(tick?.ingestSequence ?? tick?.ingest_sequence ?? ""),
    time: tradeRowDisplayTime(tick),
    priced,
    priceText: priced ? formatTradePrice(number) : "--",
    priceCellClass: priced ? MarketPriceColorPolicy.cssClass(number, vm?.referencePrice) : "price-flat",
    priceClass: `tick-details-trade-price${limitClass ? ` ${limitClass}` : ""}`,
    badge: priced && tick?.isLarge ? `tick-details-large-badge${side === "BUY" ? " buy" : side === "SELL" ? " sell" : ""}` : "",
    volumeText: volume !== null ? formatQuantity(volume, { quantityScale: tick?.quantityScale ?? tick?.quantity_scale }) : "--",
    volumeClass: TradeSideColorPolicy.volumeCssClass(tradeSide),
    changeText: change !== null ? signed(change, formatTradePrice(change)) : "--",
    changePctText: changePct !== null ? `${signed(changePct, changePct.toFixed(2))}%` : "--",
    totalText: total !== null ? formatQuantity(total, { quantityScale: tick?.quantityScale ?? tick?.quantity_scale }) : "--",
  };
}

function largeBadge(doc, className) {
  const badge = doc.createElement("span");
  badge.className = className;
  for (const text of ["大", "單"]) { const i = doc.createElement("i"); i.textContent = text; badge.appendChild(i); }
  return badge;
}

// The price cell: a priced row is [anchor >] price (+ 大單 badge in the anchor); an unpriced one is the bare "--".
// The anchor (成交明細) reserves the badge's room beside the price; a table without badges (workspace) has none.
function fillPriceCell(td, model) {
  td.className = model.priceCellClass;
  if (!model.priced) { td.textContent = "--"; return; }
  const doc = td.ownerDocument;
  const price = doc.createElement("span");
  price.className = model.priceClass;
  price.textContent = model.priceText;
  if (!model.anchored) { td.replaceChildren(price); return; }
  const anchor = doc.createElement("span");
  anchor.className = "tick-details-price-anchor";
  anchor.appendChild(price);
  if (model.badge) anchor.appendChild(largeBadge(doc, model.badge));
  td.replaceChildren(anchor);
}

function priceSpan(td, model) { return model.anchored ? td.firstChild.firstChild : td.firstChild; }

// What each column of a trade row shows (its column id, column_schemas.js): `build` fills a new cell, `patch` writes
// only what differs from the last model.
const CELLS = {
  time: {
    build(td, model) {
      td.className = "tick-details-time-cell";
      const time = td.ownerDocument.createElement("span");
      time.className = "tick-details-time-text";
      time.textContent = model.time;
      td.appendChild(time);
    },
    patch(td, model, last) { if (last.time !== model.time) td.firstChild.textContent = model.time; },
  },
  trade: {
    build: fillPriceCell,
    patch(td, model, last) {
      if (last.priced !== model.priced || last.badge !== model.badge || last.anchored !== model.anchored) { fillPriceCell(td, model); return; }
      if (last.priceCellClass !== model.priceCellClass) td.className = model.priceCellClass;
      if (!model.priced) return;
      const price = priceSpan(td, model);
      if (last.priceClass !== model.priceClass) price.className = model.priceClass;
      if (last.priceText !== model.priceText) price.textContent = model.priceText;
    },
  },
  change: textCell((model) => model.priceCellClass, (model) => model.changeText),
  change_pct: textCell((model) => model.priceCellClass, (model) => model.changePctText),
  volume: textCell((model) => model.volumeClass, (model) => model.volumeText),
  total_volume: textCell(() => "", (model) => model.totalText),
};

function textCell(classOf, textOf) {
  return {
    build(td, model) { td.className = classOf(model); td.textContent = textOf(model); },
    patch(td, model, last) {
      if (classOf(last) !== classOf(model)) td.className = classOf(model);
      if (textOf(last) !== textOf(model)) td.textContent = textOf(model);
    },
  };
}

// The workspace list's three cells; 成交明細 passes the columns its user shows (tick_details_columns.js).
export const COMPACT_TRADE_COLUMNS = Object.freeze(["time", "trade", "volume"]);

// `columns`: the column ids of the table, in its order -- the row has one cell per column, in the same order.
// `sideAttributes`: the side and ingest sequence as data-* attributes (成交明細's own CSS and freeze logic read them;
// the workspace list has none).
export function buildTradeRow(doc, model, { identityAttribute = "data-trade-row-identity", sideAttributes = true, columns = COMPACT_TRADE_COLUMNS } = {}) {
  const tr = doc.createElement("tr");
  tr.setAttribute(identityAttribute, model.identity);
  if (sideAttributes) {
    tr.dataset.tradeSide = model.side;
    tr.dataset.ingestSequence = model.ingest;
  }
  tr._sideAttributes = sideAttributes;
  tr._columns = columns.filter((id) => CELLS[id]);
  tr.append(...tr._columns.map((id) => {
    const td = doc.createElement("td");
    CELLS[id].build(td, model);
    return td;
  }));
  tr._trade = model;
  return tr;
}

export function patchTradeRow(tr, model) {
  const last = tr._trade;
  if (tr._sideAttributes && last.side !== model.side) tr.dataset.tradeSide = model.side;
  if (tr._sideAttributes && last.ingest !== model.ingest) tr.dataset.ingestSequence = model.ingest;
  tr._columns.forEach((id, index) => CELLS[id].patch(tr.cells[index], model, last));
  tr._trade = model;
}

export function emptyTradeRow(doc, text, columns = 3) {
  const tr = doc.createElement("tr");
  const td = doc.createElement("td");
  td.colSpan = columns;
  td.className = "empty";
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}
