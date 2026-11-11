import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// Market Runtime listens while it still recovers its WAL and answers only `health` then. The window used to subscribe
// right after opening, was refused (RECOVERING) and closed, and every App start recorded a renderer.live_ws_reconnect.
// Now a connection subscribes nothing until a health says Market Runtime serves; the recovering port's handoff close
// (4005 RECOVERED) is no lost socket: the window connects again at once and records nothing.

const remediations = [];
const recoveries = [];
let status = "recovering";
const live = installRealtimeHarness({
  health: () => ({ status, service_id: "market_runtime", protocol: 2, recovery: { phase: "replaying", replayed: 5, total: 10 } }),
  onEvent: (event) => { if (event.type === "stock-monitor:market-runtime-recovery") recoveries.push(event.detail); },
  desktopAPI: { reportRemediation: (payload) => remediations.push(payload) },
});
const { sockets, timers } = live;

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const spec = { source: "shioaji", market: "IDX", code: "TAIEX", trading_date: "2026-10-14", session: "DAY", channels: ["summary", "trend"] };
realtime.subscribeRealtimeView(spec, () => {}, { stateDelivery: "snapshot-only" });
realtime.startRealtimeStream();
const first = sockets[0];
first.open();
assert.deepEqual(first.sent.map((m) => m.type), ["health"], "nothing but health while Market Runtime recovers");
assert.equal(realtime.getRealtimeConnectionState(), realtime.REALTIME_CONNECTION_STATE.RECONNECTING, "not connected while recovering");
assert.equal(recoveries.at(-1)?.phase, "replaying", "the status bar shows the recovery progress");

// Recovery ends: the recovering port closes with RECOVERED. No remediation; the next connection is made at once.
status = "healthy";
first.drop(4005, "recovered");
assert.equal(remediations.filter((e) => e.mechanism_id === "renderer.live_ws_reconnect").length, 0, "a handoff is not a lost socket");
assert.equal(realtime.getRealtimeTransportHealth().disconnect_count, 0, "nor a disconnect in 連線診斷 (it marks any as a warning)");
const pending = [...timers.values()].map((t) => t.delay);
assert.ok(pending.length > 0, "a reconnect is scheduled");
for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
const second = sockets.at(-1);
assert.notEqual(second, first, "connected again");
second.open();
assert.ok(second.sent.some((m) => m.type === "view.subscribe" && m.payload.code === "TAIEX"), "subscribes once a health says it serves");
assert.equal(recoveries.at(-1), null, "the recovery progress is cleared");
assert.equal(realtime.getRealtimeConnectionState(), realtime.REALTIME_CONNECTION_STATE.CONNECTED);

// A real loss is still recorded.
second.drop();
assert.equal(remediations.filter((e) => e.mechanism_id === "renderer.live_ws_reconnect" && e.outcome === "started").length, 1);
assert.equal(realtime.getRealtimeTransportHealth().disconnect_count, 1, "a real loss is one disconnect");
realtime.stopRealtimeStream("test");
console.log("renderer recovering runtime handoff contract passed");
