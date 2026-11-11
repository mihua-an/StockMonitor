import assert from "node:assert/strict";
import fs from "node:fs";

// 大單流向 分時's large-order list places a print by Rust B's `minute` (the session axis hourSeries and minuteSeries
// are on), never by turning the row's clock text into a minute of its own: a futures night past midnight (minute
// 1440+) and a Futu overnight session continuing from the previous partition (minutes before 0) are on B's axis only.
// B's answer to a bucket query is shown as B gave it, without a second filter here.
const { bigOrderFlowBuckets, renderUnifiedBigOrderMinuteVolume } = await import("../ui/renderer/js/core/big_order_flow.js");

const bucket = (key, from, to, opens, closes, buy, sell, total) => ({ key, from_minute: from, to_minute: to, opens_session: opens,
  closes_session: closes, large: { buy, sell }, total, buy_ratio: buy / total, sell_ratio: sell / total });
const row = (seq, time, minute, side = "BUY") => ({ durable_sequence: seq, time, minute, price: 100, volume: 5, side });
const listed = (html) => [...html.matchAll(/flow-large-order-row[^"]*"><span>([^<]*)</g)].map((m) => m[1]);

// A futures night: 15:00 (900) to 05:00 (1740); its 00:00 hour is 1440-1499.
const night = { market: "FUT", minuteSeries: [], hourSeries: [
  bucket("all", 900, 1740, true, true, 10, 0, 40), bucket("m900", 900, 959, true, false, 5, 0, 20),
  bucket("m1440", 1440, 1499, false, false, 5, 0, 20)],
  largeOrders: [row(2, "00:30:05", 1470), row(1, "15:10:00", 910)] };
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(night, { bucketKey: "m1440" })), ["00:30:05"], "the night's hour past midnight lists its print");
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(night, { bucketKey: "m900" })), ["15:10:00"]);
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(night, { bucketKey: "all" })), ["00:30:05", "15:10:00"], "開盤迄今 lists every print B sent");

// A Futu US overnight session continuing from the previous partition: 20:00 is -240 on the session's axis.
const overnight = { market: "US", minuteSeries: [], hourSeries: [
  bucket("all", -240, 239, true, true, 10, 0, 40), bucket("m-180", -180, -121, false, false, 5, 0, 20),
  bucket("m0", 0, 59, false, false, 5, 0, 20)],
  largeOrders: [row(2, "00:30:00", 30, "SELL"), row(1, "21:40:00", -140)] };
const labels = bigOrderFlowBuckets(overnight).map((b) => b.label);
assert.deepEqual(labels, ["開盤迄今", "21:00~22:00", "00:00~01:00"], "a bucket before 0 is labelled on the previous evening's clock");
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(overnight, { bucketKey: "m-180" })), ["21:40:00"], "the previous partition's part lists its print");
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(overnight, { bucketKey: "m0" })), ["00:30:00"]);
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(overnight, { bucketKey: "m0", sideFilter: "BUY" })), [], "單別 still picks the side");

// B answered for THIS bucket and side: its rows are the list, as given.
const answer = (bucketKey, rows, side = "ALL") => ({ ok: true, bucketKey, side, rows, truncated: false });
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(night, { bucketKey: "m1440",
  windowOrders: answer("m1440", [row(9, "00:59:59", 1499), row(8, "00:00:00", 1440)]) })), ["00:59:59", "00:00:00"]);
assert.deepEqual(listed(renderUnifiedBigOrderMinuteVolume(overnight, { bucketKey: "m-180",
  windowOrders: answer("m-180", [row(7, "21:05:00", -175)]) })), ["21:05:00"]);

const source = fs.readFileSync(new URL("../ui/renderer/js/core/big_order_flow.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /minuteOfDay/, "no minute of the renderer's own from a row's clock text");
console.log("renderer large order minute contract passed");
