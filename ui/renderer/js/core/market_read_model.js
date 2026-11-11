// Read-only UI contract. Stores own ordering/resync; this module owns no cache,
// clock, subscription, session decision or synthetic market values.
export const MARKET_READ_VERSION = 1;
const channelNames = ["summary", "quote", "trades", "orderbook", "trend", "coverage", "tradeflow"];
// The one numeric reading (numbers.js), under the name the read adapters use.
export { numberOrNull as nullableNumber } from "./numbers.js";

export function readChannel(data, { enabled = true, supported = null, subscribed = null, ready = null, reason = null, freshness = null } = {}) {
  const present = data != null && (Array.isArray(data) ? data.length > 0 : typeof data !== "object" || Object.keys(data).length > 0);
  const state = !enabled ? "disabled" : supported === false ? "unsupported" : subscribed === false ? "unsubscribed"
    : present ? "available" : ready === false ? "waiting" : "missing";
  return { state, supported, subscribed, reason, freshness: {state:"UNKNOWN", expectedActive:null, eventAgeSeconds:null, lastEventAt:null, ...freshness}, data: ["disabled", "unsupported", "unsubscribed"].includes(state) ? null : data ?? null };
}

export function marketReadModel({ identity, session = {}, time = {}, encoding = {}, revision = {}, channels = {}, policy = {}, sourceDetails = {} }) {
  return {
    schemaVersion: MARKET_READ_VERSION,
    identity: { source: identity.source, code: identity.code || null, contractCode: identity.contractCode || null, market: identity.market || null },
    session: { tradingDate: null, name: null, timezone: null, ...session },
    // Exchange-local epoch-shaped integers are NOT UTC event timestamps.
    time: { eventTime: null, eventTimeKind: null, receivedTime: null, receivedTimeKind: null, ...time },
    encoding: { priceUnit: null, quantityUnit: null, priceScale: null, quantityScale: null, pricePrecision: null, quantityPrecision: null, ...encoding },
    revision: { kind: "snapshot", lastWire: null, protocolVersion: null, sequence: null, streamId: null, daemonInstanceId: null, selectionGeneration: null, sessionGeneration: null, contextGeneration: null, cursor: null, ...revision },
    channels: Object.fromEntries(channelNames.map((name) => [name, readChannel(channels[name], { ...policy.common, ...policy[name] })])),
    sourceDetails,
  };
}

// The read views a shared component consumes. A view model reaches a component carrying its read model
// (`marketRead`), built at the data boundary (market_read_adapters.js withMarketRead / withOrderBookRead /
// withProductRead): that is where the view's own quote and display identity were settled, so these views read market
// facts -- quote, book levels, trade rows, trend points, channel state -- from the model only. The view model's own
// presentation fields (titles, metrics, availability, messages) pass through. A view model without a read model is
// a producer that skipped the boundary: it is refused and logged, and the component keeps what it showed.
function readModelOf(vm, consumer) {
  const model = vm?.marketRead;
  if (model) return model;
  console.error(`[market read] ${consumer} refused a view model without marketRead: its producer skipped the data boundary`,
    { fields: Object.keys(vm || {}).slice(0, 20) });
  return null;
}

const BLOCKED_BOOK = { disabled: "來源未啟用", unsupported: "此商品不支援委託簿", unsubscribed: "尚未訂閱委託簿" };

export function orderBookReadView(vm) {
  const view = productQuoteReadView(vm, "order book");
  if (!view) return null;
  const book = view.marketRead.channels.orderbook;
  const blocked = BLOCKED_BOOK[book.state];
  return { ...view,
    bidLevels: book.data?.bids || [],
    askLevels: book.data?.asks || [],
    availability: blocked ? "UNAVAILABLE" : vm.availability ?? (book.state === "available" ? "AVAILABLE" : "UNAVAILABLE"),
    message: blocked || vm.message,
    readState: book.state,
  };
}

export function tradesReadView(vm) {
  const model = readModelOf(vm, "trade details");
  if (!model) return null;
  const channel = model.channels.trades;
  return { ...vm, rows: channel.data || [], readState: channel.state };
}

export function trendReadView(vm) {
  const view = productQuoteReadView(vm, "trend");
  if (!view) return null;
  const channel = view.marketRead.channels.trend;
  return { ...view, points: channel.data || [], readState: channel.state };
}

export function productQuoteReadView(vm, consumer = "product quote") {
  const model = readModelOf(vm, consumer);
  if (!model) return null;
  const quote = model.channels.quote.data || {};
  const current = quote.lastPrice ?? null, prevClose = quote.prevClose ?? null, open = quote.openPrice ?? null;
  const totalVolume = quote.totalVolume ?? null;
  return {
    ...vm,
    currentPrice: current,
    lastPrice: current,
    prevClose,
    openPrice: open,
    totalVolume,
    stockInfo: { ...(vm.stockInfo || {}), open, high: quote.dayHigh ?? null, low: quote.dayLow ?? null, prevClose, totalVolume },
  };
}

export function productReadView(row) {
  const read = readModelOf(row, "product row");
  if (!read) return null;
  const quote = read.channels.quote.data || {};
  return { ...row, code: read.identity.code ?? read.channels.summary.data?.code ?? null, name: read.channels.summary.data?.label ?? null,
    current: quote.lastPrice ?? null, prev_close: quote.prevClose ?? null, day_high: quote.dayHigh ?? null, day_low: quote.dayLow ?? null,
    open: quote.openPrice ?? null, total_volume: quote.totalVolume ?? null };
}

// The view's error text: the store-projected flat field (realtime_market_math / workspace runtime) or, for a view
// model built straight from a read model, the snapshot's own view_error. The one reader of that precedence.
export function viewErrorOf(vm) {
  return String(vm?.viewError || vm?.view_error || vm?.marketRead?.sourceDetails?.viewError || "").trim();
}
