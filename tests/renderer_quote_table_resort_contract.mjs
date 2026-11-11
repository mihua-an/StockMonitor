import assert from "node:assert/strict";

// User's choice: re-sort every few seconds, never under the pointer. The sorted order was kept until
// the product list changed, so ranks froze at the moment the header was clicked.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
const table = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
// Rows as the product list hands them over: through the data boundary, carrying their read model.
const { withProductRead } = await import("../ui/renderer/js/core/market_read_adapters.js");

let hovered = false;
const body = { matches: (selector) => selector === ":hover" && hovered };
table.applyRealtimeQuoteSort({ sortKey: "total_volume", direction: "desc" }, body);
const rows = (a, b) => [{ code: "A", total_volume: a }, { code: "B", total_volume: b }].map((row) => withProductRead(row, "shioaji"));
const codes = (list) => list.map((row) => row.code).join("");

assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 5), body, 0)), "AB");
assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 50), body, 1000)), "AB", "within the hold the order stays");
hovered = true;
assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 50), body, table.REALTIME_RESORT_MS + 1)), "AB", "never under the pointer");
hovered = false;
assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 50), body, table.REALTIME_RESORT_MS + 2)), "BA", "after the hold it follows the values");

// Each list owns its sort: sorting the Futu list leaves the Shioaji list's order alone.
const other = { matches: () => false };
table.applyRealtimeQuoteSort({ sortKey: "total_volume", direction: "asc" }, other);
assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 50), other, 0)), "AB", "the other list sorts ascending");
assert.equal(codes(table.sortedRealtimeQuoteRows(rows(10, 50), body, table.REALTIME_RESORT_MS * 3)), "BA", "this list is still descending");

// 現價 sorts by the figure it shows: during 試撮 that is the indicative price, not the last trade.
const auction = { matches: () => false };
table.applyRealtimeQuoteSort({ sortKey: "current", direction: "desc" }, auction);
const preOpen = [
  { code: "A", prev_close: 100, current: 101, indicative_price: 95, status: "simtrade" },
  { code: "B", prev_close: 100, current: 99, indicative_price: 105, status: "simtrade" },
].map((row) => withProductRead(row, "shioaji"));
const shown = (code) => table.realtimeRowCells(preOpen.find((row) => row.code === code), ["current"])[0];
assert.ok(JSON.stringify(shown("B")).includes("105"), "B shows its 試撮 price");
assert.equal(codes(table.sortedRealtimeQuoteRows(preOpen, auction, 0)), "BA", "sorted by the shown 試撮 price");
console.log("renderer quote table resort contract passed");
