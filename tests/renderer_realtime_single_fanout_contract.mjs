// One canonical event, one UI fan-out (BACKLOG D07-08): canonical_view_owner.js is the only place a view snapshot or
// delta reaches the 即時報價 components. live_signals.js replaceSignalRows only writes the signal store; the analysis
// row is one more changed channel of the same event, so the selected symbol's 五檔 and 走勢 are invalidated once per
// event -- not once by the signal writer (its own frame) and again by the snapshot's channel fan-out.
// Driven through the real page over the fake live socket.
import assert from "node:assert/strict";
import { realtimeModuleSource } from "./lib/realtime_sources.mjs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, rows: [], items: [], index: null, page: 1, total_pages: 1, total_rows: 0 }),
  { status: 200, headers: { "content-type": "application/json" } });
const page = await startRealtimePage({ tradingDate: "2026-10-27" });
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
const { appState } = await import("../ui/renderer/js/core/state.js");

appState.watchlistItems = [{ code: "2330" }];
page.showProducts(["2330"]);
await page.select("2330");
page.pageState.setRealtimePageShown(true);
page.pageState.viewResources.activate();
page.acceptPending();
const spec = page.stockSpec("2330");
page.serve(spec, {});
page.flush(); page.flush();

const deliveries = new Map();
for (const id of ["orderbook", "trendChart", "stockTrend"]) {
  realtimeContext.dataSource.subscribe(id, () => deliveries.set(id, (deliveries.get(id) || 0) + 1));
}
const drain = () => { page.flush(); page.flush(); page.flush(); };
const take = () => { const out = Object.fromEntries(["orderbook", "trendChart", "stockTrend"].map((id) => [id, deliveries.get(id) || 0])); deliveries.clear(); return out; };
drain(); take();

// A snapshot carrying a new summary AND a new analysis row: each panel once.
page.serve(spec, { summary: { current: 1105, trading_date: "2026-10-27" }, signals: { chg_1m: 0.4, update_time: "09:31:00" } });
drain();
assert.equal(appState.signalsByCode.get("2330")?.chg_1m, 0.4, "the analysis row is applied");
assert.deepEqual(take(), { orderbook: 1, trendChart: 1, stockTrend: 1 },
  "one snapshot of the selected symbol invalidates 五檔 and 走勢 exactly once each");

// A snapshot whose only change is the analysis row still redraws what shows it -- once.
page.serve(spec, { summary: { current: 1105, trading_date: "2026-10-27" }, signals: { chg_1m: 0.6, update_time: "09:32:00" } });
drain();
assert.equal(appState.signalsByCode.get("2330")?.chg_1m, 0.6);
assert.deepEqual(take(), { orderbook: 1, trendChart: 1, stockTrend: 1 },
  "a snapshot whose analysis row changed redraws 五檔 and 走勢 once each");

// A signals.frame delta: the same single fan-out.
page.delta(spec, "signals.frame", { signals: { chg_1m: 0.5, update_time: "09:33:00" } });
drain();
assert.equal(appState.signalsByCode.get("2330")?.chg_1m, 0.5);
assert.deepEqual(take(), { orderbook: 1, trendChart: 1, stockTrend: 1 },
  "a signals.frame of the selected symbol invalidates 五檔 and 走勢 exactly once each");

// Another symbol's analysis row touches no detail panel.
page.showProducts(["2330", "2317"]);
appState.watchlistItems = [{ code: "2330" }, { code: "2317" }];
page.acceptPending();
page.serve(page.stockSpec("2317"), { signals: { chg_1m: 0.1 } });
drain();
assert.equal(appState.signalsByCode.get("2317")?.chg_1m, 0.1);
assert.deepEqual(take(), { orderbook: 0, trendChart: 0, stockTrend: 0 },
  "an unselected symbol's analysis row redraws none of the selected symbol's panels");

const signalsSource = realtimeModuleSource("live_signals");
assert.doesNotMatch(signalsSource, /from "\.\/realtime_presentation\.js"/,
  "the signal store writer must not schedule any presentation itself");
assert.doesNotMatch(signalsSource, /\brender\b\s*[:=]/, "replaceSignalRows has no render switch: it never renders");

console.log("realtime single fan-out contract passed (D07-08)");
