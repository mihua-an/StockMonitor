import assert from "node:assert/strict";

// One table of numeric readings, held by every module that reads a number from data: numbers.js and the readers
// that are now that same function under another name. The same bad value reads the same on every surface.
const { numberOrNull, positiveNumberOrNull } = await import("../ui/renderer/js/core/numbers.js");
const { nullableNumber } = await import("../ui/renderer/js/core/market_read_model.js");
const { auctionPrice } = await import("../ui/renderer/js/core/auction_price.js");
const { tradeRowSequence } = await import("../ui/renderer/js/core/trade_row_order.js");

const CASES = [
  [0, 0], [12.5, 12.5], [-3, -3], ["12.5", 12.5], [" 7 ", 7], ["1e3", 1000], ["-0.5", -0.5],
  [null, null], [undefined, null], ["", null], ["   ", null], ["abc", null], ["12abc", null],
  [Number.NaN, null], [Infinity, null], [-Infinity, null], ["Infinity", null],
  [true, null], [false, null], [[5], null], [{}, null], [10n, null],
];
for (const [input, expected] of CASES) {
  assert.equal(numberOrNull(input), expected, `numberOrNull(${String(input)})`);
  assert.equal(nullableNumber(input), expected, `nullableNumber(${String(input)})`);
  assert.equal(tradeRowSequence({ ingest_sequence: input }), expected, `tradeRowSequence(${String(input)})`);
  const positive = expected != null && expected > 0 ? expected : null;
  assert.equal(positiveNumberOrNull(input), positive, `positiveNumberOrNull(${String(input)})`);
  assert.equal(auctionPrice({ status: "simtrade", indicative_price: input }), positive, `auctionPrice(${String(input)})`);
}
console.log("renderer numbers contract passed");
