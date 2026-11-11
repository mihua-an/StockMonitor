// 即時報價 panes: drag a tab into another pane, beside a pane, or into a new row; an emptied pane
// disappears and its neighbour takes its width, but every row keeps one pane; extra rows go when emptied.
import assert from "node:assert/strict";
import { normalizeLayout, storedLayoutUsable, PANE_LAYOUT_VERSION, moveTab, splitPane, addRow, setPaneTabs, resize, prune, pixelExtents, paneOfComponent } from "../ui/renderer/js/core/pane_layout.js";

const base = normalizeLayout({ rows: [
  { id: "top", size: 0.4, panes: [
    { id: "A", size: 0.5, componentIds: ["productList"], activeComponentId: "productList" },
    { id: "B", size: 0.5, componentIds: ["marketTrend", "priceFlow"], activeComponentId: "marketTrend" },
  ] },
  { id: "bottom", size: 0.6, panes: [
    { id: "C", size: 0.6, componentIds: ["stockTrend", "technicalAnalysis"], activeComponentId: "stockTrend" },
    { id: "D", size: 0.4, componentIds: ["orderbook"], activeComponentId: "orderbook" },
  ] },
] });
const ids = (layout) => layout.rows.map((row) => row.panes.map((pane) => `${pane.id}:${pane.componentIds.join("+")}@${pane.size.toFixed(2)}`).join(" | "));

// Join another pane: the tab becomes that pane's active tab.
const joined = moveTab(base, "priceFlow", "D");
assert.deepEqual(ids(joined), ["A:productList@0.50 | B:marketTrend@0.50", "C:stockTrend+technicalAnalysis@0.60 | D:orderbook+priceFlow@0.40"]);
assert.equal(paneOfComponent(joined, "priceFlow").activeComponentId, "priceFlow");
assert.deepEqual(ids(base)[0], "A:productList@0.50 | B:marketTrend+priceFlow@0.50", "the input is never changed");

// Beside a pane: a new pane with half the target's width; the source pane loses the tab.
const split = splitPane(base, "priceFlow", "B", "right", { paneId: "E" });
assert.deepEqual(ids(split)[0], "A:productList@0.50 | B:marketTrend@0.25 | E:priceFlow@0.25");
assert.equal(splitPane(base, "productList", "A", "left"), base, "a pane cannot split off its only tab");

// The source pane emptied by a move disappears; its left neighbour takes its width.
const emptied = moveTab(base, "orderbook", "B");
assert.deepEqual(ids(emptied)[1], "C:stockTrend+technicalAnalysis@1.00");
// ...but a row's last pane stays (it offers the add-feature page).
const lastOfRow = moveTab(base, "productList", "B");
assert.deepEqual(ids(lastOfRow)[0], "B:marketTrend+priceFlow+productList@1.00", "A emptied, B takes the row");
const both = setPaneTabs(lastOfRow, "B", [], "");
assert.deepEqual(ids(both)[0], "B:@1.00", "the row keeps one (empty) pane");

// Rows: refused at the limit; above it a new row takes an even share, and goes again when emptied.
assert.equal(addRow(base, "priceFlow", "top", { maxRows: 2 }), base);
const three = addRow(base, "priceFlow", "bottom", { maxRows: 3, paneId: "F" });
assert.equal(three.rows.length, 3);
assert.deepEqual(three.rows.map((row) => row.size.toFixed(3)), ["0.267", "0.400", "0.333"]);
assert.deepEqual(ids(three)[2], "F:priceFlow@1.00");
const backToTwo = moveTab(three, "priceFlow", "A");
assert.equal(backToTwo.rows.length, 2, "an emptied third row disappears");
// A row added at the top is row 0, and still goes when emptied -- also after a save and reload.
const topped = addRow(base, "priceFlow", "top", { maxRows: 3, paneId: "T" });
assert.deepEqual(ids(topped)[0], "T:priceFlow@1.00");
const reloaded = normalizeLayout(JSON.parse(JSON.stringify(topped)));
const topEmptied = moveTab(reloaded, "priceFlow", "A");
assert.equal(topEmptied.rows.length, 2, "the emptied top row disappears");
assert.ok(topEmptied.rows.every((row) => !row.extra), "the default rows remain");
assert.equal(moveTab(setPaneTabs(base, "B", [], ""), "orderbook", "A").rows.length, 2, "a default row is never removed");
assert.ok(Math.abs(backToTwo.rows.reduce((s, r) => s + r.size, 0) - 1) < 1e-9);

// Reorder inside a pane.
const reordered = moveTab(base, "stockTrend", "C", 2);
assert.deepEqual(paneOfComponent(reordered, "stockTrend").componentIds, ["technicalAnalysis", "stockTrend"]);

// Resize keeps shares summing to 1; pixel extents land on whole pixels and fill the space exactly.
const resized = resize(base, "bottom", [3, 1]);
assert.deepEqual(resized.rows[1].panes.map((p) => p.size), [0.75, 0.25]);
assert.deepEqual(pixelExtents([0.3333, 0.3333, 0.3334], 1001, 8), [328, 329, 328], "edges at round(985 x 1/3), round(985 x 2/3)");
assert.equal(pixelExtents([0.22, 0.18, 0.15, 0.15, 0.15, 0.15], 1663.5, 8).reduce((a, b) => a + b, 0), 1663 - 40);

// A stored layout with a component twice, an unknown one and broken sizes is repaired, not rejected.
const repaired = normalizeLayout({ rows: [{ panes: [{ id: "X", componentIds: ["a", "a", "gone"], size: -1 }, { id: "Y", componentIds: ["a", "b"], size: 0 }] }] },
  { isKnown: (id) => id !== "gone" });
assert.deepEqual(repaired.rows[0].panes.map((p) => p.componentIds), [["a"], ["b"]]);
assert.deepEqual(repaired.rows[0].panes.map((p) => p.size), [0.5, 0.5]);
assert.equal(prune(normalizeLayout({ rows: [] })).rows.length, 1);
// A layout stored before rows said whether they were added cannot be read by position: it is not used (the
// workspace rebuilds the defaults), and a row without `extra` is a default row, never guessed from where it sits.
assert.equal(PANE_LAYOUT_VERSION, 2);
const oldStored = { rows: [{ panes: [{ componentIds: ["a"] }] }, { panes: [] }, { panes: [] }] };
assert.equal(storedLayoutUsable(oldStored), false);
assert.equal(storedLayoutUsable({ ...oldStored, version: 1 }), false);
assert.equal(storedLayoutUsable({ version: 2, rows: [{ extra: true, panes: [] }, { panes: [] }] }), false, "every row must say");
assert.equal(storedLayoutUsable(normalizeLayout({ rows: [{ panes: [] }, { panes: [] }] })), true);
assert.ok(normalizeLayout(oldStored).rows.every((row) => row.extra === false), "no row is guessed to be an added one");
console.log("renderer pane layout contract passed");
