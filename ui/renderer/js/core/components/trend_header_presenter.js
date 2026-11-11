// What the surface's header and tape show, computed from a view model: the rounded change, the derived 漲停 /
// 漲幅 / 振幅 figures, the prediction cells and the event switch's state.

import { MarketPriceColorPolicy, signedValueClass } from "../market_color_policy.js";
import { numberOrNull } from "../numbers.js";
import { getTrendFooterHorizons } from "../trend_footer_horizons.js";
import { localeNumber, syncClass, syncText } from "../utility.js";
import { limitPriceClass } from "./orderbook_depth_table.js";
import { ownBreadth } from "./trend_surface_shell.js";
import { formatQuoteChange, quoteMoveClass, roundedChange, syncProductQuoteFailure } from "./product_quote_header.js";

export function syncPredictionCells(host, metrics = {}, percentText) {
  const horizons = getTrendFooterHorizons();
  const notes = metrics?.predictionNotes || {};
  // The cells and their parts are found once per host (this runs on every trend update); writes are skipped when
  // nothing changed.
  let cells = host?._predictionCells;
  if (!cells || cells.some((cell) => !cell.isConnected)) {
    cells = [...(host?.querySelectorAll?.('[data-role="prediction-cell"]') || [])];
    if (host) host._predictionCells = cells;
  }
  const setData = (node, key, value) => { if (node.dataset[key] !== value) node.dataset[key] = value; };
  for (const cell of cells) {
    const direction = cell.dataset.direction === "down" ? "down" : "up";
    const minutes = horizons[Number(cell.dataset.slot) === 1 ? 1 : 0];
    const field = `${direction}${minutes}m`;
    const note = notes[field] || null;
    const text = percentText(metrics[field]);
    const parts = cell._parts ??= { name: cell.querySelector('[data-role="prediction-name"]'),
      label: cell.querySelector('[data-role="prediction-label"]'), value: cell.querySelector("b") };
    const { name, label, value } = parts;
    if (label) syncText(label, String(minutes));
    if (!value) continue;
    setData(value, "role", `metric-${direction}-${minutes}m`);
    syncText(value, note?.testOnly && text !== "--" ? `${text} 測試` : text);
    setData(value, "predictionStatus", note?.status || "");
    setData(value, "predictionTestOnly", note?.testOnly ? "1" : "");
  }
}

export function syncEventMarkerToggle(host, visible, button = host?.querySelector?.('[data-role="event-marker-toggle"]')) {
  if (!button) return;
  if (button.classList.contains("active") !== Boolean(visible)) button.classList.toggle("active", Boolean(visible));
  const pressed = visible ? "true" : "false";
  if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
}

// Of `tokens`, exactly the non-empty ones in `wanted` are on the node; a token is added or removed only if it changes.
export function setStateClasses(node, tokens, wanted) {
  for (const token of tokens) {
    const on = wanted.includes(token);
    if (node.classList.contains(token) !== on) node.classList.toggle(token, on);
  }
}

// The surface's header (name, code, price, change), its metrics tape (漲停 / 漲幅 / 跌停 / 振幅 and the model
// predictions), the exchange breadth row and the stock facts row, written from a view model. One per surface: attach()
// gives it the surface's host and kind; a manual surface (a page draws the chart alone) has no tapes to write.
export class TrendHeaderPresenter {
  constructor() {
    this.host = null;
    this.manual = false;
    this.variant = "auto";
    this.nodeCache = new Map();
    this.breadthDate = "";
  }

  attach(host, { manual = false, variant = "auto" } = {}) {
    this.host = host;
    this.manual = Boolean(manual);
    this.variant = String(variant || "auto");
    this.nodeCache.clear();
  }

  setVariant(variant) {
    this.variant = String(variant || "auto");
  }

  detach() {
    this.host = null;
    this.nodeCache.clear();
  }

  // A node of this surface by selector / data-role, found once and kept while it is in the document (the header,
  // metrics and breadth are written on every update; the surface is rebuilt only when it is repaired or restored).
  node(selector) {
    const known = this.nodeCache.get(selector);
    if (known?.isConnected && this.host?.contains?.(known)) return known;
    const node = this.host?.querySelector?.(selector) || null;
    if (node) this.nodeCache.set(selector, node); else this.nodeCache.delete(selector);
    return node;
  }
  roleNode(name) { return this.node(`[data-role="${name}"]`); }

  syncHeader(vm = {}) {
    if (!this.host) return;
    const nameNode = this.node(".product-quote-name");
    const codeNode = this.node(".product-quote-code");
    const priceNode = this.node(".quote-main-price");
    const changeNode = this.node(".quote-change");
    const symbol = String(vm?.displayCode || vm?.symbol || "").trim();
    const name = String(vm?.displayName || symbol || "--").trim();
    syncText(nameNode, name || "--");
    syncText(codeNode, symbol || "--");
    const current = numberOrNull(vm?.currentPrice ?? vm?.current ?? vm?.price);
    // 漲跌 / 漲幅 are the view model's metrics (Market Runtime's change, D01-04): formatted here, never derived.
    const change = numberOrNull(vm?.metrics?.change);
    const changePct = numberOrNull(vm?.metrics?.changePct);
    // Colour and sign follow the change as displayed (2 decimals): a raw float remainder such as -1e-12 drew a
    // green "-0.00%".
    const shownDelta = change == null ? 0 : roundedChange(change);
    const movementClass = quoteMoveClass(change);
    if (priceNode) {
      // 試撮 (盤前 / 緩漲緩跌 / 尾盤): the indicative price, marked "#".
      syncText(priceNode, current == null ? "--" : `${vm?.indicative ? "#" : ""}${current.toFixed(2)}`);
      // At 漲停 / 跌停 the price is marked like everywhere else: 紅底白字 / 綠底白字.
      const limitClass = limitPriceClass(current, vm?.metrics?.limitUp, vm?.metrics?.limitDown);
      setStateClasses(priceNode, ["price-up", "price-down", "price-flat", "limit-up-price", "limit-down-price"], [movementClass, limitClass]);
    }
    if (changeNode) {
      setStateClasses(changeNode, ["price-up", "price-down", "price-flat", "up", "down"], [movementClass]);
      if (change == null || changePct == null) {
        syncText(changeNode, "--");
      } else {
        // One format for every product header (期貨 too).
        syncText(changeNode, formatQuoteChange(shownDelta, roundedChange(changePct)));
      }
    }
  }

