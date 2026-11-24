import assert from "node:assert/strict";
import fs from "node:fs";

// A table or list with nothing to show yet says so through the one load-state component (core/load_state_view.js):
// emptyStateRowHtml / loadStateRowHtml for a table's only row, loadStateHtml for a section. These views wrote the row
// by hand, each its own markup.
const files = [
  "features/account/daily_pairs_view.js", "features/account/daytrade_view.js", "features/account/stock_stats_view.js",
  "features/data_center/days_view.js", "features/realtime/product_list.js",
  "features/workspace/workspace_trades_component.js", "features/realtime/components/industry_index_list_component.js",
];
for (const file of files) {
  const text = fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(text, /class="empty"/, `${file} writes an empty row by hand`);
  assert.match(text, /from "(\.\.\/)+core\/load_state_view\.js"/, `${file} uses the load-state component`);
}
assert.doesNotMatch(fs.readFileSync(new URL("../ui/renderer/styles/components/industry-index-list.css", import.meta.url), "utf8"),
  /industry-index-list-empty/, "the list's own empty style is gone");

const { emptyStateRowHtml, loadStateRowHtml } = await import("../ui/renderer/js/core/load_state_view.js");
assert.equal(emptyStateRowHtml(3, "等待即時成交"), '<tr><td colspan="3" class="empty" data-state="empty">等待即時成交</td></tr>');
assert.equal(loadStateRowHtml(12, "unavailable", "帳務需要重新計算"),
  '<tr><td colspan="12" class="empty" data-state="unavailable" role="status">暫不可用：帳務需要重新計算</td></tr>');
console.log("renderer load state rows contract passed");
