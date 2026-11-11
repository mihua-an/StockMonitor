import assert from "node:assert/strict";

// The policy is pure: verify the complete sequence without opening a browser
// socket or waiting on real timers.
globalThis.window = { desktopAPI: { sourceSettings: {} } };
const realtime = await import("../ui/renderer/js/market_data/realtime.js");
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6].map(realtime.reconnectDelayMs),
  [1000, 2000, 4000, 8000, 15000, 15000, 15000],
);
assert.equal(realtime.reconnectDelayMs(-2), 1000);
assert.equal(realtime.reconnectDelayMs("bad"), 1000);
console.log("Renderer WebSocket reconnect backoff contract passed");
