import assert from "node:assert/strict";
import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";
import { createDocument } from "./lib/mini_dom.mjs";

// N02: the workspace trade table kept its own render signature and left out the quantity scale it formats volumes
// with (and the empty-state text), so a metadata-only change did not repaint until something else changed. Rows are
// now compared field by field, so every displayed field repaints.
globalThis.performance ??= { now: () => 0 };
const { WorkspaceTradesComponent } = await import("../ui/renderer/js/features/workspace/workspace_trades_component.js");

const doc = createDocument();
const body = doc.createElement("tbody");
doc.body.appendChild(body);
const host = { dataset: {}, firstElementChild: null, querySelector: (sel) => (sel.includes("workspace-trades-body") ? body : null) };
const component = new WorkspaceTradesComponent();
component.host = host;
const row = { trade_id: "t1", exchange_time: "09:00:01", price: 100, volume: 1.2345, side: 1 };

component.update(withMarketRead({ rows: [{ ...row, quantityScale: 100 }], referencePrice: 99 }));
const before = body.innerHTML;
component.update(withMarketRead({ rows: [{ ...row, quantityScale: 10000 }], referencePrice: 99 }));
assert.notEqual(body.innerHTML, before, "a quantity-scale change repaints the volume");

component.update(withMarketRead({ rows: [], emptyText: "沒有成交" }));
component.update(withMarketRead({ rows: [], emptyText: "休市" }));
assert.match(body.innerHTML, /休市/, "an empty-state text change repaints");
console.log("workspace trades signature contract passed");
