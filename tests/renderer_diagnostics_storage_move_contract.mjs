// 連線診斷 儲存空間 shows a storage move under way: progress, time taken, room left on the target and how much is moved.
import assert from "node:assert/strict";

const { buildDiagnosticsModel } = await import("../ui/renderer/js/core/diagnostics_model.js");
const { storageCardHtml } = await import("../ui/renderer/js/core/diagnostics_cards.js");

const GB = 2 ** 30;
const now = Date.parse("2026-11-09T09:10:00Z");
const storage = (move) => ({ availability: "OK", total_bytes: 20 * GB, disk: { root: "D:\\", total_bytes: 931 * GB, free_bytes: 850 * GB },
  parts: [{ id: "historical", label: "歷史資料", bytes: 20 * GB }], move });
const card = (move) => storageCardHtml(buildDiagnosticsModel({ now, monitoring: { storage: storage(move) } }).storage);

assert.doesNotMatch(card(null), /dg-storage-move/, "no move: nothing extra on the card");

const html = card({ state: "copying", to: "E:\\LM_STK", started_at: "2026-11-09T09:07:00Z", bytes_done: 14 * GB, bytes_total: 56 * GB,
  files_done: 10, files_total: 100, target_root: "E:\\", target_free_bytes: 900 * GB });
assert.match(html, /搬移到 E:\\LM_STK · 複製中 25%/);
assert.match(html, /14\.0 GB \/ 56\.0 GB/);
assert.match(html, /已用 3 分/);
assert.match(html, /E: 剩 900 GB/);
assert.match(html, /width:25\.00%/);

const scanning = card({ state: "scanning", to: "E:\\LM_STK", started_at: null, bytes_done: 0, bytes_total: null, target_root: "E:\\", target_free_bytes: 900 * GB });
assert.match(scanning, /掃描中/);
assert.match(scanning, /計算中/, "the amount is not known before the scan");
console.log("renderer diagnostics storage move contract passed");
