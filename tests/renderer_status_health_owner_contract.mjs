import assert from "node:assert/strict";
import fs from "node:fs";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// One writer per light, Health the authority for diagnostics and the trend (docs/BACKLOG.md D06-01 .. D06-05):
//  * the FASTAPI light and apiOnline are written only by refreshStatus()'s /api/status read -- not by the Market Runtime
//    socket connecting, a page's initial refresh failing or the model center's own requests;
//  * the 永豐 light is written only from that read's broker_status; FastAPI unanswered makes it 狀態未知, never 未連線;
//  * the monitoring trend a page draws is Health's points only (core/monitoring_trend.js).

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

// ---- sources: no other writer remains ----
const app = read("../ui/renderer/app.js");
const status = read("../ui/renderer/js/core/status.js");
const training = read("../ui/renderer/js/pages/training.js");
assert.doesNotMatch(app, /setApiOnline|markFastApiOffline|setShioajiOnline/, "app.js writes neither the FASTAPI nor the 永豐 light");
assert.doesNotMatch(training, /setApiOnline/, "the model center's requests never write the FASTAPI light");
assert.doesNotMatch(status, /export function setApiOnline|export function setShioajiOnline/, "the two lights have no exported writer");
const wsHandler = app.match(/subscribeRealtimeConnectionState\(\(\{ state, connected \}\) => \{([\s\S]*?)\n {2}\}\);/)?.[1] || "";
assert.ok(wsHandler.includes("setWebSocketOnline(realtimeConnected)"), "the socket callback writes the WebSocket light");
assert.doesNotMatch(wsHandler, /Api/, "and nothing about FastAPI");

// ---- behaviour: refreshStatus() is the owner, also of the offline / unknown answer ----
function makeElement(id) {
  const classes = new Set();
  return { id, textContent: "", classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    add(name) { classes.add(name); }, remove(...names) { for (const name of names) classes.delete(name); },
    contains(name) { return classes.has(name); },
  } };
}
const elements = new Map();
const el = (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.document = { getElementById: (id) => el(id), querySelectorAll: () => [] };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {}, addEventListener() {}, setInterval: () => 0, clearInterval() {},
};
let fastApiUp = true;
let statusReads = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/status")) statusReads += 1;
  if (!fastApiUp) throw new TypeError("fetch failed");
  const body = String(url).includes("/api/futu/status")
    ? { ok: true, readiness: { connected: true, state: "READY" } }
    : { ok: true, sources: { shioaji: { enabled: true } },
      broker_status: { authority: "persistent_market_daemon", readiness: { connected: true, state: "READY" } } };
  return { ok: true, status: 200, json: async () => body };
};
const { refreshStatus, onApiOnline } = await import("../ui/renderer/js/core/status.js");
const lightOf = (dot, text) => ({ online: el(dot).classList.contains("online"), offline: el(dot).classList.contains("offline"), text: el(text).textContent });

let cameOnline = 0;
onApiOnline(() => { cameOnline += 1; });
await refreshStatus();
assert.deepEqual(lightOf("apiStatusDot", "apiStatusText"), { online: true, offline: false, text: "FASTAPI 已連線" });
assert.deepEqual(lightOf("shioajiStatusDot", "shioajiStatusText"), { online: true, offline: false, text: "永豐 已連線" });
assert.equal(cameOnline, 1, "FastAPI answering is the readiness transition pages wait on");

fastApiUp = false;
await new Promise((resolve) => setTimeout(resolve, 1600));
await assert.rejects(refreshStatus(), /fetch failed/);
assert.deepEqual(lightOf("apiStatusDot", "apiStatusText"), { online: false, offline: true, text: "FASTAPI 未連線" },
  "the /api/status read itself shows FastAPI offline -- no caller has to");
const shioaji = lightOf("shioajiStatusDot", "shioajiStatusText");
assert.equal(shioaji.text, "永豐 狀態未知（FastAPI 無回應）", "FastAPI down says nothing about the persistent Shioaji provider");
assert.equal(shioaji.online, false);
assert.equal(shioaji.offline, false, "unknown is not drawn as disconnected");

fastApiUp = true;
onApiOnline(() => { cameOnline += 1; });
await refreshStatus();
assert.equal(cameOnline, 2, "and FastAPI answering again brings it back");
assert.equal(lightOf("shioajiStatusDot", "shioajiStatusText").text, "永豐 已連線");

// The poll sets the cadence (1 s until market data is ready): each of its turns is a new read, or every other turn
// would be answered from the previous one and the cadence silently doubled.
const readsBefore = statusReads;
await refreshStatus();
await refreshStatus();
assert.equal(statusReads, readsBefore + 2, "refreshStatus() never answers from an earlier completed read");

// ---- the trend: Health's points only ----
const { createMonitoringTrend } = await import("../ui/renderer/js/core/monitoring_trend.js");
const trend = createMonitoringTrend();
const snap = (sampledAt, points) => ({ sampled_at: new Date(sampledAt).toISOString(), trend_retention_ms: 300_000, trend: points });
const point = (t) => ({ t, system: { cpu: 1, mem: 2 } });
assert.equal(trend.since(), 0, "nothing held: ask for all of Health's points");
trend.apply(snap(1_000_000, [point(980_000), point(990_000), point(1_000_000)]));
assert.equal(trend.since(), 1_000_000);
// A snapshot between two of Health's samples carries no point: the page adds none (it used to push one per snapshot).
trend.apply(snap(1_002_000, []));
trend.apply(snap(1_004_000, []));
assert.deepEqual(trend.points().map((p) => p.t), [980_000, 990_000, 1_000_000]);
trend.apply(snap(1_010_000, [point(1_000_000), point(1_010_000)]));
assert.deepEqual(trend.points().map((p) => p.t), [980_000, 990_000, 1_000_000, 1_010_000], "a point already held is not taken twice");
// Health's retention, not a length of the page's own.
trend.apply(snap(1_285_000, [point(1_285_000)]));
assert.deepEqual(trend.points().map((p) => p.t), [990_000, 1_000_000, 1_010_000, 1_285_000]);
trend.reset();
assert.deepEqual(trend.points(), []);

assert.doesNotMatch(status, /diagnostics\.trend\.push|slice\(-60\)/, "the diagnostics panel adds no trend point of its own");
assert.match(status, /getMonitoringSnapshot\?\.\(\{ trendSince: diagnostics\.trend\.since\(\) \}\)/);
assert.doesNotMatch(status.slice(status.indexOf("async function loadDiagnosticsInputs")), /"\/api\/status"/,
  "the diagnostics panel does not read /api/status: the Shioaji connection is Health's probe");
console.log("renderer status / Health owner contract passed");
