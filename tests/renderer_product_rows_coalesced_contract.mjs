// 畫面卡頓／資料套用停滯: each one-symbol update (an analysis row, a summary) re-merged EVERY product row
// synchronously inside the WebSocket batch handler -- 13.5 s of 15 on the renderer main thread on a busy market. Rows
// now repaint once per frame for all dirty codes, and a repaint re-merges only those rows.
import assert from "node:assert/strict";

const frames = [];
const body = { dataset: { productMarket: "tw" }, querySelectorAll: () => [] };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.document = { querySelector: (selector) => (selector.includes('data-provider="shioaji"') ? body : null), getElementById: () => null };

const { appState } = await import("../ui/renderer/js/core/state.js");
const presentation = await import("../ui/renderer/js/features/realtime/realtime_presentation.js");
const { subscribeTaiwanProductListView } = await import("../ui/renderer/js/features/realtime/taiwan_product_list_store.js");

const views = [];
subscribeTaiwanProductListView((view) => views.push(view));
appState.watchlistItems = Array.from({ length: 50 }, (_, i) => ({ code: String(2300 + i), name: `S${i}` }));
appState.signalsByCode = new Map();
appState.productMarketSummaries = {};

presentation.renderRealtimeQuoteTable();
const baseline = views.length;
const full = views.at(-1).rows;

for (let i = 0; i < 20; i += 1) {
  appState.signalsByCode = new Map([["2305", { code: "2305", chg_1m: i }]]);
  presentation.updateRealtimeQuoteRows(new Set(["2305"]));
  presentation.updateRealtimeQuoteRows(new Set(["2310"]));
}
assert.equal(views.length, baseline, "nothing repaints synchronously inside the update calls");
assert.equal(frames.length, 1, "forty one-symbol updates schedule one frame");
frames.shift()();
assert.equal(views.length, baseline + 1, "one repaint for the whole frame");
const repainted = views.at(-1);
assert.deepEqual([...repainted.changedCodes].sort(), ["2305", "2310"]);
const rows = repainted.rows;
assert.equal(rows.length, 50);
assert.equal(rows.find((row) => row.code === "2300"), full.find((row) => row.code === "2300"), "a clean row is reused, not re-merged");
assert.notEqual(rows.find((row) => row.code === "2305"), full.find((row) => row.code === "2305"), "a dirty row is re-merged");
console.log("renderer product rows coalesced contract passed");
