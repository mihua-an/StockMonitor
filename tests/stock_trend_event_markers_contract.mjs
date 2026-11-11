import assert from "node:assert/strict";

// 個股走勢 盤中事件 markers: the 歷史回放 vocabulary, one marker per minute (B's highest priority wins), only for the
// selected code, placed on that minute's trend price, and a revoked alert never shown. The toggle persists.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const seen = [];
globalThis.window = { dispatchEvent: (e) => seen.push(e.type), addEventListener() {}, removeEventListener() {} };
const m = await import("../ui/renderer/js/core/event_markers.js");

const points = [
  { minute_timestamp: "2026-09-30T09:01:00+08:00", price: 100 },
  { minute_timestamp: "2026-09-30T09:02:00+08:00", price: 101 },
];
const events = [
  { event_id: "a", code: "2330", time: "09:01:12", info: "3分急拉", direction: "up", priority: 350 },
  { event_id: "b", code: "2330", time: "09:01:40", info: "開盤急拉", direction: "up", priority: 450 },
  { event_id: "c", code: "2330", time: "09:02:05", info: "5分急殺", direction: "down", priority: 300, revoked: true },
  { event_id: "d", code: "2317", time: "09:02:05", info: "1分急拉", direction: "up", priority: 400 },
  { event_id: "e", code: "2330", time: "09:05:00", info: "1分急拉", direction: "up", priority: 400 },   // no trend point yet: not placed
];
const markers = m.liveEventMarkers(events, { code: "2330", points });
assert.deepEqual(markers.map((x) => [x.time, x.label, x.price]), [["09:01:40", "開盤急拉", 100]],
  "one marker per minute, highest priority, on the minute's price; other codes, revoked and unplaceable are skipped");
assert.equal(markers[0].color, m.eventMarkerColor(events[1]));
assert.equal(markers[0].placement, "below");
assert.equal(markers[0].dot, false, "live markers draw the leader line and label, no dot");

assert.equal(m.stockTrendEventMarkersVisible(), true, "markers are on by default");
m.setStockTrendEventMarkersVisible(false);
assert.equal(m.stockTrendEventMarkersVisible(), false);
assert.ok(seen.includes("stock-trend-event-markers-changed"));
console.log("stock trend event markers contract passed");
