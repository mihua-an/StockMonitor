// 歷史回放: where Rust B's analysis of the replay's step is not built yet, 大單流向 drew an empty chart under
// 「大單控盤 0.0%、大單 0、小單 0」 -- numbers that read as data. A view model that says the analysis is pending
// (`pending`) now shows its message in the panel's content (the tabs stay), as 價量 does; the charts come back with it.
import assert from "node:assert/strict";
import { TradeFlowComponent } from "../ui/renderer/js/core/components/trade_flow_component.js";

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const component = new TradeFlowComponent();
const content = { dataset: {}, innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
component.host = { querySelector: () => content, querySelectorAll: () => [] };
component.renderTabs = () => {};
component.paintCrosshair = () => {};
let drawn = "";
component.replaceContent = (_content, html) => { drawn = html; return true; };

component.vm = { availability: "UNAVAILABLE", pending: true, message: "計算中", flow: { available: false, sample_count: 0 } };
component.render();
assert.match(drawn, /<div class="empty">計算中<\/div>/, "the pending analysis said in the content");
assert.doesNotMatch(drawn, /大單控盤/, "no 0% that reads as data");

component.vm = { availability: "AVAILABLE", flow: { available: true, cumulative: { large: { buy: 10, sell: 5 }, small: { buy: 1, sell: 1 } } } };
component.render();
assert.match(drawn, /大單控盤/, "the charts come back with the analysis");
console.log("trade flow pending contract passed");
