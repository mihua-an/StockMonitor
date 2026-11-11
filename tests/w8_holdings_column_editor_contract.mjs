import assert from "node:assert/strict";

// The 實際庫存 page has its own column list. The column editor edits the list the open event names: each product
// list's ⚙ (product_list_tools.js) sends `detail.profile` for the page it shows.
class Surface extends EventTarget {
  dataset = {}; hidden = true; innerHTML = ""; parent = null; textContent = "";
  queries = new Map(); selectors = new Set();
  querySelector(selector) { return this.queries.get(selector) || null; }
  querySelectorAll() { return []; }
  closest(selector) { return this.selectors.has(selector) ? this : this.parent?.closest(selector); }
  contains(node) { return node === this || node?.parent === this; }
}
const ids = new Map(), saved = new Map();
const overlay = new Surface(), host = new Surface(), title = new Surface();
ids.set("quoteColumnSettingsOverlay", overlay);
for (const selector of ["[data-column-settings-close]", "#quoteColumnCancelBtn", "#quoteColumnDoneBtn"]) overlay.queries.set(selector, new Surface());
overlay.queries.set("#quoteColumnSettingsList", host);
overlay.queries.set(".product-list-column-settings-head b", title);
globalThis.document = new Surface();
document.getElementById = (id) => ids.get(id) || null;
globalThis.window = new Surface();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } };

const { retainColumnSettingsEditor, openColumnSettings } = await import("../ui/renderer/js/core/components/column_settings_editor.js");
const presentation = await import("../ui/renderer/js/features/market/quote_presentation.js");
const { HOLDINGS_COLUMN_PROFILE, PRODUCT_COLUMN_PROFILE } = presentation;

const changed = [];
window.addEventListener("realtime-product-columns-changed", (event) => changed.push(event.detail?.profile));
const release = retainColumnSettingsEditor();
const open = (profile) => openColumnSettings(profile);
const done = () => overlay.querySelector("#quoteColumnDoneBtn").dispatchEvent(new Event("click"));

// ⚙ on the 實際庫存 page -> the holdings list, titled as such; saving writes only that list.
open(HOLDINGS_COLUMN_PROFILE);
assert.equal(overlay.hidden, false);
assert.equal(title.textContent, "實際庫存欄位");
done();
assert.deepEqual([...saved.keys()], ["actualHoldingsQuoteColumnsV1"]);
assert.deepEqual(changed, [HOLDINGS_COLUMN_PROFILE]);

// ⚙ on an ordinary page -> the ordinary list.
open(PRODUCT_COLUMN_PROFILE);
assert.equal(title.textContent, "商品列表欄位");
done();
assert.ok(saved.has("shioajiMonitorQuoteColumnsV1"));
assert.deepEqual(changed, [HOLDINGS_COLUMN_PROFILE, PRODUCT_COLUMN_PROFILE]);
release();
console.log("w8 holdings column editor contract passed");
