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
assert.equal(body.children[0].getAttribute("data-workspace-trade"), "seq:101", "the new print is on top");
assert.deepEqual(body.children.slice(1), kept, "the rows already drawn are the same nodes, in order");

const recolour = doc.created;
assert.equal(body.children[50].cells[1].className, "price-up");
component.update(withMarketRead({ rows: page(101, 100), referencePrice: 200, logicalCode: "2330" }));
assert.equal(doc.created, recolour, "a new reference price builds nothing");
assert.equal(body.children[50].cells[1].className, "price-down", "it recolours the prices in place");
assert.deepEqual(body.children.slice(1), kept, "on the same rows");
console.log("renderer workspace trades keyed contract passed");
