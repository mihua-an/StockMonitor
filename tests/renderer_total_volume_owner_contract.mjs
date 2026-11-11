// 商品列「總量」只有一個來源：A product summary 的 total_volume。B 量變的單分鐘量、分析列或
// watch item 的量都不是當日累計量，A 還沒有總量時總量格是空的，不拿別的數字頂替。
import assert from "node:assert/strict";
import { mergeCanonicalStockSummary, mergeStockMarketSummary } from "../ui/renderer/js/market_data/stock_market_summary.js";
import { withProductRead } from "../ui/renderer/js/core/market_read_adapters.js";

globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
const { realtimeRowCells } = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
const { renderedCells } = await import("./lib/rendered_cells.mjs");
const totalCell = (row) => renderedCells(realtimeRowCells(withProductRead({ code: "2330", ...row }, "shioaji"), ["total_volume"]));

// B's 量變 block arrived (its completed minute traded 37) before A has a summary total.
const windowsOnly = mergeCanonicalStockSummary({}, {
  volume_baseline_source: "NATIVE_COMPLETED_CLOCK_MINUTE",
  baseline_volume: 50, current_volume: 37, volume: 37, volume_change_pct_vs_baseline: -26,
}, "2330");
assert.equal(windowsOnly.total_volume, undefined, "no A total is no total");
assert.equal(totalCell(windowsOnly), '<td class="">--</td>');

// Analysis rows and watch items carry volumes of their own; none of them is A's cumulative total.
const nonOwners = mergeStockMarketSummary({
  watchItem: { code: "2330", total_volume: 900, volume: 900 },
  productSummary: { code: "2330", current: 1000 },
  liveSignal: { code: "2330", total_volume: 37, current_volume: 37, volume: 37 },
});
assert.equal(nonOwners.total_volume, undefined);
assert.equal(totalCell(nonOwners), '<td class="">--</td>');

// A row that only names a minute or a tick volume draws no total either.
assert.equal(totalCell({ current_volume: 37 }), '<td class="">--</td>');
assert.equal(totalCell({ volume: 37 }), '<td class="">--</td>');

// A's total is the figure, whatever the other sources say.
const owned = mergeStockMarketSummary({
  watchItem: { code: "2330", total_volume: 900 },
  productSummary: { code: "2330", total_volume: 51234 },
  liveSignal: { code: "2330", total_volume: 37, volume: 37 },
});
assert.equal(owned.total_volume, 51234);
assert.equal(totalCell(owned), '<td class="">51,234</td>');

// A sparse summary delta with a null total keeps the accepted total.
const kept = mergeCanonicalStockSummary(owned, { total_volume: null, current: 1001 }, "2330");
assert.equal(kept.total_volume, 51234);

console.log("renderer total volume owner contract passed");
