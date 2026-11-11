import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stepPrice, tickSize, tickTable } from "../ui/renderer/js/market_data/tw_stock_rules.js";
import { sellProceeds } from "../ui/renderer/js/core/trade_costs.js";
import * as marketMath from "../ui/renderer/js/market_data/realtime_market_math.js";
import * as rules from "../ui/renderer/js/market_data/tw_stock_rules.js";

// The renderer steps 台股 prices on the price policy the paper funds serve (config/twse_price_policy.json, read here as
// the desk reads it) for the product catalog's instrument kind, and agrees with the Python cases
// (tests/test_tw_stock_rules_parity.py) on the same fixture. It derives neither a kind nor a limit itself.
const policy = JSON.parse(readFileSync(new URL("../config/twse_price_policy.json", import.meta.url), "utf8"));
const served = { tick_tables: policy.tick_tables, tick_table_of_kind: policy.tick_table_of_kind };
const cases = JSON.parse(readFileSync(new URL("./fixtures/tw_stock_rules_cases.json", import.meta.url), "utf8"));
for (const [price, kind, tick] of cases.ticks) assert.equal(tickSize(price, tickTable(served, kind)), tick, `tick at ${price} ${kind}`);
// A sale under the ledger's closing terms of the kind (the renderer never decides a rate itself).
for (const [code, kind, price, qty, proceeds] of cases.sells) {
  assert.equal(sellProceeds(cases.closing_terms[kind], qty, price), proceeds, `sale of ${qty} ${code} at ${price}`);
}
// An ETN at 50 steps by the ETF table's 0.05, a stock by 0.1; no kind or no policy yet: no step.
assert.equal(stepPrice(50, 1, tickTable(served, "etn")), 50.05);
assert.equal(stepPrice(50, 1, tickTable(served, "stock")), 50.1);
assert.equal(stepPrice(50, -1, tickTable(served, "stock")), 49.95, "a step down at a band edge uses the lower band");
assert.equal(tickTable(served, null), null);
assert.equal(tickTable(null, "stock"), null);
assert.equal(stepPrice(50, 1, null), 50);
assert.equal(tickSize(0, tickTable(served, "stock")), null);
// No limit formula and no code rule is left in the renderer.
assert.equal(marketMath.standardStockLimitPrices, undefined, "漲停／跌停 are only the provider's official values");
for (const gone of ["priceLimits", "isEtfCode", "isEtfLikeType"]) assert.equal(rules[gone], undefined, gone);
console.log("renderer tw stock rules parity contract passed");
