import { readFileSync } from "node:fs";
// 技術分析: today's candles come from Market Runtime as they are -- 1m from the minute trend, 3/5/15/30/60m from
// Rust B's fixed_k, the day's own OHLCV for D/W/M -- and minutes without a trade are not candles. Earlier days are folded
// here from history_api's rows, the same way. The header code box and its session rule.
import assert from "node:assert/strict";
import { simpleMovingAverage } from "../ui/renderer/js/core/trend/kline_chart.js";
import { productQuoteSearchHtml } from "../ui/renderer/js/core/components/product_quote_search.js";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { foldBars, historyDayBars, periodBars, technicalBars, TECHNICAL_TIMEFRAMES } = await import("../ui/renderer/js/features/realtime/technical_series.js");
const { TechnicalHistory } = await import("../ui/renderer/js/features/realtime/technical_history.js");
await import("../ui/renderer/js/features/realtime/components/technical_analysis_component.js");

const state = {
  trend: [
    { minute: 541, open: 10, high: 11, low: 9.5, close: 10.5, minute_volume: 7 },
    { minute: 540, open: null, high: null, low: null, close: null, minute_volume: null },
    { minute: 542, open: 10.5, high: 10.6, low: 10.4, close: 10.4, minute_volume: 3 },
  ],
  day: { fixed_k: { k5: [
    { start_minute: 540, end_minute: 544, open: 10, high: 11, low: 9.5, close: 10.4, volume: 10 },
    { start_minute: 545, end_minute: 549, open: null, high: null, low: null, close: null, volume: 0 },
  ] } },
};
assert.deepEqual(technicalBars(state, "1").map((bar) => [bar.label, bar.close, bar.volume]), [["09:01", 10.5, 7], ["09:02", 10.4, 3]],
  "1m: traded minutes only, in time order");
assert.deepEqual(technicalBars(state, "5").map((bar) => [bar.label, bar.open, bar.high, bar.low, bar.close, bar.volume]),
  [["09:00", 10, 11, 9.5, 10.4, 10]], "5m: B's fixed_k bar, the untraded one dropped");
assert.deepEqual(technicalBars({}, "15"), []);

assert.deepEqual(TECHNICAL_TIMEFRAMES.map(([key]) => key), ["1", "3", "5", "15", "30", "60", "D", "W", "M"]);

// A no-trade minute Market Runtime filled in is not a candle: 1m shows what 5m and the history show.
assert.deepEqual(technicalBars({ trend: [{ minute: 805, open: 10, high: 10, low: 10, close: 10, minute_volume: 0, synthetic: true }] }, "1"), []);

// 60m is one more of B's fixed K.
assert.deepEqual(technicalBars({ day: { fixed_k: { k60: [{ start_minute: 600, open: 1, high: 2, low: 1, close: 2, volume: 9 }] } } }, "60", "2026-11-06")
  .map((bar) => [bar.key, bar.label, bar.crosshairLabel]), [["2026-11-06|600", "10:00", "11/06 10:00"]]);

// D/W/M: today is the session's own OHLCV (with its auctions); nothing traded yet is no bar.
assert.deepEqual(technicalBars({ day: { open: 10, high: 12, low: 9, close: 11, volume: 5 } }, "W", "2026-11-06"),
  [{ trading_date: "2026-11-06", open: 10, high: 12, low: 9, close: 11, volume: 5 }]);
assert.deepEqual(technicalBars({ day: { open: null, high: null, low: null, close: null, volume: 0 } }, "D", "2026-11-06"), []);

// One fold: an untraded row only adds its volume; a group of untraded rows is no candle.
assert.deepEqual(foldBars([
  { open: null, high: null, low: null, close: null, volume: 2, g: 1 },
  { open: 10, high: 12, low: 9, close: 11, volume: 3, g: 1 },
  { open: 11, high: 15, low: 8, close: 14, volume: 4, g: 1 },
  { open: null, high: null, low: null, close: null, volume: 1, g: 2 },
], (row) => row.g).map(({ key, open, high, low, close, volume }) => [key, open, high, low, close, volume]), [[1, 10, 15, 8, 14, 9]]);

