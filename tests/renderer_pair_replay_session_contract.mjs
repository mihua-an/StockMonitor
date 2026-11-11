import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// 帳務 配對回放 replays the pair's day with Market Runtime's replay (使用者 11-02／11-03), a second at a time, and
// draws its own six cards from the replay's view (pair_replay_model.js). Driven through the REAL realtime client with a
// fake socket:
//   1. opening a pair asks Market Runtime for its day at the pair's entry -- no FastAPI bundle;
//   2. once opened, every frame is told and the cards' model reads the replay's view: the 走勢資訊 stock line as its
//      change from 昨收, the book, the tape, the K bars, the position at the replay time;
//   3. 播放, the speed and the bar are replay controls; a refusal is said;
//   4. closing it closes the replay.

const live = installRealtimeHarness();
// app_api's answer for the day's 加權 and 產業指數 (the stored day): the replay never reads FastAPI for the stock.
const apiReads = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input?.url || input), "http://app.invalid");
  apiReads.push(url.pathname + url.search);
  const body = url.pathname === "/api/history/pair-indexes"
    ? { ok: true, date: "2026-10-15", code: "2330",
      market: { code: "TAIEX", name: "加權", reason: "", points: [{ time: "09:05", price: 20200 }], prev_close: 20000 },
      industry: { code: "IX0010", name: "半導體類指數", reason: "", points: [{ time: "09:06", price: 990 }], prev_close: 1000 } }
    : { ok: false, error: `unexpected ${url.pathname}` };
  return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404, headers: { "Content-Type": "application/json" } });
};
const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.ready();

const { account } = await import("../ui/renderer/js/features/account/account_state.js");
const session = await import("../ui/renderer/js/features/account/pair_replay_session.js");
const { taipeiTimeToNs } = await import("../ui/renderer/js/features/history/engine_replay.js");
const model = await import("../ui/renderer/js/features/account/pair_replay_model.js");
const { actualAccountReplayState } = await import("../ui/renderer/js/features/account/account_state.js");
const statuses = [];
let frames = 0;
session.installPairReplayOrigin(() => {});
session.installPairReplayPresenter({ renderStatus: (status) => statuses.push(status), renderFrame: () => { frames += 1; } });
account.market = "台股";

const pair = {
  id: 7, realized_date: "2026-10-15", market: "台股", code: "2330", name: "台積電", trade_type: "當沖", direction: "多",
  qty: 1000, buy_price: 100, sell_price: 102, profit: 2000, buy_ref: "09:05:12", sell_ref: "09:20:40", entry_ref: "09:05:12",
  exit_ref: "09:20:40", fee: 0, tax: 0,
};
const lastOf = (type) => socket.sentOfType(type).at(-1);
const answer = (type, request, payload) => socket.frame({ type, request_id: request.request_id, payload });

// --- 1. the pair's day at its entry, from Market Runtime ---------------------------------------------------------
assert.equal(session.openPairReplay(pair, "pairs"), true);
await live.settle(() => socket.sentOfType("replay.open").length > 0);
const open = lastOf("replay.open");
assert.ok(open, "opening a pair opens Market Runtime's replay of its day");
assert.deepEqual({ code: open.payload.code, date: open.payload.trading_date, at: open.payload.at_ns },
  { code: "2330", date: "2026-10-15", at: taipeiTimeToNs("2026-10-15", "09:05:12") }, "at the pair's entry");
assert.equal(actualAccountReplayState.loadState, "loading", "before it opens the cards wait");
assert.deepEqual(session.pairReplayView(), {}, "no replay view yet");

const position = taipeiTimeToNs("2026-10-15", "09:10:00");
answer("replay.opened", open, { ok: true, replay_id: "replay-1-1",
  status: { replay_id: "replay-1-1", playing: false, position_ns: position, speed: 1, recording: { market_first_ns: taipeiTimeToNs("2026-10-15", "09:00:00"),
    market_last_ns: taipeiTimeToNs("2026-10-15", "13:30:00") } } });
await live.settle(() => socket.sentOfType("view.subscribe").some((message) => message.payload.replay_id === "replay-1-1"));
const subscribe = socket.sentOfType("view.subscribe").find((message) => message.payload.replay_id === "replay-1-1");
assert.ok(subscribe, "the replay's own view is subscribed");
assert.equal(statuses.at(-1)?.replay_id, "replay-1-1", "the play bar is told the replay's status");

// --- 2. the cards read the replay's view --------------------------------------------------------------------------
const stream = "replay|shioaji|STK|2330|2026-10-15|DAY";
socket.frame({ type: "view.subscription.accepted", payload: { request_id: subscribe.payload.request_id, subscription_id: "sub-r", stream_id: stream, watermark: 1 } });
socket.frame({ type: "view.snapshot", payload: { request_id: subscribe.payload.request_id, subscription_id: "sub-r", stream_id: stream,
  session_key: { source: "shioaji", market: "STK", logical_code: "2330", trading_date: "2026-10-15", session: "DAY" }, session_generation: 1,
  watermark: 1, sequence: 1, replay_id: "replay-1-1",
  summary: { current: 101, prev_close: 99, open: 100, high: 101.5, low: 99.5, change: 2, change_pct: 2.02 },
  trend: [{ minute: 545, time: "09:05", timestamp: "2026-10-15T09:05:00+08:00", price: 100, open: 99.5, high: 100, low: 99.5, close: 100, minute_volume: 3 },
    { minute: 550, time: "09:10", timestamp: "2026-10-15T09:10:00+08:00", price: 101, open: 100.5, high: 101, low: 100.5, close: 101, minute_volume: 6 }],
  orderbook: { bid_prices: [100.5], bid_volumes: [10], ask_prices: [101], ask_volumes: [5] },
  price_volume: { buckets: [{ price: 100, volume: 3, out: 1, in: 2 }, { price: 101, volume: 6, out: 6, in: 0 }] },
  trades: [{ durable_sequence: 11, exchange_ts_ns: String(taipeiTimeToNs("2026-10-15", "09:09:59")), price: 101, volume: 6, side: "BUY", tick_type: 1 }] } });
