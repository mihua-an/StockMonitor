// A secondary window ends its live transport when it goes away: its own release runs first (while the socket is still
// open), then the stream stops (state DISCONNECTED with the reason) -- once, however often pagehide fires. Both
// secondary windows install it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const listeners = new Map();
const target = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) };
globalThis.window = { dispatchEvent() { return true; }, desktopAPI: { sourceSettings: { enabled_sources: [] } }, setTimeout, clearTimeout };
globalThis.performance ??= { now: () => Date.now(), timeOrigin: Date.now() };

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const { installSecondaryWindowRealtime } = await import("../ui/renderer/js/market_data/secondary_window_realtime.js");
const order = [];
const states = [];
realtime.subscribeRealtimeConnectionState((state) => { states.push(state); order.push(`state:${state.state}`); });
order.length = 0;
states.length = 0;
installSecondaryWindowRealtime({ target, reason: "test_window_closed", release: () => order.push("release") });
listeners.get("pagehide")();
assert.deepEqual(order, ["release", "state:DISCONNECTED"], "release first, then the stream stops");
assert.equal(states[0].reason, "test_window_closed");

for (const page of ["workspace_view.js", "detached_view.js"]) {
  const source = readFileSync(new URL(`../ui/renderer/${page}`, import.meta.url), "utf8");
  assert.match(source, /installSecondaryWindowRealtime\(\{/, `${page} ends its transport on close`);
  assert.doesNotMatch(source, /keepalive|beforeunload/, `${page} keeps no unload path of its own`);
}
console.log("renderer secondary window realtime contract passed");
