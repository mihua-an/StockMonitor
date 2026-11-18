import assert from "node:assert/strict";

// 成交明細's page 1 is one merge for 即時報價 and 工作區 (market_data/trade_detail/tape_rows.js mergeFirstPage): the stored
// newest page and the live view's prints, one row per print, a live row winning field by field, newest first, only
// listed prints. 工作區 keeps its own row format (decisions.md); only the merge is shared.
const { mergeFirstPage } = await import("../ui/renderer/js/market_data/trade_detail/tape_rows.js");

const print = (seq, extra = {}) => ({ ingest_sequence: seq, exchange_ts_ns: 1_000_000 + seq, trade_id: `t${seq}`, price: 100, volume: 1, ...extra });

const stored = [print(3, { total_volume: 30 }), print(2), print(1)];
const live = [print(4), print(3, { volume: 2 }), print(5, { simtrade: true }), print(6, { price: 0 }), print(7, { volume: 0 })];
const rows = mergeFirstPage(stored, live, { limit: 100 });
assert.deepEqual(rows.map((r) => r.ingest_sequence), [4, 3, 2, 1], "newest first, one row per print, 試撮 and unpriced/empty prints left out");
assert.equal(rows[1].volume, 2, "the live row's fields win");
assert.equal(rows[1].total_volume, 30, "the stored row's other fields stay");
assert.deepEqual(mergeFirstPage(stored, live, { limit: 2 }).map((r) => r.ingest_sequence), [4, 3]);
assert.deepEqual(mergeFirstPage(stored, live, { limit: 100, keep: (r) => r.ingest_sequence % 2 === 0 }).map((r) => r.ingest_sequence), [4, 2],
  "keep narrows both sides (the TXF display window)");
assert.deepEqual(mergeFirstPage(null, undefined, { limit: 100 }), []);

console.log("renderer tape first page contract passed");
