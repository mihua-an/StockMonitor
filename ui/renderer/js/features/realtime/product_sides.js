// One row per product on the Taiwan product list (decisions.md 商品的現貨／期貨與月份): a stock has a 現貨 side and, when
// it has 個股期貨, a 期貨 side with its months; 台指期／小台指 are products with only months. Which side and month a row
// shows is the user's choice per product (kept across restarts); the instrument it names -- the stock's code, or the
// month's symbol ("CDF202611", "TXF202611") -- is what the row's quote, the selection and every detail panel read.
//
// What each product has and is subscribed with is settings_api's (GET /api/subscriptions: its rows' 明細／五檔, a
// stock's `futures` with the months the contract table lists, an index future's `index_futures`), read again when any
// window saves the pages or the 訂閱偏好.

import { apiGet } from "../../core/api.js";
import { notifyEach } from "../../core/listeners.js";
import { readJsonPreference, writePreference } from "../../core/preferences.js";
import { setProductDerivedNames } from "../../core/instrument_names.js";

const SIDES_KEY = "realtimeProductSides";

let products = new Map();
let byInstrument = new Map();
const saved = readJsonPreference(SIDES_KEY, { context: "product sides" });
const chosen = new Map(Object.entries(saved && typeof saved === "object" ? saved : {}));
const listeners = new Set();

function productFromRow(row) {
  if (row.index_futures) {
    const months = row.index_futures.months_listed || [];
    return months.length ? { spot: null, fut: { category: row.code, months, trade: Boolean(row.trade), orderbook: Boolean(row.orderbook),
      chosenMonths: new Set(row.index_futures.months || []) } } : null;
  }
  const futures = row.futures;
  return {
    spot: { trade: Boolean(row.trade), orderbook: Boolean(row.orderbook) },
    fut: futures?.months_listed?.length ? { category: futures.category, months: futures.months_listed,
      trade: Boolean(futures.on && futures.trade), orderbook: Boolean(futures.on && futures.orderbook),
      chosenMonths: new Set(futures.on ? futures.months || [] : []) } : null,
  };
}

/** The products of the subscriptions view (Shioaji rows only). */
export function setProductSidesView(view = {}) {
  const next = new Map();
  for (const row of view.instruments || []) {
    if (row.source !== "shioaji") continue;
    const product = productFromRow(row);
    if (product) next.set(String(row.code).toUpperCase(), product);
  }
  products = next;
  byInstrument = new Map();
  // A futures month is headed by its product: 台玻期 (a stock's 個股期貨), 台指期 (an index future).
  const names = [];
  const nameOf = new Map((view.instruments || []).map((row) => [String(row.code).toUpperCase(), String(row.name || "")]));
  for (const [code, product] of products) {
    for (const month of product.fut?.months || []) {
      const symbol = `${product.fut.category}${month}`;
      byInstrument.set(symbol, code);
      const name = nameOf.get(code);
      if (name) names.push([symbol, product.spot ? `${name}期` : name]);
    }
  }
  setProductDerivedNames("shioaji", names);
  notifyEach(listeners, "product sides", null);
}

export async function loadProductSides() {
  setProductSidesView(await apiGet("/api/subscriptions"));
}

export function subscribeProductSides(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A product's sides: { spot, fut } (spot null for an index future, fut null for a stock with no 個股期貨). */
export function productSides(code) {
  const key = String(code || "").trim().toUpperCase();
  return products.get(key) || { spot: { trade: true, orderbook: true }, fut: null };
}

// A month is subscribed while it is the near month or a chosen one, and its side's lanes say what it takes.
function monthLanes(fut, index) {
  const listed = index === 0 || fut.chosenMonths.has(fut.months[index]);
  return { trade: listed && fut.trade, orderbook: listed && fut.orderbook };
}

/** The side a product opens on: the side subscribed with 明細 first (the trend is drawn from it), then 五檔. */
function defaultChoice({ spot, fut }) {
  const futNear = fut ? monthLanes(fut, 0) : { trade: false, orderbook: false };
  const side = spot?.trade ? "spot" : futNear.trade ? "fut" : spot?.orderbook ? "spot" : futNear.orderbook ? "fut" : spot ? "spot" : "fut";
  return { side, month: 0 };
}

/** The side and month index a product's row shows now. */
export function productChoice(code) {
  const key = String(code || "").trim().toUpperCase();
  const sides = productSides(key);
  const saved = chosen.get(key);
  const choice = saved || defaultChoice(sides);
  if (choice.side === "fut" && !sides.fut) return { side: "spot", month: 0 };
  if (choice.side === "spot" && !sides.spot) return { side: "fut", month: 0 };
  const months = sides.fut?.months || [];
  return { side: choice.side, month: Math.min(Math.max(0, Number(choice.month) || 0), Math.max(0, months.length - 1)) };
}

export function setProductChoice(code, side, month = 0) {
  const key = String(code || "").trim().toUpperCase();
  chosen.set(key, { side: side === "fut" ? "fut" : "spot", month: Math.max(0, Number(month) || 0) });
  writePreference(SIDES_KEY, JSON.stringify(Object.fromEntries(chosen)), { context: "product sides" });
  notifyEach(listeners, "product sides", key);
}

/** The instrument a product's row shows: the stock's code, or the chosen month's symbol. */
export function instrumentOf(code) {
  const key = String(code || "").trim().toUpperCase();
  const { side, month } = productChoice(key);
  const fut = productSides(key).fut;
  return side === "fut" && fut ? `${fut.category}${fut.months[month]}` : key;
}

/** The product a shown instrument belongs to: a futures month's stock or index future, else the code itself. */
export function productOfInstrument(instrument) {
  const key = String(instrument || "").trim().toUpperCase();
  return byInstrument.get(key) || key;
}

/** Whether a shown instrument is a month of 台指期／小台指 (a product with no spot side). */
export function isIndexFutureMonth(instrument) {
  const key = String(instrument || "").trim().toUpperCase();
  const product = byInstrument.get(key);
  return Boolean(product) && !productSides(product).spot;
}

/** The picker a product row or card draws: 現 when it has both sides, then its futures months; none for a stock without
 * 個股期貨. Only the chosen one shows until hovered; on 現 a 「期」 beside it shows the product has futures and picks
 * its last chosen month, and it gives way to the months once the picker opens (user 11-08). */
export function sidePickerOf(code) {
  const { spot, fut } = productSides(code);
  if (!fut) return null;
  const choice = productChoice(code);
  const onSpot = choice.side === "spot";
  return {
    options: [...(spot ? [["spot", "現"]] : []), ...fut.months.map((month, index) => [`m${index}`, month.slice(4)])],
    current: onSpot ? "spot" : `m${choice.month}`,
    hint: onSpot ? [`m${choice.month}`, "期"] : null,
  };
}

/** The months a product's futures side lists (YYYYMM, near month first). */
export function productMonths(code) {
  return productSides(code).fut?.months || [];
}