await live.settle(() => (session.pairReplayView().trend || []).length > 0);
assert.ok(frames > 0, "the cards are drawn when the replay's view changes");
await live.settle(() => actualAccountReplayState.indexes !== null);
assert.deepEqual(apiReads, ["/api/history/pair-indexes?date=2026-10-15&code=2330"], "only the day's indexes are read from app_api");
assert.deepEqual([actualAccountReplayState.indexes.market.points.length, actualAccountReplayState.indexes.industry.name,
  actualAccountReplayState.indexes.industry.prevClose], [1, "半導體類指數", 1000], "the stored 加權 and 產業指數");
assert.equal(actualAccountReplayState.loadState, "ready");
const view = session.pairReplayView();
const overlay = model.replayOverlayAt({ stockPoints: view.trend, stockPrevClose: 99, stockName: "2330 台積電",
  indexes: { market: { name: "加權", points: [{ time: "09:05", price: 20200 }], prevClose: 20000 },
    industry: { name: "半導體類指數", points: [], prevClose: null, note: "這天沒有存到半導體類指數的報價" } }, untilMinute: 10 });
const stockLine = overlay.lines.find((line) => line.key === "stock");
assert.ok(Math.abs(stockLine.pct[10] - (101 - 99) / 99 * 100) < 1e-9, "走勢資訊: the stock as its change from 昨收");
assert.equal(overlay.lines.find((line) => line.key === "market").pct[5], 1, "加權 on the same axis, from its own 昨收");
assert.equal(overlay.lines.find((line) => line.key === "industry").drawn, false, "an index without levels has no line");
const book = model.replayBook(view.orderbook, 101, 99);
assert.deepEqual([book.rows[0].bid.priceText, book.rows[0].ask.priceText, book.rows[0].ask.isLast], ["100.50", "101.00", true], "the replay's book");
const tape = model.replayTape(view.trades, 99, view.tradeflow);
assert.deepEqual(tape.map((row) => [row.price, row.change, row.volume]), [[101, 2, 6]], "the replay's prints with their change from 昨收");
const k = model.replayKBars(model.replayMinuteBars(view.trend), 5, 99);
assert.deepEqual(k.bars.map((bar) => [bar.minute, bar.open, bar.close, bar.volume]), [[5, 99.5, 100, 3], [10, 100.5, 101, 6]], "5 分 K from the replay's minutes");
assert.equal(model.replayPosition(pair, 9 * 3600 + 10 * 60, 101).state, "持有多單", "09:10 is inside the 09:05 - 09:20 holding");
assert.equal(model.replayPosition(pair, 9 * 3600 + 21 * 60, 101).pnl, 2000, "after the exit the pair's realized profit");

// --- 3. controls are replay controls ------------------------------------------------------------------------------
void session.playPairReplay();
await live.settle(() => socket.sentOfType("replay.control").some((message) => message.payload.action === "play"));
assert.equal(lastOf("replay.control").payload.action, "play");
session.setPairReplaySpeed(5);
await live.settle(() => lastOf("replay.control")?.payload.speed === 5);
assert.deepEqual([lastOf("replay.control").payload.action, lastOf("replay.control").payload.speed], ["speed", 5]);
session.seekPairReplay(9 * 3600 + 30 * 60);
await live.settle(() => lastOf("replay.control")?.payload.action === "seek");
assert.equal(lastOf("replay.control").payload.at_ns, String(BigInt(taipeiTimeToNs("2026-10-15", "09:30:00")) + 999_999_999n),
  "the bar seeks to the end of the second it shows");

// --- 4. closing it closes the replay --------------------------------------------------------------------------------
session.closePairReplay();
await live.settle(() => socket.sentOfType("replay.close").length > 0);
assert.equal(lastOf("replay.close").payload.replay_id, "replay-1-1");
assert.deepEqual(session.pairReplayView(), {}, "closed: no replay to read");

// A refusal is said (a busy replay elsewhere, a day not recorded).
const opens = socket.sentOfType("replay.open").length;
assert.equal(session.openPairReplay(pair, "pairs"), true);
await live.settle(() => socket.sentOfType("replay.open").length > opens);
const refused = lastOf("replay.open");
answer("replay.opened", refused, { ok: false, error: "NOT_AVAILABLE" });
await live.settle(() => actualAccountReplayState.loadState === "error");
assert.equal(actualAccountReplayState.loadError, "這一天沒有這檔商品的回放資料");
session.closePairReplay();

console.log("renderer pair replay session contract passed");
