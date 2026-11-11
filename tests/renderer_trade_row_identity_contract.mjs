import assert from "node:assert/strict";
import { compareTradeRowsNewestFirst, tradeRowKey } from "../ui/renderer/js/core/trade_row_order.js";

// One print reaches page 1 twice -- from the live view (sequence = the view's state version) and from the
// durable page of a materialized session (sequence = the producer's). Both carry the durable sequence, its identity.
const stamp = "1791504000000000000";
const live = { sequence: 812, ingest_sequence: 40017, durable_sequence: 40017, exchange_ts_ns: stamp, price: 101.5, volume: 3, source: "shioaji" };
const stored = { sequence: 9, ingest_sequence: 40017, durable_sequence: 40017, exchange_ts_ns: stamp, price: 101.5, volume: 3, source: "shioaji" };
assert.equal(tradeRowKey(live), tradeRowKey(stored), "the same print is one row");

// Two different prints at the same time, price and size stay two rows.
const other = { ...stored, sequence: 10, ingest_sequence: 40018, durable_sequence: 40018 };
assert.notEqual(tradeRowKey(stored), tradeRowKey(other));
assert.equal(compareTradeRowsNewestFirst(stored, other) > 0, true, "the later durable sequence sorts first");

// A row without a durable sequence keeps the time/event/price/size key.
assert.match(tradeRowKey({ exchange_ts_ns: stamp, price: 1, volume: 1, source: "shioaji" }), /\|/);

console.log("renderer trade row identity contract passed");
