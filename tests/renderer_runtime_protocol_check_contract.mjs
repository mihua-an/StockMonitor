// The live socket subscribes only after the first serving health names the expected service and wire protocol (from
// main's runtime contract). Another service or protocol is refused: recorded, the transport stopped, nothing subscribed.
import assert from "node:assert/strict";

const timers = new Map();
let nextTimer = 1;
const timer = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; };
Object.assign(globalThis, { setTimeout: timer, clearTimeout: (id) => timers.delete(id), setInterval: timer, clearInterval: (id) => timers.delete(id) });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const states = [];
const errors = [];
console.error = (...args) => errors.push(args);
globalThis.window = {
  setTimeout: timer, clearTimeout: globalThis.clearTimeout, setInterval: timer, clearInterval: globalThis.clearInterval,
  dispatchEvent(event) { if (event.type === "stock-monitor:ws-state") states.push(event.detail); },
  desktopAPI: { liveEngineConnection: { url: "ws://127.0.0.1:8010/live", revision: 1, expected: { service_id: "market_runtime", protocol: 2 } },
    sourceSettings: { enabled_sources: ["shioaji"] }, reportRemediation() {} },
};
let health = { status: "healthy", service_id: "market_runtime", protocol: 3 };
const sockets = [];
class FakeSocket {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 0; listeners = new Map(); sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  send(raw) { const message = JSON.parse(raw); this.sent.push(message); if (message.type === "health") this.emit("message", { data: JSON.stringify({ type: "health", payload: health }) }); }
  emit(name, payload) { this.listeners.get(name)?.(payload); }
  close(code = 1000) { this.readyState = 3; this.emit("close", { code }); }
}
globalThis.WebSocket = FakeSocket;
globalThis.performance ??= { now: () => Date.now(), timeOrigin: Date.now() };
globalThis.requestAnimationFrame = () => 0;

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const { servingIdentityProblem } = realtime;
const expected = { service_id: "market_runtime", protocol: 2 };
assert.equal(servingIdentityProblem({ service_id: "market_runtime", protocol: 2 }, expected), "");
assert.match(servingIdentityProblem({ service_id: "app_api", protocol: 2 }, expected), /service "app_api"/);
assert.match(servingIdentityProblem({ service_id: "market_runtime", protocol: 1 }, expected), /protocol 1 is not 2/);
assert.match(servingIdentityProblem({ service_id: "market_runtime" }, expected), /protocol null/);
assert.match(servingIdentityProblem({ service_id: "market_runtime", protocol: 2 }, null), /not configured/);

// An incompatible runtime: refused, recorded, stopped; no view subscription goes out and nothing reconnects.
realtime.notifyBackendReadyForRealtime();
const socket = sockets[0];
socket.readyState = 1;
socket.emit("open", {});
await new Promise((resolve) => setImmediate(resolve));
assert.ok(errors.some((args) => String(args[0]).includes("not compatible")), "the refusal is recorded");
assert.ok(!socket.sent.some((m) => String(m.type).startsWith("view.") || m.type === "focus.set"), "nothing is subscribed");
assert.ok(!states.some((s) => s.state === "CONNECTED"), "never reported connected");
assert.equal(socket.readyState, 3, "the socket is closed");
const before = sockets.length;
for (const [id, entry] of [...timers]) { timers.delete(id); entry.fn(); }
assert.equal(sockets.length, before, "no reconnect to the incompatible runtime");
console.log("renderer runtime protocol check contract passed");
