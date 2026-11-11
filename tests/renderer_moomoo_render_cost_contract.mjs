import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { liveEngineConnection, rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";
import { futuCanonicalViewSpec } from '../ui/renderer/js/market_data/moomoo_symbol.js';

// Futu product-list / focused-panel render cost -- BEHAVIOURAL.
//
// Four separate defects, all of them "do the same expensive thing once per row, per symbol or per
// frame". None of them is visible from source text, and a source-regex suite would stay green
// against a stub, so this file boots the REAL renderer transport against a fake WebSocket, feeds
// the REAL Market Runtime view frames into the REAL RealtimeViewStore singleton, drives the REAL
// components, and counts the primitives each defect used to burn:
//
//   * Item 4  MoomooProductListComponent.realtimeRow() called getRealtimeViewSnapshot() -- a
//             structuredClone of the WHOLE view state, minute trend and 100-row trade window
//             included -- once per row on every render, to read six summary scalars. Counted here
//             as structuredClone invocations.
//   * Item 5  Each hot view scheduled a FULL table render under its own per-code key, so nine
//             symbols updating in one frame scheduled nine whole-table renders. Counted here as
//             render() calls per animation frame.
//   * Item 6  currentUsSession() constructed an Intl.DateTimeFormat on every call, and it is
//             called once per product row per render (it now reads Rust A's US session and formats
//             nothing). Counted here as constructions.
//   * Item 7  The focused panels re-formatted every trade in the window on every update with
//             `new Date(ms).toLocaleString("sv-SE", {timeZone})`. Counted here as
//             Date.prototype.toLocaleString calls.
//
// Each counter is asserted against a bound that the pre-fix code cannot meet, so reverting any one
// fix fails this file.
//
// Every global this file replaces is put back after the cases (pass or fail), and the transport is ended with
// stopRealtimeStream(), so the process ends by itself.

const REPLACED_GLOBALS = ['structuredClone', 'localStorage', 'document', 'window', 'desktopAPI', 'CustomEvent',
  'ResizeObserver', 'dispatchEvent', 'addEventListener', 'removeEventListener', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'WebSocket', 'fetch'];
const originalGlobals = new Map(REPLACED_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function restoreGlobals() {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  Intl.DateTimeFormat = RealDateTimeFormat;
  Date.prototype.toLocaleString = realToLocaleString;
}

// --- instrumentation, installed before anything can cache a formatter -------------------------
let structuredCloneCalls = 0;
// A view STATE clone is the expensive one: it carries the minute trend and the trade window.
// RealtimeViewStore.describe() also clones the (tiny, fixed-size) spec on every notify, which is
// not what any of these fixes is about, so the two are counted separately rather than lumped.
let viewStateCloneCalls = 0;
const realStructuredClone = globalThis.structuredClone;
globalThis.structuredClone = (value) => {
  structuredCloneCalls += 1;
  if (value && (Array.isArray(value.trend) || Array.isArray(value.trades))) viewStateCloneCalls += 1;
  return realStructuredClone(value);
};

const dateTimeFormatConstructions = [];
let dateTimeFormatCalls = 0;
const RealDateTimeFormat = Intl.DateTimeFormat;
class CountingDateTimeFormat extends RealDateTimeFormat {
  constructor(locales, options) {
    super(locales, options);
    dateTimeFormatConstructions.push({ locales, options: options || {} });
  }
  format(value) { dateTimeFormatCalls += 1; return super.format(value); }
}
Intl.DateTimeFormat = CountingDateTimeFormat;

let toLocaleStringCalls = 0;
const realToLocaleString = Date.prototype.toLocaleString;
Date.prototype.toLocaleString = function countedToLocaleString(...args) {
  toLocaleStringCalls += 1;
  return realToLocaleString.apply(this, args);
};

// --- the minimum browser surface the renderer modules touch -----------------------------------
const noopElement = () => ({
  style: { setProperty() {} }, classList: { add() {}, remove() {} }, dataset: {},
  hidden: false, textContent: '', className: '',
  setAttribute() {}, appendChild() {}, insertBefore() {}, replaceChildren() {}, remove() {},
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
});
globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
globalThis.document = {
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => noopElement(),
  createDocumentFragment: () => ({ childNodes: [], appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
// Source settings are read from preload at module load, before any test code runs.
globalThis.desktopAPI = { waitForFutuProvider: async () => ({ status: "ready", detail: "" }), liveEngineConnection: liveEngineConnection(), networkManifest: rendererNetworkManifest(), sourceSettings: {
  enabled_sources: ['futu', 'shioaji'], startup_steps: {},
  sources: { futu: { api_prefixes: ['/api/futu/'] }, shioaji: { api_prefixes: ['/api/shioaji/'] } },
} };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
// The renderer's heartbeat/watchdog intervals would keep this process alive forever and their
// checkStaleness() sweeps are not what this file is measuring. setTimeout stays real: the shared
// render scheduler falls back to it when requestAnimationFrame is absent, which is the whole
// mechanism Item 5 is about.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
// The shared render scheduler coalesces on animation frames; a macrotask stand-in keeps that exact
// code path (kind "frame") while staying flushable from a test.
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (token) => clearTimeout(token);

const sockets = [];
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 1; this.handlers = new Map(); this.sent = []; sockets.push(this); }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }
  // Like a serving Market Runtime: a health is answered (the window subscribes only after one that says it serves).
  send(raw) { const message = JSON.parse(raw); this.sent.push(message); if (message.type === "health") this.emit("message", { data: JSON.stringify({ type: "health", payload: { status: "healthy", service_id: "market_runtime", protocol: 2 } }) }); }
  close() { this.readyState = 3; }
  emit(type, event) { for (const handler of this.handlers.get(type) || []) handler(event); }
  deliver(message) { this.emit('message', { data: JSON.stringify(message) }); }
}
globalThis.WebSocket = FakeSocket;

let realtime = null;
after(() => {
  realtime?.stopRealtimeStream('test_end');
  restoreGlobals();
});
realtime = await import('../ui/renderer/js/market_data/realtime.js');
const { MoomooProductListComponent, MoomooTradesComponent } =
  await import('../ui/renderer/js/features/realtime/components/moomoo_components.js');

realtime.startRealtimeStream(() => {});
const socket = sockets.at(-1);
assert.ok(socket, 'the renderer must have opened a live-engine socket');
socket.emit('open', {});

// --- fixture: one Futu view, known numbers ----------------------------------------------------
const TRADING_DATE = '2026-09-27';
const trendStamp = (minute) => `${TRADING_DATE}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const trendBar = (minute, close, average) => ({
  minute, close, average_price: average,
  timestamp: trendStamp(minute), minute_timestamp: trendStamp(minute),
  time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
});
// 09:30..09:35 New York. Deliberately longer than the 7-minute window the 1m/3m/5m columns read,
// so a projector that only looks at a tail cannot accidentally pass.
const TREND = [
  trendBar(570, 95, 94.0), trendBar(571, 96, 94.5), trendBar(572, 97, 95.0),
  trendBar(573, 98, 96.0), trendBar(574, 99, 97.0), trendBar(575, 100, 97.5),
];
const trade = (index) => ({
  exchange_ts_ns: (Date.UTC(2026, 8, 27, 13, 30, index) * 1e6),
  price: 100 + index * 0.01, volume: 10 + index, trade_side: 'BUY',
});
const TRADES = Array.from({ length: 60 }, (_item, index) => trade(index));

// 漲跌 is Market Runtime's (SymbolState::change against the 昨收); the renderer only reads it.
const aChange = (current) => ({ change: current - 90, change_pct: (current / 90 - 1) * 100 });

function snapshotFrame(code, requestId, subscriptionId, { watermark = 100, trades = TRADES } = {}) {
  return {
    type: 'view.snapshot',
    request_id: requestId,
    payload: {
      subscription_id: subscriptionId, stream_id: 'stream-1',
      watermark, sequence: watermark, generation: 1,
      market: 'US', code, session: 'FULL', trading_date: TRADING_DATE,
      summary: { current: 100, prev_close: 90, ...aChange(100), open: 91, high: 101, low: 89, total_volume: 12345 },
      trend: TREND, trades,
      windows: { windows: { 1: { change_pct: 1.25 }, 3: { change_pct: 2.5 }, 5: { change_pct: 3.75 } } },
      orderbook: { bids: [], asks: [] },
      price_volume: { in_volume: 1, out_volume: 2 },
    },
  };
}

function deltaFrame(code, subscriptionId, sequence, current) {
  return {
    type: 'view.delta',
    payload: {
      subscription_id: subscriptionId, stream_id: 'stream-1', sequence, generation: 1,
      market: 'US', code, session: 'FULL', trading_date: TRADING_DATE,
      delta_type: 'summary.updated', channels: ['summary'],
      payload: { current, prev_close: 90, ...aChange(current), open: 91, high: 101, low: 89, total_volume: 12345 },
    },
  };
}

const CODES = ['US.AAA', 'US.BBB', 'US.CCC', 'US.DDD', 'US.EEE', 'US.FFF', 'US.GGG', 'US.HHH', 'US.III'];
const subscriptionOf = new Map();

function acceptAndSeed(codes, { trades = TRADES } = {}) {
  for (const code of codes) {
    const request = socket.sent.findLast((message) => message.type === 'view.subscribe' && message.payload?.code === code && !message.payload?.trading_date);
    assert.ok(request, `the component must have sent a view.subscribe for ${code}`);
    const subscriptionId = `sub-${code}`;
    subscriptionOf.set(code, subscriptionId);
    socket.deliver({
      type: 'view.subscription.accepted',
      payload: { request_id: request.payload.request_id, subscription_id: subscriptionId, stream_id: 'stream-1', watermark: 0, symbol: `futu:US:${code}` },
    });
    socket.deliver(snapshotFrame(code, request.payload.request_id, subscriptionId, { trades }));
  }
}

// Two hops: the scheduler's own frame, then any paint callback it queues behind it.
const flushFrames = async () => { for (let hop = 0; hop < 3; hop += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

// moomooQuoteStore is the one owner of a view subscription per Futu code; the product list only renders the store's
// rows and the codes the store says moved.
const { moomooQuoteStore } = await import('../ui/renderer/js/features/realtime/moomoo_quote_store.js');
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('/api/futu/watchlist')) {
    return { ok: true, status: 200, json: async () => ({ items: CODES.map((code, index) => ({ code, name: code.slice(3), sort_order: index })) }) };
  }
  if (path.includes('/api/futu/status')) {
    return { ok: true, status: 200, json: async () => ({ readiness: { connected: true, market_data_ready: true } }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
await moomooQuoteStore.bootstrap({ force: true });
assert.equal(moomooQuoteStore.products.length, CODES.length,
  'the quote store must have adopted the catalog, or its view subscriptions never happen');

const list = new MoomooProductListComponent();
list.host = { querySelector: () => null, querySelectorAll: () => [] };
list.pages = [{ id: 'page-1', name: 'US', source: 'futu', codes: CODES, count: CODES.length }];
list.activePageId = 'page-1';
acceptAndSeed(CODES);
await flushFrames();
assert.equal(socket.sent.filter((message) => message.type === 'view.subscribe').length, CODES.length,
  'one view.subscribe per code: the product list opens none of its own beside the store');

// --- Item 4: a product row must not clone the whole view state --------------------------------
test('Item 4: a product row must not clone the whole view state', async () => {
  const rows = moomooQuoteStore.snapshot().products;
  structuredCloneCalls = 0;
  const built = rows.map((row) => list.realtimeRow(row, true));
  assert.equal(structuredCloneCalls, 0,
    'building the product rows must not deep-clone any view state -- a row is the store row plus its live fields');

  // The cheap read has to produce the SAME row, or this is a speed-up that changed the numbers.
  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`);
  const first = built[0];
  assert.equal(first.current, 100);
  assert.equal(first.prev_close, 90);
  assert.equal(first.open, 91);
  assert.equal(first.day_high, 101);
  assert.equal(first.day_low, 89);
  assert.equal(first.total_volume, 12345);
  assert.equal(first.avg_price, 97.5, 'the average price comes from the last minute-trend bar');
  near(first.change_pct, (100 / 90 - 1) * 100, 'change_pct');
  near(first.chg_1m, 1.25, "chg_1m is Rust B's 1-minute window");
  near(first.chg_3m, 2.5, "chg_3m is Rust B's 3-minute window");
  near(first.chg_5m, 3.75, "chg_5m is Rust B's 5-minute window");

  for (const leaked of ['presentation_state', 'view_status', 'resyncing', 'view_error']) {
    assert.equal(Object.hasOwn(first, leaked), false, `${leaked} must not leak into a product row`);
  }
});

