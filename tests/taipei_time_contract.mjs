// Taiwan market time and the exchange clock: one parser for every feature, the same answers in any machine zone.
import assert from "node:assert/strict";

process.env.TZ = "America/New_York";  // far from Taipei, with daylight saving: a machine-zone read would show
globalThis.window ??= {};
globalThis.document ??= { getElementById: () => null, addEventListener() {} };

const t = await import("../ui/renderer/js/market_data/taipei_time.js");

// Timestamps: naive text is Taipei wall-clock; an offset is honoured; anything else is null.
const at = Date.parse("2026-10-22T09:30:00+08:00");
for (const text of ["2026-10-22T09:30:00", "2026-10-22 09:30:00", "2026-10-22T09:30:00+08:00", "2026-10-22T01:30:00Z", "2026-10-22T09:30"]) {
  assert.equal(t.parseTaipeiTimestampMs(text), at, text);
}
assert.equal(t.parseTaipeiTimestampMs("2026-10-22"), Date.parse("2026-10-22T00:00:00+08:00"));
for (const bad of ["", null, undefined, "09:30", "yesterday", "2026-13-40T99:99:99"]) assert.equal(t.parseTaipeiTimestampMs(bad), null, String(bad));

// Parts / date key / clock text are Taipei's.
const late = Date.parse("2026-10-22T23:59:30+08:00");
assert.deepEqual(t.taipeiParts(late), { year: 2026, month: 10, day: 22, hour: 23, minute: 59, second: 30, secondsOfDay: 86370 });
assert.equal(t.taipeiDateKey(late), "2026-10-22");
assert.equal(t.taipeiDateKey(late + 60_000), "2026-10-23");
assert.equal(t.taipeiClockText(late), "23:59");
assert.equal(t.taipeiClockText(late, { seconds: true }), "23:59:30");
assert.equal(t.taipeiClockText(Number.NaN), "--");
assert.equal(t.taipeiDayStartMs(late), Date.parse("2026-10-22T00:00:00+08:00"));

// The exchange clock: one validated shape for every caller.
const clockCases = [
  ["09:05", { hour: 9, minute: 5, second: 0, secondsOfDay: 32700 }],
  ["9:05:07", { hour: 9, minute: 5, second: 7, secondsOfDay: 32707 }],
  ["13:30:00.123456", { hour: 13, minute: 30, second: 0, secondsOfDay: 48600 }],
  ["2026-10-22T09:05:07", { hour: 9, minute: 5, second: 7, secondsOfDay: 32707 }],
  ["2026-10-22 09:05:07", { hour: 9, minute: 5, second: 7, secondsOfDay: 32707 }],
  ["2026-10-22T09:05:07+08:00", { hour: 9, minute: 5, second: 7, secondsOfDay: 32707 }],
];
for (const [text, want] of clockCases) assert.deepEqual(t.parseExchangeClock(text), want, text);
for (const bad of ["", null, "24:00", "12:60", "12:00:60", "abc", "1205", "x 09:05"]) assert.equal(t.parseExchangeClock(bad), null, String(bad));

// The features read the clock through it: the same input gives the same answer everywhere.
const { replayClockSeconds } = await import("../ui/renderer/js/features/account/analytics.js");
const { normalizeHistoryClockText } = await import("../ui/renderer/js/features/history/history_values.js");
for (const [text, want] of clockCases) {
  assert.equal(replayClockSeconds(text), want.secondsOfDay, text);
  assert.equal(normalizeHistoryClockText(text), [want.hour, want.minute, want.second].map((n) => String(n).padStart(2, "0")).join(":"), text);
}
assert.equal(replayClockSeconds("25:00"), null);
assert.equal(normalizeHistoryClockText("25:00"), "");

console.log("taipei time contract ok");
