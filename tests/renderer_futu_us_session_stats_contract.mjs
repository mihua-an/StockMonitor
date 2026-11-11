// A Futu US tab's 資訊列 and 均價 count only the minutes inside the tab's window (user 11-09).
import assert from "node:assert/strict";

const { usShownOpen, usWindowFigures, usWindowMoves, usWindowReference, withWindowAverage } = await import("../ui/renderer/js/features/realtime/futu_us_session_stats.js");
const { usTrendWindow } = await import("../ui/renderer/js/features/realtime/futu_us_trend_window.js");

const row = (trading_date, minute, close, volume, amount, high = close, low = close, synthetic = false) => ({ trading_date, minute, close, volume, amount, high, low, synthetic });
const carried = (trading_date, minute, close, volume) => row(trading_date, minute, close, volume, null, close, close, true);
const day = [row("2026-11-09", 240, 10, 100, 1000, 11, 9), carried("2026-11-09", 241, 12, 0), row("2026-11-09", 242, 12, 300, 3600, 13, 11.5)];

const figures = usWindowFigures(day);
assert.deepEqual(figures, { high: 13, low: 9, volume: 400, average: 11.5, last: 12 });
assert.deepEqual(usWindowFigures([carried("2026-11-09", 241, 12, 0)]), { high: null, low: null, volume: null, average: null, last: null }, "no trade: no figures, not a range around a carried price");
// Odd-lot / average-price prints alone: B marks the minute synthetic -- it has volume but did not trade (decisions.md).
assert.deepEqual(usWindowFigures([carried("2026-11-09", 241, 12, 5)]), { high: null, low: null, volume: null, average: null, last: null }, "odd lots alone: not a traded minute");

// 總量 (decisions.md 富途的量): 日盤 is its newest quote's cumulative volume, the prints' sum before the first quote; 夜盤
// is the prints' sum; 全日 adds the two. A quote in a minute without a trade still counts.
const quoted = (trading_date, minute, close, volume, quote_total_volume) => ({ ...row(trading_date, minute, close, volume, null), quote_total_volume });
assert.equal(usWindowFigures([row("2026-11-09", 300, 10, 7, 70), quoted("2026-11-09", 570, 10, 5, 1000), quoted("2026-11-09", 960, 10, 5, 3000)]).volume, 3000, "日盤: the newest quote");
assert.equal(usWindowFigures([{ ...carried("2026-11-09", 961, 12, 0), quote_total_volume: 3100 }, row("2026-11-09", 300, 10, 7, 70)]).volume, 3100, "a quote in a minute that did not trade");
assert.equal(usWindowFigures([row("2026-11-08", 1300, 10, 40, 400), row("2026-11-09", 100, 10, 60, 600)]).volume, 100, "夜盤: the prints' sum");
assert.equal(usWindowFigures([row("2026-11-08", 1300, 10, 40, 400), row("2026-11-09", 300, 10, 7, 70), quoted("2026-11-09", 960, 10, 5, 3000)]).volume, 3040, "全日: 夜盤 + 日盤");

const moves = usWindowMoves(figures, 10);
assert.equal(moves.change, 2);
assert.equal(moves.changePct, 20);
assert.equal(moves.amplitude, 40);
assert.deepEqual(usWindowMoves(usWindowFigures([]), 10), { change: null, changePct: null, amplitude: null });

// Each minute carries the window's running average, and a minute with no amount keeps it rather than dropping the line.
assert.deepEqual(withWindowAverage(day).map((r) => r.average_price), [10, 10, 11.5]);
assert.equal(withWindowAverage([row("2026-11-09", 240, 10, 0, null)])[0].average_price, null, "nothing traded yet: no average");

// 夜盤 measures against the last trade before its 20:00 open; 日盤 and 全日 against 昨收 until the regular close, then
// against the last trade before that close.
// Monday 11-09 21:00 New York as Rust A sends it (session.current `us`).
const us = { phase: "overnight", day_regular_close: 960, windows: {
  day: [{ trading_date: "2026-11-09", from: 240, to: 1200 }],
  overnight: [{ trading_date: "2026-11-09", from: 1200, to: 1440 }, { trading_date: "2026-11-10", from: 0, to: 240 }],
  full: [{ trading_date: "2026-11-09", from: 1200, to: 1440 }, { trading_date: "2026-11-10", from: 0, to: 1200 }] } };
const span = usTrendWindow("overnight", us);
const all = [...day, row("2026-11-09", 959, 14, 10, 140), row("2026-11-09", 961, 14.5, 10, 145), row("2026-11-09", 1199, 15, 10, 150), row("2026-11-09", 1200, 16, 10, 160), row("2026-11-08", 959, 99, 10, 990)];
assert.equal(usWindowReference("overnight", all, span, 8, us), 15);
assert.equal(usWindowReference("overnight", [], span, 8, us), 8, "nothing before the open: the regular close");
for (const [phase, reference] of [["pre", 8], ["regular", 8], ["after", 14], ["overnight", 14], ["closed", 14]]) {
  const at = { ...us, phase };
  assert.equal(usWindowReference("day", all, usTrendWindow("day", at), 8, at), reference, `日盤 in ${phase}`);
  assert.equal(usWindowReference("full", all, usTrendWindow("full", at), 8, at), reference, `全日 in ${phase}`);
}
assert.equal(usWindowReference("day", all, usTrendWindow("day", us), 8, { ...us, day_regular_close: 780 }), 12, "a half day closes at 13:00");
assert.equal(usWindowReference("day", [], usTrendWindow("day", us), 8, us), 8, "no trade before the close: 昨收");

// 開盤: 09:30 until 20:00, by the session trading now.
for (const [phase, shown] of [["pre", null], ["regular", 100], ["after", 100], ["overnight", null], ["closed", null]]) {
  assert.equal(usShownOpen({ phase }, 100), shown, `開盤 in ${phase}`);
}
assert.equal(usShownOpen({ phase: "regular" }, null), null, "not known yet");
assert.equal(usShownOpen(null, 100), null, "before A has said");
console.log("renderer futu us session stats contract passed");
