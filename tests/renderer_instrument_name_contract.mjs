import assert from "node:assert/strict";
import {
  _resetInstrumentNamesForTest, requestInstrumentNames, resolveInstrumentDisplayName, setCatalogNameSource,
} from "../ui/renderer/js/core/instrument_names.js";
import { mergeStockMarketSummary } from "../ui/renderer/js/market_data/stock_market_summary.js";
import { StockOrderBookAdapter } from "../ui/renderer/js/core/orderbook_adapters.js";
import { WorkspaceColumn } from "../ui/renderer/js/features/workspace/workspace_column_runtime.js";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";
import { MarketDataGateway } from "../ui/renderer/js/market_data/market_data_gateway.js";
import { createDashboardContext } from "../ui/renderer/js/core/dashboard_context.js";

// Shioaji names: 台積電 used to become "2330" the moment the first analysis row arrived, because
// that row's `name` WAS the code and every panel let the live row win. One resolver now decides.

// The renderer's names are the product catalog's (Electron main's copy): a test hands in the catalog's answers.
async function catalogNames(names) {
  setCatalogNameSource(async (source, codes) => ({ ok: true, revision: "r1", items: codes.map((code) => ({ source, code, name: names[code] || "" })) }));
  requestInstrumentNames("shioaji", Object.keys(names));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// No resolver path may reach the network: names must come from what is already loaded.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("name resolution must not fetch metadata"); };

// --- 1. The live row cannot overwrite the watch page's name ---------------------------------
{
  _resetInstrumentNamesForTest();
  const row = mergeStockMarketSummary({
    watchItem: { code: "2330", name: "台積電" },
    liveSignal: { code: "2330", name: "2330", current: 1105, prev_close: 1090 },
  });
  assert.equal(row.name, "台積電", "a live row whose name is its code must not replace 台積電");
  const noName = mergeStockMarketSummary({ watchItem: { code: "2330", name: "台積電" }, liveSignal: { code: "2330", current: 1105 } });
  assert.equal(noName.name, "台積電");
  // Cold start, nothing known anywhere: the product list shows no fake name (the code column is there).
  assert.equal(mergeStockMarketSummary({ liveSignal: { code: "2330", name: "2330" } }).name, "");
  // An analysis row is no source of a product's name (D01-06: static fields are the watch item's, then Market Runtime's
  // reference name).
  assert.equal(mergeStockMarketSummary({ liveSignal: { code: "2330", name: "台積電" } }).name, "");
  assert.equal(mergeStockMarketSummary({ productSummary: { code: "2330", name: "台積電" }, liveSignal: { code: "2330" } }).name, "台積電");
}

// --- 2. The catalog's names never regress ------------------------------------------------------
{
  _resetInstrumentNamesForTest();
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330", "2330"), "2330", "only when truly unknown");
  await catalogNames({ 2330: "台積電", 2317: "2317" });
  for (const later of ["", "2330", undefined, null]) {
    assert.equal(resolveInstrumentDisplayName("shioaji", "2330", later), "台積電",
      `a later delta carrying name=${JSON.stringify(later)} must not regress 台積電 to the code`);
  }
  assert.equal(resolveInstrumentDisplayName("shioaji", "2317", "鴻海"), "鴻海", "a catalog name equal to the code is no name");
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330"), "台積電");
}

// --- 3. Futu is isolated from the Shioaji rule -------------------------------------------------
{
  _resetInstrumentNamesForTest();
  assert.equal(resolveInstrumentDisplayName("futu", "US.AAPL", "US.AAPL"), "US.AAPL",
    "a Futu ticker is a legitimate display name and must not be cleared");
  assert.equal(resolveInstrumentDisplayName("futu", "US.SPCX", "SpaceX"), "SpaceX");
}

// --- 4. 買賣報價 uses the same resolver ---------------------------------------------------------
{
  _resetInstrumentNamesForTest();
  const cold = StockOrderBookAdapter.build({ code: "2330", signal: { name: "2330" } });
  assert.equal(cold.titlePrimary, "2330", "cold start with no name anywhere shows the code");
  await catalogNames({ 2330: "台積電" });
  const warm = StockOrderBookAdapter.build({ code: "2330", signal: { name: "2330" } });
  assert.equal(warm.titlePrimary, "台積電");
}

// (5. 個股走勢's header: renderer_live_trend_view_model_contract.mjs, on the page's real view models.)

// --- 6. Workspace: a real column on a real gateway shows the same name -------------------------
{
  _resetInstrumentNamesForTest();
  await catalogNames({ 2330: "台積電" });
  const wire = [];
  const rawStore = new RealtimeViewStore({ send: (message) => { wire.push(message); return true; } });
  const gateway = new MarketDataGateway({ subscribeView: rawStore.subscribe.bind(rawStore), getSnapshot: rawStore.snapshot.bind(rawStore) });
  rawStore.onConnected();
  const apiGet = async () => ({ ok: true, rows: [], page: 1, total_pages: 1, total_rows: 0, snapshot_watermark: 0 });
  const context = createDashboardContext({ id: "test:2330", mode: "live", capabilities: ["tick", "bidask", "trend"] });
  const column = new WorkspaceColumn({
    code: "2330", tradingDate: "2026-09-19", gateway, apiGet, context,
    benchmarkSource: { ensure: async () => {}, points: () => [], openPrice: () => null },
  });
  await Promise.resolve();
  const requestId = wire.find((m) => m.type === "view.subscribe" && m.payload.code === "2330").payload.request_id;
  const sessionKey = { market: "STK", logical_code: "2330", session: "DAY", trading_date: "2026-09-19" };
  rawStore.handleAccepted({ request_id: requestId, subscription_id: "s1", stream_id: "s1", watermark: 0 });
  // The canonical summary carries NO name: names are catalog metadata, not Rust market state.
  rawStore.handleSnapshot({ request_id: requestId, subscription_id: "s1", stream_id: "s1", session_key: sessionKey,
    watermark: 0, summary: { open: 1100, current: 1105, prev_close: 1090 }, trend: [], trades: [], orderbook: {} });
  assert.equal(column.buildTrendViewModel().displayName, "台積電", "workspace and 個股走勢 must agree");
}

globalThis.fetch = realFetch;
console.log("renderer instrument name contract passed");
