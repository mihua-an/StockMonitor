import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

// 量變 and 1mK/3mK/5mK had no producer after the 9/29 split (every row read "--"); Rust B now computes them in
// its windows block, and the page's product-row projection maps them onto the row next to 1m/3m/5m. Driven through
// the real page: the product's view holds B's windows, and the row reads it (product_summary_reader.js).
const page = await startRealtimePage({ tradingDate: "2026-10-02" });
const { productSummaryOf } = await import("../ui/renderer/js/features/realtime/product_summary_reader.js");
const { mergeStockMarketSummary } = await import("../ui/renderer/js/market_data/stock_market_summary.js");
page.showProducts(["2330"]);
const spec = page.stockSpec("2330");

page.serve(spec, { summary: { current: 100 }, windows: {
  windows: { 1: { change_pct: 0.5, change_pct_unit: "percent" } },
  k: { 1: { change_pct: 0 }, 3: { change_pct: -2.94 }, 5: { change_pct: null } },
  volume_compare: { minute: 543, baseline_minute: "09:03", volume: 4, baseline_date: "2026-10-02", baseline_volume: 2, change_pct: 100, ratio: 2, diff: 2 },
} });
const fields = productSummaryOf("2330");
assert.equal(fields.k_1m, 0);
assert.equal(fields.k_3m, -2.94);
assert.equal(fields.k_5m, null);
assert.equal(fields.volume_change_pct_vs_baseline, 100);
assert.equal(fields.baseline_minute, "09:03");

// A named minute with no baseline clears the previous minute's 量變 instead of leaving it standing.
page.serve(spec, { summary: { current: 100 }, windows: { windows: {}, k: { 3: { change_pct: -2.94 } },
  volume_compare: { minute: 544, baseline_minute: "09:04", volume: 3, baseline_volume: null, change_pct: null } } });
const row = mergeStockMarketSummary({ productSummary: productSummaryOf("2330"), liveSignal: { k_3m: null, volume_change_pct_vs_baseline: 7 } });
assert.equal(row.volume_change_pct_vs_baseline, null);
assert.equal(row.k_3m, -2.94, "B's K is the row's authority; a sparse signal null does not erase it");
// No volume_compare (a market without baselines): the row keeps whatever else supplied 量變.
page.serve(spec, { summary: { current: 100 }, windows: { windows: {} } });
assert.equal("volume_change_pct_vs_baseline" in productSummaryOf("2330"), false);
console.log("renderer row K / 量變 contract passed");
