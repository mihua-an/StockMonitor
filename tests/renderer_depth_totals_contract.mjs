import assert from 'node:assert/strict';
import { resolveOrderBookDepthTotal } from '../ui/renderer/js/core/orderbook_normalization.js';
import { StockOrderBookAdapter } from '../ui/renderer/js/core/orderbook_adapters.js';

const book = {
  bid_prices: [100, 99, 98, 97, 96], bid_volumes: [1, 2, 3, 4, 5],
  ask_prices: [101, 102, 103, 104, 105], ask_volumes: [6, 7, 8, 9, 10],
};
const vm = StockOrderBookAdapter.build({book, signal: {bid_side_total_vol: 9000, ask_side_total_vol: 8000}});
assert.equal(resolveOrderBookDepthTotal(vm.depthBidTotal, vm.bidLevels), 15);
assert.equal(resolveOrderBookDepthTotal(vm.depthAskTotal, vm.askLevels), 40);
for (const missing of [null, undefined, '', NaN, Infinity, -1]) {
  assert.equal(resolveOrderBookDepthTotal(missing, vm.bidLevels), 15);
}
assert.equal(resolveOrderBookDepthTotal(0, vm.bidLevels), 0);
assert.equal(resolveOrderBookDepthTotal('25', vm.bidLevels), 25);
const canonical = StockOrderBookAdapter.build({book: {...book, bid_total_volume: 20, ask_total_volume: 50}});
assert.equal(canonical.depthBidTotal, 20);
assert.equal(canonical.depthAskTotal, 50);
const next = StockOrderBookAdapter.build({book: {...book, bid_volumes: [10, 20, 30, 40, 50]}});
assert.equal(resolveOrderBookDepthTotal(next.depthBidTotal, next.bidLevels), 150);
console.log('renderer depth totals contract passed');
