// 逐價內外盤 draws buyer- and seller-initiated volume only (使用者 10-21): a print whose side cannot be told is neither a
// bar segment nor part of a bar's height.
import assert from "node:assert/strict";
import { buildPriceVolumeProjection } from "../ui/renderer/js/core/price_volume_projection.js";

const projection = buildPriceVolumeProjection([
  { price: 100, out: 30, in: 10, unknown: 500 },
  { price: 101, buy_volume: 5, sell_volume: 15, unknown_volume: 900 },
], 101);

assert.deepEqual(projection.buckets.map((row) => Object.keys(row).sort()), [["in", "out", "price"], ["in", "out", "price"]]);
assert.equal(projection.maxVolume, 40, "the tallest bar is the largest buy + sell volume");
console.log("renderer price volume sides only contract passed");
