import assert from "node:assert/strict";
import fs from "node:fs";

// "Backend callback arrival -> this UI surface finished updating", per destination.
//
// Every softer rule that has been tried here produced a wrong number under the right name, so the
// rule is now strict: a component may be measured ONLY against the arrival of the channel it
// actually rendered, and a component whose channel has no arrival is not sampled at all.
//
//   * a view-level `trace.arrival_ns` is the arrival of the last event of ANY channel, so a BidAsk
//     got measured against whichever Tick landed in between;
//   * `read.time.receivedTime` is the SUMMARY's arrival -- a quote -- so it is Tick time wearing a
//     different label;
//   * `sourceLane()` trusted an explicit `source_lane` BEFORE checking the source, so a Futu view
//     could be counted in the Shioaji lane on the caller's word alone;
//   * the wire carried epoch NANOseconds as a JSON number. 1.79e18 is past JS's safe-integer limit
//     (2^53 = 9.0e15), so JSON.parse rounded the low bits away before any consumer saw them and no
//     BigInt work afterwards could recover them. The wire now carries `channel_arrival_us`.
//
// requestAnimationFrame is absent from all of it. The `frame` window still exists for other
// diagnostics and is asserted here to stay OUT of the destination answer.

const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
globalThis.window = { dispatchEvent: () => true };

const clock = Date.now;
let epochMs = 1_800_000_000_000;
Date.now = () => epochMs;

const {
  componentUpdated, marketRenderDestinationLatency, marketRenderLatencySnapshot,
} = await import("../ui/renderer/js/core/market_render_trace.js");
const { canonicalReadModel } = await import("../ui/renderer/js/core/market_read_adapters.js");

/** Epoch microseconds `msAgo` milliseconds before "now". */
const us = (msAgo) => (epochMs - msAgo) * 1000;
const host = () => ({ isConnected: true, dataset: {} });
const count = (key) => marketRenderDestinationLatency()[key]?.sample_count ?? 0;

function read({ channelArrivalUs = {}, receivedTime = null, trace = null, source = "shioaji" } = {}) {
  return {
    identity: { source, code: "2330", market: "STK" },
    session: { tradingDate: "2026-09-28", name: "DAY" },
    time: { receivedTime, receivedTimeKind: receivedTime ? "unix_ns" : null },
    revision: { sequence: 1, streamId: "STK:2330:DAY" },
    sourceDetails: { channelArrivalUs, trace },
  };
}

// ---------------------------------------------------------------------------------------------
// 1 -- each component is measured against its OWN channel.
// ---------------------------------------------------------------------------------------------
{
  componentUpdated("orderbook", { marketRead: read({ channelArrivalUs: { orderbook: us(40) } }) }, host());
  componentUpdated("trades", { marketRead: read({ channelArrivalUs: { trades: us(12) } }) }, host());
  componentUpdated("trend", { marketRead: read({ channelArrivalUs: { trend: us(85) } }) }, host());

  const all = marketRenderDestinationLatency();
  assert.equal(all["stock_bidask:orderbook"].latest_ms, 40);
  assert.equal(all["stock_tick:trades"].latest_ms, 12);
  assert.equal(all["stock_tick:trend"].latest_ms, 85);
  assert.notEqual(
    all["stock_tick:trades"].latest_ms, all["stock_tick:trend"].latest_ms,
    "trades and trend are different amounts of work and must not share one number",
  );
}

// ---------------------------------------------------------------------------------------------
// 2 -- a BidAsk with no book arrival is NOT sampled, even when a fresh Tick arrival is on offer.
//
// Three ways the old code could reach a Tick clock, all asserted here in one go: a view-level
// `sourceDetails.trace`, a caller-supplied `vm.trace`, and `read.time.receivedTime`.
// ---------------------------------------------------------------------------------------------
{
  const before = count("stock_bidask:orderbook");

  componentUpdated("orderbook", {
    marketRead: read({
      channelArrivalUs: { trades: us(3), quote: us(3) },   // a Tick just landed on this view
      receivedTime: String(BigInt(us(3)) * 1000n),          // the summary's arrival
      trace: { arrival_ns: String(BigInt(us(3)) * 1000n) }, // and the view-level trace
    }),
    trace: { arrival_us: us(3) },                           // and a caller-supplied one
  }, host());

  assert.equal(
    count("stock_bidask:orderbook"), before,
    "with no orderbook channel arrival there must be NO sample. Every value on offer here belongs "
    + "to a Tick, and a BidAsk latency computed from a Tick's clock is not a BidAsk latency -- a "
    + "gap is honest, a plausible wrong number is not",
  );
}

