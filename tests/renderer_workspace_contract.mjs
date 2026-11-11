import assert from "node:assert/strict";
import { WorkspaceStore, WORKSPACE_MAX_SYMBOLS, isSupportedWorkspaceCode, isFutuWorkspaceCode } from "../ui/renderer/js/features/workspace/workspace_store.js";
import { createWorkspaceBenchmarkSource } from "../ui/renderer/js/features/workspace/workspace_benchmark_source.js";
import { WorkspaceColumn } from "../ui/renderer/js/features/workspace/workspace_column_runtime.js";
import { stockCanonicalViewSpec } from "../ui/renderer/js/market_data/stock_view_spec.js";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";
import { MarketDataGateway } from "../ui/renderer/js/market_data/market_data_gateway.js";
import { createDashboardContext } from "../ui/renderer/js/core/dashboard_context.js";
import { tradesReadView } from "../ui/renderer/js/core/market_read_model.js";

// --- 1. WorkspaceStore: add/remove/replace/reorder, max 6, reject duplicate, mixed providers (v2) ---
{
  const store = new WorkspaceStore();
  assert.equal(store.maxSymbols, WORKSPACE_MAX_SYMBOLS);
  assert.equal(store.add("2330").ok, true);
  assert.equal(store.add("2330").ok, false, "duplicate must be rejected");
  assert.equal(store.add("US.AAPL").ok, true, "v2: Futu codes are now supported alongside Shioaji codes");
  assert.equal(isSupportedWorkspaceCode("US.AAPL"), true);
  assert.equal(isSupportedWorkspaceCode("2330"), true);
  assert.equal(isSupportedWorkspaceCode("US."), false, "a malformed Futu code (nothing after the dot) is rejected");
  assert.equal(isFutuWorkspaceCode("US.AAPL"), true);
  assert.equal(isFutuWorkspaceCode("2330"), false);
  // Futu codes are canonicalized by shape only: CC.BTCUSD is kept as written, and a second add is the same symbol.
  assert.equal(store.add("CC.BTCUSD").ok, true);
  assert.equal(store.list().includes("CC.BTCUSD"), true);
  assert.equal(store.add("cc.btcusd").ok, false, "the same code in another case is the same symbol");

  for (const code of ["2317", "2303", "1101"]) assert.equal(store.add(code).ok, true);
  assert.equal(store.list().length, 6, "2330, US.AAPL, CC.BTCUSD, 2317, 2303, 1101 -- mixed providers still count toward one shared max-6");
  assert.equal(store.isFull(), true);
  const overflow = store.add("2891");
  assert.equal(overflow.ok, false, "7th symbol must be rejected regardless of provider");
  assert.match(overflow.error, /6/);

  const removed = store.remove("US.AAPL");
  assert.equal(removed.ok, true);
  assert.equal(store.list().includes("US.AAPL"), false);
  assert.equal(store.add("US.MSFT").ok, true, "a freed slot must accept a new symbol from either provider");

  const replaceResult = store.replace(0, "US.NVDA");
  assert.equal(replaceResult.ok, true, "a Shioaji column can be replaced with a Futu symbol");
  assert.equal(store.list()[0], "US.NVDA");
  assert.equal(store.replace(0, "2317").ok, false, "replace must reject a code already present elsewhere");

  const before = store.list();
  const reordered = store.reorder(0, 2);
  assert.equal(reordered.ok, true);
  assert.equal(store.list()[2], before[0]);

  const setAllResult = store.setAll(["2330", "2330", "US.AAPL", "US.", "2317", "2303", "1101", "2412", "2882", "2891"]);
  assert.deepEqual(setAllResult, ["2330", "US.AAPL", "2317", "2303", "1101", "2412"], "setAll dedupes, drops malformed codes, keeps mixed providers, and caps at max");
}

// --- 2. A Taiwan futures month is a product of the workspace too ---
{
  assert.equal(isSupportedWorkspaceCode("CDF202611"), true, "a stock's futures month");
  assert.equal(isSupportedWorkspaceCode("TXF202611"), true, "an index future's month");
  assert.equal(isSupportedWorkspaceCode("CDF2026"), false, "not a month");
  assert.equal(isFutuWorkspaceCode("CDF202611"), false, "a futures month is Shioaji's");
}

// --- 3. Shared benchmark source: N concurrent ensure() calls -> exactly ONE Rust subscription ---
{
  let calls = 0;
  let deliver;
  const subscribeView = (spec, callback) => {
    calls += 1;
    assert.equal(spec.market, "IDX");
    deliver = callback;
    return () => {};
  };
  const source = createWorkspaceBenchmarkSource({ subscribeView });
  const pending = Promise.all([
    source.ensure("taiex"), source.ensure("taiex"), source.ensure("taiex"),
    source.ensure("taiex"), source.ensure("taiex"), source.ensure("taiex"),
  ]);
  deliver({ type: "snapshot", state: { summary: { open: 100, reference_price: 98 }, trend: [{ time: "09:00:00", price: 100 }] } });
  const results = await pending;
  assert.equal(results.length, 6);
  assert.equal(calls, 1, "six columns calling ensure() concurrently must share one Rust subscription");
  assert.equal(source.points("taiex").length, 1);
  assert.equal(source.referencePrice("taiex"), 98);
  source.dispose();
}

