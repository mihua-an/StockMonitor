import assert from "node:assert/strict";

// A preference setter announces a value only once storage kept it; a refused write is a failure the caller sees
// (pane rows, trend footer horizons, 盤中事件 toggle, slot layouts). Store listeners are isolated from each other, on
// a change and on the immediate call alike, and cross-window storage events reach the subscriber of that key only.
const store = new Map();
let refuse = false;
const warnings = [];
const windowListeners = new Map();
console.warn = (...args) => warnings.push(args.map(String).join(" "));
console.error = (...args) => warnings.push(args.map(String).join(" "));
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { if (refuse) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); store.set(key, String(value)); },
  removeItem: (key) => store.delete(key),
};
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const dispatched = [];
globalThis.addEventListener = (type, fn) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); };
globalThis.removeEventListener = (type, fn) => windowListeners.get(type)?.delete(fn);
globalThis.window = { dispatchEvent: (event) => dispatched.push(event.type), addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener };
const fireStorage = (key) => { for (const fn of [...(windowListeners.get("storage") || [])]) fn({ key }); };

const prefs = await import("../ui/renderer/js/core/preferences.js");
const horizons = await import("../ui/renderer/js/core/trend_footer_horizons.js");
const markers = await import("../ui/renderer/js/core/event_markers.js");
const layout = await import("../ui/renderer/js/core/layout_config.js");
const { ScopedValueStore } = await import("../ui/renderer/js/core/scoped_state.js");
const breadth = await import("../ui/renderer/js/core/market_breadth_store.js");

// writePreference reports the outcome.
assert.deepEqual(prefs.writePreference("k", "v"), { ok: true, key: "k" });
refuse = true;
const refused = prefs.writePreference("k", "w", { context: "test" });
assert.equal(refused.ok, false);
assert.equal(refused.error, "persist_failed");
assert.ok(warnings.some((line) => line.includes("saving k (test)")), "a refused write is logged with its key and context");
assert.equal(store.get("k"), "v");
refuse = false;

// Trend footer horizons and the 盤中事件 toggle.
dispatched.length = 0;
refuse = true;
assert.throws(() => horizons.setTrendFooterHorizons([10, 15]), (error) => error.code === "persist_failed");
assert.equal(markers.setStockTrendEventMarkersVisible(false).ok, false);
assert.deepEqual(dispatched, [], "no change event for a value storage refused");
assert.equal(markers.stockTrendEventMarkersVisible(), true);
refuse = false;
assert.equal(markers.setStockTrendEventMarkersVisible(false).ok, true);
assert.deepEqual(dispatched, ["stock-trend-event-markers-changed"]);

// Slot layouts: the setter's ok follows the save; a refused save leaves the stored layout as it was.
const registry = { supports: () => true, get: () => ({}) };
assert.equal(layout.setSlotComponent("history", "replayPrimary", "eventFeed", registry).ok, true);
const kept = store.get("shioajiSlotLayoutConfigV9");
refuse = true;
const failedSlot = layout.setSlotComponent("history", "replayPrimary", "orderbook", registry);
assert.deepEqual([failedSlot.ok, failedSlot.error, failedSlot.config.slots.replayPrimary], [false, "persist_failed", "eventFeed"]);
const failedTabs = layout.setTabbedSlot("realtime", "liveInfo", { componentIds: ["eventFeed"], activeComponentId: "eventFeed" }, registry);
assert.deepEqual([failedTabs.ok, failedTabs.error], [false, "persist_failed"]);
refuse = false;
assert.equal(store.get("shioajiSlotLayoutConfigV9"), kept);

// Store listeners: the immediate call is isolated as the change call is.
const scoped = new ScopedValueStore("t", 1);
const got = [];
scoped.subscribe(() => { throw new Error("immediate boom"); }, { immediate: true });
scoped.subscribe((value) => got.push(value), { immediate: true });
scoped.set(2);
assert.deepEqual(got, [1, 2]);
assert.ok(warnings.some((line) => line.includes("[ScopedValueStore:t: immediate] listener failed")));
breadth.setMarketBreadthReader(() => ({ up_count: 1 }));
const counts = [];
breadth.subscribeMarketBreadth(() => { throw new Error("breadth boom"); });
breadth.subscribeMarketBreadth((value) => counts.push(value.up_count));
breadth.setMarketBreadthReader(() => ({ up_count: 2 }));
breadth.notifyMarketBreadthChanged();
assert.deepEqual(counts, [1, 2], "a breadth listener that throws stops neither the immediate call nor the change");
// The pages keep their remembered choices (帳務 market / view / ledger, 商品頁, 設定 section) through the same module:
// a storage that refuses is logged there and never fails a page's startup.
const { readdirSync, readFileSync: readPage } = await import("node:fs");
const pagesDir = new URL("../ui/renderer/js/pages/", import.meta.url);
for (const name of readdirSync(pagesDir).filter((file) => file.endsWith(".js"))) {
  assert.doesNotMatch(readPage(new URL(name, pagesDir), "utf8"), /localStorage/, `${name} reads preferences through core/preferences.js`);
}
console.log("renderer preference persist contract passed");