// ---------------------------------------------------------------------------------------------
// 3 -- trades/trend are equally strict: they may not borrow the quote channel either.
// ---------------------------------------------------------------------------------------------
{
  const before = count("stock_tick:trades");
  componentUpdated("trades", {
    marketRead: read({ channelArrivalUs: { quote: us(9), orderbook: us(9) }, receivedTime: "1790000000000000000" }),
  }, host());
  assert.equal(count("stock_tick:trades"), before,
    "the trade table may only be measured against the trades channel's own arrival");
}

// ---------------------------------------------------------------------------------------------
// 4 -- the product row is measured, from a caller-supplied arrival, and the lane is DERIVED.
// ---------------------------------------------------------------------------------------------
{
  componentUpdated("product_list", {
    provider: "shioaji", code: "watchlist", trace: { arrival_us: us(30) },
  }, host());

  const row = marketRenderDestinationLatency()["stock_tick:product_list"];
  assert.ok(row, "the product row must be measured: it is the surface every symbol updates into");
  assert.equal(row.latest_ms, 30);
  assert.equal(row.source_lane, "stock_tick");
}

// ---------------------------------------------------------------------------------------------
// 5 -- a Futu update may NOT enter a Shioaji lane, even if it says it should.
// ---------------------------------------------------------------------------------------------
{
  const beforeRow = count("stock_tick:product_list");
  const beforeTrades = count("stock_tick:trades");

  componentUpdated("product_list", {
    provider: "futu", code: "watchlist",
    trace: { arrival_us: us(30), source_lane: "stock_tick" },   // explicitly claims the lane
  }, host());
  componentUpdated("trades", {
    marketRead: read({ source: "futu", channelArrivalUs: { trades: us(15) } }),
    trace: { source_lane: "stock_tick" },
  }, host());

  assert.equal(count("stock_tick:product_list"), beforeRow,
    "a Futu product row must not land in the Shioaji Tick lane, however it labels itself");
  assert.equal(count("stock_tick:trades"), beforeTrades,
    "nor a Futu trade table. The lane is derived from the SOURCE; the module must refuse a "
    + "caller-asserted lane rather than rely on callers not asserting one");
}

