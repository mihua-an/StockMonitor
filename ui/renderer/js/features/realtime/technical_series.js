// 技術分析's candles, as data. Today's come from Market Runtime as they are (the minute trend, Rust B's fixed K, the
// session's OHLCV in `day`); the earlier local days come from history_api at the timeframe each is held (older days are
// coarser) or as daily bars, and this is the one place that folds those rows into the candle the chosen timeframe shows.
import { numberOrNull as finite } from "../../core/numbers.js";

export const TECHNICAL_TIMEFRAMES = Object.freeze([["1", "1分"], ["3", "3分"], ["5", "5分"], ["15", "15分"], ["30", "30分"], ["60", "60分"],
  ["D", "日"], ["W", "週"], ["M", "月"]]);

/** What a timeframe reads from history: minute rows, or daily bars. */
export function timeframeResolution(timeframe) {
  return Number.isFinite(Number(timeframe)) ? "minute" : "day";
}

function clock(minute) {
  const m = Number(minute);
  return Number.isFinite(m) ? `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` : "--";
}

const monthDay = (date) => date.slice(5).replace("-", "/");
const fullDate = (date) => date.replaceAll("-", "/");

function intradayBar(date, minute, ohlc, volume) {
  return { key: `${date}|${minute}`, label: clock(minute), crosshairLabel: date ? `${monthDay(date)} ${clock(minute)}` : clock(minute),
    minute: Number(minute), ...ohlc, volume };
}

function ohlcOf(raw) {
  const open = finite(raw?.open), high = finite(raw?.high), low = finite(raw?.low), close = finite(raw?.close);
  return [open, high, low, close].some((value) => value == null) ? null : { open, high, low, close };
}

/** Today's candles of one timeframe from a canonical view state. Minutes / bars without a trade are not candles. */
export function technicalBars(state = {}, timeframe = "5", date = "") {
  const key = String(timeframe);
  if (timeframeResolution(key) === "day") {
    const ohlc = ohlcOf(state?.day);
    return ohlc && date ? [{ trading_date: date, ...ohlc, volume: finite(state.day.volume) ?? 0 }] : [];
  }
  const toBar = (raw, minute, volume) => {
    const ohlc = ohlcOf(raw);
    return ohlc ? intradayBar(date, minute, ohlc, finite(volume) ?? 0) : null;
  };
  if (key === "1") {
    return (Array.isArray(state?.trend) ? state.trend : [])
      .filter((point) => !point?.synthetic)
      .map((point) => toBar(point, point?.minute, point?.minute_volume ?? point?.volume))
      .filter(Boolean)
      .sort((a, b) => a.minute - b.minute);
  }
  const rows = state?.day?.fixed_k?.[`k${key}`];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => toBar(row, row?.start_minute, row?.volume))
    .filter(Boolean);
}

/**
 * Rows folded into one candle per group, in the order the groups first appear: first open, highest high, lowest low,
 * last close of the rows that traded, and every row's volume (a minute of odd lots only has volume and no price, as
 * in Rust B's fixed K). A group where nothing traded is not a candle.
 */
export function foldBars(rows, groupOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupOf(row);
    const group = groups.get(key);
    if (group) group.rows.push(row); else groups.set(key, { key, rows: [row] });
  }
  const out = [];
  for (const { key, rows: members } of groups.values()) {
    const traded = members.filter((row) => row.open != null && row.high != null && row.low != null && row.close != null);
    if (!traded.length) continue;
    out.push({ key, first: traded[0], open: traded[0].open, close: traded.at(-1).close,
      high: Math.max(...traded.map((row) => row.high)), low: Math.min(...traded.map((row) => row.low)),
      volume: members.reduce((sum, row) => sum + (Number(row.volume) || 0), 0) });
  }
  return out;
}

/** The first minute of the n-minute bar holding `minute`: bars count trading minutes from their segment's first, as Rust
 * B's fixed K do. `segments` is each business session's trading intervals. */
function bucketStart(minute, n, segments) {
  for (const intervals of segments) {
    let position = 0;
    for (const [from, to] of intervals) {
      if (minute >= from && minute <= to) {
        let offset = Math.floor((position + minute - from) / n) * n;
        for (const [a, b] of intervals) {
          if (offset <= b - a) return a + offset;
          offset -= b - a + 1;
        }
      }
      position += to - from + 1;
    }
  }
  return minute;
}

/** One history day's rows ([minute, open, high, low, close, volume], at `day.timeframe`) as N-minute candles. A bar can
 * only be made from finer ones that divide it: a day held at 5 minutes has no 1- or 3-minute candles. */
export function historyDayBars(day, minutes, segments) {
  const n = Number(minutes);
  if (n % day.timeframe !== 0) return [];
  const rows = day.bars.map(([minute, open, high, low, close, volume]) => ({ minute, open, high, low, close, volume }));
  return foldBars(rows, (row) => bucketStart(row.minute, n, segments)).map((bar) =>
    intradayBar(day.trading_date, bar.key, { open: bar.open, high: bar.high, low: bar.low, close: bar.close }, bar.volume));
}

function mondayOf(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Daily bars ({trading_date, open, high, low, close, volume}, oldest first) as candles of D, W or M. */
export function periodBars(daily, timeframe) {
  if (timeframe === "D") {
    return daily.map((row) => ({ key: row.trading_date, label: monthDay(row.trading_date), crosshairLabel: fullDate(row.trading_date),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: Number(row.volume) || 0 }));
  }
  const weekly = timeframe === "W";
  return foldBars(daily, (row) => (weekly ? mondayOf(row.trading_date) : row.trading_date.slice(0, 7))).map((bar) => ({
    key: bar.key, label: weekly ? monthDay(bar.first.trading_date) : fullDate(bar.key),
    crosshairLabel: weekly ? `${fullDate(bar.first.trading_date)} 當週` : fullDate(bar.key),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
  }));
}

/** A day's first candle in a chart of several days: the axis shows its date and a line separates the days. */
export function markDayStart(bar, date) {
  return bar ? { ...bar, dayStart: true, dayLabel: monthDay(date) } : bar;
}
