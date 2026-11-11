import assert from "node:assert/strict";

// 大單流向 分時: B's session buckets (flow.hourSeries, projection.rs hour_buckets) labelled and shown as they are,
// and the selected bucket lists its large prints as 時間 / 成交 / 單量 only.
const { renderUnifiedBigOrderMinuteVolume, bigOrderFlowBuckets } = await import("../ui/renderer/js/core/big_order_flow.js");

const bucket = (key, from, to, opens, closes, buy, sell, total) => ({ key, from_minute: from, to_minute: to, opens_session: opens,
  closes_session: closes, large: { buy, sell }, total, buy_ratio: buy / total, sell_ratio: sell / total, ratio_unit: "decimal_ratio" });
const flow = {
  market: "STK",
  hourSeries: [bucket("all", 540, 810, true, true, 10, 20, 200), bucket("m540", 540, 599, true, false, 10, 0, 100),
    bucket("m600", 600, 659, false, false, 0, 20, 100)],
  largeOrders: [
    { time: "10:01:05", minute: 601, price: 175.5, volume: 20, side: "SELL", large_reason: "VOLUME+IMPACT" },
    { time: "09:00:03", minute: 540, price: 175, volume: 10, side: "BUY", large_reason: "EPISODE" },
  ],
};

const buckets = bigOrderFlowBuckets(flow);
assert.deepEqual(buckets.map((b) => b.label), ["開盤迄今", "開盤~10:00", "10:00~11:00"]);
assert.deepEqual(buckets.map((b) => [b.buyPct, b.sellPct]), [[5, 10], [10, 0], [0, 20]]);

const hour10 = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m600" });
assert.ok(hour10.includes("10:01:05") && !hour10.includes("09:00:03"));
const listHead = hour10.slice(hour10.indexOf("flow-large-order-head"));
assert.ok(!/<span>單別<\/span>/.test(listHead) && !hour10.includes("掃價"), "no 單別 column or reason in the list");
// 單別 filter (全部 / 買 / 賣) above the buckets.
assert.match(hour10, /data-flow-side-filter/);
const sells = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m600", sideFilter: "SELL" });
const buysOnly = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m600", sideFilter: "BUY" });
assert.ok(sells.includes("10:01:05"), "the 內盤 print stays under 賣");
assert.ok(!buysOnly.includes("10:01:05") && buysOnly.includes("沒有買方大單"), "and is filtered out under 買");
assert.ok(hour10.includes("flow-large-order-row price-down"), "a 內盤 print takes the down colour");
assert.ok(!hour10.includes("11:00~12:00"), "a bucket B did not send (no trades yet) is not shown");
assert.ok(!hour10.includes("flow-large-order-note"), "a fully listed bucket carries no truncation note");
// One share per bucket: the larger side under 全部, the filtered side otherwise.
assert.ok(hour10.includes('<b class="price-down">賣 10.0%</b>') && !hour10.includes("買 5.0%"), "全部 shows only the larger side");
assert.ok(buysOnly.includes('<b class="price-up">買 5.0%</b>'), "買 shows the buy share even when smaller");

const all = renderUnifiedBigOrderMinuteVolume(flow);
assert.ok(all.includes("09:00:03") && all.includes("10:01:05"), "開盤迄今 lists both sides");
assert.ok(all.includes("data-flow-side-filter"), "the 單別 filter is back (user, 2026-10-08)");

// Older prints beyond B's wire cap are called out rather than silently missing.
const capped = renderUnifiedBigOrderMinuteVolume({ ...flow, largeOrders: flow.largeOrders.slice(0, 1) }, { bucketKey: "m540" });
assert.ok(capped.includes("flow-large-order-note"));

assert.ok(renderUnifiedBigOrderMinuteVolume({ market: "STK" }).includes("尚無成交"));

// B9: the selected bucket's list comes from Rust B when it answered for THAT bucket -- complete, no cap note.
const { bigOrderBucketWindow } = await import("../ui/renderer/js/core/big_order_flow.js");
assert.deepEqual(bigOrderBucketWindow(buckets.find((b) => b.key === "m540")), { fromMinute: 540, toMinute: 599 }, "B's own minutes");
assert.deepEqual(bigOrderBucketWindow(buckets.find((b) => b.key === "all")), { fromMinute: 540, toMinute: 810 });
const older = { time: "09:00:01", minute: 540, price: 174, volume: 10, side: "BUY", large_reason: "VOLUME" };
const queried = renderUnifiedBigOrderMinuteVolume({ ...flow, largeOrders: [] }, { bucketKey: "m540",
  windowOrders: { ok: true, bucketKey: "m540", rows: [older], truncated: false } });