// History's N-minute buckets are counted from the session start as B counts its fixed K: 09:00-09:04, 09:05-09:09...
{
  const stock = [[[540, 810]]];
  const day = { trading_date: "2026-11-05", timeframe: 1, bars: [
    [541, 100, 101, 99, 100.5, 3], [544, 100.5, 102, 100, 101, 4], [545, 101, 103, 100, 102, 5], [800, 90, 90, 90, 90, 1],
  ] };
  assert.deepEqual(historyDayBars(day, "5", stock).map((bar) => [bar.key, bar.open, bar.high, bar.low, bar.close, bar.volume]), [
    ["2026-11-05|540", 100, 102, 99, 101, 7], ["2026-11-05|545", 101, 103, 100, 102, 5], ["2026-11-05|800", 90, 90, 90, 90, 1]]);
  assert.deepEqual(historyDayBars(day, "60", stock).map((bar) => bar.label), ["09:00", "13:00"]);
  assert.deepEqual(historyDayBars(day, "3", stock).map((bar) => bar.minute), [540, 543, 798], "3 minutes comes from the 1-minute rows");

  // A day aged to a coarser timeframe shows only the timeframes that timeframe divides.
  const aged = { trading_date: "2026-08-05", timeframe: 5, bars: [[540, 1, 2, 1, 2, 3], [545, 2, 3, 2, 3, 4], [555, 3, 3, 3, 3, 5]] };
  assert.deepEqual(historyDayBars(aged, "1", stock), []);
  assert.deepEqual(historyDayBars(aged, "3", stock), [], "no 3-minute candles from 5-minute rows");
  assert.deepEqual(historyDayBars(aged, "5", stock).map((bar) => bar.minute), [540, 545, 555]);
  assert.deepEqual(historyDayBars(aged, "15", stock).map((bar) => [bar.minute, bar.open, bar.close, bar.volume]), [[540, 1, 3, 7], [555, 3, 3, 5]]);

  // A bar counts trading minutes: the lunch break does not shift it (Rust B's buckets, kbar_store.rs).
  const lunch = { trading_date: "2026-11-05", timeframe: 1, bars: [[719, 1, 1, 1, 1, 1], [780, 2, 2, 2, 2, 1], [810, 3, 3, 3, 3, 1]] };
  assert.deepEqual(historyDayBars(lunch, "60", [[[570, 719], [780, 969]]]).map((bar) => [bar.minute, bar.volume]), [[690, 2], [810, 1]]);
}

// Weekly and monthly from daily bars, today folded into the week and month it belongs to.
{
  const daily = [
    { trading_date: "2026-10-30", open: 90, high: 95, low: 89, close: 94, volume: 1 },
    { trading_date: "2026-11-02", open: 94, high: 96, low: 93, close: 95, volume: 2 },
    { trading_date: "2026-11-06", open: 95, high: 99, low: 92, close: 98, volume: 3 },
  ];
  const pick = (bars) => bars.map((bar) => [bar.key, bar.open, bar.high, bar.low, bar.close, bar.volume]);
  assert.deepEqual(pick(periodBars(daily, "W")), [["2026-10-26", 90, 95, 89, 94, 1], ["2026-11-02", 94, 99, 92, 98, 5]]);
  assert.deepEqual(pick(periodBars(daily, "M")), [["2026-10", 90, 95, 89, 94, 1], ["2026-11", 94, 99, 92, 98, 5]]);
  assert.deepEqual(pick(periodBars(daily, "D")).map((row) => row[0]), ["2026-10-30", "2026-11-02", "2026-11-06"]);
}