// ---------------------------------------------------------------------------------------------
// 6 -- the arrival survives a REAL JSON round trip, which epoch nanoseconds do not.
// ---------------------------------------------------------------------------------------------
{
  // The true value the daemon holds. As nanoseconds this is 1.79e18, past 2^53, where doubles are
  // spaced 128 apart -- so a JSON number of it cannot be represented and JSON.parse rounds it
  // before this code runs. Measured: 99ns lost at parse, and 123ns once String() shortens the
  // decimal for a BigInt round trip, which is exactly what the old conversion did.
  const trueNs = 1_790_582_566_339_297_123n;
  const parsedNs = JSON.parse(`{"v":${trueNs}}`).v;
  assert.equal(Number.isSafeInteger(parsedNs), false,
    "an epoch nanosecond value is not a safe integer; if this ever passes the premise has changed");
  assert.notEqual(BigInt(parsedNs), trueNs,
    "JSON.parse must be shown to lose precision on epoch nanoseconds, or this contract asserts "
    + "nothing about why the wire carries microseconds instead");
  assert.notEqual(BigInt(String(parsedNs)), BigInt(parsedNs),
    "and String() loses more still: it yields the shortest decimal that round-trips the double, so "
    + "BigInt(String(x)) -- the conversion this module used to do -- cannot recover the original");

  // Microseconds are exact through the same round trip.
  // Microseconds: 1.79e15, inside the safe range, so the same round trip is exact.
  const trueUs = trueNs / 1000n;
  const wire = JSON.stringify({ channel_arrival_us: { orderbook: Number(trueUs), quote: 0, trades: 0, trend: 0 } });
  const parsed = JSON.parse(wire);
  assert.equal(BigInt(parsed.channel_arrival_us.orderbook), trueUs, "microseconds survive exactly");
  assert.equal(Number.isSafeInteger(parsed.channel_arrival_us.orderbook), true);

  // And it reaches the trace through the REAL read model, not a hand-built object.
  epochMs = Number(trueUs / 1000n) + 25;
  const model = canonicalReadModel({
    session_key: { logical_code: "2330", market: "STK", trading_date: "2026-09-28", session: "DAY" },
    summary: { code: "2330" },
    channel_arrival_us: parsed.channel_arrival_us,
  }, { code: "2330", market: "STK" });
  componentUpdated("orderbook", { marketRead: model }, host());

  // 24.703ms, not a round 25: the arrival carries 297 microseconds past its millisecond, and they
  // survive. A nanosecond pipeline through a JSON number could not have produced this exactly.
  const expectedMs = Number(BigInt(epochMs) * 1000n - trueUs) / 1000;
  const book = marketRenderDestinationLatency()["stock_bidask:orderbook"];
  assert.equal(book.latest_ms, expectedMs,
    "the wire value must reach the measurement through the real read model and produce the real "
    + "latency, exactly");
  assert.equal(expectedMs, 24.703, "and the sub-millisecond part must be preserved, not rounded");
  assert.equal(book.resolution, "microsecond arrival, millisecond latency",
    "and the resolution must be stated honestly: this is not exact-nanosecond arithmetic");
}

// ---------------------------------------------------------------------------------------------
// 6b -- through the REAL read model: a channel with no arrival must not inherit another's.
//
// The blocks above hand-build the read, which cannot catch a fallback reintroduced in the adapter
// itself. This one goes through canonicalReadModel() with the quote channel stamped and the trades
// channel empty -- the exact shape the old adapter turned into "trades arrived when the summary
// did".
// ---------------------------------------------------------------------------------------------
{
  const before = count("stock_tick:trades");
  const model = canonicalReadModel({
    session_key: { logical_code: "2317", market: "STK", trading_date: "2026-09-28", session: "DAY" },
    summary: { code: "2317" },
    channel_arrival_us: { quote: us(50), trades: 0, trend: 0, orderbook: us(50) },
  }, { code: "2317", market: "STK" });

  assert.equal(model.sourceDetails.channelArrivalUs.trades, 0,
    "the adapter must pass the wire's own per-channel value through, not substitute another");
  componentUpdated("trades", { marketRead: model }, host());
  assert.equal(
    count("stock_tick:trades"), before,
    "a trades channel with no arrival must not be measured against the quote channel's: that "
    + "substitution is how the trade table came to report the summary's latency",
  );
}

// ---------------------------------------------------------------------------------------------
// 7 -- no animation frame in the destination answer.
// ---------------------------------------------------------------------------------------------
{
  const beforeFlush = JSON.stringify(marketRenderDestinationLatency());
  epochMs += 500;
  for (const callback of frames.splice(0)) callback();
  assert.equal(
    JSON.stringify(marketRenderDestinationLatency()), beforeFlush,
    "flushing animation frames must not change the destination numbers: rAF is a scheduling "
    + "boundary, not evidence that a pixel was shown",
  );
  const lane = marketRenderLatencySnapshot().stock_tick;
  assert.ok(lane.frame && lane.update, "the lane windows are kept for other diagnostics");
}

const source = fs.readFileSync(
  new URL("../ui/renderer/js/core/market_render_trace.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /performance\.now\(\)\s*-\s*arrival/i,
  "arrival is an epoch stamp from another process; performance.now() is not comparable to it");
// Code only: the removal is explained in prose at the top of the module.
assert.doesNotMatch(source.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, ""), /receivedTime/,
  "the summary arrival must not be reachable from this module at all");

Date.now = clock;
console.log("renderer latency destination contract passed");
