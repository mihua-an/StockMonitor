// The depth table: one row per level (bid qty / bid price / ask price / ask qty, and the H/L edge markers), built
// once and patched cell by cell from each level's model.

import { MarketPriceColorPolicy } from "../market_color_policy.js";
import { escapeHtml, formatPrice, formatQuantity, priceMoveClass, syncClass, syncText } from "../utility.js";

// Two prices are the same only when both ARE prices: Number(null) is 0, so an empty level (price 0) would
// "equal" a day high / low / limit that does not exist yet, and pre-open every empty ask row would show 「H」.
export function samePrice(value, target) {
  if (value === null || value === undefined || value === "" || target === null || target === undefined || target === "") return false;
  const a = Number(value); const b = Number(target);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && Math.abs(a - b) < 1e-7;
}

export function limitPriceClass(value, up, down) {
  if (samePrice(value, up)) return "limit-up-price";
  if (samePrice(value, down)) return "limit-down-price";
  return "";
}

// The H/L marker cell of a level, as data: its class, the marker text, and the live diff badge (null when none).
// `change` is the level's badge as the order book holds it: { delta, id, leaving } -- its net quantity change, which
// badge it is (one id for its whole life, so a later change at the same price updates it instead of starting a new
// one), and whether it is fading out.
export function extremeModel(price, high, low, prev, side, change = null) {
  const p = Number(price);
  if (!Number.isFinite(p)) return { className: "orderbook-extreme-cell", text: "", badge: null };
  let text = "", cls = "";
  if (samePrice(p, high)) { text = "H"; cls = priceMoveClass(p, prev); }
  else if (samePrice(p, low)) { text = "L"; cls = priceMoveClass(p, prev); }
  const rawDelta = Number(change?.delta);
  if (Number.isFinite(rawDelta) && rawDelta !== 0) {
    const add = rawDelta > 0;
    // The badge floats over the cell: at the day high/low it covers the H/L marker for its short life instead of
    // pushing the marker up (user decision), so nothing in the row moves.
    return { className: `orderbook-extreme-cell ${cls} ${side || ""} orderbook-with-change`, text,
      badge: { id: change.id, className: `orderbook-book-change ${add ? "add" : "cancel"}${change.leaving ? " leaving" : ""}`,
        label: `${add ? "+" : "-"}${formatQuantity(Math.abs(rawDelta))}` } };
  }
  return { className: `orderbook-extreme-cell ${cls} ${side || ""}`, text, badge: null };
}

/** The H/L marker cell as markup (what extremeModel() puts on screen). */
export function extremeMarker(price, high, low, prev, side, change = null) {
  const model = extremeModel(price, high, low, prev, side, change);
  const badge = model.badge ? `<span class="${model.badge.className}">${escapeHtml(model.badge.label)}</span>` : "";
  return `<td class="${model.className}">${model.text}${badge}</td>`;
}

// Every level reaches the renderer through orderbook_normalization.js, which names its quoteState. A level without
// one is a caller bug: it is shown empty, and every book drawn with such levels is reported with the product and
// how many levels lacked it (#reportLevelsWithoutQuoteState).
export const QUOTE_STATES = new Set(["PRICE", "MARKET", "EMPTY"]);

export function normalizedQuoteState(level = {}) {
  const state = level?.quoteState;
  return QUOTE_STATES.has(state) ? state : "EMPTY";
}

// A level's quantity cell (bar width in percent, text) and price cell (class, text), as data.
export function qtyModel(level, ratio) {
  const empty = normalizedQuoteState(level) === "EMPTY";
  const pct = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
  return { width: `${empty ? "0.00" : pct.toFixed(2)}%`, text: empty ? "--" : formatQuantity(Number(level?.volume) || 0) };
}

export function priceModel(level, referencePrice, up, down, current) {
  const state = normalizedQuoteState(level);
  const p = Number(level?.price);
  const market = state === "MARKET";
  const validPrice = state === "PRICE" && Number.isFinite(p) && p > 0;
  const text = market ? "市價" : validPrice ? formatPrice(p) : "--";
  const priceClass = market ? "orderbook-price-market" : MarketPriceColorPolicy.cssClass(validPrice ? p : null, referencePrice);
  const currentClass = validPrice && samePrice(p, current) ? " orderbook-current-price" : "";
  const limitClass = validPrice ? limitPriceClass(p, up, down) : "";
  return { className: `orderbook-price-value ${priceClass}${currentClass}${limitClass ? ` ${limitClass}` : ""}`, text };
}

