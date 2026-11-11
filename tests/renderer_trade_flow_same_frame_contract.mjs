// 大單流向 paints in the frame its data arrives in, as 五檔 and 價量 do. Its updates come from the page's own once-a-frame
// notice (a requestAnimationFrame callback); deferring each paint to yet another requestAnimationFrame put it one frame
// behind every other panel (the user 10-31: 大單流向慢半拍). Several updates within one frame still paint once more,
// at the next frame, never once each.
import assert from "node:assert/strict";
import { TradeFlowComponent } from "../ui/renderer/js/core/components/trade_flow_component.js";

const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
const runFrame = () => { const due = frames.splice(0); for (const callback of due) callback(); };

const component = new TradeFlowComponent();
const host = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
const context = { mode: "live", services: {},
  symbolStore: { subscribe: () => () => {}, getSelectedSymbol: () => "2330" },
  dataSource: { subscribe: () => () => {}, invalidate: () => {} } };
component.bindCrosshair = () => {};
component.mount({ host, context, hydrate: false });
let renders = [];
component.render = () => { renders.push(component.vm.presentationRevision); };

// The page's frame notice delivers revision 1: drawn in that same frame.
frames.push(() => component.update({ logicalCode: "2330", presentationRevision: 1 }));
runFrame();
assert.deepEqual(renders, [1], "drawn in the frame its data arrived in, not the next");

// Two more deliveries within one frame: the first is drawn at once, the second at the next frame (the newest only).
frames.push(() => {
  component.update({ logicalCode: "2330", presentationRevision: 2 });
  component.update({ logicalCode: "2330", presentationRevision: 3 });
});
runFrame();
assert.deepEqual(renders, [1, 2], "one paint per frame");
runFrame();
assert.deepEqual(renders, [1, 2, 3], "the frame's later delivery is drawn next frame");
runFrame();
assert.deepEqual(renders, [1, 2, 3], "nothing pending: no extra paint");
component.destroy();
console.log("trade flow same-frame contract passed");
