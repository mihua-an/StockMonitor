// D01-06＋D03-02: the stock row took 昨收 / 現價 / 開高低 from whichever of the live signal, the product summary and the
// watch item had one (live first), and needed a PREOPEN rule so yesterday's signal could not cover today's summary. The
// join is by owner now: market facts from Market Runtime's product summary only, analysis fields from the signal, the
// name from the watch item.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeStockMarketSummary } from "../ui/renderer/js/market_data/stock_market_summary.js";

const summary = { code: "2330", current: 1105, prev_close: 1090, reference_price: 1090, open: 1095, high: 1110, low: 1092,
  total_volume: 21000, average: 1101, change: 15, change_pct: 1.376, status: "live", session_state: "LIVE" };
const yesterday = { code: "2330", current: 980, prev_close: 970, open: 975, high: 990, low: 960, day_high: 990, day_low: 960,
  volume: 50000, avg_price: 978, status: "live", name: "2330", model_up_5m: 0.61, volume_change_pct_vs_baseline: 12 };
const watch = { code: "2330", name: "台積電", market: "TSE", current: 1000, prev_close: 999, high: 1200 };

const row = mergeStockMarketSummary({ watchItem: watch, productSummary: summary, liveSignal: yesterday });
assert.deepEqual([row.current, row.prev_close, row.open, row.high, row.low, row.day_high, row.day_low, row.total_volume, row.avg_price],
  [1105, 1090, 1095, 1110, 1092, 1110, 1092, 21000, 1101], "every market fact is the product summary's");
assert.equal(row.model_up_5m, 0.61, "an analysis field is the signal's");
assert.equal(row.volume_change_pct_vs_baseline, 12);
assert.deepEqual([row.name, row.market], ["台積電", "TSE"], "the name and market are the watch item's");

// No summary yet (a cold row): no market fact at all, not the signal's nor the watch item's.
const cold = mergeStockMarketSummary({ watchItem: watch, liveSignal: yesterday });
for (const key of ["current", "prev_close", "open", "high", "low", "day_high", "day_low", "volume", "avg_price", "status"]) {
  assert.equal(cold[key], undefined, `${key} comes from Market Runtime's summary only`);
}

// PREOPEN needs no rule of its own: the signal never supplies a market fact in any phase.
const preopen = mergeStockMarketSummary({ productSummary: { ...summary, session_state: "PREOPEN", current: null, high: null },
  liveSignal: yesterday });
assert.equal(preopen.current, null);
assert.equal(preopen.high ?? null, null);
const source = readFileSync(new URL("../ui/renderer/js/market_data/stock_market_summary.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /PREOPEN|firstPositive|firstNumber/, "no phase rule and no first-of-three picking");

console.log("renderer stock row owner join contract passed");