assert.ok(queried.includes("09:00:01") && !queried.includes("flow-large-order-note"), "B's complete list, no cap note");
const cut = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m540",
  windowOrders: { ok: true, bucketKey: "m540", rows: [older], truncated: true } });
assert.ok(cut.includes("此時段大單較多"), "B said its answer was cut");
const otherBucket = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m600",
  windowOrders: { ok: true, bucketKey: "m540", rows: [older], truncated: false } });
assert.ok(otherBucket.includes("10:01:05") && !otherBucket.includes("09:00:01"), "an answer for another bucket is never shown");
const failed = renderUnifiedBigOrderMinuteVolume({ ...flow, largeOrders: flow.largeOrders.slice(0, 1) }, { bucketKey: "m540",
  windowOrders: { ok: false, bucketKey: "m540", rows: [] } });
assert.ok(failed.includes("此時段較早的大單未列出"), "without an answer the flow's newest prints are used, and the gap is said");

// The component asks once per bucket, again only when the bucket's large volume moved, and backs off after a failure.
const { TradeFlowComponent } = await import("../ui/renderer/js/core/components/trade_flow_component.js");
const component = new TradeFlowComponent();
component.host = {};
let renders = 0;
component.render = () => { renders += 1; };
const asked = [];
let answer = { ok: true, rows: [older], truncated: false };
const vm = { logicalCode: "2330", queryLargeOrders: (window) => { asked.push(window); return Promise.resolve(answer); } };
component.bucketKey = "m540";
component.requestWindowOrders(vm, flow);
component.requestWindowOrders(vm, flow);
assert.equal(asked.length, 1, "one query in flight");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(asked[0], { fromMinute: 540, toMinute: 599, side: "ALL" });
assert.equal(component.windowOrders.rows[0].time, "09:00:01");
assert.equal(renders, 1, "an answer re-renders");
component.requestWindowOrders(vm, flow);
assert.equal(asked.length, 1, "same bucket, same large volume: not asked again");
component.windowOrders.at -= 5000;
component.requestWindowOrders(vm, { ...flow, hourSeries: [flow.hourSeries[0], bucket("m540", 540, 599, true, false, 30, 0, 120), flow.hourSeries[2]] });
assert.equal(asked.length, 2, "the bucket's large volume moved: asked again");
await new Promise((resolve) => setTimeout(resolve, 0));
component.bucketKey = "m600";
answer = { ok: false, reason: "ANALYSIS_RUNTIME_UNAVAILABLE", rows: [] };
component.requestWindowOrders(vm, flow);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(asked[2], { fromMinute: 600, toMinute: 659, side: "ALL" }, "a new bucket is asked at once");
component.windowOrders.at -= 3000;
component.requestWindowOrders(vm, flow);
assert.equal(asked.length, 3, "a failed answer is not retried within the back-off");
component.windowOrders.at -= 10000;
component.requestWindowOrders(vm, flow);
assert.equal(asked.length, 4, "and is retried after it");
// A rejected query and a query that throws at once are failures like an answered one: logged, kept with their time,
// and not asked again within the back-off.
{
  const c = new TradeFlowComponent();
  c.host = {};
  c.render = () => {};
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(String(args[0]));
  let asks = 0;
  let mode = "reject";
  const vmFail = { logicalCode: "2330", queryLargeOrders: () => {
    asks += 1;
    if (mode === "throw") throw new Error("bridge gone");
    return Promise.reject(new Error("timed out"));
  } };
  c.bucketKey = "m540";
  c.requestWindowOrders(vmFail, flow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([c.windowQuery, c.windowOrders.ok, c.windowOrders.reason], [null, false, "timed out"]);
  c.requestWindowOrders(vmFail, flow);
  assert.equal(asks, 1, "a rejection backs off like an answered failure");
  mode = "throw";
  c.bucketKey = "m600";
  c.requestWindowOrders(vmFail, flow);
  assert.deepEqual([asks, c.windowOrders.ok, c.windowOrders.reason], [2, false, "bridge gone"], "a synchronous throw is kept too");
  c.requestWindowOrders(vmFail, flow);
  assert.equal(asks, 2);
  console.warn = warn;
  assert.equal(warned.filter((line) => /large orders for 2330 .* failed: (timed out|bridge gone)/.test(line)).length, 2, "each failure is logged");
}
// The side is part of the query (Rust B picks it before its limit) and of the cache key; an answer for one
// side is never shown for another.
{
  const c = new TradeFlowComponent();
  c.host = {};
  c.render = () => {};
  const asks = [];
  const vmSide = { logicalCode: "2330", queryLargeOrders: (window) => { asks.push(window); return Promise.resolve({ ok: true, rows: [older] }); } };
  c.bucketKey = "m540";
  c.requestWindowOrders(vmSide, flow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  c.sideFilter = "SELL";
  c.requestWindowOrders(vmSide, flow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asks.map((w) => w.side), ["ALL", "SELL"], "a new side is asked at once");
  assert.equal(c.windowOrders.side, "SELL");
  const shown = renderUnifiedBigOrderMinuteVolume(flow, { bucketKey: "m540", sideFilter: "BUY",
    windowOrders: { ok: true, bucketKey: "m540", side: "SELL", rows: [older], truncated: false } });
  assert.ok(!shown.includes("此時段大單較多") && !shown.includes("09:00:01"), "a SELL answer is not the BUY list");
}
// TXFR1's 日盤/夜盤 (or a new day) keep the same code; the answer is keyed by partition.
{
  const c = new TradeFlowComponent();
  c.host = {};
  c.render = () => {};
  const asks = [];
  const vmFor = (identity) => ({ logicalCode: "TXFR1", largeOrderIdentity: identity,
    queryLargeOrders: (window) => { asks.push(identity); return Promise.resolve({ ok: true, rows: [older] }); } });
  c.bucketKey = "m540";
  c.requestWindowOrders(vmFor("FUT|TXFR1|2026-09-30|FULL"), flow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  c.requestWindowOrders(vmFor("FUT|TXFR1|2026-10-01|FULL"), flow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asks, ["FUT|TXFR1|2026-09-30|FULL", "FUT|TXFR1|2026-10-01|FULL"], "another partition is asked again");
  assert.equal(c.windowOrders.identity, "FUT|TXFR1|2026-10-01|FULL");
}
// The ratio tab must receive B's recent windows, never draw 50/50 for every interval.
{
  const { bigOrderFlowWindowsFromRust, renderUnifiedBigOrderRatios, BIG_ORDER_FLOW_WINDOWS } = await import("../ui/renderer/js/core/big_order_flow.js");
  const block = { windows: {
    "5": { flow: { large: { buy: 300, sell: 100, buy_ratio: 0.75, sell_ratio: 0.25 }, small: { buy: 10, sell: 30, buy_ratio: 0.25, sell_ratio: 0.75 } } },
    "60": { flow: { large: { buy: 1, sell: 3, buy_ratio: 0.25, sell_ratio: 0.75 }, small: {} } },
  } };
  const windows = bigOrderFlowWindowsFromRust(block);
  assert.deepEqual(Object.keys(windows).sort(), ["300s", "3600s"]);
  assert.equal(windows["300s"].large.buy_ratio, 0.75);
  assert.ok(BIG_ORDER_FLOW_WINDOWS.every(([key]) => key !== "600s"), "only windows B computes are offered");
  const html = renderUnifiedBigOrderRatios({ cumulative: {}, windows }, { activeWindow: "300s" });
  assert.ok(html.includes("買 75.0%") && html.includes('class="sell" style="width:25%"'), "the 近5分 large ratio comes from B's window");
  assert.ok(html.includes('<b class="price-up">買 75.0%</b>'), "a cell shows the larger side's share in its colour");
  assert.ok(html.includes('<b class="price-down">賣 75.0%</b>'), "a sell-heavy cell names 賣");
  assert.ok(html.includes('<i class="buy" style="width:75%"></i><i class="sell" style="width:25%"></i>'), "with the split bar under it");
  // 開盤迄今 and 累計盤差 are B's totals: no direction yet is B's null, shown as such, never a drawn 50/50.
  const totals = { net: -7, large: { buy: 0, sell: 0, unknown: 5, buy_ratio: null, sell_ratio: null }, small: { buy: 2, sell: 6, buy_ratio: 0.25, sell_ratio: 0.75 } };
  const day = renderUnifiedBigOrderRatios({ cumulative: {}, totals, windows: {} }, { activeWindow: "300s" });
  assert.ok(!day.includes("50.0%"), day);
  assert.ok(day.includes("尚無方向"));
  assert.ok(day.includes('<b class="price-down">賣 75.0%</b>') && day.includes('<i class="buy" style="width:25%"></i>'), "the small day ratio is B's");
  assert.match(day, /累計盤差<\/span><b class="price-down">-7</, "the 累計盤差 is B's net over every class");
  assert.deepEqual(bigOrderFlowWindowsFromRust(undefined), {});
}
console.log("big order price-volume contract ok");
