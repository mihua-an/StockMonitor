import { withOrderBookRead } from "./market_read_adapters.js";
import { displayQuote } from "./auction_price.js";
import { resolveInstrumentDisplayName } from "./instrument_names.js";
import { futuresDisplayCode } from "../market_data/futures_symbol.js";
import { normalizeParallelOrderBookLevels, normalizeProviderOrderBook, normalizeTradeSideSummary } from "./orderbook_normalization.js";
import { numberOrNull, positiveNumberOrNull } from "./numbers.js";


function baseViewModel(source = {}, aggregate = {}, { code = "", label = "", secondaryLabel = "", message = "", market = "STK", readModel = null } = {}) {
  const bidPrices = Array.isArray(source.bid_prices) ? source.bid_prices : [];
  const bidVolumes = Array.isArray(source.bid_volumes) ? source.bid_volumes : [];
  const askPrices = Array.isArray(source.ask_prices) ? source.ask_prices : [];
  const askVolumes = Array.isArray(source.ask_volumes) ? source.ask_volumes : [];
  const diffBidVol = Array.isArray(source.diff_bid_vol) ? source.diff_bid_vol : [];
  const diffAskVol = Array.isArray(source.diff_ask_vol) ? source.diff_ask_vol : [];
  // 內外盤: Rust B's per-print direction summed over the session (價量's out/in volumes, call auctions excluded) --
  // the one basis 價量, 大單 shares and the model use (user 11-01). Not the broker's cumulative totals: a missed print
  // made A's auction deduction from them wrong for the rest of the day. No 價量 yet is no ratio, not a guess.
  const outsideTradeVolume = numberOrNull(aggregate.outVol);
  const insideTradeVolume = numberOrNull(aggregate.inVol);
  // ONE 現價 / 參考價 / 漲跌 for 個股走勢, 買賣報價 and the product row: the canonical summary as displayQuote() reads it
  // (試撮 included). Market Runtime computed the change; the book only shows it.
  const quote = displayQuote(source);
  const directed = Math.max(0, Number(outsideTradeVolume || 0)) + Math.max(0, Number(insideTradeVolume || 0));
  const outsideRatioPct = directed > 0 ? Math.max(0, Number(outsideTradeVolume || 0)) / directed * 100 : 50;
  return withOrderBookRead({
    availability: (bidPrices.length || askPrices.length || bidVolumes.length || askVolumes.length) ? "AVAILABLE" : "UNAVAILABLE",
    message,
    code,
    displayLabel: label || code,
    titlePrimary: label || code,
    titleSecondary: secondaryLabel || code,
    timestamp: source.exchange_time || source.time || source.datetime || "",
    lastPrice: quote.current,
    indicative: quote.indicative,
    lastTradeTime: source.last_trade_time || source.exchange_time || source.time || source.datetime || "",
    prevClose: quote.reference,
    priceReference: quote.reference,
    limitUp: numberOrNull(source.limit_up),
    limitDown: numberOrNull(source.limit_down),
    dayHigh: numberOrNull(source.day_high ?? source.high),
    dayLow: numberOrNull(source.day_low ?? source.low),
    // Both adapters name the day total total_volume (the stock one is A's summary total); a tick or book `volume` is not it.
    totalVolume: numberOrNull(source.total_volume),
    priceChange: quote.change,
    pctChange: quote.changePct,
    outsideTradeVolume,
    insideTradeVolume,
    depthBidTotal: numberOrNull(source.bid_total_vol ?? source.bid_total_volume),
    depthAskTotal: numberOrNull(source.ask_total_vol ?? source.ask_total_volume),
    exchange: String(source.exchange || ""),
    suspended: source.suspend === true,
    bidLevels: normalizeParallelOrderBookLevels(bidPrices, bidVolumes, diffBidVol, { provider: "shioaji", maxDepth: 5 }),
    askLevels: normalizeParallelOrderBookLevels(askPrices, askVolumes, diffAskVol, { provider: "shioaji", maxDepth: 5 }),
    bookDepth: 5,
    // Whether the level changes may be drawn: every caller says so explicitly (diff_renderable). The selected
    // stock allows it only for a book that came by delta; a missing flag draws nothing.
    diffRenderable: source.diff_renderable === true,
    diffEventToken: source.diff_event_token ?? source.exchange_ts_ns ?? null,
    outsideRatioPct,
    priceVolumeRows: Array.isArray(aggregate.byPrice) ? aggregate.byPrice : [],
    priceVolumeEmptyText: "等待逐價內外盤資料",
    bookUpdatedAt: source.updated_at || source.exchange_time || source.time || source.datetime || "",
    showDepthTotals: true,
  }, {source: "shioaji", raw: source, code, readModel});
}

