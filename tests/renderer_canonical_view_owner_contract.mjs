// One owner declares this window's canonical views from prerequisites and applies only the
// difference; a view still wanted is never re-created, and leaving the page releases nothing.
// Driven through the real page (features/realtime/canonical_view_owner.js) over the live socket: what it declares is
// what the window sends -- view.subscribe / view.unsubscribe and the workspace.replace of the page's products.
import assert from "node:assert/strict";
import { realtimeModuleSource } from "./lib/realtime_sources.mjs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

const source = realtimeModuleSource("canonical_view_owner");
// No readiness wait (a fixed 12 s timeout that "settled" with nothing) and no per-view map left behind.
assert.doesNotMatch(source, /canonicalViewReadiness|function canonicalViewReady|setTimeout\(\(\) => settleCanonicalView/);

// The industry index a stock follows is read from the backend; 2330 here has none (無對應產業指數).
globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("/industry-indexes/stock/")
  ? { ok: true, index: null } : { ok: true, items: [] }), { status: 200, headers: { "content-type": "application/json" } });

// Futures views are their own contract (renderer_txf_*): this page's session authority names no TXF identity.
const page = await startRealtimePage({ displayContext: {} });
const { heldCanonicalViews, reconcileCanonicalViews } = page.owner;
const stockCodes = (codes) => codes.filter((code) => /^\d/.test(code)).sort();

// No trading date from the session authority: nothing is subscribable yet.
page.showProducts(["2330"]);
assert.deepEqual(page.subscribedCodes(), [], "no trading date from the session authority: nothing is subscribable yet");

// The authority names the date: the page's products, the detail target, TAIEX and the 期貨 benchmark (TXF's DAY of
// that date) are declared, once.
page.sessionState.setRealtimeDisplayContext({ equity: { trading_date: "2026-10-09" }, taiex: { trading_date: "2026-10-09" } });
await page.select("2454");
page.showProducts(["2330", "2317"]);
page.acceptPending();
assert.deepEqual(stockCodes(page.subscribedCodes()), ["2317", "2330", "2454"]);
assert.ok(page.subscribedCodes().includes("TAIEX"));
assert.ok(page.subscribedCodes().includes("TXFR1"), "the 期貨 benchmark is declared like TAIEX");
assert.deepEqual(page.workspaceDeclarations().at(-1), "2330,2317");
const subscribed = page.subscribedCodes().length;
const declared = page.workspaceDeclarations().length;
reconcileCanonicalViews("SESSION_AUTHORITY");
reconcileCanonicalViews("SELECTION");
assert.equal(page.subscribedCodes().length, subscribed, "a view still wanted is never re-created");
assert.equal(page.workspaceDeclarations().length, declared, "an unchanged page is not re-declared");

// The page changes: one leaves, one joins; the detail target moves onto a page product.
await page.select("2330");
page.showProducts(["2330", "2603"]);
page.acceptPending();
assert.deepEqual(stockCodes(page.unsubscribedCodes()), ["2317", "2454"]);
assert.ok(page.subscribedCodes().includes("2603"));
assert.equal(page.workspaceDeclarations().at(-1), "2330,2603");

// A stock view's events reach the stock handler: its snapshot's analysis row lands on the product row.
const { appState } = await import("../ui/renderer/js/core/state.js");
page.serve(page.stockSpec("2603"), { signals: { chg_1m: 0.25 } });
assert.equal(appState.signalsByCode.get("2603")?.chg_1m, 0.25);

// A new trading date moves every equity view to the new partition.
page.sessionState.setRealtimeDisplayContext({ equity: { trading_date: "2026-10-12" }, taiex: { trading_date: "2026-10-12" } });
reconcileCanonicalViews("SESSION_AUTHORITY");
assert.deepEqual([...heldCanonicalViews.values()].map((held) => `${held.spec.code}@${held.spec.trading_date}`).sort(),
  ["2330@2026-10-12", "2603@2026-10-12", "TAIEX@2026-10-12", "TXFR1@2026-10-12"], "2330, 2603, TAIEX and the 期貨 benchmark, now on the new date");
page.acceptPending();

// 產業指數: the current industry index is one more declared view; a new current index replaces it.
const { industryIndexStore } = await import("../ui/renderer/js/features/realtime/industry_index_store.js");
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
registerLiveViewModelResolvers();
const industryDraws = [];
realtimeContext.dataSource.subscribe("industryIndexTrend", (viewModel) => industryDraws.push(viewModel));
industryIndexStore.selectIndex({ code: "IX0028", name: "半導體" });
page.acceptPending();
assert.ok(page.subscribedCodes().includes("IX0028"));
page.serve({ market: "IDX", code: "IX0028", session: "DAY", trading_date: "2026-10-12" }, { summary: { current: 500 } });
page.flush();
assert.ok(industryDraws.length > 0, "its events draw 產業指數");
industryIndexStore.selectIndex({ code: "IX0053", name: "電子零組件" });
page.acceptPending();
assert.ok(page.unsubscribedCodes().includes("IX0028"));
assert.ok(page.subscribedCodes().includes("IX0053"));
await industryIndexStore.followStock("2330");
assert.ok(page.unsubscribedCodes().includes("IX0053"), "無對應產業指數 holds no index view");
assert.ok(![...heldCanonicalViews.values()].some((held) => held.kind === "industry"));

// Leaving the page releases nothing: the canonical views and the workspace belong to the window.
const { disposeRealtimePage } = await import("../ui/renderer/js/pages/realtime.js");
const released = page.unsubscribedCodes().length;
const declarations = page.workspaceDeclarations().length;
disposeRealtimePage();
assert.equal(page.unsubscribedCodes().length, released, "no view is released with the page");
assert.equal(page.workspaceDeclarations().length, declarations, "the workspace is not re-declared");
assert.equal(heldCanonicalViews.size, 4);
console.log("canonical view owner contract passed (S2c-03, S2c-05)");
