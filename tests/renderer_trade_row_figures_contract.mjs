// The 成交明細 row: 漲跌, 漲跌幅 and 總量 are Market Runtime's fields, carried through the tape projection unchanged; a
// missing one reads "--", never 0. The workspace list keeps its three cells.
import assert from "node:assert/strict";

const { tradeRowModel, buildTradeRow, patchTradeRow, emptyTradeRow } = await import("../ui/renderer/js/core/trade_rows.js");
const { tapeRow } = await import("../ui/renderer/js/market_data/trade_detail/tape_rows.js");
const { TICK_DETAILS_COLUMNS, FUTU_TICK_DETAILS_COLUMNS } = await import("../ui/renderer/js/core/column_schemas.js");

const titles = ["時間", "成交", "漲跌", "漲跌幅", "單量", "總量"];
assert.deepEqual(TICK_DETAILS_COLUMNS.map((column) => column.title), titles);
assert.deepEqual(FUTU_TICK_DETAILS_COLUMNS.map((column) => column.title), titles);

const wire = { price: 1000, volume: 3, side: "BUY", tick_type: 1, ingest_sequence: 7, exchange_ts_ns: "1", change: 50, change_pct: 5.263157, total_volume: 1234 };
const tape = tapeRow(wire, false);
assert.deepEqual([tape.change, tape.change_pct, tape.total_volume], [50, 5.263157, 1234]);
const up = tradeRowModel(tape, { referencePrice: 950 }, "seq:7");
assert.deepEqual([up.changeText, up.changePctText, up.totalText], ["+50.00", "+5.26%", "1,234"]);
const down = tradeRowModel({ ...tape, price: 900, change: -50, change_pct: -5.26 }, { referencePrice: 950 }, "seq:7");
assert.deepEqual([down.changeText, down.changePctText], ["-50.00", "-5.26%"]);
const flat = tradeRowModel({ ...tape, price: 950, change: 0, change_pct: 0 }, { referencePrice: 950 }, "seq:7");
assert.deepEqual([flat.changeText, flat.changePctText], ["0.00", "0.00%"]);
const none = tradeRowModel(tapeRow({ price: 1000, volume: 3, ingest_sequence: 8, change: null, change_pct: null, total_volume: null }, false), { referencePrice: 950 }, "seq:8");
assert.deepEqual([none.changeText, none.changePctText, none.totalText], ["--", "--", "--"], "a field the source has not is shown as missing, not 0");

// A minimal DOM: what the row builder and the patch touch.
function element(tag) {
  return { tag, children: [], dataset: {}, className: "", textContent: "", colSpan: 1, ownerDocument: fake,
    setAttribute() {}, appendChild(child) { this.children.push(child); return child; }, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, get firstChild() { return this.children[0]; }, get cells() { return this.children; } };
}
const fake = { createElement: element };
const shown = (tr) => tr.children.map((td) => td.textContent);
const row = buildTradeRow(fake, up, { columns: TICK_DETAILS_COLUMNS.map((column) => column.id) });
assert.equal(row.children.length, TICK_DETAILS_COLUMNS.length);
assert.deepEqual([shown(row)[2], shown(row)[3], shown(row)[5]], ["+50.00", "+5.26%", "1,234"]);
assert.equal(row.children[2].className, up.priceCellClass, "漲跌 is coloured as the price is");
patchTradeRow(row, { ...up, changeText: "+60.00", totalText: "1,240" });
assert.deepEqual([shown(row)[2], shown(row)[5]], ["+60.00", "1,240"], "an update writes the cells in place");
assert.equal(buildTradeRow(fake, up).children.length, 3, "the workspace list keeps 時間, 成交, 單量");
// The 成交明細 user's columns: the row has one cell per shown column, in the shown order, and patches each in place.
const picked = buildTradeRow(fake, up, { columns: ["total_volume", "trade", "volume"] });
assert.deepEqual([shown(picked)[0], shown(picked)[2]], ["1,234", "3"]);
patchTradeRow(picked, { ...up, totalText: "1,240", volumeText: "4" });
assert.deepEqual([shown(picked)[0], shown(picked)[2]], ["1,240", "4"]);
assert.equal(emptyTradeRow(fake, "x", 6).children[0].colSpan, 6);
console.log("renderer trade row figures contract passed");
