import assert from "node:assert/strict";
import { emptyStateRowHtml, loadStateHtml, loadStateRowHtml } from "../ui/renderer/js/core/load_state_view.js";

// A table's placeholder row is the same state and text as the block version, across the table's columns, with the
// table's empty-row look (base.css .empty); the detail is escaped.
assert.equal(loadStateRowHtml(10), '<tr><td colspan="10" class="empty" data-state="loading" role="status">載入中…</td></tr>');
assert.equal(loadStateRowHtml(4, "failed", "<x>"), '<tr><td colspan="4" class="empty" data-state="failed" role="status">讀取失敗：&lt;x&gt;</td></tr>');
assert.equal(loadStateRowHtml(4, "pending"), loadStateRowHtml(4, "loading"), "an unknown state reads as loading");
assert.equal(emptyStateRowHtml(2, "沒有<紀錄>"), '<tr><td colspan="2" class="empty" data-state="empty">沒有&lt;紀錄&gt;</td></tr>');
assert.match(loadStateHtml("failed", "x"), /讀取失敗：x/, "the block version says the same");

console.log("renderer load state row contract passed");
