// Switching 價量 to an instrument with no ladder (no data, or no 大單 rule) leaves no rows behind --
// the scroll position, the row-snap content and the discrete scrollbar all go to zero, not the last instrument's.
import assert from "node:assert/strict";

globalThis.window = globalThis.window || { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);

const { PriceFlowComponent } = await import("../ui/renderer/js/core/components/price_flow_component.js");

// The component morphs its parts (core/dom_morph.js); a part records the markup it was brought to.
const ownerDocument = { createElement: () => ({ innerHTML: "", content: { childNodes: [] } }) };
function element() {
  return { innerHTML: "", textContent: "", scrollTop: 0, clientHeight: 300, querySelectorAll: () => [], dataset: {},
    ownerDocument, childNodes: [], firstChild: null };
}
const parts = { "price-flow-scroll": element(), "price-flow-summary": element(), "price-flow-rail": element() };
const host = {
  querySelector: (selector) => parts[/data-role="([^"]+)"/.exec(selector)?.[1]] || null,
  dataset: {}, setAttribute() {}, getAttribute() { return null; },
};

const component = new PriceFlowComponent();
component.host = host;
const calls = [];
component.rowSnap = { refreshContent: (arg) => calls.push(["refresh", arg.logicalRows]) };
component.scrollbar = { syncScrollbar: () => calls.push(["sync"]) };
// As if the previous instrument showed a long ladder, scrolled down.
component.rowCount = 120;
parts["price-flow-scroll"].scrollTop = 900;

component.update({ code: "2330", message: "等待逐價大小單資料" });
assert.equal(component.rowCount, 0);
assert.equal(parts["price-flow-scroll"].scrollTop, 0);
assert.deepEqual(calls, [["refresh", 0], ["sync"]]);
assert.match(parts["price-flow-scroll"].__morphMarkup, /等待逐價大小單資料/);
console.log("renderer price flow empty contract passed");
