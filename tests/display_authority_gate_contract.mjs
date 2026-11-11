// One presentation revision, stamped by the data source; a component compares only that.
//
// Before, every panel's DisplayFrameGate re-derived the transport's order (selection generation, daemon instance,
// session generation, trading date, view sequence) -- RealtimeViewStore's rules duplicated per component, with its own
// special cases (the 期貨走勢 全日 / 日盤 / 夜盤 tabs, an unfenced frame, a restarted Market Runtime). The page now reads
// the store's current state when it resolves a ViewModel, so ordering what reaches a component is the data
// source's job, and the component's gate is a revision comparison.
import assert from "node:assert/strict";
import { PresentationRevisionGate } from "../ui/renderer/js/core/display_frame_gate.js";
import { ScopedDataAdapter } from "../ui/renderer/js/core/dashboard_context.js";

// The data source stamps every delivery of a component with its next revision, in resolve order.
{
  const source = new ScopedDataAdapter({ mode: "live", contextId: "test" });
  let symbol = "2330";
  source.setResolver("orderbook", () => ({ displaySymbol: symbol }));
  const seen = [];
  source.subscribe("orderbook", (vm) => seen.push(vm));
  source.invalidate("orderbook");
  symbol = "2317";
  source.invalidate("orderbook");
  assert.deepEqual(seen.map((vm) => [vm.displaySymbol, vm.presentationRevision]), [["2330", 1], ["2317", 2]]);
  assert.equal(source.lastValues.get("orderbook").presentationRevision, 2, "the remembered value carries its revision");
  // Each component id counts on its own.
  source.setResolver("tickDetails", () => ({}));
  source.subscribe("tickDetails", () => {});
  assert.equal(source.invalidate("tickDetails").presentationRevision, 1);
}

// The gate paints the newest revision, re-paints the one shown (a resize re-renders the same frame), refuses older.
{
  const gate = new PresentationRevisionGate();
  assert.equal(gate.accept({ presentationRevision: 5 }), true);
  assert.equal(gate.accept({ presentationRevision: 5 }), true, "the frame already shown re-renders");
  assert.equal(gate.accept({ presentationRevision: 3 }), false, "an older delivery never paints over a newer one");
  assert.equal(gate.lastRejectReason, "STALE_PRESENTATION_REVISION");
  assert.equal(gate.rejections.STALE_PRESENTATION_REVISION, 1);
  assert.equal(gate.accept({ presentationRevision: 6 }), true);
  // A frame that did not come through a data source (a component driven directly) is not ordered by it.
  assert.equal(gate.accept({ displaySymbol: "2330" }), true);
  gate.reset();
  assert.equal(gate.accept({ presentationRevision: 1 }), true, "a remounted component starts over");
}

// The 期貨走勢 tabs need no special case any more: switching tabs is just the next delivery.
{
  const source = new ScopedDataAdapter({ mode: "live", contextId: "tabs" });
  let tab = "full";
  source.setResolver("futuresTrend", () => ({ session: tab }));
  const gate = new PresentationRevisionGate();
  const painted = [];
  source.subscribe("futuresTrend", (vm) => { if (gate.accept(vm)) painted.push(vm.session); });
  for (const next of ["full", "day", "night", "full"]) { tab = next; source.invalidate("futuresTrend"); }
  assert.deepEqual(painted, ["full", "day", "night", "full"]);
}
console.log("presentation revision gate contract passed (S2c-17)");
