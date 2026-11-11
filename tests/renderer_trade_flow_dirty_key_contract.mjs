// A frame whose inputs are unchanged (same UI choices, same immutable view-state objects behind the
// flow) does not run the chart/list builders at all; any change does.
import assert from "node:assert/strict";
import { TradeFlowComponent } from "../ui/renderer/js/core/components/trade_flow_component.js";

const content = { dataset: {}, innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
const tabs = { innerHTML: "", querySelectorAll: () => [], addEventListener() {} };
const host = { innerHTML: "", dataset: {}, querySelector: (sel) => (sel.includes("flow-content") ? content : sel.includes("flow-tabs") ? tabs : null), querySelectorAll: () => [] };
const context = { mode: "live", services: {},
  symbolStore: { subscribe: () => () => {}, getSelectedSymbol: () => "2330" },
  dataSource: { subscribe: () => () => {}, invalidate: () => {} } };
globalThis.requestAnimationFrame = (callback) => { callback(); return 0; };   // frames run at once
const component = new TradeFlowComponent();
component.bindCrosshair = () => {};
component.renderTabs = () => {};   // the tab strip is not under test
component.mount({ host, context, hydrate: true });
let built = 0;
// The DOM write itself (a morph) is not under test here: only whether a frame builds the markup at all.
component.replaceContent = (el) => { built += 1; el.dataset.flowRendered = "1"; return true; };

const tradeflow = { available: true, buckets: [] };
const windows = { "300s": {} };
const vm = (source, revision) => ({ availability: "AVAILABLE", scopeLabel: "2330 當日交易時段", flow: { available: true }, flowSource: source, presentationRevision: revision });

component.update(vm([tradeflow, windows], 1));
assert.equal(built, 1, "the first frame builds");
component.update(vm([tradeflow, windows], 2));
component.update(vm([tradeflow, windows], 3));
assert.equal(built, 1, "same view-state objects, same choices: no builder runs");
component.update(vm([{ ...tradeflow }, windows], 4));
assert.equal(built, 2, "a new tradeflow object builds");
component.displayMode = "minute";
component.render();
assert.equal(built, 3, "a UI choice builds");
const noSource = vm(undefined, 5);
delete noSource.flowSource;
component.update(noSource);
component.update({ ...noSource, presentationRevision: 6 });
assert.equal(built, 5, "a view model without flowSource always builds");
console.log("trade flow dirty key contract passed (CX-110)");
