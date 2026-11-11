// 帳務 配對回放's model: a closed trade pair's entry and exit, whether it can be replayed, and what the six cards draw
// at the replay time -- 走勢資訊 (加權、個股、產業指數 on one chart, each as its change from its own 昨收), 買賣報價,
// 成交明細 and 技術分析 (價量 and 大單流向 are 即時報價's own drawings, core/price_flow_ladder.js and big_order_flow.js) -- from Market Runtime's replay view of the stock (pair_replay_session.js) and the
// day's minute levels of the two indexes. Pure: every input is an argument (no DOM, no page state).
import { MarketPriceColorPolicy } from "../../core/market_color_policy.js";
import { pairNetAtPrice } from "../../core/trade_costs.js";
import { isTapePrint, largePrintMatcher, tapeRow } from "../../market_data/trade_detail/tape_rows.js";
import { normalizeRustTradeFlow } from "../../market_data/realtime_market_math.js";
import { replayClockSeconds } from "./analytics.js";
import { isShortDirection } from "./trade_semantics.js";

const SESSION_START_MINUTE = 9 * 60;
/** 09:00 .. 13:30: the charts' x axis, a minute each. */
export const REPLAY_MINUTES = 271;
/** The K bar sizes the 技術分析 card switches between, and the one it opens with. */
export const REPLAY_KBAR_MINUTES = Object.freeze([1, 5, 15, 30]);
export const REPLAY_DEFAULT_KBAR_MINUTES = 5;
/** How many prints the 成交明細 card lists (newest first). */
export const REPLAY_TAPE_ROWS = 60;

