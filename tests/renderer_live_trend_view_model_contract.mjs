// The 即時報價 page's trend view models (features/realtime/live_view_models.js), built by the page's own resolvers
// over views served through the real live socket: no function is copied out of the page and re-run.
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

const TRADING_DATE = "2026-09-25";
const page = await startRealtimePage({ tradingDate: TRADING_DATE });
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
const { _resetInstrumentNamesForTest, requestInstrumentNames, setCatalogNameSource } = await import("../ui/renderer/js/core/instrument_names.js");
registerLiveViewModelResolvers();
const resolve = (id) => realtimeContext.dataSource.resolve(id, {});

// No name may be fetched over the network: names come from what is already loaded.
globalThis.fetch = () => { throw new Error("a trend view model fetched over the network"); };

// --- the exchange-wide breadth is not in the trend view models: the surfaces write it from the breadth store alone ----
const EXCHANGE_BREADTH = { trading_date: TRADING_DATE, up_count: 411, down_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 };
page.serve(page.taiexSpec(), { summary: { ...EXCHANGE_BREADTH, prev_close: 21000, current: 21100, open: 21010, high: 21150, low: 20990 } });
for (const id of ["marketTrend", "futuresTrend", "stockTrend"]) {
  assert.equal(resolve(id)?.breadth, undefined, `${id} must not carry the exchange breadth: its row has one writer, the breadth store`);
}
assert.equal(resolve("marketTrend").currentPrice, 21100);
assert.ok(resolve("marketTrend").marketRead, "the data boundary attached the view's read model");

// --- 個股走勢 header: the one name resolver, never regressed by a nameless update ------------------------------------
_resetInstrumentNamesForTest();
assert.equal(resolve("stockTrend").displayName, "請先在商品列表選擇商品", "nothing selected yet: the shared prompt");
await page.select("2330");
// The canonical summary carries no name: names are catalog metadata, not Rust market state.
page.serve(page.stockSpec("2330"), { summary: { open: 1092, current: 1105, high: 1110, low: 1088, prev_close: 1090 } });
assert.equal(resolve("stockTrend").displayName, "2330", "cold start, nothing known: the code");
// The product catalog names it (the page asks for its products' names when it loads them).
setCatalogNameSource(async (source, codes) => ({ ok: true, revision: "r1", items: codes.map((code) => ({ source, code, name: code === "2330" ? "台積電" : "" })) }));
requestInstrumentNames("shioaji", ["2330"]);
for (let i = 0; i < 10; i += 1) await Promise.resolve();   // the page harness holds timers: the answer is microtasks
assert.equal(resolve("stockTrend").displayName, "台積電");
page.serve(page.stockSpec("2330"), { summary: { current: 1106 } });    // a later snapshot with no name
assert.equal(resolve("stockTrend").displayName, "台積電", "a nameless update must not regress the header");
assert.equal(resolve("stockTrend").currentPrice, 1106);

// --- the stock's model predictions come from its own signals channel ---------------------------------------------------
page.serve(page.stockSpec("2330"), { summary: { current: 1106, prev_close: 1090 },
  signals: { model_predictions: { "5m_up": { status: "OK", probability: 0.61 }, "5m_down": { status: "FAILED", probability: null, reason: "no model" } } } });
const metrics = resolve("stockTrend").metrics;
assert.equal(metrics.up5m, 0.61);
assert.equal(metrics.down5m, null);
assert.equal(metrics.predictionNotes.down5m.reason, "no model");

console.log("live trend view model contract passed (no breadth in the trend view models, header name, predictions)");
