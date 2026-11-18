import assert from "node:assert/strict";
import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";
import { createDocument } from "./lib/mini_dom.mjs";

// A new print no longer rebuilds all rows -- the rows already drawn are the same DOM nodes, only the new one
// is built and the one pushed past the limit is removed. A colouring change (reference price) recolours the
// prices of the rows already drawn in place.
globalThis.performance ??= { now: () => 0 };
const { WorkspaceTradesComponent } = await import("../ui/renderer/js/features/workspace/workspace_trades_component.js");

const doc = createDocument();
const body = doc.createElement("tbody");
doc.body.appendChild(body);
const host = { dataset: {}, firstElementChild: null, querySelector: (sel) => (sel.includes("workspace-trades-body") ? body : null) };
const component = new WorkspaceTradesComponent();
component.host = host;

const trade = (n) => ({ ingest_sequence: n, exchange_time: `09:00:${String(n).padStart(2, "0")}`, price: 100 + n / 100, volume: n, side: 1 });
const page = (from, count) => Array.from({ length: count }, (_, i) => trade(from - i));

component.update(withMarketRead({ rows: page(100, 100), referencePrice: 99, logicalCode: "2330" }));
assert.equal(body.children.length, 100);
const kept = body.children.slice(0, 99);
const before = doc.created;
component.update(withMarketRead({ rows: page(101, 100), referencePrice: 99, logicalCode: "2330" }));
assert.equal(doc.created - before, 6, "only the new print is built (tr, 3 cells, time and price spans)");
assert.equal(body.children.length, 100, "the oldest row left with the limit");
assert.equal(body.children[0].getAttribute("data-workspace-trade"), "d:101", "the new print is on top");
assert.deepEqual(body.children.slice(1), kept, "the rows already drawn are the same nodes, in order");

const recolour = doc.created;
assert.equal(body.children[50].cells[1].className, "price-up");
component.update(withMarketRead({ rows: page(101, 100), referencePrice: 200, logicalCode: "2330" }));
assert.equal(doc.created, recolour, "a new reference price builds nothing");
assert.equal(body.children[50].cells[1].className, "price-down", "it recolours the prices in place");
assert.deepEqual(body.children.slice(1), kept, "on the same rows");
// A workspace product is shown, not stored (durable sequence 0): two prints of the same second, price and volume are
// still two rows -- they are keyed by exchange time and trade id, the identity the main 成交明細 uses (tradeRowKey).
{
  const doc2 = createDocument();
  const body2 = doc2.createElement("tbody");
  doc2.body.appendChild(body2);
  const live = new WorkspaceTradesComponent();
  live.host = { dataset: {}, firstElementChild: null, querySelector: (sel) => (sel.includes("workspace-trades-body") ? body2 : null) };
  const unstored = (ns, id, side) => ({ ingest_sequence: 0, durable_sequence: 0, exchange_ts_ns: ns, trade_id: id,
    exchange_time: "10:00:00", price: 50, volume: 3, side });
  live.update(withMarketRead({ rows: [unstored("1700000000000000002", "8", 2), unstored("1700000000000000001", "7", 1)],
    referencePrice: 49, logicalCode: "BTC" }));
  assert.equal(body2.children.length, 2, "same second, price and volume: two prints, two rows");
  assert.deepEqual(body2.children.map((tr) => tr.getAttribute("data-workspace-trade")),
    ["l:1700000000000000002|8", "l:1700000000000000001|7"]);
}
console.log("renderer workspace trades keyed contract passed");