// --- Item 6: one Intl.DateTimeFormat for the US session clock, not one per row ----------------
test('Item 6: one Intl.DateTimeFormat for the US session clock, not one per row', async () => {
  const beforeNy = dateTimeFormatConstructions.filter((item) => item.options?.timeZone === 'America/New_York').length;
  for (let round = 0; round < 20; round += 1) {
    CODES.forEach((code) => list.realtimeRow({ code, name: code }, true));
  }
  const afterNy = dateTimeFormatConstructions.filter((item) => item.options?.timeZone === 'America/New_York').length;
  assert.equal(afterNy - beforeNy, 0,
    '180 product rows must construct zero further New York session formatters -- the timezone is '
    + 'fixed, so the formatter is built once and reused (core/utility.js::formatQuantity precedent)');
  assert.ok(beforeNy <= 1, 'the US session clock must be a single cached formatter');
});

const sequenceOf = new Map(CODES.map((code) => [code, 100]));
const nextSequence = (code) => { const next = sequenceOf.get(code) + 1; sequenceOf.set(code, next); return next; };

// --- Item 5: one frame of deltas is one table render with the codes that moved -----------------
test('Item 5: one frame of deltas is one table render with the codes that moved', async () => {
  const renders = [];
  const release = moomooQuoteStore.subscribe((state) => { if (state.changedCodes) renders.push(state); });
  CODES.forEach((code, index) => socket.deliver(deltaFrame(code, subscriptionOf.get(code), nextSequence(code), 101 + index)));
  await flushFrames();
  assert.equal(renders.length, 1,
    `${CODES.length} symbols updating in one frame must coalesce into ONE emit, not one per symbol`);
  assert.deepEqual([...renders[0].changedCodes].sort(), [...CODES].sort(),
    'the coalesced emit must carry every code that moved, so no row is silently left stale');

  renders.length = 0;
  socket.deliver(deltaFrame(CODES[0], subscriptionOf.get(CODES[0]), nextSequence(CODES[0]), 111));
  await flushFrames();
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].changedCodes, [CODES[0]], 'only the symbol that moved is marked dirty on the next frame');

  // A notice that moved nothing a row shows marks no row.
  renders.length = 0;
  socket.deliver(deltaFrame(CODES[0], subscriptionOf.get(CODES[0]), nextSequence(CODES[0]), 111));
  await flushFrames();
  assert.equal(renders.length, 0, 'a delta with the same row facts must not repaint the row');
  release();
});

