// The trade pager's counted-key set stays within its bound on every path: a page's rows (addKnownKeys) and live trades
// (apply) both trim to the limit, so paging through history never grows it without bound.
import assert from "node:assert/strict";

const { createOptimisticCountTracker } = await import("../ui/renderer/js/market_data/trade_detail/optimistic_count.js");
const row = (i) => ({ ingest_sequence: i + 1, price: 100, volume: 1 });

const tracker = createOptimisticCountTracker({ pageSize: 100, limit: 50 });
tracker.addKnownKeys(Array.from({ length: 500 }, (_, i) => row(i)));
assert.equal(tracker.size, 50, "a large page is trimmed to the limit");
const pager = { target: "2330", bootstrapReady: true, totalCount: 1000, totalPages: 10 };
assert.equal(tracker.apply("2330", row(10_000), pager), true);
assert.equal(tracker.size, 50, "a live trade keeps it at the limit");
assert.equal(pager.totalCount, 1001);
assert.equal(tracker.apply("2330", row(10_000), pager), false, "a trade is counted once");
assert.equal(tracker.apply("2330", row(499), pager), false, "a recent page row is known");
assert.equal(tracker.apply("2317", row(20_000), pager), false, "another product's trade is not counted");
tracker.clear();
assert.equal(tracker.size, 0);

// One rule for both pagers: a print at or below the count read's watermark is inside its count; a newer one adds one.
const row2 = (sequence) => ({ ingest_sequence: sequence, price: 100, volume: 1 });
const counted = createOptimisticCountTracker({ pageSize: 100 });
const paged = { target: "US.NOK", bootstrapReady: true, totalCount: 100, totalPages: 1, snapshotWatermark: 100 };
assert.equal(counted.apply("US.NOK", row2(100), paged), false, "already inside the count");
assert.equal(paged.totalCount, 100);
assert.equal(counted.apply("US.NOK", row2(101), paged), true);
assert.deepEqual([paged.totalCount, paged.totalPages], [101, 2]);
// A page's rows are inside its count; a later count read keeps the live trades counted beyond its watermark.
counted.addKnownKeys([row2(500)]);
counted.rebase(paged, { totalRows: 100, totalPages: 1, watermark: 100 });
assert.deepEqual([paged.totalCount, paged.totalPages], [101, 2], "101 is beyond the watermark, the page's 500 was never counted");
counted.rebase(paged, { totalRows: 101, totalPages: 2, watermark: 101 });
assert.equal(paged.totalCount, 101, "the read holds it now: not counted twice");
assert.equal(counted.apply("US.NOK", row2(101), { ...paged, snapshotWatermark: 0 }), false, "a print is counted once");
const before = { target: "US.NOK", bootstrapReady: false, totalCount: 0, totalPages: 1, snapshotWatermark: 0 };
assert.equal(counted.apply("US.NOK", row2(900), before), false, "no base count yet");

// Both pagers ask with the one query builder.
const { TRADE_DETAIL_PAGE_SIZE, tradePageQuery } = await import("../ui/renderer/js/market_data/trade_detail/page_query.js");
const full = tradePageQuery({ market: "FUT", code: "CDF202611", session: "NIGHT", tradingDate: "2026-11-10", actualContract: "CDF202611", page: 3, watermark: 42 });
assert.deepEqual(Object.fromEntries(full), { market: "FUT", logical_code: "CDF202611", session: "NIGHT", page: "3", page_size: String(TRADE_DETAIL_PAGE_SIZE),
  snapshot_watermark: "42", trading_date: "2026-11-10", actual_contract: "CDF202611" });
const meta = tradePageQuery({ market: "US", code: "US.NOK", session: "", tradingDate: "2026-11-10", page: 1, metadataOnly: true });
assert.deepEqual([meta.get("metadata_only"), meta.get("snapshot_watermark"), meta.has("session")], ["true", "0", false]);
console.log("renderer optimistic count contract passed");
