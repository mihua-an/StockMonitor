import assert from "node:assert/strict";

// 買賣報價 H/L: the day high/low come from the summary (canonical high/low). A book carrying its own older
// day_high used to win and put 「H」 at the day's low (50.00).
const { StockOrderBookAdapter } = await import("../ui/renderer/js/core/orderbook_adapters.js");

const book = { bid_prices: [50, 49.95], bid_volumes: [3, 4], ask_prices: [50.05, 50.1], ask_volumes: [5, 6] };
const summary = { high: 51.2, low: 50, current: 50.05 };

const stale = StockOrderBookAdapter.build({ code: "2344", signal: summary, book: { ...book, day_high: 50, day_low: 48 } });
assert.equal(stale.dayHigh, 51.2, "a book's own day_high never overrides the canonical high");
assert.equal(stale.dayLow, 50);

// A legacy signal field (day_high) loses to the canonical summary field (high) merged over it.
const legacy = StockOrderBookAdapter.build({ code: "2344", signal: { day_high: 50, day_low: 47, ...summary }, book });
assert.deepEqual([legacy.dayHigh, legacy.dayLow], [51.2, 50]);

// Without a summary figure the book's is still used, and nothing is invented.
assert.deepEqual([StockOrderBookAdapter.build({ code: "2344", book: { ...book, day_high: 52, day_low: 49 } }).dayHigh,
  StockOrderBookAdapter.build({ code: "2344", book }).dayHigh], [52, null]);

// Pre-open (1802 台玻 #72.20): no day high / low yet, and the empty ask levels carry price 0. Number(null)
// is 0, so every empty row was marked 「H」 (and would have been 「L」). Only a real price equals a real extreme.
const { extremeMarker } = await import("../ui/renderer/js/core/components/orderbook_depth_table.js");
const marker = (...args) => extremeMarker(...args).replace(/<[^>]+>/g, "");
assert.equal(marker(0, null, null, 72, "ask"), "", "empty level, no high/low: no marker");
assert.equal(marker(null, null, null, 72, "ask"), "");
assert.equal(marker(72.2, null, null, 72, "ask"), "", "a price is not the high when there is no high yet");
assert.equal(marker(0, 0, 0, 72, "ask"), "", "0 is never a price");
assert.equal(marker(72.2, 72.2, 71.5, 72, "ask"), "H");
assert.equal(marker(71.5, 72.2, 71.5, 72, "bid"), "L");
console.log("orderbook day extremes contract ok");