// --- Item 4, second half: the quote store must not clone a view per delta either ---------------
test('Item 4, second half: the quote store must not clone a view per delta either', async () => {
  viewStateCloneCalls = 0;
  CODES.forEach((code) => socket.deliver(deltaFrame(code, subscriptionOf.get(code), nextSequence(code), 120)));
  await flushFrames();
  assert.equal(viewStateCloneCalls, 0,
    `${CODES.length} deltas must not deep-clone the whole view state for the quote store`);
  const updated = moomooQuoteStore.snapshot().products.find((row) => row.code === CODES[0]);
  assert.equal(moomooQuoteStore.products.find((row) => row.code === CODES[0]).regular_current, undefined,
    'the catalog row itself stays static');
  assert.equal(updated.regular_current, 120, 'the quote store must still apply the delta it was told about');
  assert.equal(updated.prev_close_price, 90);
  assert.equal(updated.regular_avg_price, 97.5);
  for (const leaked of ['presentation_state', 'view_status', 'resyncing', 'view_error']) {
    assert.equal(Object.hasOwn(updated, leaked), false, `${leaked} must not leak into a quote-store product row`);
  }

  // An authoritative snapshot with nothing in it (a new session before its first quote) clears the row.
  const emptyCode = CODES[CODES.length - 1];
  assert.equal(moomooQuoteStore.snapshot().products.find((row) => row.code === emptyCode).regular_current, 120);
  const request = socket.sent.findLast((message) => message.type === 'view.subscribe' && message.payload?.code === emptyCode && !message.payload?.trading_date);
  const empty = snapshotFrame(emptyCode, request.payload.request_id, subscriptionOf.get(emptyCode), { watermark: 200, trades: [] });
  Object.assign(empty.payload, { summary: {}, trend: [], tradeflow: {}, price_volume: { buckets: [] } });
  socket.deliver(empty);
  sequenceOf.set(emptyCode, 200);
  await flushFrames();
  assert.equal(moomooQuoteStore.snapshot().products.find((row) => row.code === emptyCode).regular_current, undefined,
    'the previous session\'s price must go with an empty authoritative snapshot');
});

