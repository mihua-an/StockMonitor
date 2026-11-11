import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// One 買賣報價's variant is named and checked where it is made: the options every caller passes today are accepted
// as they are, a combination without a meaning is refused instead of clamped into another book.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest() }, dispatchEvent() {}, addEventListener() {} };
const { orderBookVariant } = await import("../ui/renderer/js/core/components/orderbook_component.js");

const live = orderBookVariant();
assert.equal(live.depth, 5);
assert.ok(live.showPriceVolume && live.showExtremeMarkers && live.productHeader && !live.dynamicDepth);
assert.ok(Object.isFrozen(live));
const futu = orderBookVariant({ manual: true, depth: 5, minDepth: 5, maxDepth: 10, dynamicDepth: true, title: "Futu 買賣報價" });
assert.deepEqual([futu.minDepth, futu.maxDepth, futu.dynamicDepth], [5, 10, true]);
const paper = orderBookVariant({ manual: true, depth: 10, productHeader: false, showInsideOutside: false, showPriceVolume: false });
assert.deepEqual([paper.depth, paper.productHeader, paper.showPriceVolume], [10, false, false]);
const replay = orderBookVariant({ manual: true, depth: 5, title: "五檔報價", showInsideOutside: false, showPriceVolume: false, showDepthTotals: true, showExtremeMarkers: false });
assert.equal(replay.showExtremeMarkers, false);

assert.throws(() => orderBookVariant({ depth: 0 }), /depth must be 1-10 levels/);
assert.throws(() => orderBookVariant({ depth: 11 }), /depth must be 1-10 levels/);
assert.throws(() => orderBookVariant({ depth: 5, minDepth: 3 }), /only apply to a dynamicDepth book/);
assert.throws(() => orderBookVariant({ dynamicDepth: true, minDepth: 8, maxDepth: 6 }), /minDepth 8 is above maxDepth 6/);
console.log("renderer orderbook variant contract passed");
