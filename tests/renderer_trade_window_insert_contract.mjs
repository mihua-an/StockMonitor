import assert from "node:assert/strict";
import { applyDeltaToState, insertTrade, UI_TRADE_WINDOW } from "../ui/renderer/js/market_data/view_state_reducer.js";

// Market Runtime's trade frame carries the print it just put on its tape. A gap filled from the broker afterwards
// (a late join, a restart) is older than the newest print: the view puts it in exchange-time order, not at the end.
const base = 1794366000000000000n;
const print = (seconds, durable = 0, volume = 1) => ({
  source: "shioaji", market: "STK", code: "2458", exchange_ts_ns: String(base + BigInt(seconds) * 1000000000n),
  price: 100 + seconds / 1000, volume, ingest_sequence: durable, durable_sequence: durable, trade_id: `t${seconds}`,
});
const times = (rows) => rows.map((row) => Number((BigInt(row.exchange_ts_ns) - base) / 1000000000n));

let trades = [print(100), print(200), print(300)];
trades = insertTrade(trades, print(150));
assert.deepEqual(times(trades), [100, 150, 200, 300], "a filled print takes its place among the prints of its time");
trades = insertTrade(trades, print(400));
assert.deepEqual(times(trades), [100, 150, 200, 300, 400], "a new print goes at the newest end");
trades = insertTrade(trades, print(150));
assert.deepEqual(times(trades), [100, 150, 200, 300, 400], "the same print twice is one row");

// The window keeps the newest by exchange time: a burst of filled prints older than the live ones never pushes the
// live ones out.
let window = Array.from({ length: UI_TRADE_WINDOW }, (_, i) => print(10000 + i));
for (let i = 0; i < 179; i += 1) window = insertTrade(window, print(i));
assert.equal(window.length, UI_TRADE_WINDOW);
assert.deepEqual(times(window), Array.from({ length: UI_TRADE_WINDOW }, (_, i) => 10000 + i), "older fills do not evict newer prints");

// Through the reducer: a trade frame inserts its trade the same way.
const state = applyDeltaToState({ trades: [print(100), print(300)] }, { delta_type: "trade.frame", payload: { trade: print(200) } });
assert.deepEqual(times(state.trades), [100, 200, 300]);

console.log("renderer_trade_window_insert_contract: ok");