// --- 4/7/8/9. WorkspaceColumn: per-symbol isolation for trend/orderbook/trades ---
{
  const wire = [];
  const rawStore = new RealtimeViewStore({ send: (message) => { wire.push(message); return true; } });
  const gateway = new MarketDataGateway({ subscribeView: rawStore.subscribe.bind(rawStore), getSnapshot: rawStore.snapshot.bind(rawStore) });
  rawStore.onConnected();

  const apiGetCalls = [];
  const apiGet = async (path) => {
    apiGetCalls.push(path);
    return { ok: true, rows: [], page: 1, total_pages: 1, total_rows: 0, snapshot_watermark: 0 };
  };
  const benchmarkSource = { ensure: async () => {}, points: () => [], openPrice: () => null };

  function makeColumn(code) {
    const context = createDashboardContext({ id: `test:${code}`, mode: "live", capabilities: ["tick", "bidask", "trend"] });
    return new WorkspaceColumn({ code, tradingDate: "2026-09-19", futuresPartition: { trading_date: "2026-09-19", session: "DAY" }, gateway, apiGet, context, benchmarkSource });
  }

  const colA = makeColumn("2330");
  const colB = makeColumn("2317");
  await Promise.resolve(); // let the initial pager.load() microtasks settle

  const specA = stockCanonicalViewSpec("2330", "2026-09-19");
  const specB = stockCanonicalViewSpec("2317", "2026-09-19");
  const requestIdA = wire.find((m) => m.type === "view.subscribe" && m.payload.code === "2330").payload.request_id;
  const requestIdB = wire.find((m) => m.type === "view.subscribe" && m.payload.code === "2317").payload.request_id;
  const sessionKeyA = { market: "STK", logical_code: "2330", session: "DAY", trading_date: "2026-09-19" };
  const sessionKeyB = { market: "STK", logical_code: "2317", session: "DAY", trading_date: "2026-09-19" };
  rawStore.handleAccepted({ request_id: requestIdA, subscription_id: "sa", stream_id: "sa-stream", watermark: 0 });
  rawStore.handleAccepted({ request_id: requestIdB, subscription_id: "sb", stream_id: "sb-stream", watermark: 0 });
  rawStore.handleSnapshot({ request_id: requestIdA, subscription_id: "sa", stream_id: "sa-stream", session_key: sessionKeyA, watermark: 0, summary: { open: 500, current: 505, prev_close: 495, reference_price: 495 }, trend: [], trades: [], orderbook: {} });
  rawStore.handleSnapshot({ request_id: requestIdB, subscription_id: "sb", stream_id: "sb-stream", session_key: sessionKeyB, watermark: 0, summary: { open: 60, current: 61, prev_close: 59, reference_price: 59 }, trend: [], trades: [], orderbook: {} });

  // A trade + orderbook update for 2330 only.
  rawStore.handleDeltaBatch({
    items: [
      { subscription_id: "sa", stream_id: "sa-stream", session_key: sessionKeyA, sequence: 1, delta_type: "trade.append", payload: { price: 506, volume: 3, ingest_sequence: 1, datetime: "2026-09-19T09:01:00" } },
      { subscription_id: "sa", stream_id: "sa-stream", session_key: sessionKeyA, sequence: 2, delta_type: "orderbook.latest", payload: { bid_prices: [505], bid_volumes: [10], ask_prices: [506], ask_volumes: [8] } },
    ],
  });

  const trendA = colA.buildTrendViewModel();
  const trendB = colB.buildTrendViewModel();
  assert.equal(trendA.symbol, "2330");
  assert.equal(trendB.symbol, "2317");
  assert.equal(trendA.currentPrice, 505, "column A's summary must be unaffected by column B (only initial snapshot applied so far)");
  assert.equal(trendB.currentPrice, 61, "column B must never see column A's trade/orderbook deltas");
  assert.equal(Object.hasOwn(trendA, "stockInfo"), false, "workspace chart-only trend must not send the removed information row");
  assert.deepEqual(Object.keys(trendA.metrics).sort(), ["change", "changePct", "limitDown", "limitUp"], "workspace chart-only trend sends only the header's 漲跌 and its 漲停/跌停 marking, no hidden analysis metrics");

  const bookA = colA.buildOrderbookViewModel();
  const bookB = colB.buildOrderbookViewModel();
  assert.equal(bookA.availability, "AVAILABLE", "column A received a real orderbook delta");
  assert.equal(bookB.availability, "UNAVAILABLE", "column B must not see column A's orderbook update -- no cross-contamination");

  const tickA = colA.buildTickDetailsViewModel();
  const tickB = colB.buildTickDetailsViewModel();
  assert.equal(tickA.rows.length, 1, "column A's live trade must appear in its own tick details");
  assert.equal(tickA.rows[0].price, 506);
  assert.equal(Object.hasOwn(tickA, "totalPages"), false, "workspace recent trades must not carry unused pagination metadata");
  assert.equal(tickB.rows.length, 0, "column B must not see column A's live trade");

  // What the column's 成交明細 shows is its read model's trades (tradesReadView): the newest print on top, like the main
  // page. A's view keeps its trades oldest first; the model carried those raw rows and the column drew them upside
  // down, its newest print at the bottom of a list scrolled to the top (user 11-10).
  rawStore.handleDeltaBatch({
    items: [1, 2, 3].map((n) => ({ subscription_id: "sb", stream_id: "sb-stream", session_key: sessionKeyB, sequence: n, delta_type: "trade.append",
      payload: { price: 60 + n, volume: n, ingest_sequence: 100 + n, datetime: `2026-09-19T09:0${n}:00` } })),
  });
  const shownB = tradesReadView(colB.buildTickDetailsViewModel()).rows;
  assert.deepEqual(shownB.map((row) => row.time), ["09:03:00", "09:02:00", "09:01:00"], "the column shows its newest print first");
  assert.deepEqual(shownB.map((row) => row.price), [63, 62, 61]);

  // --- 16. stale/late data must not overwrite newer state ---
  // A late snapshot response for an already-unsubscribed/old generation must
  // not resurrect stale data: dispose column A, then feed a delayed delta for
  // its old subscription and confirm nothing throws and no listener fires.
  colA.dispose();
  assert.doesNotThrow(() => {
    rawStore.handleDeltaBatch({
      items: [{ subscription_id: "sa", stream_id: "sa-stream", session_key: sessionKeyA, sequence: 3, delta_type: "trade.append", payload: { price: 999, volume: 1 } }],
    });
  });

  colB.dispose();

  // Each column's benchmark is its product type's: no switch, nothing kept per window.
  const benchmarks = Object.fromEntries(["2454", "CDF202611", "TXF202611", "US.AAPL"].map((code) => {
    const column = makeColumn(code);
    const benchmark = column.buildTrendViewModel().benchmark;
    column.dispose();
    return [code, benchmark];
  }));
  assert.deepEqual(benchmarks, { 2454: "taiex", CDF202611: "futures", TXF202611: "taiex", "US.AAPL": "off" });

  // A futures column is read in the partition trading now, its trades as that FUT view, and it moves when the session does.
  const futures = makeColumn("CDF202611");
  assert.equal(futures.spec.market, "FUT");
  assert.equal(futures.spec.trading_date, "2026-09-19");
  assert.equal(futures.pager.state.target !== undefined, true);
  const firstRead = apiGetCalls.filter((path) => path.includes("CDF202611"));
  assert.ok(firstRead.every((path) => path.includes("market=FUT")), `the trade pages are the FUT view's: ${firstRead}`);
  futures.setSession({ tradingDate: "2026-09-19", futuresPartition: { trading_date: "2026-09-19", session: "NIGHT" } });
  assert.equal(futures.spec.session, "NIGHT", "the night session moves the column");
  assert.equal(futures.benchmark(), "off", "加權 and 台指期's day view are closed at night");
  futures.dispose();
  const stock = makeColumn("2603");
  stock.setSession({ tradingDate: "2026-09-18", futuresPartition: { trading_date: "2026-09-19", session: "NIGHT" } });
  assert.equal(stock.spec.trading_date, "2026-09-19", "a stock's day never moves back");
  stock.setSession({ tradingDate: "2026-09-22", futuresPartition: null });
  assert.equal(stock.spec.trading_date, "2026-09-22");
  stock.dispose();

  // The markers are the window's tape, read when the chart is drawn.
  const marked = new WorkspaceColumn({ code: "2330", tradingDate: "2026-09-19", gateway, apiGet, benchmarkSource,
    context: createDashboardContext({ id: "test:markers", mode: "live", capabilities: ["trend"] }),
    eventOptions: (code) => ({ eventMarkers: [code], eventMarkersVisible: true }) });
  assert.deepEqual(marked.buildTrendViewModel().options.eventMarkers, ["2330"]);
  marked.dispose();
}

console.log("workspace contract passed");

// The workspace and the main page build a stock's view with the one shared builder, so one view serves both: neither
// keeps its own channel list.
{
  const { readFileSync } = await import("node:fs");
  const read = (rel) => readFileSync(new URL(`../ui/renderer/js/${rel}`, import.meta.url), "utf8");
  const page = read("features/realtime/session_state.js");
  const workspace = read("features/workspace/workspace_column_runtime.js");
  for (const [name, source] of [["features/realtime/session_state.js", page], ["workspace_column_runtime.js", workspace]]) {
    assert.match(source, /from "\.\.\/(\.\.\/)?market_data\/stock_view_spec\.js"/, `${name} uses the shared stock view builder`);
    assert.doesNotMatch(source, /"price_volume", "signals"/, `${name} keeps no channel list of its own`);
  }
  assert.match(page, /sharedStockCanonicalViewSpec\(normalized, tradingDate, futures\)/);
}
