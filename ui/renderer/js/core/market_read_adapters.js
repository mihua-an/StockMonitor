import { normalizeParallelOrderBookLevels, normalizeProviderOrderBook } from "./orderbook_normalization.js";
import { marketReadModel, nullableNumber as number } from "./market_read_model.js";
import { tradeRowSequence } from "./trade_row_order.js";

const first = (row, keys) => keys.map((key) => row?.[key]).find((v) => v != null && v !== "") ?? null;
const textTimeKind = (value) => value == null ? null : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(value)) ? "iso8601_offset" : "exchange_local_text";
const precision = (scale) => {
  const value = number(scale);
  return value > 0 && Number.isInteger(Math.log10(value)) ? Math.log10(value) : null;
};
function encoding(raw = {}) {
  return { priceUnit: raw.currency ?? null, quantityUnit: raw.quantity_unit ?? null,
    priceScale: number(raw.price_scale), quantityScale: number(raw.quantity_scale),
    pricePrecision: number(raw.price_precision) ?? precision(raw.price_scale),
    quantityPrecision: number(raw.quantity_precision) ?? precision(raw.quantity_scale) };
}
function quoteView(raw = {}) {
  return { lastPrice: number(first(raw, ["current", "lastPrice", "price", "close"])),
    prevClose: number(first(raw, ["prev_close", "prevClose", "prev", "reference_price"])),
    dayHigh: number(raw.day_high ?? raw.high), dayLow: number(raw.day_low ?? raw.low),
    openPrice: number(raw.open), totalVolume: number(raw.total_volume) };
}
function knownQuote(raw) {
  const quote = quoteView(raw);
  return Object.values(quote).some((value) => value !== null) ? quote : null;
}
export function futuTradeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const event = first(row, ["trade_timestamp", "datetime", "timestamp", "time", "data_time"]);
    const display = first(row, ["exchange_time", "time", "data_time", "timestamp"]) ?? event;
    const sequence = first(row, ["sequence", "ticker_sequence"]);
    // A print's identity is its durable sequence; `sequence` is the live view's state version or a stored row's
    // producer sequence, two number spaces in which different prints share a number.
    const ingest = tradeRowSequence(row);
    return { ...row, datetime: event, timestamp: event, time: display, exchange_time: display, trade_timestamp: event,
      price: number(row.price), volume: number(row.volume), quantityScale: number(row.quantity_scale ?? row.quantityScale),
      tradeSide: first(row, ["ticker_direction", "trade_side", "direction", "side"]) ?? "UNKNOWN",
      sequence: sequence == null ? null : String(sequence), ingestSequence: ingest == null ? null : String(ingest) };
  });
}
export function futuTrendPoints(rows = []) {
  let cumulativeVolume = 0;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const volume = number(row.volume);
    if (volume !== null && volume >= 0) cumulativeVolume += volume;
    return { timestamp: first(row, ["time", "data_time", "timestamp"]), time: first(row, ["time", "data_time", "timestamp"]),
      price: number(first(row, ["cur_price", "close", "price"])), average_price: number(row.avg_price ?? row.average_price),
      minute_volume: volume, minute_turnover: number(row.turnover ?? row.trade_turnover),
      total_volume: number(row.total_volume) ?? (volume !== null ? cumulativeVolume : null) };
  }).filter((row) => row.price !== null);
}

function bookRead(book, source) {
  const raw = book?.book || book || {};
  const normalized = source === "futu" ? normalizeProviderOrderBook(raw, {provider: "futu", minDepth: 5, maxDepth: 10}) : {
    bidLevels: normalizeParallelOrderBookLevels(raw.bid_prices || [], raw.bid_volumes || [], [], {provider: "shioaji", maxDepth: 5}),
    askLevels: normalizeParallelOrderBookLevels(raw.ask_prices || [], raw.ask_volumes || [], [], {provider: "shioaji", maxDepth: 5}), displayDepth: 5 };
  return readableBook(normalized.bidLevels, normalized.askLevels, normalized.displayDepth);
}
// The canonical (Market Runtime) book is parallel arrays for every source; only the depth differs.
function canonicalBookRead(book, source) {
  const raw = book?.book || book || {};
  const options = {provider: source, maxDepth: source === "futu" ? 10 : 5};
  return readableBook(normalizeParallelOrderBookLevels(raw.bid_prices || [], raw.bid_volumes || [], [], options),
    normalizeParallelOrderBookLevels(raw.ask_prices || [], raw.ask_volumes || [], [], options), options.maxDepth);
}
// The renderer's copy of config/market_timezones.json (the one table; Python loads it, Rust A's offsets are tested
// against it): the clock a market's trading date, minutes and trade times are read on.
// tests/renderer_market_timezones_contract.mjs keeps this copy equal to the JSON.
const MARKET_TIMEZONES = { STK: "Asia/Taipei", ODD: "Asia/Taipei", IDX: "Asia/Taipei", FUT: "Asia/Taipei", OTC: "Asia/Taipei", TW: "Asia/Taipei",
  US: "America/New_York", HK: "Asia/Hong_Kong", SH: "Asia/Shanghai", SZ: "Asia/Shanghai", CC: "America/New_York" };

