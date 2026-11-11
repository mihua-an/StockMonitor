import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";
import { MarketDataGateway } from "../ui/renderer/js/market_data/market_data_gateway.js";

// Characterizes the removal of MarketDataGateway's dead parallel trend
// computation. Before this fix, every snapshot/delta hydrated/applied into a
// per-entry TrendSeriesStore whose only outputs -- `event.trendSeries`,
// `gateway.trendSnapshot()`, and the trend fields inside `gateway.diagnostics()`
// -- had zero production or test consumers (verified by exhaustive grep
// across ui/renderer/js and tests/ before this change): nothing ever
// read `.trendSeries` off a delivered event, called `.trendSnapshot()`, or
// read the trend-derived fields (`points`, `watermark`, `streamId`,
// `sessionKey`, `intervalMinutes`) out of `.diagnostics()`. The real trend
// pipeline (`txfPoints` / `pages/realtime.js` / `minute_trend.js`) never
// touched this gateway machinery at all and is unaffected by its removal.

// --- 1. Source-level regression guard: the dead import/module must not come back ---
{
  const gatewaySource = fs.readFileSync(
    fileURLToPath(new URL("../ui/renderer/js/market_data/market_data_gateway.js", import.meta.url)),
    "utf8",
  );
  assert.ok(!/trend_series_store/i.test(gatewaySource), "market_data_gateway.js must not import TrendSeriesStore again");
  assert.ok(!fs.existsSync(fileURLToPath(new URL("../ui/renderer/js/features/realtime/trend_series_store.js", import.meta.url))),
    "trend_series_store.js is dead-parallel-path-only and must stay deleted");
}

// --- Harness: same wiring pattern as renderer_delivery_contract.mjs ---
const spec = { market: "STK", code: "2330", session: "DAY", trading_date: "2026-09-04" };
const key = { market: "STK", logical_code: "2330", session: "DAY", trading_date: "2026-09-04" };
const wire = [];
const rawStore = new RealtimeViewStore({ send: (m) => { wire.push(m); return true; } });
const gateway = new MarketDataGateway({ subscribeView: rawStore.subscribe.bind(rawStore), getSnapshot: rawStore.snapshot.bind(rawStore) });
const projected = [];
gateway.subscribe(spec, (event) => projected.push(event));
rawStore.onConnected();
const requestId = wire[0].payload.request_id;
rawStore.handleAccepted({ request_id: requestId, subscription_id: "g", stream_id: "gstream", watermark: 0 });
rawStore.handleSnapshot({ request_id: requestId, subscription_id: "g", stream_id: "gstream", session_key: key, watermark: 0, trend: [], trades: [] });
projected.length = 0;

const trendDelta = (sequence, minute) => ({
  subscription_id: "g", stream_id: "gstream", session_key: key, sequence, delta_type: "trend.upsert",
  payload: { timestamp: `2026-09-04T09:0${minute}:00`, price: 100 + minute },
});
rawStore.handleDeltaBatch({ items: [trendDelta(1, 1), trendDelta(2, 2)] });

// --- 2. Real functionality (channel classification, batch delivery) is unaffected ---
{
  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, "batch");
  assert.equal(projected[0].deltas.length, 2);
  assert.deepEqual(projected[0].changedChannels, ["trend"]);
}

// --- 3. The dead per-event computation and its output are gone ---
{
  assert.equal(Object.hasOwn(projected[0], "trendSeries"), false, "delivered events must no longer carry a trendSeries field");
  assert.equal(typeof gateway.trendSnapshot, "undefined", "trendSnapshot() had zero consumers and must be removed");
  assert.equal(typeof gateway.reset, "undefined", "reset() only ever called the dead trend store and must be removed");
}

// --- 4. diagnostics() keeps its real (connection-health) fields, drops the dead trend-derived ones ---
{
  const rows = gateway.diagnostics();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(typeof row.key, "string");
  assert.ok(row.key.length > 0);
  assert.equal(row.references, 1);
  assert.equal(row.received, 2); // accepted + snapshot
  for (const deadField of ["lastDeliveryLatencyMs", "maxDeliveryLatencyMs", "points", "watermark", "streamId", "sessionKey", "intervalMinutes", "trendSeries"]) {
    // Delivery latency: the 系統拓樸 latency board (Rust A, per source) is the one measurement; this copy read fields
    // Rust A never sends.
    assert.equal(Object.hasOwn(row, deadField), false, `diagnostics() must not expose the dead field "${deadField}"`);
  }
}

// --- 5. snapshot()/readSnapshot() (the real, live-used API) are untouched ---
{
  const state = gateway.snapshot(spec);
  assert.ok(state, "snapshot() must keep returning the canonical live state");
  const model = gateway.readSnapshot(spec);
  assert.ok(model && model.revision, "readSnapshot() must keep working");
}

console.log("market data gateway architecture contract passed");
