import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

globalThis.performance = { now: () => 0 };
const live = installRealtimeHarness({ health: () => null, enabledSources: [] });
const { sockets, timers } = live;

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream(() => {});
assert.equal(sockets.length, 1);
sockets[0].drop();
assert.ok([...timers.values()].some(entry => entry.delay === 1000));
const retry = [...timers.entries()].reverse().find(([, entry]) => entry.delay === 1000);
timers.delete(retry[0]);
retry[1].fn();
assert.equal(sockets.length, 2);
sockets[1].drop();
assert.ok([...timers.values()].some(entry => entry.delay === 2000));
const secondRetry = [...timers.entries()].reverse().find(([, entry]) => entry.delay === 2000);
timers.delete(secondRetry[0]);
secondRetry[1].fn();
assert.equal(sockets.length, 3);
sockets[2].open();
sockets[2].drop();
assert.ok([...timers.values()].some(entry => entry.delay === 1000), "successful open resets backoff");
const countBeforeStaleClose = timers.size;
sockets[0].drop();
assert.equal(timers.size, countBeforeStaleClose, "obsolete socket cannot schedule a reconnect");
console.log("Renderer reconnect sequence contract passed");