export function marketTimezone(market) {
  return MARKET_TIMEZONES[String(market || "").toUpperCase()] ?? null;
}
function readableBook(bids = [], asks = [], depth = null) {
  if (![...bids, ...asks].some((row) => ["PRICE", "MARKET"].includes(row.quoteState))) return null;
  const clean = (rows) => rows.map((row) => row.quoteState === "EMPTY" ? {...row, price: null, volume: null} : {...row});
  return {bids: clean(bids), asks: clean(asks), depth};
}

export function canonicalReadModel(state = {}, spec = {}, overrides = {}) {
  const key = state.session_key || {}, raw = state.summary || {};
  // Identity comes from the snapshot: Futu workspace rows read this model too, and were labelled shioaji / Taipei
  // with a five-level book.
  const code = key.logical_code || spec.code || raw.code;
  const market = String(key.market || state.market || spec.market || "").toUpperCase() || null;
  const source = String(key.source || state.source || spec.source
    || (market === "US" || String(code || "").includes(".") ? "futu" : "shioaji")).toLowerCase();
  const timezone = MARKET_TIMEZONES[market] ?? MARKET_TIMEZONES[String(code || "").split(".")[0]] ?? null;
  // The runtime's summary time is `price_exchange_ts_ns` (epoch ns as a string); `exchange_ts_ns` was never sent,
  // so the quote's event time was always empty.
  const eventNs = raw.price_exchange_ts_ns ?? raw.exchange_ts_ns ?? null;
  const eventTime = eventNs != null && String(eventNs) !== "0" ? eventNs : (raw.exchange_time ?? null);
  return marketReadModel({
    identity: { source, code, contractCode: raw.contract_code, market: key.market || spec.market },
    session: { tradingDate: key.trading_date ?? spec.trading_date ?? null, name: key.session ?? spec.session ?? null, timezone },
    time: { eventTime, eventTimeKind: eventTime === eventNs && eventNs != null ? "unix_ns" : textTimeKind(raw.exchange_time),
      receivedTime: raw.arrival_ns ?? null, receivedTimeKind: raw.arrival_ns != null ? "unix_ns" : null },
    encoding: encoding(raw),
    revision: { protocolVersion: state.protocol_version ?? null, sequence: state.watermark ?? null, streamId: state.stream_id ?? null,
      daemonInstanceId: state.daemon_instance_id ?? null, sessionGeneration: state.session_generation ?? null,
      selectionGeneration: spec.selectionGeneration ?? null },
    channels: { summary: Object.keys(raw).length ? { code: key.logical_code || spec.code || raw.code, label: raw.name ?? null } : null,
      quote: knownQuote(raw), orderbook: canonicalBookRead(state.orderbook, source), trades: state.trades, trend: state.trend, coverage: state.coverage, tradeflow: state.tradeflow, ...overrides },
    policy: { common: { enabled: spec.enabled !== false,
        ready: spec.ready ?? (state.presentation_state === "loading" ? false : null) },
      ...Object.fromEntries(["trades", "trend", "orderbook", "tradeflow"].map((name) => [name, {
        supported: state.capabilities?.[name] ?? null, subscribed: Array.isArray(spec.channels) ? spec.channels.includes(name) : null,
      }])) },
    sourceDetails: { sourceSummary: state.source_summary ?? null, resyncRequired: state.resync_required ?? null,
      viewState: state.presentation_state ?? null, viewStatus: state.view_status ?? null,
      viewError: state.view_error ?? null, trace:state.trace ?? null,
      // Telemetry lineage only. Components still consume the same channel data;
      // this lets the existing render trace select the arrival belonging to the
      // channel it actually updated instead of treating summary Tick time as
      // BidAsk time.
      // Straight from the wire's `channel_arrival_us`: the arrival of the newest event of EACH
      // channel, in epoch microseconds. It replaces a per-channel guess assembled here that fell
      // back to the summary's arrival, i.e. to Tick time, for channels that carried none -- and
      // for trades/trend the wire carried none at all, so that lane had no real samples ever.
      // Microseconds because epoch nanoseconds exceed JS's safe-integer range and JSON.parse
      // rounds them; see channel_arrival_wire() in market_runtime_daemon.rs.
      // Keyed by PROJECTION, matching the wire: "when did the thing I rendered last change".
      // `summary` is deliberately not called `quote` -- a Shioaji Tick arrives as a Trade and
      // changes the summary, so a quote-named stamp was never written and the product row that
      // read it had no arrival at all.
      channelArrivalUs: {
        summary: state.channel_arrival_us?.summary ?? null,
        trades: state.channel_arrival_us?.trades ?? null,
        trend: state.channel_arrival_us?.trend ?? null,
        orderbook: state.channel_arrival_us?.orderbook ?? null,
      } },
  });
}