export const StockOrderBookAdapter = Object.freeze({
  build({ code = "", signal = {}, book = {}, aggregate = {}, readModel = null } = {}) {
    // Day high/low belong to the summary (canonical `high`/`low`), never the book. A context/native book can carry
    // its own older `day_high`, which must not win (book spread last, `day_high` read before `high`): an 「H」 would
    // sit at the day's low 50.00. The book's figures are only a fallback when the summary has none.
    const dayHigh = [signal.high, signal.day_high, book.day_high, book.high].map(positiveNumberOrNull).find((v) => v != null) ?? null;
    const dayLow = [signal.low, signal.day_low, book.day_low, book.low].map(positiveNumberOrNull).find((v) => v != null) ?? null;
    const merged = { ...signal, ...book, code, day_high: dayHigh, day_low: dayLow };
    // The code box shows what people type: a futures month by its category (its month is on the product row).
    return { ...baseViewModel(merged, aggregate, {
      code,
      label: resolveInstrumentDisplayName("shioaji", code, book.name, merged.name, merged.stock_name),
      secondaryLabel: futuresDisplayCode(code),
      message: `${code} 尚無五檔資料`,
      market: "STK", readModel,
    }), inputCode: futuresDisplayCode(code) };
  },
});

export const FuturesOrderBookAdapter = Object.freeze({
  build({ tick = {}, book = {}, aggregate = {}, readModel = null } = {}) {
    // The summary (Market Runtime's TXFR1 summary) owns current/volume/reference/漲跌. BidAsk owns depth only. Never
    // infer a futures成交價 from bid1/ask1/mid or a market-order sentinel.
    const merged = {
      ...book,
      code: "TXFR1",
      contract_code: tick.contract_code || book.contract_code,
      current: tick.current,
      indicative_price: tick.indicative_price,
      total_volume: tick.total_volume,
      prev_close: tick.prev_close,
      reference_price: tick.reference_price,
      limit_up: tick.limit_up,
      limit_down: tick.limit_down,
      day_high: tick.high,
      day_low: tick.low,
      change: tick.change,
      change_pct: tick.change_pct,
      exchange: tick.exchange || book.exchange,
      last_trade_time: tick.exchange_time || tick.time || tick.datetime || "",
    };
    const contractCode = String(merged.contract_code || "").trim();
    return baseViewModel(merged, aggregate, {
      code: "TXFR1",
      label: "台指期",
      secondaryLabel: contractCode || "TXFR1",
      message: "TXFR1 尚無五檔資料",
      market: "FUT", readModel,
    });
  },
});

export const FutuOrderBookAdapter = Object.freeze({
  build({ code = "", book = {}, tradeSideSummary = {}, quote = {}, label = "", secondaryLabel = "", available = false, readModel = null } = {}) {
    const sourceBook = book?.book && typeof book.book === "object" ? book.book : book;
    const normalizedBook = normalizeProviderOrderBook(sourceBook, { provider: "futu", minDepth: 5, maxDepth: 10 });
    const tradeSide = normalizeTradeSideSummary(tradeSideSummary);
    // A Futu product (futu_product.js): Market Runtime's current / 昨收 / 漲跌 / 漲幅.
    const current = positiveNumberOrNull(quote.current);
    const prev = positiveNumberOrNull(quote.prev);
    const hasBook = [...normalizedBook.bidLevels, ...normalizedBook.askLevels].some((level) => ["PRICE", "MARKET"].includes(level.quoteState));
    return withOrderBookRead({
      availability: hasBook ? "AVAILABLE" : "UNAVAILABLE",
      message: hasBook ? "" : "尚無買賣報價或行情權限不足",
      code,
      displayLabel: label || code,
      titlePrimary: label || code,
      titleSecondary: secondaryLabel || code,
      lastPrice: current,
      prevClose: prev,
      priceReference: prev,
      priceChange: numberOrNull(quote.change),
      pctChange: numberOrNull(quote.changePct),
      totalVolume: numberOrNull(quote.volume ?? quote.totalVolume),
      // Keep quantity numeric in the view model. Presentation uses the shared
      // quantity formatter so crypto/fractional volume is never rounded to an integer.
      summaryText: "",
      bidLevels: normalizedBook.bidLevels,
      askLevels: normalizedBook.askLevels,
      bookDepth: normalizedBook.displayDepth,
      availableBookDepth: normalizedBook.availableDepth,
      outsideTradeVolume: tradeSide.outsideVolume,
      insideTradeVolume: tradeSide.insideVolume,
      neutralTradeVolume: tradeSide.neutralVolume,
      unknownTradeVolume: tradeSide.unknownVolume,
      outsideRatioPct: tradeSide.outsideRatioPct,
      priceVolumeRows: [],
      showDepthTotals: true,
    }, {source: "futu", raw: sourceBook, code, readModel});
  },
});
