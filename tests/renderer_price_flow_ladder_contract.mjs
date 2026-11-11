// 價量: rows are read back from Rust B's ladder flow by flow_fields (never classified here), and the two views
// never invent a split.
import assert from "node:assert/strict";
import { buildPriceFlowRows, ladderPriceDigits, ladderRowModels, patchLargeSmallLadder, priceFlowTotals } from "../ui/renderer/js/core/price_flow_ladder.js";
import { createDocument } from "./lib/mini_dom.mjs";

const FIELDS = ["large_buy", "large_sell", "large_unknown", "large_count", "small_buy", "small_sell", "small_unknown", "small_count",
  "unclassified_buy", "unclassified_sell", "unclassified_unknown", "unclassified_count"];
const pv = {
  flow_fields: FIELDS,
  buckets: [
    { price: 61.3, volume: 477, out: 90, in: 387, flow: [0, 132, 0, 3, 90, 255, 0, 40, 0, 0, 0, 0] },
    { price: 60.7, volume: 840, out: 502, in: 338, flow: [0, 0, 0, 0, 269, 338, 0, 90, 233, 0, 0, 1] },
    { price: 61, volume: 199, out: 159, in: 40, flow: [139, 0, 0, 2, 20, 40, 0, 9, 0, 0, 0, 0] },
  ],
};
const { rows, classified } = buildPriceFlowRows(pv);
assert.equal(classified, true);
assert.deepEqual(rows.map((r) => r.price), [61.3, 61, 60.7], "highest price first");
assert.deepEqual(rows[0], { price: 61.3, volume: 477, out: 90, in: 387, largeBuy: 0, largeSell: 132, smallBuy: 90, smallSell: 255, otherBuy: 0, otherSell: 0 });
assert.equal(rows[2].otherBuy, 233, "unclassified volume is kept, not dropped or folded into 小單");
// The header's totals are B's session totals as sent (price_volume.totals), not the rows added back up.
const totals = priceFlowTotals({ ...pv, totals: { large: { buy: 139, sell: 140 }, small: { buy: 379, sell: 633 }, unclassified: { buy: 233, sell: 0 } } });
assert.deepEqual(totals, { largeBuy: 139, largeSell: 140, smallBuy: 379, smallSell: 633 });
assert.deepEqual(priceFlowTotals(pv), { largeBuy: 0, largeSell: 0, smallBuy: 0, smallSell: 0 }, "no totals from B: none made up from the rows");

// The field order is read, not assumed.
const reordered = buildPriceFlowRows({ flow_fields: ["small_sell", "large_buy"], buckets: [{ price: 10, out: 5, in: 7, flow: [7, 5] }] });
assert.equal(reordered.rows[0].smallSell, 7);
assert.equal(reordered.rows[0].largeBuy, 5);

// No large-order rule (Futu, TXF): no flow, 內外盤 only.
const plain = buildPriceFlowRows({ flow_fields: null, buckets: [{ price: 23000, out: 3, in: 4, volume: 7 }] });
assert.equal(plain.classified, false);
assert.equal(plain.rows[0].largeBuy, 0);

const context = { currentPrice: 60.7, referencePrice: 61 };
const doc = createDocument();
const container = doc.createElement("div");
doc.body.appendChild(container);
assert.equal(patchLargeSmallLadder(container, rows, context), true, "the first render adds the rows");
const split = container.innerHTML;
assert.match(split, /data-price="60.7"[^>]*class="price-flow-row is-current"/, "the current price row is marked");
assert.match(split, /class="price-flow-price is-center price-up">61.3/, "a price above the reference takes the up colour");
assert.match(split, /<th class="is-center">大單<\/th>/);
assert.match(split, />139</);
assert.match(split, />255</);

// The next update of the same prices builds nothing and moves nothing; a changed number is written in place.
const created = doc.created;
assert.equal(patchLargeSmallLadder(container, rows.map((row) => (row.price === 61 ? { ...row, largeBuy: 150 } : row)), context), false);
assert.equal(doc.created, created, "an update of known prices creates no element");
assert.match(container.innerHTML, />150</);
// A new price is one new row, placed in price order.
assert.equal(patchLargeSmallLadder(container, [...rows, { ...rows[0], price: 61.5, largeBuy: 1 }].sort((x, y) => y.price - x.price), context), true);
assert.match(container.innerHTML, /<tbody><tr data-price="61.5"/);

// One ladder, one number of decimals: as many as its finest price needs, none when every price is whole.
const priced = (prices) => prices.map((price) => ({ price, largeBuy: 0, largeSell: 0, smallBuy: 0, smallSell: 0 }));
assert.deepEqual(ladderRowModels(priced([224.5, 224, 223.5])).map((model) => model.price), ["224.5", "224.0", "223.5"]);
assert.deepEqual(ladderRowModels(priced([501, 500])).map((model) => model.price), ["501", "500"]);
assert.deepEqual(ladderRowModels(priced([50.15, 50.1, 50])).map((model) => model.price), ["50.15", "50.10", "50.00"]);
assert.equal(ladderPriceDigits(priced([0.1 + 0.2])), 1, "binary noise is not a digit");
// The row key stays the raw price: a ladder whose digits change keeps its rows.
assert.deepEqual(ladderRowModels(priced([224, 223])).map((model) => model.key), ["224", "223"]);

console.log("renderer price-flow ladder contract passed");
