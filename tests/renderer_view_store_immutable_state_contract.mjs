// 實際持倉 成交明細 一秒一跳: snapshot() structuredCloned the whole view state on every read and the 五檔/價量
// view model read it three times per render -- 40% of the renderer main thread on a live feed. The state is immutable
// now: reads share it, and a delta produces a new state instead of writing into the one already handed out.
import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

const spec = { source: "shioaji", market: "STK", code: "2344", session: "DAY", trading_date: "", channels: ["summary", "trades"], live_expected: true };
const store = new RealtimeViewStore({ send: () => true });
store.onConnected();
let requestId = "";
store.send = (m) => { if (m.type === "view.subscribe") requestId = m.payload.request_id; return true; };
store.subscribe(spec, () => {});
store.handleAccepted({ request_id: requestId, subscription_id: "sub-1", stream_id: "mr" });
const trades = Array.from({ length: 100 }, (_, i) => ({ price: 10 + i / 100, volume: 1, sequence: i + 1 }));
store.handleSnapshot({ subscription_id: "sub-1", request_id: requestId, watermark: 1, stream_id: "mr", daemon_instance_id: "mr",
  summary: { current: 10 }, trades, trend: [] });

const first = store.snapshot(spec);
const again = store.snapshot(spec);
assert.equal(first.trades, again.trades, "two reads share the state: nothing is copied per read");
assert.equal(first.trades.length, 100);

store.handleDelta({ subscription_id: "sub-1", sequence: 2, stream_id: "mr", daemon_instance_id: "mr", delta_type: "trade.frame",
  channels: ["trades", "summary"], payload: { trade: { price: 11, volume: 2, sequence: 101 }, summary: { current: 11 } } });
const after = store.snapshot(spec);
assert.equal(after.summary.current, 11);
assert.equal(after.trades.at(-1).price, 11);
assert.equal(first.summary.current, 10, "a state handed out before the delta is unchanged");
assert.equal(first.trades.at(-1).price, 10.99);
assert.equal(first.watermark, 1);
assert.equal(after.watermark, 2);
console.log("renderer view store immutable state contract passed");
