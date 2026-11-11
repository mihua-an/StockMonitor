// While the user scrolls page 1 of 成交明細, new rows of the SAME stream are held back until the list is at the top;
// a ViewModel of another product (or another session of it) must never be held -- that kept the previous product's rows
// on screen after a switch.
import assert from "node:assert/strict";
import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";
import { TickDetailsComponent } from "../ui/renderer/js/core/components/tick_details_component.js";

// No stored column settings: the list shows its default columns.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const viewport = { scrollTop: 40, querySelector: () => null };
const body = {};
const host = {
  querySelector(selector) {
    if (selector.includes('"tick-body"')) return body;
    if (selector.includes('"tick-scroll"')) return viewport;
    return null;
  },
};
const vmOf = (code, generation = 3, sequence = 10) => ({
  code, logicalCode: code, page: 1, pageSize: 100,
  rows: [{ ingestSequence: sequence, price: 100, volume: 1 }],
  sessionGeneration: generation, displaySequence: sequence,
});
const identity = (code, generation = 3) => [code, "", generation, ""].join("|");

function component(renderedCode, generation = 3) {
  const c = new TickDetailsComponent();
  c.host = host;
  c.context = { mode: "live" };
  c.renderedPage = 1;
  c.renderedLogicalCode = renderedCode;
  c.renderedStreamIdentity = identity(renderedCode, generation);
  c.rowNodes = new Map([["seq:9", {}]]);  // page 1 already shows rows of this stream
  return c;
}

{
  const c = component("2330");
  c.update(withMarketRead(vmOf("2330", 3, 11)));
  assert.ok(c.pendingLiveVm, "the same stream is held while the user reads older rows");
}
{
  const c = component("2330");
  try { c.update(withMarketRead(vmOf("2317", 3, 11))); } catch (_error) { /* the render path needs a real DOM; the decision is made before it */ }
  assert.equal(c.pendingLiveVm, null, "another product is never held: its rows render at once");
}
{
  const c = component("2330", 3);
  try { c.update(withMarketRead(vmOf("2330", 4, 1))); } catch (_error) { /* as above */ }
  assert.equal(c.pendingLiveVm, null, "another session of the same product is never held either");
}
console.log("tick details freeze identity contract passed (R10a-03)");