export function futuReadModel(state = {}, { quote = {}, code = state.code, enabled = true, include = ["trades", "trend", "orderbook"], overrides = {} } = {}) {
  const market = String(code || "").split(".")[0], status = state.status || {}, raw = state.book || {};
  const timezone = status.timezone ?? marketTimezone(market);
  const latest = state.trades?.[0] || raw;
  return marketReadModel({
    identity: { source: "futu", code, market },
    session: { tradingDate: state.cursor?.session_date ?? null, name: state.session ?? null, timezone },
    time: { eventTime: latest.exchange_ts_ns ?? first(latest, ["trade_timestamp", "time", "data_time"]),
      eventTimeKind: latest.exchange_ts_ns != null ? "unix_ns" : textTimeKind(first(latest, ["trade_timestamp", "time", "data_time"])),
      receivedTime: latest.arrival_ns ?? null, receivedTimeKind: latest.arrival_ns != null ? "unix_ns" : null },
    encoding: encoding({ ...quote, ...latest }),
    revision: { cursor: state.cursor ? { ...state.cursor } : null, selectionGeneration: state.generation ?? null,
      contextGeneration: status.context_generation ?? state.contextGeneration ?? null, sessionGeneration: state.session_generation ?? null,
      sequence: state.sequence ?? state.readMetadata?.lastWire?.sequence ?? null, protocolVersion: state.protocol_version ?? state.readMetadata?.contractVersion ?? null, lastWire: state.readMetadata?.lastWire ?? null },
    // A Futu product (futu_product.js product()) names its day total `volume`.
    channels: { summary: code ? { code, label: quote.name ?? null } : null, quote: knownQuote({ ...quote, total_volume: quote.volume }), orderbook: include.includes("orderbook") ? bookRead(state.book, "futu") : null,
      trades: include.includes("trades") ? futuTradeRows(state.trades) : null, trend: include.includes("trend") ? futuTrendPoints(state.trend) : null, coverage: state.coverage ?? null, ...overrides },
    policy: { common: { enabled, ready: state.bootstrapped ?? null }, tradeflow: { supported: false },
      ...Object.fromEntries(["trades", "trend", "orderbook"].map((name) => [name, { ...futuLanePolicy(status, code, name), supported: status.capabilities?.[name] ?? null, ...(state.subscriptions?.[name] == null ? {} : {subscribed:state.subscriptions[name]}) }])) },
    sourceDetails: { tradeSideSummary: state.tradeSideSummary ?? null, status, trace:state.readMetadata?.trace ?? null },
  });
}

const BLOCKED_CHANNEL = ["disabled", "unsupported", "unsubscribed"];
// A model channel set to what the view shows: a blocked channel stays empty; otherwise its data decides it.
function projectChannel(existing, data) {
  if (BLOCKED_CHANNEL.includes(existing.state)) return { ...existing, data: null };
  return { ...existing, data, state: data ? "available" : existing.state === "available" ? "missing" : existing.state };
}

