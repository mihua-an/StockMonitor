import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// Futu 成交明細 and 買賣報價 in the overnight session (20:00-04:00 New York) measure against the same 昨收 as the
// 個股走勢 夜盤 tab: the last trade before the session's 20:00 open (decisions.md). Until midnight the product's
// current partition is still the New York date whose summary 昨收 is the day before's close, so the panels used
// 835.06 while the 夜盤 tab used 882.48 for the same stock at the same time.
//  * outside the overnight session (Rust A's US session says when it trades) nothing extra is read;
//  * in it, the partition the session opened in is read and its last trade before 20:00 is the panels' 昨收,
//    with 漲跌 / 漲幅 against it; after midnight that is still the previous date's partition.

const live = installRealtimeHarness({ enabledSources: ["futu"] });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [] }) });
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
};

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
const { futuCanonicalViewSpec } = await import("../ui/renderer/js/market_data/moomoo_symbol.js");
const { MoomooOrderBookComponent, MoomooTradesComponent } = await import("../ui/renderer/js/features/realtime/components/moomoo_components.js");

realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.ready();

const CODE = "US.SNDK";
// The US session as Rust A sends it (session.current `us`, native/market_runtime/src/us_session.rs, where which
// evenings have an overnight session -- none on Friday, Saturday or a holiday eve -- is tested): `phase` and the 夜盤
// window, the session that opened at 20:00 on `evening`.
const us = (phase, evening, next) => () => ({ phase, windows: {
  overnight: [{ trading_date: evening, from: 1200, to: 1440 }, { trading_date: next, from: 0, to: 240 }] } });

// Which partition each session reads (2026-11-09 is a Monday).
const book = new MoomooOrderBookComponent();
book.usSession = us("regular", "2026-11-08", "2026-11-09");
assert.equal(book.overnightSpec(CODE), null, "the regular session reads no extra partition");
book.usSession = us("after", "2026-11-08", "2026-11-09");
assert.equal(book.overnightSpec(CODE), null, "before 20:00 there is no overnight session yet");
book.usSession = us("closed", "2026-11-12", "2026-11-13");
assert.equal(book.overnightSpec(CODE), null, "a closed market (a Friday evening) has no overnight session");
book.usSession = us("overnight", "2026-11-09", "2026-11-10");
assert.equal(book.overnightSpec(CODE)?.trading_date, "2026-11-09", "the partition the session opened in");
book.usSession = () => null;
assert.equal(book.overnightSpec(CODE), null, "before A has sent a session");
assert.equal(new MoomooOrderBookComponent().overnightSpec("CC.BTCUSD"), null, "crypto has no overnight session");

// The product's current view: summary 昨收 835.06 (Friday's close), 現價 878.65.
const current = futuCanonicalViewSpec(CODE);
const opened = { ...current, trading_date: "2026-11-09", channels: ["trend"] };
const releases = [current, opened].map((spec) => realtime.subscribeRealtimeView(spec, () => {}, { stateDelivery: "snapshot-only", replayCached: false }));
await live.settle(() => socket.sentOfType("view.subscribe").length >= 2);
const point = (minute, close, volume) => {
  const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return { minute, time, timestamp: `2026-11-09T${time}:00-05:00`, close, price: close, volume, amount: close * volume };
};
let sub = 0;
for (const message of socket.sentOfType("view.subscribe")) {
  const date = message.payload.trading_date || "2026-11-09";
  const identity = { request_id: message.payload.request_id, subscription_id: `sub-${++sub}`, stream_id: `stream-${sub}`, watermark: 1 };
  socket.frame({ type: "view.subscription.accepted", payload: identity });
  socket.frame({ type: "view.snapshot", payload: {
    ...identity, sequence: 1, source: "futu", market: "US", code: CODE, session: "FULL", trading_date: date,
    session_key: { market: "US", logical_code: CODE, session: "FULL", trading_date: date },
    summary: { current: 878.65, prev_close: 835.06, change: 43.59, change_pct: 5.22 },
    // 16:00 close, the last post-market trade at 19:58 (19:59 printed nothing) and the overnight session's first.
    trend: [point(959, 860.1, 300), point(1198, 882.48, 12), point(1199, 882.48, 0), point(1201, 880.0, 5)],
  } });
}

for (const Panel of [MoomooOrderBookComponent, MoomooTradesComponent]) {
  const panel = new Panel();
  panel.usSession = us("overnight", "2026-11-09", "2026-11-10");
  panel.overnightViewSpec = panel.overnightSpec(CODE);
  panel.overnightReference = null;
  panel.readOvernightReference();
  assert.equal(panel.overnightReference, 882.48, `${panel.kind}: the last trade before 20:00 (a minute with no print is not one)`);
  const quote = panel.focusedQuote(CODE);
  assert.equal(quote.prev, 882.48, `${panel.kind}: 昨收 is the 夜盤 tab's`);
  assert.ok(Math.abs(quote.change - (878.65 - 882.48)) < 1e-9, `${panel.kind}: 漲跌 against it`);
  assert.ok(Math.abs(quote.changePct - ((878.65 - 882.48) / 882.48) * 100) < 1e-9, `${panel.kind}: 漲幅 against it`);

  // Outside the overnight session the product's own 昨收 and Market Runtime's 漲跌 stay.
  panel.usSession = us("regular", "2026-11-08", "2026-11-09");
  panel.overnightViewSpec = panel.overnightSpec(CODE);
  panel.readOvernightReference();
  const day = panel.focusedQuote(CODE);
  assert.equal(day.prev, 835.06);
  assert.equal(day.change, 43.59);
}

releases.forEach((release) => release());
console.log("renderer_futu_overnight_reference_contract: ok");
