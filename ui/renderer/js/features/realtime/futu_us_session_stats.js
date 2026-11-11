// The figures of one Futu US tab, from the minutes inside its window (futu_us_trend_window.js, New York time, so summer
// and winter time need nothing here): 最高, 最低, 均價 and 振幅 count only what traded in that window; 總量 is usWindowVolume
// (decisions.md 富途的量).

import { numberOrNull } from "../../core/numbers.js";

const positive = (value) => {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
};

// A minute that traded, by Rust B's rule (`Minute::traded`): it has a price and B did not mark it `synthetic` (a minute
// with no print, or only odd-lot / average-price prints, repeats the last price and would widen the window's range).
const traded = (row) => !row?.synthetic && positive(row?.close) !== null;

/** Each row with `average_price` replaced by the window's own running average: amount over volume since its first row. */
export function withWindowAverage(rows = []) {
  let amount = 0, volume = 0;
  return rows.map((row) => {
    const rowAmount = positive(row?.amount), rowVolume = positive(row?.volume);
    if (rowAmount !== null && rowVolume !== null) { amount += rowAmount; volume += rowVolume; }
    return { ...row, average_price: volume > 0 ? amount / volume : null };
  });
}

// The 日盤 part of a date, 04:00 to 20:00 New York; the rest is 夜盤, which no quote covers.
const inDayPart = (minute) => minute >= 240 && minute < 1200;

// The prints reach only some exchanges, so 日盤's volume is its newest quote's cumulative total, the prints' sum only
// before the first quote; 夜盤 is the prints' sum; 全日 is the two added.
function usWindowVolume(rows) {
  let night = 0, dayPrints = 0, dayQuote = null;
  for (const row of rows) {
    if (inDayPart(row?.minute)) dayQuote = positive(row?.quote_total_volume) ?? dayQuote;
    if (!traded(row)) continue;
    if (inDayPart(row.minute)) dayPrints += positive(row.volume);
    else night += positive(row.volume);
  }
  return night + (dayQuote ?? dayPrints);
}

/** `{high, low, volume, average, last}` of the window's rows, each null while nothing has traded in it. */
export function usWindowFigures(rows = []) {
  let high = null, low = null, amount = 0, amountVolume = 0, last = null;
  for (const row of rows) {
    if (!traded(row)) continue;
    const close = positive(row.close), size = positive(row.volume), rowAmount = positive(row.amount);
    high = Math.max(high ?? close, positive(row.high) ?? close);
    low = Math.min(low ?? close, positive(row.low) ?? close);
    if (rowAmount !== null) { amount += rowAmount; amountVolume += size; }
    last = close;
  }
  return { high, low, volume: last === null ? null : usWindowVolume(rows), average: amountVolume > 0 ? amount / amountVolume : null, last };
}

/** The last traded close before minute `from` among one partition's rows; null when nothing traded before it. */
export function lastCloseBefore(rows = [], from) {
  let close = null, at = -1;
  for (const row of rows) {
    if (row?.minute < from && row.minute > at && traded(row)) {
      close = positive(row.close);
      at = row.minute;
    }
  }
  return close;
}

/** 開盤 goes by the session trading now (Rust A's `phase`): the regular open from 09:30 until 20:00, else none. */
export function usShownOpen(us, open) {
  return us?.phase === "regular" || us?.phase === "after" ? positive(open) : null;
}

/** The price a tab measures against. 夜盤: the last trade before its 20:00 open. The others: until the regular session
 * closes its 昨收, from then on (`phase` after / overnight / closed) the last trade before that close. */
export function usWindowReference(tab, rows = [], window, prevClose, us = null) {
  if (tab === "overnight") {
    const open = window?.parts?.[0];
    return lastCloseBefore(rows.filter((row) => row?.trading_date === open?.trading_date), open?.from) ?? positive(prevClose);
  }
  if (!us || us.phase === "pre" || us.phase === "regular") return positive(prevClose);
  const date = us.windows?.day?.[0]?.trading_date;
  return lastCloseBefore(rows.filter((row) => row?.trading_date === date), us.day_regular_close) ?? positive(prevClose);
}

/** 漲跌, 漲幅 (percent) and 振幅 (percent) of the figures against `reference`; null where either side is unknown. */
export function usWindowMoves(figures, reference) {
  const ref = positive(reference);
  if (ref === null || figures?.last === null || figures?.last === undefined) return { change: null, changePct: null, amplitude: null };
  const change = figures.last - ref;
  return { change, changePct: (change / ref) * 100, amplitude: ((figures.high - figures.low) / ref) * 100 };
}