// The read model of a view no store projected (a replay summary, a Futu empty state, an account replay): built from
// the view's own trend points, trade rows and book.
function viewReadModel(vm, { source = "shioaji", market = null } = {}) {
  const code = vm.code ?? vm.logicalCode ?? vm.symbol ?? null;
  const channels = { trend: Array.isArray(vm.points) ? vm.points : null, trades: Array.isArray(vm.rows) ? vm.rows : null,
    orderbook: readableBook(vm.bidLevels, vm.askLevels, vm.bookDepth) };
  return source === "futu" ? futuReadModel({ code }, { code, include: [], overrides: channels })
    : canonicalReadModel({}, { code, market: market ?? vm.market ?? null }, channels);
}

/**
 * The data boundary every producer of a market view model passes (trend, order book, trade details): the view model
 * with the read model the components read. `model` is the one the view's store projected (by default the one the view
 * model already carries); without one it is built from the view itself (source / market name it). The view's own quote is what it shows -- the canonical summary as
 * displayQuote() reads it (試撮 included), a closed session's own close -- so its explicit scalars win and the model
 * fills what the view lacks; a view without a display name or code takes the model's. Read views
 * (market_read_model.js) then read these facts from the model only.
 */
export function withMarketRead(vm, model = vm.marketRead ?? null, options = {}) {
  const read = model ?? viewReadModel(vm, options);
  const summary = read.channels.summary.data || {}, held = read.channels.quote.data || {};
  const info = vm.stockInfo || {};
  const quote = {
    lastPrice: vm.currentPrice ?? vm.lastPrice ?? held.lastPrice ?? null,
    prevClose: vm.prevClose ?? info.prevClose ?? held.prevClose ?? null,
    dayHigh: info.high ?? vm.dayHigh ?? held.dayHigh ?? null,
    dayLow: info.low ?? vm.dayLow ?? held.dayLow ?? null,
    openPrice: info.open ?? vm.openPrice ?? held.openPrice ?? null,
    totalVolume: info.totalVolume ?? vm.totalVolume ?? held.totalVolume ?? null,
  };
  const displayCode = vm.displayCode ?? vm.titleSecondary ?? vm.code ?? read.identity.code ?? summary.code ?? "";
  const displayName = vm.displayName ?? vm.titlePrimary ?? vm.displayLabel ?? summary.label ?? displayCode;
  return {
    ...vm,
    displayCode,
    displayName,
    titlePrimary: vm.titlePrimary ?? displayName,
    titleSecondary: vm.titleSecondary ?? displayCode,
    priceReference: vm.priceReference ?? quote.prevClose,
    marketRead: { ...read, channels: { ...read.channels,
      quote: projectChannel(read.channels.quote, Object.values(quote).some((value) => value !== null) ? quote : null) } },
  };
}

// An order book view at the data boundary: its book is the view's own (the canonical state's levels, plus the level
// change marks the model's copy does not carry), projected into the store's model or a model built for the view.
export function withOrderBookRead(view, { source, raw = {}, code = view.code, market = "TW", readModel = null } = {}) {
  const book = readableBook(view.bidLevels, view.askLevels, view.bookDepth);
  const model = readModel ?? (source === "futu" ? futuReadModel({ code, book: raw }, { code })
    : canonicalReadModel({ summary: raw }, { code, market }));
  return withMarketRead(view, { ...model, channels: { ...model.channels, orderbook: projectChannel(model.channels.orderbook, book) } });
}

function futuLanePolicy(status, code, channel) {
  const lane = {trades:"TICKER", trend:"RT_DATA", orderbook:"ORDER_BOOK"}[channel];
  const rows = status.lane_freshness || [];
  const entry = Array.isArray(rows) ? rows.find((row) => row.code === code && row.lane === lane) : null;
  if (!entry) return {};
  const awaiting = entry.confirmed === false || ["SUBSCRIPTION_PENDING", "CONFIRMED_AWAITING_EVENT"].includes(entry.state);
  return {subscribed: entry.desired ?? null, ready:awaiting ? false : entry.confirmed ?? null, reason:entry.state ?? null,
    freshness:{state:entry.state ?? "UNKNOWN", expectedActive:entry.expected_active ?? null,
      eventAgeSeconds:entry.age_seconds ?? null, lastEventAt:entry.last_event_at ?? null}};
}

export function withProductRead(row, source) {
  const overrides = {summary:{code:row.code,label:row.name??null}, quote:knownQuote(row)};
  const marketRead = source === "futu" ? futuReadModel({code:row.code},{quote:row,include:[],overrides})
    : canonicalReadModel({summary:row},{code:row.code,market:"TW"},overrides);
  return {...row,marketRead};
}
