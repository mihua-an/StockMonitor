import assert from "node:assert/strict";

// Futu 成交明細 pages like Shioaji's (user 10-16): page 1 is the live view, the older pages and the page count are
// /api/trade-detail/page over the stored trades of the view's day and session. It used to pass totalPages 1 always.
globalThis.localStorage = { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, String(value)); }, removeItem() {} };
globalThis.window = { desktopAPI: { sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} },
  networkManifest: { routes: [["/api/", "realtime_api"]], services: { realtime_api: { url: "http://127.0.0.1:8000" } } } }, dispatchEvent() {},
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const requests = [];
globalThis.fetch = async (url) => {
  const query = new URL(url).searchParams;
  requests.push(query);
  const page = Number(query.get("page"));
  const body = query.get("metadata_only") === "true"
    ? { ok: true, page: 1, total_rows: 21992, total_pages: 220, snapshot_watermark: 5000, rows: [] }
    : { ok: true, page, total_rows: 21992, total_pages: 220, snapshot_watermark: 5000,
      rows: [{ ingest_sequence: 4800, exchange_ts_ns: 1792149545739000000, price: 910.16, volume: 5, side: "NEUTRAL", trade_id: "a" }] };
  return { ok: true, status: 200, json: async () => body };
};

const { MoomooTradesComponent } = await import("../ui/renderer/js/features/realtime/components/moomoo_components.js");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const drawn = [];
const component = new MoomooTradesComponent();
component.host = {};
component.sharedTicks = { update: (vm) => drawn.push(vm) };
const live = (sequences) => sequences.map((sequence) => ({ ingest_sequence: sequence, exchange_ts_ns: 1792149545739000000 + sequence,
  price: 911, volume: 1, datetime: "2026-10-16 07:12:28", time: "2026-10-16 07:12:28", source: "futu" }));

// A frame of the live view: its session is known, so the page count is asked once.
component.sessionKey = { trading_date: "2026-10-16", session: "FULL" };
component.renderData({ items: live([5001, 4999]) }, "US.MU");
await settle();
const count = requests.find((query) => query.get("metadata_only") === "true");
assert.ok(count, "the page count is read");
assert.equal(count.get("market"), "US");
assert.equal(count.get("logical_code"), "US.MU");
assert.equal(count.get("trading_date"), "2026-10-16");
assert.equal(count.get("session"), "FULL");
assert.equal(drawn.at(-1).totalPages, 220, "the stored 220 pages");
assert.equal(drawn.at(-1).totalCount, 21993, "plus the live trade newer than the count's watermark");
assert.equal(drawn.at(-1).page, 1);

// More frames do not ask again; a new trade raises the count once.
component.renderData({ items: live([5002, 5001, 4999]) }, "US.MU");
component.renderData({ items: live([5002, 5001, 4999]) }, "US.MU");
await settle();
assert.equal(requests.filter((query) => query.get("metadata_only") === "true").length, 1);
assert.equal(drawn.at(-1).totalCount, 21994);

// An older page is FastAPI's, drawn on the market's clock; a live frame meanwhile keeps that page on screen.
await component.requestPage({ page: 3 });
const pageRead = requests.at(-1);
assert.equal(pageRead.get("page"), "3");
assert.equal(pageRead.get("snapshot_watermark"), "5000", "older pages are read against the counted watermark");
assert.equal(drawn.at(-1).page, 3);
assert.equal(drawn.at(-1).marketRead.channels.trades.data[0].ingest_sequence, 4800);
assert.match(drawn.at(-1).marketRead.channels.trades.data[0].datetime, /^2026-10-16 \d\d:\d\d:\d\d$/);
component.renderData({ items: live([5003, 5002]) }, "US.MU");
assert.equal(drawn.at(-1).page, 3, "a live frame does not pull the list back to page 1");

// Back to page 1 is the live view at once (no read); another product starts over.
const before = requests.length;
await component.requestPage({ page: 1 });
assert.equal(requests.length, before);
assert.equal(drawn.at(-1).page, 1);
component.renderData({ items: live([10]) }, "US.AAPL");
await settle();
assert.equal(requests.at(-1).get("logical_code"), "US.AAPL");
assert.equal(drawn.at(-1).page, 1);

console.log("renderer futu trades paging contract passed");
