// A Futu print's row identity is its durable sequence. Rows carry `sequence` too (the live view's state version, or a
// stored row's producer sequence), but different prints share it; when 成交明細 keyed on it, every redraw built the
// second print of a pair anew and washed it again, so a batch showed every other row highlighted.
import assert from "node:assert/strict";
import { futuTradeRows } from "../ui/renderer/js/core/market_read_adapters.js";
import { tradeRowKey } from "../ui/renderer/js/core/trade_row_order.js";

const print = (ingest, price) => ({ sequence: 1167, ingest_sequence: ingest, durable_sequence: ingest,
  trade_timestamp: "2026-10-20 21:08:57", time: "21:08:57", price, volume: 10, ticker_direction: "BUY" });
const rows = futuTradeRows([print(58519178, 160.1), print(58519179, 160.05)]);

assert.deepEqual(rows.map((row) => row.ingestSequence), ["58519178", "58519179"], "ingestSequence is the durable sequence");
assert.notEqual(rows[0].ingestSequence, rows[1].ingestSequence, "two prints sharing `sequence` are two rows");
assert.equal(`d:${rows[0].ingestSequence}`, tradeRowKey(rows[0]), "the adapter and the shared row key agree");
assert.equal(futuTradeRows([{ sequence: 5, price: 1, volume: 1 }])[0].ingestSequence, null, "no durable sequence, none invented");

console.log("renderer futu trade row identity contract passed");