// One depth row, built once: [H/L] bid qty, bid price, ask price, ask qty [H/L]. Its cells are kept on the row and
// an update writes only what changed. The H/L cell is rebuilt when what it shows changes, so a new diff badge is a
// new element and plays its animation once, as before.
export function buildLevelRow(doc, index, withExtremes) {
  const tr = doc.createElement("tr");
  tr.dataset.orderbookLevel = String(index);
  const td = (className) => { const cell = doc.createElement("td"); cell.className = className; tr.appendChild(cell); return cell; };
  const qty = (side) => {
    const cell = td(`orderbook-qty-cell ${side}`);
    const wrap = doc.createElement("div"); wrap.className = `orderbook-qty-wrap ${side}`;
    const bar = doc.createElement("i"); bar.className = `orderbook-qty-bar ${side}`;
    const text = doc.createElement("span"); text.className = "orderbook-qty-text";
    wrap.append(bar, text); cell.appendChild(wrap);
    return { bar, text };
  };
  const price = (side) => { const cell = td(`orderbook-price-cell ${side}`); const value = doc.createElement("span"); cell.appendChild(value); return value; };
  const refs = {};
  if (withExtremes) refs.bidExtreme = td("orderbook-extreme-cell");
  refs.bidQty = qty("bid"); refs.bidPrice = price("bid"); refs.askPrice = price("ask"); refs.askQty = qty("ask");
  if (withExtremes) refs.askExtreme = td("orderbook-extreme-cell");
  tr._level = refs;
  return tr;
}

// The cell is rebuilt only when its marker or WHICH badge it shows changes: the same badge (same id) with a new net
// quantity or starting to fade is updated in place, so its entry animation plays once and never restarts.
export function patchExtreme(cell, model) {
  const badgeId = model.badge ? String(model.badge.id) : "";
  const key = `${model.className}\u001f${model.text}\u001f${badgeId}`;
  if (cell._key === key) {
    if (model.badge && cell._badge) {
      syncClass(cell._badge, model.badge.className);
      syncText(cell._badge, model.badge.label);
    }
    return;
  }
  cell._key = key;
  cell.className = model.className;
  const nodes = model.text ? [cell.ownerDocument.createTextNode(model.text)] : [];
  cell._badge = null;
  if (model.badge) {
    const badge = cell.ownerDocument.createElement("span");
    badge.className = model.badge.className;
    badge.textContent = model.badge.label;
    cell._badge = badge;
    nodes.push(badge);
  }
  cell.replaceChildren(...nodes);
}

/** How long a level's change badge shows in full (ms) before it fades, and how long the fade takes. Counted from when
 * it appears: a change at the same price while it shows is added to it but does not start its time again, so the
 * badge always says "what changed at this price just now" and a busy best bid / ask never keeps one up (user 11-11:
 * half a second is enough to read, as long as the next book does not take it away sooner). */
export const BOOK_CHANGE_HOLD_MS = 500;
export const BOOK_CHANGE_FADE_MS = 160;

/** The badges an order book shows, by side and price: each shows BOOK_CHANGE_HOLD_MS from when it appears, then fades
 * for BOOK_CHANGE_FADE_MS. Kept by price, not row, so a badge moves with its price when the book shifts and goes when
 * its price leaves the book. */
export class BookChangeBadges {
  constructor() { this.entries = new Map(); this.seq = 0; this.code = ""; }

  /** Start over for another product (a badge of one stock must never show on another). */
  forCode(code) {
    if (code === this.code) return;
    this.code = code;
    this.entries.clear();
  }

  /** A diff event's level changes: each one starts a badge, or adds to the one still showing at its price. */
  add(side, levels, now) {
    for (const level of levels) {
      const delta = Number(level?.delta);
      const price = Number(level?.price);
      if (!Number.isFinite(delta) || delta === 0 || !(price > 0)) continue;
      const key = `${side}:${price}`;
      const entry = this.entries.get(key);
      if (entry && now < entry.until) entry.delta += delta;
      else this.entries.set(key, { delta, id: ++this.seq, until: now + BOOK_CHANGE_HOLD_MS });
    }
  }

  /** The badge at `price` on `side` as extremeModel takes it, or null; gone ones are dropped first by prune(). */
  at(side, price, now) {
    const entry = this.entries.get(`${side}:${Number(price)}`);
    if (!entry || entry.delta === 0) return null;
    return { delta: entry.delta, id: entry.id, leaving: now >= entry.until };
  }

  /** Drop the badges whose fade has ended; the time of the next change to show (a badge starting to fade or going),
   * or null when none is showing. */
  prune(now) {
    let next = null;
    for (const [key, entry] of this.entries) {
      const gone = entry.until + BOOK_CHANGE_FADE_MS;
      if (now >= gone) { this.entries.delete(key); continue; }
      const due = now < entry.until ? entry.until : gone;
      next = next === null ? due : Math.min(next, due);
    }
    return next;
  }
}

export function patchQty(refs, model) {
  if (refs.width !== model.width) { refs.bar.style.width = model.width; refs.width = model.width; }
  syncText(refs.text, model.text);
}

export function patchPrice(node, model) {
  syncClass(node, model.className);
  syncText(node, model.text);
}

export function availabilityMessage(vm) {
  const state = String(vm?.availability || "UNAVAILABLE").toUpperCase();
  if (vm?.message) return vm.message;
  if (state === "DISABLED") return "此功能已停用";
  if (state === "PARTIAL") return "歷史五檔資料不完整";
  if (state === "AVAILABLE") return "";
  return "尚無買賣報價";
}