// --- Item 5, second guard: one frame is one pass over the rows --------------------------------
test('Item 5, second guard: one frame is one pass over the rows', async () => {
  let realtimeRowCalls = 0;
  const realRealtimeRow = list.realtimeRow.bind(list);
  list.realtimeRow = (row, live) => { realtimeRowCalls += 1; return realRealtimeRow(row, live); };
  const release = moomooQuoteStore.subscribe((state) => { if (state.changedCodes) list.render(state); });
  CODES.forEach((code) => socket.deliver(deltaFrame(code, subscriptionOf.get(code), nextSequence(code), 130)));
  await flushFrames();
  release();
  list.realtimeRow = realRealtimeRow;
  assert.equal(realtimeRowCalls, CODES.length,
    `one frame must project each of the ${CODES.length} rows once`);
});

// --- Item 7: the trade panel must not re-format rows that have not changed --------------------
test('Item 7: the trade panel must not re-format rows that have not changed', async () => {
  const trades = new MoomooTradesComponent();
  trades.host = { querySelector: () => null, querySelectorAll: () => [] };
  const code = CODES[0];

  toLocaleStringCalls = 0;
  dateTimeFormatCalls = 0;
  trades.bindRustView(code);
  await flushFrames();

  assert.equal(toLocaleStringCalls, 0,
    'the trade panel must not reach for Date.prototype.toLocaleString per trade -- that is the '
    + 'per-call formatter construction this fix removes');
  const firstPass = dateTimeFormatCalls;
  assert.equal(firstPass, TRADES.length,
    `the first projection must format each of the ${TRADES.length} trades exactly once`);

  // One new trade arrives; the other 60 are byte-identical rows that were already formatted.
  const extended = [...TRADES, trade(TRADES.length)];
  const request = socket.sent.findLast((message) => message.type === 'view.subscribe' && message.payload?.code === code && !message.payload?.trading_date);
  dateTimeFormatCalls = 0;
  socket.deliver(snapshotFrame(code, request.payload.request_id, subscriptionOf.get(code), { watermark: 300, trades: extended }));
  await flushFrames();

  assert.equal(dateTimeFormatCalls, 1,
    'a window that gained one trade must format one trade -- re-formatting the 60 unchanged rows '
    + 'was ~16% of main-thread self time');
  assert.equal(toLocaleStringCalls, 0);

  // Cheaper must still mean identical. The cached string is the one toLocaleString produced.
  // The product has exactly ONE canonical view identity per Futu code, and `channels` is part
  // of the store key -- so a probe that omits them addresses a different entry and finds
  // nothing. Read it the way the product declares it.
  // Read through select(), not snapshot(): this suite replaces structuredClone with a counter,
  // so the cloning read is not a usable probe here -- and select() is the clone-free path the
  // product itself uses for exactly this reason.
  const projected = realtime.selectRealtimeView(futuCanonicalViewSpec(code), (state) => ({
    trades: state.trades || [],
  }));
  const newest = projected.trades.at(-1);
  const expected = realToLocaleString.call(new Date(Number(newest.exchange_ts_ns) / 1e6), 'sv-SE',
    { timeZone: 'America/New_York', hour12: false });
  assert.match(expected, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const formatted = new RealDateTimeFormat('sv-SE', { timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(Number(newest.exchange_ts_ns) / 1e6));
  assert.equal(formatted, expected,
    'the cached formatter must produce exactly the string toLocaleString did, or this fix changed the UI');

  trades.destroy();
});

// --- Item 7, equivalence: cheaper must not mean different -------------------------------------
// The replacement is an Intl.DateTimeFormat with the components toLocaleString("sv-SE") implies.
// If those components are wrong the panel silently shows a different clock, so the equivalence is
// asserted across every timezone the focused panels choose from (US / HK / UTC) and across both
// New York DST transitions, where a mis-specified formatter diverges by an hour.
test('Item 7, equivalence: cheaper must not mean different', async () => {
  const ZONES = ['America/New_York', 'Asia/Hong_Kong', 'UTC'];
  // 2026 US DST: forward 2026-03-08 07:00Z, back 2026-11-01 06:00Z. Walk a window around each.
  const anchors = [
    Date.UTC(2026, 2, 8, 4, 0, 0),    // 3 hours before spring-forward
    Date.UTC(2026, 10, 1, 3, 0, 0),   // 3 hours before fall-back
    Date.UTC(2026, 5, 15, 12, 0, 0),  // mid-DST
    Date.UTC(2025, 11, 31, 23, 30, 0), // year boundary
  ];
  let compared = 0;
  for (const zone of ZONES) {
    const formatter = new RealDateTimeFormat('sv-SE', { timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    for (const anchor of anchors) {
      for (let step = 0; step < 500; step += 1) {
        const at = new Date(anchor + step * 37_117);
        assert.equal(formatter.format(at), realToLocaleString.call(at, 'sv-SE', { timeZone: zone, hour12: false }),
          `cached formatter diverged from toLocaleString in ${zone} at ${at.toISOString()}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, ZONES.length * anchors.length * 500);
  // And the shipped path really is that formatter: a trade projected through the component carries
  // the same string, for each market's timezone.
  for (const [market, zone] of [['US', 'America/New_York'], ['HK', 'Asia/Hong_Kong'], ['CC', 'America/New_York']]) {
    const marketCode = `${market}.ZZZ`;
    const panel = new MoomooTradesComponent();
    panel.host = { querySelector: () => null, querySelectorAll: () => [] };
    panel.bindRustView(marketCode);
    const request = socket.sent.findLast((message) => message.type === 'view.subscribe' && message.payload?.code === marketCode && !message.payload?.trading_date);
    assert.ok(request, `binding ${marketCode} must subscribe a view`);
    const subscriptionId = `sub-${marketCode}`;
    socket.deliver({ type: 'view.subscription.accepted',
      payload: { request_id: request.payload.request_id, subscription_id: subscriptionId, stream_id: 'stream-1', watermark: 0 } });
    const frame = snapshotFrame(marketCode, request.payload.request_id, subscriptionId, { trades: [trade(7)] });
    frame.payload.market = market;
    socket.deliver(frame);
    await flushFrames();
    // Same reason as above: clone-free read, and the product's own canonical identity.
    const state = realtime.selectRealtimeView(futuCanonicalViewSpec(marketCode), (view) => ({
      trades: view.trades || [],
    }));
    const at = new Date(Number(state.trades.at(-1).exchange_ts_ns) / 1e6);
    assert.equal(panel.tradeTimeCache.get(`${zone}|${state.trades.at(-1).exchange_ts_ns}`),
      realToLocaleString.call(at, 'sv-SE', { timeZone: zone, hour12: false }),
      `${market} trades must be stamped in ${zone}, byte-identical to the call this replaced`);
    panel.destroy();
  }
});

after(() => {
  list.destroy();
  socket.close();
});
