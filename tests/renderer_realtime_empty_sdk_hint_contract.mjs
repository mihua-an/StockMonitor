// A new user who never installed the Shioaji SDK sees an empty 商品列表 that never fills. The empty text then says why
// (尚未安裝 SDK, where to install it), read from Health's import probe (getProviderSdkStatus), throttled and only while
// the list is empty -- not "尚無自選商品", which reads as "just add one" (user 11-13).
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const body = { dataset: { productMarket: "tw" }, querySelectorAll: () => [] };
globalThis.document = { querySelector: (selector) => (selector.includes('data-provider="shioaji"') ? body : null), getElementById: () => null };

let probes = 0;
globalThis.window.desktopAPI = {
  getProviderSdkStatus: async () => { probes += 1; return { providers: { shioaji: { installed: false }, futu: { installed: true } } }; },
};

const { appState } = await import("../ui/renderer/js/core/state.js");
const presentation = await import("../ui/renderer/js/features/realtime/realtime_presentation.js");
const { subscribeTaiwanProductListView } = await import("../ui/renderer/js/features/realtime/taiwan_product_list_store.js");

const views = [];
subscribeTaiwanProductListView((view) => views.push(view));
appState.watchlistItems = [];
appState.signalsByCode = new Map();
appState.productMarketSummaries = {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const SDK_HINT = "尚未安裝 Shioaji SDK（設定 → 券商帳號 安裝）";

presentation.renderRealtimeQuoteTable();
assert.equal(views.at(-1).emptyText, "尚無自選商品", "before the probe answers, the ordinary empty text");
await tick(); await tick();
assert.equal(views.at(-1).emptyText, SDK_HINT, "SDK missing: the empty list says why, with where to install it");
assert.equal(probes, 1, "one probe for the empty list");

// Not probed again on every render: the empty-list check is throttled, not on the data path.
presentation.renderRealtimeQuoteTable();
await tick();
assert.equal(probes, 1, "a second empty render within the minute does not re-probe");
assert.equal(views.at(-1).emptyText, SDK_HINT, "the known-missing state keeps the hint");

// The hint is for the empty list only: a populated list is just its rows.
appState.watchlistItems = [{ code: "2330", name: "台積電" }];
presentation.renderRealtimeQuoteTable();
await tick();
assert.equal(views.at(-1).rows.length, 1, "a populated list shows its rows, the empty-list hint does not apply");

console.log("renderer realtime empty SDK hint contract passed");