/** A price or index level on the replay's cards: two decimals, thousands separated. */
export function replayLevelText(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  return numberValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function replayEntryRef(pair) {
  return isShortDirection(pair?.direction) ? pair?.sell_ref : pair?.buy_ref;
}

export function replayExitRef(pair) {
  return isShortDirection(pair?.direction) ? pair?.buy_ref : pair?.sell_ref;
}

export function replayEntryPrice(pair) {
  return isShortDirection(pair?.direction) ? Number(pair?.sell_price) : Number(pair?.buy_price);
}

export function replayExitPrice(pair) {
  return isShortDirection(pair?.direction) ? Number(pair?.buy_price) : Number(pair?.sell_price);
}

/** The chart minute (0 = 09:00) of a clock ("12:21", "12:21:33", an ISO time); null when unreadable. */
export function replayMinuteOf(clock) {
  const seconds = replayClockSeconds(clock);
  return seconds === null ? null : Math.floor(seconds / 60) - SESSION_START_MINUTE;
}

/** "HH:MM" of a chart minute. */
export function replayMinuteText(minute) {
  const total = SESSION_START_MINUTE + Number(minute);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** A 當沖 pair's entry / exit as clocks to the minute ("12:21 → 12:53"): the day is the row above it. */
export function replayPeriodClockText(pair) {
  const clock = (ref) => {
    const minute = replayMinuteOf(ref);
    return minute === null ? String(ref || "--") : replayMinuteText(minute);
  };
  return `${clock(replayEntryRef(pair))} → ${clock(replayExitRef(pair))}`;
}

/** A 台股 當沖 pair with readable entry and exit clocks, shown on the 台股 ledger (`market`), can be replayed. */
export function pairReplayAvailableIn(market, pair) {
  return market === "台股"
    && pair?.market === "台股"
    && pair?.trade_type === "當沖"
    && replayClockSeconds(replayEntryRef(pair)) !== null
    && replayClockSeconds(replayExitRef(pair)) !== null;
}

function clampMinute(minute) {
  return Math.max(0, Math.min(REPLAY_MINUTES - 1, Math.round(Number(minute) || 0)));
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The pair's entry and exit minutes and side, as the charts mark them. */
export function replayTradeSpan(pair) {
  return {
    entryMinute: clampMinute(replayMinuteOf(replayEntryRef(pair)) ?? 0),
    exitMinute: clampMinute(replayMinuteOf(replayExitRef(pair)) ?? REPLAY_MINUTES - 1),
    long: !isShortDirection(pair?.direction),
  };
}

/** A minute series (index = chart minute) of the last positive price of each minute's points up to `untilMinute`
 * (the replay time), null where none. */
export function replayMinuteSeries(points, untilMinute = REPLAY_MINUTES - 1) {
  const series = new Array(REPLAY_MINUTES).fill(null);
  for (const point of Array.isArray(points) ? points : []) {
    const minute = replayMinuteOf(point?.time || point?.datetime);
    const price = positive(point?.price ?? point?.close);
    if (minute === null || minute < 0 || minute > untilMinute || minute >= REPLAY_MINUTES || price === null) continue;
    series[minute] = price;
  }
  return series;
}

function lastOf(series) {
  for (let index = series.length - 1; index >= 0; index -= 1) if (series[index] !== null) return series[index];
  return null;
}

/** A card's quote (價格 漲跌 漲跌幅) and the class it is coloured by (漲紅、跌綠、平盤白). */
export function replayQuote(value, reference) {
  if (value === null) return { valueText: "--", changeText: "", pctText: "", toneClass: "price-flat" };
  if (reference === null) return { valueText: replayLevelText(value), changeText: "", pctText: "", toneClass: "price-flat" };
  const change = Number((value - reference).toFixed(2));
  return {
    valueText: replayLevelText(value),
    changeText: Math.abs(change).toFixed(2),
    pctText: `${Math.abs(change / reference * 100).toFixed(2)}%`,
    toneClass: MarketPriceColorPolicy.cssClass(value, reference),
  };
}

/**
 * 走勢資訊 at the replay minute: the 個股, 加權 and 產業指數 lines, each a minute series of its change from its own
 * 昨收 in percent (so the three share one axis), with the corner quote of each. An index without levels that day
 * carries `note` instead of a line. `indexes` is {market, industry}, each {name, prevClose, points, note}.
 */
export function replayOverlayAt({ stockPoints, stockPrevClose, stockName, indexes, untilMinute }) {
  const line = (key, name, points, prevClose, note = "") => {
    const levels = replayMinuteSeries(points, untilMinute);
    const reference = positive(prevClose);
    const pct = levels.map((value) => (value === null || reference === null ? null : (value - reference) / reference * 100));
    return { key, name, note, pct, quote: replayQuote(lastOf(levels), reference), drawn: !note && pct.some((value) => value !== null) };
  };
  const lines = [
    line("market", indexes?.market?.name || "加權", indexes?.market?.points, indexes?.market?.prevClose, indexes?.market?.note || ""),
    line("industry", indexes?.industry?.name || "產業指數", indexes?.industry?.points, indexes?.industry?.prevClose, indexes?.industry?.note || ""),
    line("stock", stockName, stockPoints, stockPrevClose),
  ];
  const values = lines.flatMap((item) => (item.drawn ? item.pct.filter((value) => value !== null) : []));
  const most = Math.max(0.5, ...values.map((value) => Math.abs(value)));
  return { lines, range: Number((most * 1.1).toFixed(3)) };
}

/** The stock's 1-minute bars from the replay's trend points (each minute's open / high / low / close and volume). */
export function replayMinuteBars(points) {
  const bars = new Array(REPLAY_MINUTES).fill(null);
  for (const point of Array.isArray(points) ? points : []) {
    const minute = replayMinuteOf(point?.time || point?.datetime);
    if (minute === null || minute < 0 || minute >= REPLAY_MINUTES) continue;
    const open = positive(point?.open), high = positive(point?.high), low = positive(point?.low), close = positive(point?.close ?? point?.price);
    if ([open, high, low, close].some((value) => value === null)) continue;
    bars[minute] = { open, high, low, close, volume: Number(point?.minute_volume ?? point?.volume) || 0 };
  }
  return bars;
}

/**
 * The `minutes`-minute K bars from the minute bars, grouped from 09:00 in fixed chunks (Rust B's fixed K rule: a
 * chunk's first traded open, its high, its low, its last close, the sum of its volume). Chunks without a trade are not
 * bars. With the scale the card draws them on (their range, 昨收 included, and the largest volume).
 */
export function replayKBars(minuteBars, minutes = REPLAY_DEFAULT_KBAR_MINUTES, prevClose = null) {
  const size = REPLAY_KBAR_MINUTES.includes(Number(minutes)) ? Number(minutes) : REPLAY_DEFAULT_KBAR_MINUTES;
  const bars = [];
  for (let start = 0; start < REPLAY_MINUTES; start += size) {
    let bar = null;
    for (let at = start; at < Math.min(start + size, REPLAY_MINUTES); at += 1) {
      const one = minuteBars[at];
      if (!one) continue;
      if (!bar) bar = { minute: start, open: one.open, high: one.high, low: one.low, close: one.close, volume: 0 };
      bar.high = Math.max(bar.high, one.high);
      bar.low = Math.min(bar.low, one.low);
      bar.close = one.close;
      bar.volume += one.volume;
    }
    if (bar) bars.push(bar);
  }
  const prices = bars.flatMap((bar) => [bar.high, bar.low]);
  if (positive(prevClose) !== null) prices.push(Number(prevClose));
  return {
    bars, size,
    scale: {
      low: prices.length ? Math.min(...prices) : 0,
      high: prices.length ? Math.max(...prices) : 0,
      volume: bars.reduce((most, bar) => Math.max(most, bar.volume), 0),
    },
  };
}

/** 買賣報價: five rows of 買量｜買價｜賣價｜賣量 from the replay's book, each volume's share of the largest, the prices'
 * colour against 昨收, the level the last trade printed at, and the two sides' totals; null without a book. */
export function replayBook(book, lastPrice, prevClose) {
  const list = (values) => (Array.isArray(values) ? values : []);
  const bidPrices = list(book?.bid_prices), bidVolumes = list(book?.bid_volumes);
  const askPrices = list(book?.ask_prices), askVolumes = list(book?.ask_volumes);
  if (!bidPrices.length && !askPrices.length) return null;
  const last = positive(lastPrice);
  const reference = positive(prevClose);
  const volumes = [...bidVolumes.slice(0, 5), ...askVolumes.slice(0, 5)].map((value) => Number(value) || 0);
  const most = Math.max(1, ...volumes);
  const level = (price, volume) => {
    const value = positive(price);
    const size = Number(volume) || 0;
    return {
      priceText: value === null ? "--" : replayLevelText(value),
      toneClass: MarketPriceColorPolicy.cssClass(value, reference),
      isLast: value !== null && last !== null && Math.abs(value - last) < 1e-6,
      volume: size,
      share: Math.round(size / most * 100),
    };
  };
  const rows = [0, 1, 2, 3, 4].map((index) => ({
    bid: level(bidPrices[index], bidVolumes[index]),
    ask: level(askPrices[index], askVolumes[index]),
  }));
  const bidTotal = rows.reduce((sum, row) => sum + row.bid.volume, 0);
  const askTotal = rows.reduce((sum, row) => sum + row.ask.volume, 0);
  return { rows, bidTotal, askTotal, bidShare: bidTotal + askTotal > 0 ? Math.round(bidTotal / (bidTotal + askTotal) * 100) : 50 };
}

/** 成交明細: the newest prints first (the tape's own rules, tape_rows.js -- no 試撮 print, the 大單 mark from the same
 * view's flow), each with its change from 昨收. */
export function replayTape(trades, prevClose, tradeflow, count = REPLAY_TAPE_ROWS) {
  const isLarge = largePrintMatcher(normalizeRustTradeFlow(tradeflow || {}));
  const reference = positive(prevClose);
  return (Array.isArray(trades) ? trades : []).filter(isTapePrint).slice(-count).reverse().map((tick, index) => {
    const row = tapeRow(tick, isLarge(tick));
    const change = reference === null || row.price === null ? null : Number((row.price - reference).toFixed(2));
    return { ...row, key: String(row.ingestSequence || `i${index}`), change };
  });
}

/** The position at the replay time: 未進場 before the entry, holding up to the exit, 已出場 from it on; the 價差 per
 * share, the net P&L as if closed at the last trade (from the exit on, the pair's realized profit) and that P&L on the
 * entry amount. Times are seconds of the day. */
export function replayPosition(pair, second, lastPrice) {
  const entry = replayClockSeconds(replayEntryRef(pair));
  const exit = replayClockSeconds(replayExitRef(pair));
  if (second === null || entry === null || second < entry) return { state: "未進場", perShare: null, pnl: null, roi: null };
  const exited = exit !== null && second >= exit;
  const price = positive(exited ? replayExitPrice(pair) : lastPrice);
  const entryPrice = replayEntryPrice(pair);
  const perShare = price !== null && Number.isFinite(entryPrice) && entryPrice > 0
    ? (isShortDirection(pair?.direction) ? entryPrice - price : price - entryPrice)
    : null;
  const realized = Number(pair?.profit);
  const pnl = exited && Number.isFinite(realized) ? realized : price !== null ? pairNetAtPrice(pair, price) : null;
  const entryAmount = entryPrice * Number(pair?.qty);
  return {
    state: exited ? "已出場" : isShortDirection(pair?.direction) ? "持有空單" : "持有多單",
    perShare, pnl, roi: pnl !== null && entryAmount > 0 ? pnl / entryAmount : null,
  };
}
