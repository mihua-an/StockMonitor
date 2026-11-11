// 價量: per traded price, how much of the volume was 大單 / 小單 buying (外盤) and selling (內盤).
//
// Rust B owns the classification (the instrument's large-order rule) and ships it on each price_volume bucket as a
// flat `flow` array laid out by `flow_fields` (native/analysis_runtime/src/accum.rs LADDER_FLOW_FIELDS). This file
// only reads those numbers back and draws them; it never classifies a trade itself. An instrument without a rule
// (Futu, TXF) has no `flow`, and the 價量 view says so instead of drawing a split.

import { morphReset } from "./dom_morph.js";
import { localeNumber } from "./utility.js";
import { MarketPriceColorPolicy } from "./market_color_policy.js";

const FIELDS = ["large_buy", "large_sell", "small_buy", "small_sell", "unclassified_buy", "unclassified_sell"];

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Rows highest price first: {price, volume, out, in, largeBuy, largeSell, smallBuy, smallSell, otherBuy, otherSell}. */
export function buildPriceFlowRows(priceVolume = {}) {
  const source = priceVolume && typeof priceVolume === "object" ? priceVolume : {};
  const raw = Array.isArray(source.buckets) ? source.buckets : Array.isArray(source.byPrice) ? source.byPrice : [];
  const layout = Array.isArray(source.flow_fields) ? source.flow_fields.map(String) : null;
  const at = Object.fromEntries(FIELDS.map((name) => [name, layout ? layout.indexOf(name) : -1]));
  let classified = false;
  const rows = raw.map((bucket) => {
    const price = Number(bucket?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const flow = layout && Array.isArray(bucket?.flow) ? bucket.flow : null;
    if (flow) classified = true;
    const field = (name) => (flow && at[name] >= 0 ? amount(flow[at[name]]) : 0);
    return {
      price,
      volume: amount(bucket?.volume ?? amount(bucket?.out) + amount(bucket?.in) + amount(bucket?.unknown)),
      out: amount(bucket?.out), in: amount(bucket?.in),
      largeBuy: field("large_buy"), largeSell: field("large_sell"),
      smallBuy: field("small_buy"), smallSell: field("small_sell"),
      otherBuy: field("unclassified_buy"), otherSell: field("unclassified_sell"),
    };
  }).filter(Boolean).sort((a, b) => b.price - a.price);
  return { rows, classified };
}

const fmt = (value) => (value ? localeNumber(Number(value), "en-US") : "");
const same = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;

function rowClass(row, { currentPrice, referencePrice }) {
  return ["price-flow-row", same(row.price, currentPrice) ? "is-current" : "", same(row.price, referencePrice) ? "is-reference" : ""].join(" ").trim();
}

function priceTone(row, { referencePrice }) {
  return MarketPriceColorPolicy.cssClass(row.price, referencePrice);
}

// Bars are % of half the track: sells grow left from the centre line, buys grow right. "" = no bar.
function halfWidth(value, max) {
  const width = max ? (value / max) * 50 : 0;
  return width ? width.toFixed(3) : "";
}

// Digits after the point for every price of one ladder: as many as its finest price needs, so a column of prices
// lines up (224.0 / 224.5); none when every price is whole (500 / 501).
function fractionDigits(value) {
  const text = Number(value).toFixed(4).replace(/0+$/, "");
  return text.endsWith(".") ? 0 : text.length - text.indexOf(".") - 1;
}

/** Digits every price of these rows is shown with. */
export function ladderPriceDigits(rows) {
  return rows.reduce((digits, row) => Math.max(digits, fractionDigits(row.price)), 0);
}

/** What each ladder row shows: class, price colour, the four numbers and the four bar widths. */
export function ladderRowModels(rows, context = {}) {
  const maxLarge = Math.max(1, ...rows.map((row) => Math.max(row.largeBuy, row.largeSell)));
  const maxSmall = Math.max(1, ...rows.map((row) => Math.max(row.smallBuy, row.smallSell)));
  const digits = ladderPriceDigits(rows);
  return rows.map((row) => ({
    key: String(row.price), price: row.price.toFixed(digits), className: rowClass(row, context), tone: priceTone(row, context),
    largeSell: fmt(row.largeSell), largeBuy: fmt(row.largeBuy), smallSell: fmt(row.smallSell), smallBuy: fmt(row.smallBuy),
    bars: { largeSell: halfWidth(row.largeSell, maxLarge), largeBuy: halfWidth(row.largeBuy, maxLarge),
      smallSell: halfWidth(row.smallSell, maxSmall), smallBuy: halfWidth(row.smallBuy, maxSmall) },
  }));
}

const HEADER = [["賣", ""], ["大單", "is-center"], ["買", "is-hug"], ["價格", "is-center"], ["賣", ""], ["小單", "is-center"], ["買", "is-hug"]];
const BAR_CLASSES = { largeSell: "is-large-sell", largeBuy: "is-large-buy", smallSell: "is-small-sell", smallBuy: "is-small-buy" };

function buildTable(doc) {
  const table = doc.createElement("table");
  table.className = "price-flow-table lined-rows";
  const thead = doc.createElement("thead");
  const head = doc.createElement("tr");
  for (const [text, className] of HEADER) { const th = doc.createElement("th"); if (className) th.className = className; th.textContent = text; head.appendChild(th); }
  thead.appendChild(head);
  const tbody = doc.createElement("tbody");
  table.append(thead, tbody);
  return { table, tbody, rows: new Map() };
}

function buildRow(doc, model) {
  const tr = doc.createElement("tr");
  tr.dataset.price = model.key;
  tr.dataset.morphKey = model.key;
  const td = (className) => { const cell = doc.createElement("td"); cell.className = className; tr.appendChild(cell); return cell; };
  const track = (sell, buy) => {
    const bar = doc.createElement("div"); bar.className = "price-flow-bar";
    const axis = doc.createElement("i"); axis.className = "price-flow-axis"; bar.appendChild(axis);
    td("price-flow-track").appendChild(bar);
    return { bar, [sell]: null, [buy]: null };
  };
  const refs = {
    largeSell: td("price-flow-num price-flow-sell"), large: track("largeSell", "largeBuy"), largeBuy: td("price-flow-num price-flow-buy is-hug"),
    price: td("price-flow-price is-center"),
    smallSell: td("price-flow-num price-flow-sell"), small: track("smallSell", "smallBuy"), smallBuy: td("price-flow-num price-flow-buy is-hug"),
  };
  tr._ladder = { refs, model: null };
  return tr;
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

// A half bar: present only while its width is not zero; a sell bar sits before the buy bar of its track.
function patchBar(track, key, width, last) {
  if (width === last) return;
  const sell = key.endsWith("Sell");
  let seg = track[key];
  if (!width) { seg?.remove(); track[key] = null; return; }
  if (!seg) {
    seg = track.bar.ownerDocument.createElement("span");
    seg.className = `price-flow-seg ${BAR_CLASSES[key]}`;
    const buyKey = sell ? key.replace("Sell", "Buy") : null;
    track.bar.insertBefore(seg, sell ? track[buyKey] : null);
    track[key] = seg;
  }
  seg.setAttribute("style", `${sell ? "right:50%" : "left:50%"};width:${width}%`);
}

function patchRow(tr, model) {
  const state = tr._ladder, last = state.model, { refs } = state;
  if (!last || last.className !== model.className) tr.className = model.className;
  setText(refs.largeSell, model.largeSell); setText(refs.largeBuy, model.largeBuy);
  setText(refs.smallSell, model.smallSell); setText(refs.smallBuy, model.smallBuy);
  if (!last || last.tone !== model.tone) refs.price.className = `price-flow-price is-center ${model.tone}`;
  setText(refs.price, model.price);
  for (const key of ["largeSell", "largeBuy"]) patchBar(refs.large, key, model.bars[key], last?.bars[key]);
  for (const key of ["smallSell", "smallBuy"]) patchBar(refs.small, key, model.bars[key], last?.bars[key]);
  state.model = model;
}

/**
 * Price in the middle; 大單 on the left, 小單 on the right, each on its own scale (sells left, buys right). The table is
 * built once into `container`; rows are kept by price and only their changed numbers, bars and classes are written.
 * Returns whether rows were added, removed or reordered.
 */
export function patchLargeSmallLadder(container, rows, context = {}) {
  const doc = container.ownerDocument;
  let ladder = container._ladder;
  if (!ladder || ladder.table.parentNode !== container) {
    ladder = buildTable(doc);
    container.replaceChildren(ladder.table);
    morphReset(container);  // the empty message was morphed into it; the next one must be written again
    container._ladder = ladder;
  }
  const models = ladderRowModels(rows, context);
  const next = new Map();
  let topologyChanged = false;
  models.forEach((model, index) => {
    let tr = ladder.rows.get(model.key);
    if (!tr) { tr = buildRow(doc, model); topologyChanged = true; }
    patchRow(tr, model);
    if (ladder.tbody.children[index] !== tr) { ladder.tbody.insertBefore(tr, ladder.tbody.children[index] || null); topologyChanged = true; }
    next.set(model.key, tr);
  });
  for (const [price, tr] of ladder.rows) if (next.get(price) !== tr) { tr.remove(); topologyChanged = true; }
  ladder.rows = next;
  return topologyChanged;
}

/** Drop the ladder kept in `container` (it is showing something else now). */
export function releaseLargeSmallLadder(container) { if (container) container._ladder = null; }

/** The header line's 大單／小單 外盤 (buy) and 內盤 (sell): Rust B's session totals (price_volume.totals, the same fold as
 *  the rows), never the rows added back up. */
export function priceFlowTotals(priceVolume = {}) {
  const totals = priceVolume?.totals || {};
  return { largeBuy: amount(totals.large?.buy), largeSell: amount(totals.large?.sell),
    smallBuy: amount(totals.small?.buy), smallSell: amount(totals.small?.sell) };
}