// The pages: asked strictly before today, then from where the last one ended; older pages go in front.
{
  const asked = [];
  const answers = [
    { segments: [[[540, 810]]], days: [{ trading_date: "2026-11-05", timeframe: 1, bars: [[540, 1, 1, 1, 1, 1]] }], next_before: "2026-11-05" },
    { segments: [[[540, 810]]], days: [{ trading_date: "2026-11-04", timeframe: 1, bars: [[540, 2, 2, 2, 2, 2]] }], next_before: null },
  ];
  const history = new TechnicalHistory(async (query) => { asked.push(query); return answers.shift(); });
  history.reset("2330", "2026-11-06");
  assert.equal(await history.loadOlder("5"), true);
  assert.equal(await history.loadOlder("15"), true, "every minute timeframe reads the same pages");
  assert.deepEqual(asked.map((query) => query.before), ["2026-11-06", "2026-11-05"]);
  assert.equal(await history.loadOlder("5"), false, "nothing older: not asked again");
  assert.equal(asked.length, 2);

  const today = technicalBars({ trend: [{ minute: 540, open: 3, high: 3, low: 3, close: 3, minute_volume: 3 }] }, "1", "2026-11-06");
  const series = history.series("1", today);
  assert.deepEqual(series.map((bar) => bar.key), ["2026-11-04|540", "2026-11-05|540", "2026-11-06|540"], "history, then today's");
  assert.deepEqual(series.map((bar) => bar.dayLabel), ["11/04", "11/05", "11/06"], "each day's first bar names its date");
  assert.strictEqual(history.intradayBars("1"), history.intradayBars("1"), "built once per version of the pages");
}

// No history: today's alone, as before.
{
  const history = new TechnicalHistory(null);
  history.reset("2330", "2026-11-06");
  const today = technicalBars({ trend: [{ minute: 540, open: 3, high: 3, low: 3, close: 3, minute_volume: 3 }] }, "1", "2026-11-06");
  assert.strictEqual(history.series("1", today), today);
  assert.equal(today[0].dayStart, undefined, "a chart of one day has no day separator");
}

// An answer for the product before the current one is dropped; a failed read is not retried in a loop.
{
  let release;
  const stale = new TechnicalHistory(() => new Promise((resolve) => { release = resolve; }));
  stale.reset("2330", "2026-11-06");
  const pending = stale.loadOlder("D");
  stale.reset("2317", "2026-11-06");
  release({ bars: [{ trading_date: "2026-11-05", open: 1, high: 1, low: 1, close: 1, volume: 1 }], next_before: null });
  assert.equal(await pending, false);
  assert.deepEqual(stale.daily, []);

  let calls = 0;
  const quiet = console.warn;
  console.warn = () => {};
  const failing = new TechnicalHistory(async () => { calls += 1; throw new Error("down"); });
  failing.reset("2330", "2026-11-06");
  assert.equal(await failing.loadOlder("D"), false);
  assert.equal(await failing.loadOlder("D"), false);
  console.warn = quiet;
  assert.equal(calls, 1);
}

assert.deepEqual(simpleMovingAverage([1, 2, 3, 4].map((close) => ({ close })), 3), [null, null, 2, 3]);

// The search box is input only: it reads no clock.
assert.doesNotMatch(readFileSync(new URL("../ui/renderer/js/core/components/product_quote_search.js", import.meta.url), "utf8"),
  /Asia\/Taipei|new Date\(/, "product_quote_search reads no clock");
assert.match(productQuoteSearchHtml("shioaji"), /data-product-search="shioaji"[\s\S]*product-quote-code-input/);
assert.equal(productQuoteSearchHtml(""), "", "加權 / 期貨 headers have no box");
console.log("renderer technical analysis contract ok");

// N03: 技術分析 drew its candles over a full, CSS-hidden 個股走勢 line chart that was still built, projected and
// re-rendered on every update. Its surface now runs without the line chart.
{
  const fs = await import("node:fs");
  globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const { TrendChartComponent } = await import("../ui/renderer/js/core/components/trend_chart_component.js");
  const surface = new TrendChartComponent({ dataKey: "stockTrend", variant: "stock", lineChart: false });
  surface.host = { querySelector: () => null, querySelectorAll: () => [], dataset: {}, firstElementChild: null };
  surface.canvas = { getBoundingClientRect: () => ({ width: 300 }), dataset: {} };
  surface.update({ symbol: "2330", points: [{ minute: 540, price: 100 }, { minute: 541, price: 101 }], prevClose: 99 });
  assert.equal(surface.manager, null, "no line chart is built behind the candles");
  const source = fs.readFileSync(new URL("../ui/renderer/js/features/realtime/components/technical_analysis_component.js", import.meta.url), "utf8");
  assert.match(source, /new TrendChartComponent\(\{[^}]*lineChart: false/, "技術分析 uses the surface without its line chart");
}
console.log("renderer technical analysis line-chart-free contract ok");
