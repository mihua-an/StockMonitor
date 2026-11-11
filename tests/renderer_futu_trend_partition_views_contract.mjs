import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// Futu 個股走勢 reads its tab windows from dated views (one per New York date partition), driven through the real view
// store over Market Runtime's wire:
//  * one view.subscribe per partition date, and every partition's rows reach the chart with their date and minute;
//    the tabs take their windows' minutes (夜盤 is tonight only);
//  * each partition keeps its view state: one that fails keeps its last rows and the chart reads as partial (stale),
//    every partition failing with nothing to draw is an error -- never a complete-looking chart;
//  * a summary notice rebuilds nothing: the merged rows stay the same array while no partition's sequence moved, and a
//    render filters them once.
// (selectRealtimeView adds its status fields to what a projector returns -- a projector returning a bare array lost
// every row and the chart drew empty.)

const live = installRealtimeHarness({ enabledSources: ["futu"] });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [] }) });
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
};

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const { MoomooTrendComponent } = await import("../ui/renderer/js/features/realtime/components/moomoo_components.js");
const { partitionTrendPresentation } = await import("../ui/renderer/js/features/realtime/components/futu/trend_component.js");

realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.ready();

const CODE = "US.NOK";
const component = new MoomooTrendComponent();
// Monday 2026-10-19 21:40 New York, as Rust A sends it (session.current `us`).
component.usSession = () => ({ phase: "overnight", windows: {
  day: [{ trading_date: "2026-10-19", from: 240, to: 1200 }],
  overnight: [{ trading_date: "2026-10-19", from: 1200, to: 1440 }, { trading_date: "2026-10-20", from: 0, to: 240 }],
  full: [{ trading_date: "2026-10-19", from: 1200, to: 1440 }, { trading_date: "2026-10-20", from: 0, to: 1200 }] } });
const specs = component.partitionViewSpecs(CODE);
assert.deepEqual(specs.map((s) => s.trading_date), ["2026-10-19", "2026-10-20"]);
const releases = specs.map((spec) => realtime.subscribeRealtimeView(spec, () => {}, { stateDelivery: "snapshot-only", replayCached: false }));
await live.settle(() => socket.sentOfType("view.subscribe").length >= 2);

const subscribes = socket.sentOfType("view.subscribe");
assert.equal(subscribes.length, 2, "one view.subscribe per partition");
assert.deepEqual(subscribes.map((m) => m.payload.trading_date).sort(), ["2026-10-19", "2026-10-20"], "one per date");
assert.ok(subscribes.every((m) => m.payload.code === CODE && m.payload.source === "futu"));

const point = (date, minute, price) => {
  const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return { minute, time, timestamp: `${date}T${time}:00-04:00`, close: price, price };
};
// Monday's partition: last night's tail (00:30), the day (10:00) and tonight's head (20:10). Tuesday's: just past
// midnight (00:05) -- each partition has rows of its own, so a trend reading one partition only cannot pass.
const ROWS = {
  "2026-10-19": [point("2026-10-19", 30, 9.4), point("2026-10-19", 600, 9.2), point("2026-10-19", 1210, 9.02)],
  "2026-10-20": [point("2026-10-20", 5, 9.05)],
};
const identities = new Map();
let sub = 0;
for (const message of subscribes) {
  const date = message.payload.trading_date;
  const identity = { request_id: message.payload.request_id, subscription_id: `sub-${++sub}`, stream_id: `stream-${date}`, watermark: 1 };
  identities.set(date, identity);
  socket.frame({ type: "view.subscription.accepted", payload: identity });
  socket.frame({ type: "view.snapshot", payload: {
    ...identity, sequence: 1, source: "futu", market: "US", code: CODE, session: "FULL", trading_date: date,
    session_key: { market: "US", logical_code: CODE, session: "FULL", trading_date: date }, trend: ROWS[date],
  } });
}

const read = () => { const state = { trend: [] }; component.readPartitions(state, CODE); return state; };
const first = read();
assert.deepEqual(first.trend.map((r) => `${r.trading_date}:${r.minute}`),
  ["2026-10-19:30", "2026-10-19:600", "2026-10-19:1210", "2026-10-20:5"], "both partitions' rows reach the trend, keyed by date and minute");
assert.equal(first.trend[0].time, "2026-10-19T00:30:00");
assert.equal(first.trend[3].time, "2026-10-20T00:05:00");
assert.deepEqual(first.presentation, { presentation_state: "ready", view_error: null });

// Nothing changed (a summary notice): the same merged rows, not a rebuilt copy.
const again = read();
assert.equal(again.trend, first.trend, "no partition's trend changed: the merged rows are the same array");

// The tabs filter the rows once per render.
let filters = 0;
component.renderSessionControl = () => {};
component.updateSummary = () => {};
component.draw = () => {};
const realFiltered = component.filteredRows.bind(component);
component.filteredRows = () => { filters += 1; return realFiltered(); };
component.renderData({ items: first.trend, presentation: first.presentation }, CODE);
component.filteredRows = realFiltered;
component.activeSession = "overnight";
assert.deepEqual(component.filteredRows().map((r) => `${r.trading_date}:${r.minute}`), ["2026-10-19:1210", "2026-10-20:5"], "夜盤 is tonight's minutes");
const overnight = component.filteredRows();
assert.equal(component.filteredRows(), overnight, "asked again for the same rows and window: worked out once");
component.activeSession = "day";
assert.deepEqual(component.filteredRows().map((r) => r.minute), [600]);

// A new print in Tuesday's partition rebuilds the merged rows; Monday's copies are kept.
socket.frame({ type: "view.delta", payload: { ...identities.get("2026-10-20"), sequence: 2, delta_type: "trend.upsert", channels: ["trend"],
  session_key: { market: "US", logical_code: CODE, session: "FULL", trading_date: "2026-10-20" }, payload: point("2026-10-20", 6, 9.06) } });
const moved = read();
assert.notEqual(moved.trend, first.trend);
assert.deepEqual(moved.trend.map((r) => r.minute), [30, 600, 1210, 5, 6]);
assert.equal(moved.trend[0], first.trend[0], "an unchanged partition's rows are the same copies");

// Tuesday's partition fails: its last rows stay and the chart reads as partial, not complete.
socket.frame({ type: "view.subscription.error", payload: { subscription_id: identities.get("2026-10-20").subscription_id, error: "partition unavailable" } });
const partial = read();
assert.deepEqual(partial.trend.map((r) => r.minute), [30, 600, 1210, 5, 6], "the failed partition keeps its last rows");
assert.equal(partial.presentation.presentation_state, "stale", "one failed partition: the chart is partial");
assert.equal(partial.presentation.view_error, null);

// The rule itself: the worst state, a failure among drawn partitions is partial, only all failed with nothing is an error.
const part = (presentation_state, rows = [], view_error = null) => ({ rows, presentation_state, view_error });
assert.deepEqual(partitionTrendPresentation([part("ready", [1]), part("empty")]), { presentation_state: "ready", view_error: null });
assert.equal(partitionTrendPresentation([part("ready", [1]), part("loading")]).presentation_state, "loading");
assert.equal(partitionTrendPresentation([part("resyncing", [1]), part("error", [], "x")]).presentation_state, "resyncing");
assert.equal(partitionTrendPresentation([part("error", [1], "x"), part("error", [], "y")]).presentation_state, "stale", "rows still drawn: partial");
assert.deepEqual(partitionTrendPresentation([part("error", [], "x"), part("error", [], "y")]), { presentation_state: "error", view_error: "x" });

releases.forEach((release) => release());
console.log("renderer_futu_trend_partition_views_contract: ok");
