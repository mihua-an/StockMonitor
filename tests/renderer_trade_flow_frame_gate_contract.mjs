// 大單流向 is a selection-scoped live surface with the same presentation fence as 五檔 / 成交明細 -- an older
// delivery never paints over a newer one (the data source's presentation revision orders them).
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";
import { TradeFlowComponent } from "../ui/renderer/js/core/components/trade_flow_component.js";

const component = new TradeFlowComponent();
const host = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
const context = { mode: "live", services: {},
  symbolStore: { subscribe: () => () => {}, getSelectedSymbol: () => "2330" },
  dataSource: { subscribe: () => () => {}, invalidate: () => {} } };
component.bindCrosshair = () => {};
component.mount({ host, context, hydrate: false });
let renders = 0;
component.render = () => { renders += 1; };

component.update({ logicalCode: "2330", presentationRevision: 4 });
assert.equal(renders, 1, "the current delivery paints");
component.update({ logicalCode: "2317", presentationRevision: 3 });
assert.equal(renders, 1, "an older delivery (the previous selection's) is refused");
component.update({ logicalCode: "2330", presentationRevision: 5 });
assert.equal(renders, 2);

// The page's own 大單流向 view model carries the view's presentation state (the frame the gate orders by).
const page = await startRealtimePage({ tradingDate: "2026-10-27" });
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
registerLiveViewModelResolvers();
await page.select("2330");
page.serve(page.stockSpec("2330"), { summary: { current: 1105 } });
const viewModel = realtimeContext.dataSource.resolve("tradeFlow", {});
assert.equal(viewModel.displaySymbol, "2330", "the trade-flow ViewModel carries the view's presentation state");
assert.equal(viewModel.displaySequence, 1, "the view's own sequence");
assert.equal(viewModel.presentationState, "ready");
console.log("trade flow frame gate contract passed (R10a-04)");
