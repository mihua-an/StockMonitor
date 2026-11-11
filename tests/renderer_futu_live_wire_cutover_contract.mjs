import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// M8/M9 live-wire cutover: proves moomooQuoteStore actually receives live
// quote updates through RealtimeViewStore's real Market Runtime wire
// protocol (view.subscribe/view.subscription.accepted/view.snapshot/
// view.delta) -- not just through REST polling. This is the missing half
// of the M15 dead-push-removal work: dead push removed + a REAL live path
// now connected, not "REST polling silently becomes the only path."

const live = installRealtimeHarness({ enabledSources: ["futu"] });
const { sockets } = live;

const requestedUrls = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  requestedUrls.push(href);
  if (href.includes("/api/futu/watchlist")) {
    return { ok: true, json: async () => ({ ok: true, items: [{ code: "US.AAPL", name: "", sort_order: 0 }] }) };
  }
  return { ok: true, json: async () => ({ ok: true }) };
};

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const { moomooQuoteStore } = await import("../ui/renderer/js/features/realtime/moomoo_quote_store.js");

realtime.startRealtimeStream(() => {});
assert.equal(sockets.length, 1);
const socket = sockets[0];
socket.ready();

await moomooQuoteStore.bootstrap();
// bootstrap() reconciles subscriptions synchronously once its async chain
// resolves -- drain microtasks until the view.subscribe request appears.
for (let attempt = 0; attempt < 20 && !socket.sent.some((m) => m.type === "view.subscribe"); attempt++) {
  await new Promise((resolve) => setImmediate(resolve));
}

const subscribeMessage = socket.sent.find((m) => m.type === "view.subscribe");
assert.ok(subscribeMessage, "moomooQuoteStore must subscribe a watchlist code via Market Runtime's view.subscribe, not only poll REST");
assert.equal(subscribeMessage.payload.market, "US");
assert.equal(subscribeMessage.payload.code, "US.AAPL");
assert.equal(subscribeMessage.payload.source, "futu");

// Simulate Market Runtime accepting the subscription and pushing a snapshot
// -- the real wire shape (native/market_runtime/src/bin/market_runtime_daemon.rs's
// own view.subscription.accepted / view.snapshot responses, read this session).
const identity = {
  request_id: subscribeMessage.payload.request_id, subscription_id: "sub-1",
  stream_id: "stream-1", watermark: 1,
};
socket.emit("message", { data: JSON.stringify({ type: "view.subscription.accepted", payload: identity }) });
socket.emit("message", { data: JSON.stringify({
  type: "view.snapshot",
  payload: {
    ...identity, market: "US", code: "US.AAPL", session_generation: 1,
    summary: { current: 152.5, open: 150, high: 155, low: 148, prev_close: 149, total_volume: 1000000, status: "live" },
    trend: [], trades: [{ price: 152.5, volume: 100, sequence: 1, side: "BUY", exchange_ts_ns: 1, trade_id: "t1" }],
  },
}) });

const productRow = moomooQuoteStore.snapshot().products.find((row) => row.code === "US.AAPL");
assert.ok(productRow, "US.AAPL must still be in the product list");
assert.equal(productRow.regular_current, 152.5, "a live view.snapshot must update the quote through the real wire, not REST polling");

// The Futu row is a plain RealtimeViewStore subscription: gaps resync through the store's own sequence check. There
// is no quiet-view supervision flag (a quiet product is not a broken view).
const aaplSubscription = realtime.getRealtimeViewStats().subscriptions.find((s) => s.spec.code === "US.AAPL");
assert.ok(aaplSubscription, "US.AAPL must have an active view subscription");
assert.equal("live_expected" in aaplSubscription.spec, false, "no quiet-view supervision flag on the spec");
assert.equal(productRow.regular_open, 150);
assert.equal(productRow.regular_high, 155);

// A live delta must also flow through -- not just the initial snapshot.
socket.emit("message", { data: JSON.stringify({
  type: "view.delta",
  payload: {
    ...identity, market: "US", code: "US.AAPL", generation: 1, sequence: 2, durable_watermark: 2,
    coverage: {}, delta_type: "quote.frame",
    payload: { summary: { current: 153.0, open: 150, high: 155.5, low: 148, prev_close: 149, total_volume: 1000100, status: "live" } },
  },
}) });

const afterDelta = moomooQuoteStore.snapshot().products.find((row) => row.code === "US.AAPL");
assert.equal(afterDelta.regular_current, 153.0, "a live view.delta must also update the quote through the real wire");

// Removing the code from the watchlist must unsubscribe (no stale subscription).
globalThis.fetch = async (url) => {
  const href = String(url);
  requestedUrls.push(href);
  if (href.includes("/api/futu/watchlist")) return { ok: true, json: async () => ({ ok: true, items: [] }) };
  return { ok: true, json: async () => ({ ok: true }) };
};
await moomooQuoteStore.bootstrap({ force: true });
const unsubscribeMessage = socket.sent.find((m) => m.type === "view.unsubscribe");
assert.ok(unsubscribeMessage, "removing a watchlist code must release its Market Runtime subscription");

// No daemon REST market read exists: only static catalog and provider status.
assert.ok(requestedUrls.every((url) => /\/api\/futu\/(watchlist|status)/.test(url)),
  "Futu product store may only read static watchlist/provider status over REST, got: " + requestedUrls.join(", "));

console.log("Futu live-wire cutover contract passed");
