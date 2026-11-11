// 商品列表 numbers were cut ("534.…", "23.2…") while another column had room (10-19): the minimums were 48 px, less
// than a price at the list's 18 px font, and a table with more columns than its pane scaled every column below its
// minimum. The product lists now keep each column's minimum (keepMinimums) and scroll sideways instead; other
// tables still scale to fit. Futu's 成交明細 keeps 單量 wide enough for a crypto quantity's 8 decimals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundaryDragWidths, fitColumnWidthsToAvailable } from "../ui/renderer/js/core/column_title.js";
import { FUTU_TICK_DETAILS_COLUMNS, REALTIME_HOLDING_COLUMNS, REALTIME_QUOTE_COLUMNS, TICK_DETAILS_COLUMNS } from "../ui/renderer/js/core/column_schemas.js";

const columns = [{ id: "a", minWidth: 88 }, { id: "b", minWidth: 88 }, { id: "c", minWidth: 96 }];
const sum = (widths) => Math.round(widths.reduce((total, value) => total + value, 0));

const scaled = fitColumnWidthsToAvailable([], 200, columns, { floorWidth: 32 });
assert.equal(sum(scaled), 200, "without keepMinimums the columns are scaled into the space");
assert.ok(scaled.every((width, index) => width < columns[index].minWidth));

const kept = fitColumnWidthsToAvailable([], 200, columns, { floorWidth: 32, keepMinimums: true });
assert.deepEqual(kept.map(Math.round), [88, 88, 96], "keepMinimums: each column keeps its minimum, the table is wider");

const roomy = fitColumnWidthsToAvailable([], 400, columns, { floorWidth: 32, keepMinimums: true });
assert.equal(sum(roomy), 400, "with room to spare the columns still fill the space");

// Narrower than every column at its floor: each column stays at its floor (or hard minimum) and the table scrolls;
// the shortfall is not pushed into the last column (it used to go below its floor, even negative).
const narrow = fitColumnWidthsToAvailable([], 50, columns, { floorWidth: 32 });
assert.deepEqual(narrow.map(Math.round), [32, 32, 32], "below the floors' total every column keeps its floor");
const hard = fitColumnWidthsToAvailable([], 50, [{ id: "a" }, { id: "b" }, { id: "c", hardMinWidth: 80 }], { floorWidth: 32 });
assert.ok(hard[2] >= 80 && hard.every((width) => width >= 32), "a hard minimum holds in a container too narrow for it");
const tight = fitColumnWidthsToAvailable([], 150, columns, { floorWidth: 32 });
assert.equal(sum(tight), 150, "above the floors' total the columns still fit the space exactly");

// A user's widths in a list that scrolls sideways are not shrunk back into the space (10-20: a dragged column snapped back).
const userWide = fitColumnWidthsToAvailable([150, 88, 96], 200, columns, { floorWidth: 32, keepMinimums: true, shrink: false });
assert.deepEqual(userWide.map(Math.round), [150, 88, 96], "a user's widths stay as set and the table scrolls");

// Dragging a boundary with every column at its minimum (10-20: nothing moved). The left column grows, the table widens.
const minimums = [88, 88, 96];
const grown = boundaryDragWidths([88, 88, 96], 0, 40, { minimums, keepMinimums: true, available: 200 });
assert.deepEqual(grown.widths, [128, 88, 96], "keepMinimums: a column grows past its neighbour's room");
const shrunk = boundaryDragWidths([128, 88, 96], 0, -40, { minimums, keepMinimums: true, available: 200 });
assert.deepEqual(shrunk.widths, [88, 88, 96], "an overflowing table narrows first");
const filled = boundaryDragWidths([120, 120, 160], 0, -20, { minimums, keepMinimums: true, available: 400 });
assert.deepEqual(filled.widths, [100, 140, 160], "a table that fills its space keeps filling it: the neighbour takes the width");
const fixed = boundaryDragWidths([88, 88, 96], 0, 40, { minimums });
assert.equal(fixed.delta, 0, "a table that may not scroll still moves width only between neighbours");

// The product lists' minimums are what the values shown need (使用者 10-20), not a width declared for the widest value
// a column could hold; measured in Chromium by renderer_column_min_width_ui.cjs.
const byId = (schema) => new Map(schema.map((column) => [column.id, column]));
for (const column of [...REALTIME_QUOTE_COLUMNS, ...REALTIME_HOLDING_COLUMNS]) {
  assert.ok(!column.minWidth && !column.widest, `${column.id}: a product-list column declares no minimum of its own`);
}
const quoteTable = readFileSync(new URL("../ui/renderer/js/features/realtime/components/realtime_quote_table.js", import.meta.url), "utf8");
assert.match(quoteTable, /keepMinimums: true/, "the product lists keep their minimums");
assert.match(quoteTable, /setColumnContentMinimums\(table, measureColumnContent\(table, body, columns, \{ rows: writtenRows \}\), \{ shrink: topologyChanged \|\| columnsChanged \}\)/,
  "every draw sets the minimums from the values drawn (a Tick measures only the rows it wrote); they shrink only when the rows change");

assert.equal(byId(FUTU_TICK_DETAILS_COLUMNS).get("volume").hardMinWidth, 80, "Futu 單量 holds 0.00030513");
assert.ok(!byId(TICK_DETAILS_COLUMNS).get("volume").hardMinWidth, "Shioaji's whole lots need no such width");
console.log("renderer column min width contract passed");