  syncMetrics(vm = {}) {
    if (!this.host || this.manual) return;
    // The view model's metrics as they are: a null (not computable yet) is shown as "--", never recomputed here.
    const metrics = vm?.metrics || {};
    const setMetric = (roleName, text, className = "") => {
      const node = this.roleNode(roleName);
      if (!node) return;
      syncText(node, text);
      if (className) syncClass(node, className);
    };
    const value = (raw) => numberOrNull(raw);
    const priceText = (raw) => value(raw) == null ? "--" : value(raw).toFixed(2);
    const percentText = (raw) => value(raw) == null ? "--" : `${(value(raw) * 100).toFixed(1)}%`;
    const change = value(metrics.change);
    const moveClass = signedValueClass(change);
    setMetric("metric-limit-up", priceText(metrics.limitUp), value(metrics.limitUp) == null ? "price-flat" : "metric-limit-up");
    setMetric("metric-limit-down", priceText(metrics.limitDown), value(metrics.limitDown) == null ? "price-flat" : "metric-limit-down");
    // 漲幅: percent change against the reference price (the point change is already in the header).
    const changePct = value(metrics.changePct);
    setMetric("metric-change", changePct == null ? "--" : `${Math.abs(changePct).toFixed(2)}%`, moveClass);
    const amplitude = value(metrics.amplitude);
    // The live summary stores amplitude as a percentage (e.g. 2.35), not a
    // ratio.  Do not multiply it by 100 again.
    setMetric("metric-amplitude", amplitude == null ? "--" : `${Math.abs(amplitude).toFixed(2)}%`, "price-flat");
    // Model predictions for the two horizons chosen in settings. A TEST_ONLY number is labelled on screen; a
    // non-OK or absent entry shows "--" and says why on hover.
    syncPredictionCells(this.host, metrics, percentText);
  }

  // The header, metrics tape, stock facts and (產業指數 only) breadth of one view model, written once per frame.
  // The exchange-wide breadth of every other surface is the breadth store's (syncBreadth from the component's
  // subscription), and the 盤中事件 switch is the marker store's: a frame writes neither.
  commit(vm = {}) {
    this.syncHeader(vm);
    syncProductQuoteFailure(this.node(".product-quote-center"), vm);
    this.syncMetrics(vm);
    this.syncStockInfo(vm);
    if (ownBreadth(this.variant)) this.syncBreadth(vm?.breadth || {});
  }

  syncBreadth(breadth = {}) {
    // Gate on the DOM, not on a second list of variants: a variant list here beside secondaryRowKinds() would be two
    // lists of the same fact, and they drift. The only question that matters is whether this surface has somewhere
    // to show the counters.
    if (!this.host || this.manual) return;
    // An own-breadth surface (產業指數) shows only its view model's counts: its index's, or "--" when that index has
    // none (another index's counts must not stay on screen after the index changed).
    const own = ownBreadth(this.variant);
    const values = {
      "breadth-up": breadth.up_count,
      "breadth-down": breadth.down_count,
      "breadth-limit-up": breadth.limit_up_count,
      "breadth-limit-down": breadth.limit_down_count,
      "breadth-flat": breadth.flat_count,
    };
    for (const [roleName, raw] of Object.entries(values)) {
      const node = this.roleNode(roleName);
      if (!node) continue;
      const number = Number(raw);
      // Canonical snapshots can arrive before the breadth enrichment.  Keep
      // the last valid count during that short transition instead of flashing
      // the visible counter back to `--`.
      if (raw === null || raw === undefined || raw === "" || !Number.isFinite(number)) {
        if (own || (breadth.trading_date && this.breadthDate && breadth.trading_date !== this.breadthDate)) syncText(node, "--");
        continue;
      }
      syncText(node, localeNumber(number));
    }
    if (breadth.trading_date) this.breadthDate = breadth.trading_date;
  }

  syncStockInfo(vm = {}) {
    // Gated on the row, like breadth: 個股走勢 (with limits), 期貨走勢 and 加權走勢 (without) all carry it.
    if (!this.host || this.manual || !(this.node('[data-secondary-row="stock"]') || this.node('[data-secondary-row="session"]'))) return;
    const facts = vm?.stockInfo || {};
    const reference = numberOrNull(facts.prevClose ?? vm?.prevClose);
    // 開盤 / 最高 / 最低 are coloured against 昨收 (up / down / flat), like every other price on the page.
    const tone = (number) => MarketPriceColorPolicy.cssClass(number, reference);
    const set = (roleName, raw, { quantity = false, compare = false } = {}) => {
      const node = this.roleNode(roleName);
      if (!node) return;
      const number = numberOrNull(raw);
      syncText(node, number == null
        ? "--"
        : quantity ? localeNumber(Math.round(number)) : number.toFixed(2));
      if (compare) syncClass(node, tone(number));
    };
    set("stock-open", facts.open ?? vm?.openPrice, { compare: true });
    set("stock-high", facts.high, { compare: true });
    set("stock-low", facts.low, { compare: true });
    set("stock-prev-close", facts.prevClose ?? vm?.prevClose);
  }
}
