import assert from "node:assert/strict";
import { buyCost, pairNetAtPrice, sellProceeds, sellTax, tradeAmount, tradeFee } from "../ui/renderer/js/core/trade_costs.js";

// core/trade_costs.js applies the terms the ledger states (AccountingCore.closing_terms) and nothing of its own: the
// rates, the minimum, the roundings and which tax applies come with the row.

const terms = (feeRate, taxRate) => ({ amount_rounding: "floor", fee_rate: feeRate, min_fee: "1", fee_rounding: "ceil",
  sell_tax_rate: taxRate, tax_rounding: "floor" });
const us = { amount_rounding: "cent", fee_rate: "0.0008", min_fee: "0", fee_rounding: "cent", sell_tax_rate: "0.0000206", tax_rounding: "cent" };

// TW: the amount and tax rounded down, the fee up with a minimum of 1.
const stock = terms("0.000399", "0.003");
assert.equal(tradeAmount(stock, 1, 198.5), 198);
assert.equal(tradeFee(stock, 198), 1);
assert.equal(tradeFee(stock, 100000), 40);
assert.equal(sellTax(stock, 100000), 300);
assert.equal(sellProceeds(stock, 1000, 100), 100000 - 40 - 300);
assert.equal(buyCost(stock, 1000, 100), 100040);
// 美股: to the cent, half up; no minimum.
assert.equal(tradeAmount(us, 3, 10.335), 31.01);
assert.equal(tradeFee(us, 41.32), 0.03);
assert.equal(sellProceeds(us, 4, 10.33), 41.29);
// No terms, nothing priced -- never a figure at some other rate.
assert.equal(sellProceeds(null, 1000, 100), null);
assert.equal(buyCost(undefined, 1000, 100), null);

// 配對回放 at a 手續費折扣 that is not 2.8 折: the row test_account_day_reads.py reads from a 6 折 paper ledger (a 當沖
// 多 of 2317, 50 -> 52). At its own exit price the replay's P&L is the ledger's profit; the old hard-coded 0.000399
// fee gave 1,858 instead.
const pair = { code: "2317", trade_type: "當沖", direction: "多", qty: 1000, buy_amount: 50000, sell_amount: 52000, buy_fee: 43,
  sell_fee: 45, fee: 88, tax: 78, profit: 1834, closing_terms: terms("0.000855", "0.0015") };
assert.equal(pairNetAtPrice(pair, 52), pair.profit);
assert.equal(pairNetAtPrice(pair, 51), 51000 - 44 - 76 - 50000 - 43);
// A short: what its sell brought in (after its fee and tax) against buying back at the price.
const short = { ...pair, direction: "空", buy_fee: 43, sell_fee: 45, tax: 78, profit: 1834, buy_amount: 50000, sell_amount: 52000 };
assert.equal(pairNetAtPrice(short, 50), short.profit);
// No price, no terms or a missing fee: unavailable.
assert.equal(pairNetAtPrice(pair, 0), null);
assert.equal(pairNetAtPrice({ ...pair, closing_terms: null }, 52), null);
assert.equal(pairNetAtPrice({ ...pair, buy_fee: undefined }, 52), null);

console.log("renderer trade costs contract passed");
