// The Workspace window's outside world for renderer_workspace_window_ui.cjs: Market Runtime's socket and the HTTP APIs,
// answered from here so the real workspace_view.html runs unchanged.
const DATE = "2026-11-06";
const wire = [];
window.__wire = wire;

function seedOf(text) { let h = 7; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

const REFERENCES = { 2330: 1085, 2317: 215.5, 2454: 1415, 2603: 198.5, 3231: 142, 2382: 297, 2308: 1120, 6173: 41.25, TSE001: 22781, TXF202611: 22760, CDF202611: 1083 };

function snapshotOf(spec) {
  const reference = REFERENCES[spec.code] || (100 + (seedOf(spec.code) % 50));
  const seed = seedOf(spec.code);
  const trend = [];
  let price = reference;
  for (let minute = 540; minute < 700; minute += 1) {
    price = Number((price * (1 + (((seed * minute) % 7) - 3) * 0.0002)).toFixed(2));
    const stamp = `${DATE}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`;
    trend.push({ minute, minute_timestamp: stamp, timestamp: stamp, price, close: price, open: price, high: price, low: price, average_price: reference, minute_volume: 10 + (minute % 40), total_volume: minute });
  }
  const current = price;
  const trades = Array.from({ length: 80 }, (_, index) => ({
    price: current, volume: 1 + (index % 9), ingest_sequence: index + 1, tick_type: 1,
    datetime: `${DATE}T11:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}+08:00`,
  }));
  return {
    summary: { name: "", open: reference, high: current + 2, low: current - 2, current, close: current, prev_close: reference, reference_price: reference, change: current - reference, change_pct: (current - reference) / reference * 100, total_volume: 1000, limit_up: reference * 1.1, limit_down: reference * 0.9 },
    trend, trades,
    orderbook: { bid_prices: [1, 2, 3, 4, 5].map((n) => current - n), bid_volumes: [11, 12, 13, 14, 15], ask_prices: [1, 2, 3, 4, 5].map((n) => current + n), ask_volumes: [21, 22, 23, 24, 25] },
  };
}

class FakeSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() {
    super();
    this.readyState = FakeSocket.CONNECTING;
    this.binaryType = "blob";
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.push("session.current", { equity: { trading_date: DATE }, futures: {
        DAY: { session: "day", trading_date: DATE, display_date: DATE, live: true, partitions: [{ trading_date: DATE, session: "DAY" }] },
        NIGHT: { session: "night", trading_date: DATE, display_date: "2026-11-05", live: false, partitions: [] },
      } });
    }, 0);
  }
  push(type, payload) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, payload }) })); }
  send(text) {
    const message = JSON.parse(text);
    wire.push(message);
    if (message.type === "health") { setTimeout(() => this.push("health", { service_id: "fake_runtime", protocol: 1, status: "ok" }), 0); return; }
    if (message.type !== "view.subscribe") return;
    const spec = message.payload;
    const id = spec.request_id;
    setTimeout(() => {
      this.push("view.subscription.accepted", { request_id: id, subscription_id: id, stream_id: `${id}-stream`, watermark: 0 });
      this.push("view.snapshot", { request_id: id, subscription_id: id, stream_id: `${id}-stream`, watermark: 0, channels: spec.channels,
        session_key: { market: spec.market, logical_code: spec.code, session: spec.session, trading_date: spec.trading_date, source: spec.source }, ...snapshotOf(spec) });
    }, 0);
  }
  close() { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(new CloseEvent("close")); }
}
window.WebSocket = FakeSocket;

const ANSWERS = {
  "/api/watch-pages": { pages: [{ id: "a", market: "tw", codes: ["2330", "2317", "2454", "2603", "3231", "2382", "2308", "6173", "2881"], items: [{ code: "2330", name: "台積電" }, { code: "2317", name: "鴻海" }] }] },
  "/api/subscriptions": { instruments: [
    { source: "shioaji", code: "2330", name: "台積電", trade: true, orderbook: true, futures: { category: "CDF", months_listed: ["202611", "202612"], months: [], on: true, trade: true, orderbook: true } },
    { source: "shioaji", code: "2317", name: "鴻海", trade: true, orderbook: true },
  ] },
  "/api/security-master/search": { items: [{ code: "2382", name: "廣達", market: "TSE" }] },
  "/api/trade-detail/page": { ok: true, rows: [], page: 1, total_pages: 1, total_rows: 0, snapshot_watermark: 0 },
};
const realFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input?.url || input);
  const answer = Object.entries(ANSWERS).find(([path]) => url.includes(path))?.[1];
  if (answer || /^https?:/.test(url)) return new Response(JSON.stringify(answer || { ok: true, items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return realFetch(input, init);
};

let seedListener = null;
window.desktopAPI = {
  liveEngineConnection: { url: "ws://fake.invalid/", expected: { service_id: "fake_runtime", protocol: 1 } },
  networkManifest: { routes: [["/api", "fake_api"]], services: { fake_api: { url: "http://fake.invalid" } } },
  sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: { shioaji: { api_prefixes: [] }, futu: { api_prefixes: [] } } },
  onWorkspaceSeed(listener) { seedListener = listener; return () => {}; },
};
window.__sendSeed = (code) => seedListener?.(code);
