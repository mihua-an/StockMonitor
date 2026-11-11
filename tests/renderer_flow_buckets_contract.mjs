import assert from "node:assert/strict";
import fs from "node:fs";

// 大單流向 分時's session buckets have one owner, Rust B (projection.rs hour_buckets, sent as flow.hourSeries): the
// renderer labels and shows them and asks B for a bucket's prints by B's own minutes. It keeps no session table of
// its own (it used to cut minuteSeries by a fixed STK 09:00-13:30 table, and every other market by observed hours).
const { bigOrderFlowBuckets, bigOrderBucketWindow, renderUnifiedBigOrderMinuteVolume } = await import("../ui/renderer/js/core/big_order_flow.js");

const bucket = (key, from, to, opens, closes, buy, sell, total) => ({ key, from_minute: from, to_minute: to, opens_session: opens,
  closes_session: closes, large: { buy, sell }, total, buy_ratio: buy / total, sell_ratio: sell / total });
// A futures day session (08:45-13:45): its first bucket is the quarter hour from the open, its last ends at the close.
const flow = { market: "FUT", minuteSeries: [], hourSeries: [
  bucket("all", 525, 825, true, true, 30, 10, 400), bucket("m525", 525, 539, true, false, 20, 0, 100),
  bucket("m540", 540, 599, false, false, 10, 10, 200), bucket("m780", 780, 825, false, true, 0, 0, 100)] };

const buckets = bigOrderFlowBuckets(flow);
assert.deepEqual(buckets.map((b) => b.label), ["開盤迄今", "開盤~09:00", "09:00~10:00", "13:00~收盤"]);
assert.deepEqual(buckets.map((b) => [b.buyPct, b.sellPct]), [[7.5, 2.5], [20, 0], [5, 5], [0, 0]], "B's shares, as percent");
assert.deepEqual(bigOrderBucketWindow(buckets[1]), { fromMinute: 525, toMinute: 539 });
assert.deepEqual(bigOrderBucketWindow(buckets[0]), { fromMinute: 525, toMinute: 825 });
// A night bucket past midnight is labelled on the clock.
const night = bigOrderFlowBuckets({ hourSeries: [bucket("m1440", 1440, 1499, false, false, 1, 1, 4)] });
assert.equal(night[0].label, "00:00~01:00");

const html = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m525" });
assert.match(html, /data-flow-bucket="m525"/);
assert.match(html, /flow-hour-share-row active" data-flow-bucket="m525"><span class="flow-hour-label">開盤~09:00</);
assert.ok(renderUnifiedBigOrderMinuteVolume({ market: "STK", hourSeries: [] }).includes("尚無成交"));

const source = fs.readFileSync(new URL("../ui/renderer/js/core/big_order_flow.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /STK_BUCKETS|bucketDefinitions|13-close/, "no session table of the renderer's own");
console.log("renderer flow buckets contract passed");
