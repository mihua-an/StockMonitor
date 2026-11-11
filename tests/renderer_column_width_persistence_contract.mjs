// 商品列表 column widths "jumped" after a restart or a data update. Three causes, each pinned here:
//   1. Shioaji and Futu product lists shared one storage key, so adjusting one re-shaped the other;
//   2. saved px were re-fitted to a different width by the default flex, not by the user's proportions;
//   3. 股號's 48 px minimum truncated codes to "23..." (now every column's minimum is what its values need:
//      renderer_column_min_width_ui.cjs draws 00631L).
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const table = read("ui/renderer/js/features/realtime/components/realtime_quote_table.js");
const title = read("ui/renderer/js/core/column_title.js");
const store = read("ui/renderer/js/core/layout_state_store.js");

assert.match(table, /monitorQuoteColumnWidthsV2:\$\{provider\}:\$\{columns\.map/, "widths are keyed per provider and per column set");
assert.match(table, /storageKey: realtimeColumnWidthsKey\(table, columns\)/, "the product list uses that key");

// One owner per key (renderer_column_width_shared_key_ui.cjs drags it in two windows): a table commits the columns
// it moved, the store merges them scaled to the width the record was fitted to and notifies the key's other tables.
assert.match(title, /layoutStateStore\.commitColumnWidths\(storageKey, \{ changed, shown, available \}/, "a drag commits the columns it moved");
assert.doesNotMatch(title, /layoutStateStore\.write\(/, "a table never writes a whole width record");
assert.match(store, /const scale = recordAvailable > 0 && width > 0 \? recordAvailable \/ width : 1;/,
  "a commit is scaled to the width the record was fitted to");
assert.match(title, /const scale = saved\.available > 0 && availableNow > 0 \? availableNow \/ saved\.available : 1;/,
  "a read scales the saved widths to the table's width now");

console.log("column width persistence contract passed");
