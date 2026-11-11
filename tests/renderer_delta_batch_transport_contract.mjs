import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// Market Runtime now coalesces one drain of a connection's queue into a `view.delta.batch` frame
// for a client that subscribes with `delta_batch: true`. Before, every delta was its own frame,
// message event, parse and page callback; under the isolated feed the renderer fell behind, the
// hub closed it ("outbound queue full"), and the reconnect storm left 加權走勢 / 期貨走勢 blank until
// a tab switch and froze the 個股走勢 加權 overlay near 10:30.
//
// This drives the REAL socket handler in market_data/realtime.js with a fake WebSocket:
//   1. the renderer opts in on view.subscribe;
//   2. a batch frame is applied item by item (every trend minute lands, in order);
//   3. the page is called back ONCE per view per batch, with every delta, not once per delta.

const live = installRealtimeHarness();
const { sockets } = live;

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream();
const socket = sockets[0];
// The page holds no credential -- neither in the URL nor as a subprotocol (Electron main sets the header).
assert.ok(!socket.url.includes("token"), socket.url);
assert.equal(socket.protocols, undefined);
socket.open();

const spec = { source: "shioaji", market: "IDX", code: "TAIEX", trading_date: "2026-09-28", session: "DAY", channels: ["summary", "trend"] };
const events = [];
realtime.subscribeRealtimeView(spec, (event) => events.push(event), { stateDelivery: "snapshot-only" });

// --- 1. the renderer opts in ------------------------------------------------------------------
const subscribe = socket.sent.find((message) => message.type === "view.subscribe" && message.payload.code === "TAIEX");
assert.ok(subscribe, "the TAIEX view must be subscribed");
assert.equal(subscribe.payload.delta_batch, true, "the renderer must ask Market Runtime for batched deltas");

const stream = "shioaji|IDX|TAIEX|2026-09-28|DAY";
const sessionKey = { source: "shioaji", market: "IDX", logical_code: "TAIEX", trading_date: "2026-09-28", session: "DAY" };
socket.frame({ type: "view.subscription.accepted", payload: { request_id: subscribe.payload.request_id, subscription_id: "sub-1", stream_id: stream, watermark: 1 } });
socket.frame({ type: "view.snapshot", payload: { request_id: subscribe.payload.request_id, subscription_id: "sub-1", stream_id: stream,
  session_key: sessionKey, session_generation: 1, watermark: 1, sequence: 1,
  summary: { current: 25000, open: 24900 }, trend: [{ minute: 540, time: "09:00", timestamp: "2026-09-28T09:00:00+08:00", price: 24900 }] } });
assert.equal(realtime.getRealtimeViewSnapshot(spec).trend.length, 1);
events.length = 0;

// --- 2 + 3. one batch frame, three trend minutes ----------------------------------------------
const item = (sequence, minute) => ({ subscription_id: "sub-1", stream_id: stream, session_key: sessionKey,
  session_generation: 1, sequence, delta_type: "trend.upsert", channels: ["trend"],
  payload: { minute, time: `09:0${minute - 540}`, timestamp: `2026-09-28T09:0${minute - 540}:00+08:00`, price: 24900 + minute - 540 } });
socket.frame({ type: "view.delta.batch", payload: { items: [item(2, 541), item(3, 542), item(4, 543)] } });

const trend = realtime.getRealtimeViewSnapshot(spec).trend;
assert.deepEqual(trend.map((point) => Number(point.minute)), [540, 541, 542, 543],
  "every item of the batch must be applied, in order -- a dropped batch is what froze the overlay");
assert.equal(events.length, 1, "the page is called back once per view per batch, not once per delta");
assert.equal(events[0].type, "batch");
assert.deepEqual(events[0].deltas.map((delta) => delta.sequence), [2, 3, 4], "the page still sees every delta");
assert.equal(realtime.getRealtimeViewStats().renderer_delta_batch_received, 1);

// The session is pushed by Market Runtime -- on the connection and with every rollover -- and held by the
// transport for the connection it came on; a subscriber gets the current one at once.
const sessions = [];
const releaseSession = realtime.subscribeRealtimeSession((session) => sessions.push(session.equity.trading_date));
assert.deepEqual(sessions, [], "nothing pushed yet on this connection");
socket.frame({ type: "session.current", payload: { equity: { trading_date: "2026-09-28" } } });
socket.frame({ type: "session.rollover", payload: { rolled: {}, cleared: {}, session: { equity: { trading_date: "2026-09-29" } } } });
assert.deepEqual(sessions, ["2026-09-28", "2026-09-29"]);
const late = [];
realtime.subscribeRealtimeSession((session) => late.push(session.equity.trading_date))();
assert.deepEqual(late, ["2026-09-29"], "a late subscriber gets the current session at once");
releaseSession();

// Stopping the stream answers every request still waiting on it and leaves no timer behind.
const replay = realtime.openRealtimeReplay({ source: "shioaji", code: "2330", tradingDate: "2026-09-28" });
const large = realtime.queryRealtimeLargeOrders(spec, { fromMinute: 540, toMinute: 600 });
realtime.stopRealtimeStream("test_stop");
const afterStop = [];
realtime.subscribeRealtimeSession((session) => afterStop.push(session))();
assert.deepEqual(afterStop, [], "a stopped connection's session is not handed out");
assert.deepEqual(await replay, { ok: false, error: "STOPPED" });
assert.deepEqual(await large, { ok: false, reason: "STOPPED", rows: [] });

console.log("renderer delta batch transport contract passed");
