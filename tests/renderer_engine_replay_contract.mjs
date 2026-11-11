import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { historySource } from "./lib/history_sources.mjs";

// The module imports the realtime client, which expects a browser. Stub just enough to load it.
globalThis.window = globalThis.window || { desktopAPI: null, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
const { taipeiTimeToNs, nsToTaipeiClock, REPLAY_SPEEDS } = await import("../ui/renderer/js/features/history/engine_replay.js");
const { modelPredictionMetrics } = await import("../ui/renderer/js/core/model_predictions.js");

// 09:31:05 Asia/Taipei on 2026-09-29 is 01:31:05 UTC: exact nanoseconds, as a string (beyond Number precision).
assert.equal(taipeiTimeToNs("2026-09-29", "09:31:05"), String(BigInt(Date.UTC(2026, 8, 29, 1, 31, 5)) * 1_000_000n));
assert.equal(taipeiTimeToNs("2026-09-29", "09:31:05.250"), String(BigInt(Date.UTC(2026, 8, 29, 1, 31, 5)) * 1_000_000n + 250_000_000n));
assert.equal(taipeiTimeToNs("2026-09-29", "2026-09-29T13:30:00"), String(BigInt(Date.UTC(2026, 8, 29, 5, 30, 0)) * 1_000_000n));
assert.equal(taipeiTimeToNs("", "09:00:00"), null);
assert.equal(nsToTaipeiClock(taipeiTimeToNs("2026-09-29", "13:24:59")), "13:24:59");
assert.equal(nsToTaipeiClock("not-a-number"), "");
assert.deepEqual([...REPLAY_SPEEDS], [1, 2, 5, 10], "the speeds Market Runtime accepts");

// 買賣報價's 逐價內外盤 in a replay is drawn from the replay view's price_volume, as on the live page.
{
  const { EngineReplay } = await import("../ui/renderer/js/features/history/engine_replay.js");
  const engine = new EngineReplay();
  engine.code = "2303";
  engine.replayId = "replay-1";
  engine.spec = { source: "shioaji", market: "STK", code: "2303", trading_date: "2026-10-29", session: "DAY", replay_id: "replay-1" };
  engine.state = () => ({
    summary: { current: 116, prev_close: 128 },
    orderbook: { bid_price: [115.5], bid_volume: [37509], ask_price: [116], ask_volume: [2837] },
    price_volume: { buckets: [{ price: 116, out: 1200, in: 300 }, { price: 115.5, out: 200, in: 900 }], current_price: 116 },
  });
  const book = engine.orderbookViewModel({ displayName: "聯電" });
  assert.deepEqual(book.priceVolumeRows.map((row) => [row.price, row.out, row.in]), [[115.5, 200, 900], [116, 1200, 300]],
    "the book's 逐價內外盤 rows are the replay's price_volume buckets");
  engine.dispose();
}

// Market Runtime's replay is the history page's only source: the time bar, ◀ ▶, 播放 and every panel read it. There is
// no second (summary) playback and no day-long preview or book download from FastAPI.
const page = historySource();   // pages/history.js and the modules split out of it
assert.match(page, /import \{[^}]*\bEngineReplay\b[^}]*\} from "\.\.?\/(features\/history\/)?engine_replay\.js"/);
assert.match(page, /function startHistoryPlayback\(\) \{\s*void runUiTask\("HISTORY_ENGINE_REPLAY_START", \(\) => startHistoryEngineReplay\(\)\);\s*\}/);
for (const gone of [/startSummaryHistoryPlayback/, /\/api\/history\/session/, /\/api\/history\/orderbook-session/, /\/api\/history\/snapshot/,
  /historyState\.session\b/, /renderHistoryDragPreview/, /selectHistoryIndex/]) {
  assert.doesNotMatch(page, gone, `no summary path: ${gone}`);
}
// The bar seeks the replay on every input (pausing it), « ‹ › » move it 30 / 5 seconds (a seek held inside the bar),
// another date ends it.
assert.match(page, /range\?\.addEventListener\("input", \(\) => \{\s*pauseHistoryEngineReplay\(\);[\s\S]*?seekHistoryEngine\(second\);/);
assert.match(page, /\(Number\(range\.value\) \|\| 0\) \+ Number\(button\.dataset\.historyShift\)\)\);\s*showHistoryTimelinePosition\(second\);\s*seekHistoryEngine\(second\);/);
const pageHtml = readFileSync(new URL("../ui/renderer/pages/history.html", import.meta.url), "utf8");
assert.deepEqual([...pageHtml.matchAll(/data-history-shift="(-?\d+)"/g)].map((m) => Number(m[1])), [-30, -5, 5, 30],
  "« ‹ 播放 › »: 30 and 5 seconds back, 5 and 30 forward");
assert.doesNotMatch(page, /stepHistoryEngine/, "no step-by-print path left");
assert.match(page, /dateSelect\?\.addEventListener\("change", \(\) => \{\s*endHistoryEngineReplay\(\);/);
assert.doesNotMatch(page, /trade_flow_replay|price_volume_replay/, "no flow / 價量 computed outside Market Runtime's replay");
for (const [id, model] of [["orderbook", "buildReplayOrderbookViewModel"], ["tradeFlow", "buildReplayTradeFlowViewModel"],
  ["priceFlow", "buildReplayPriceFlowViewModel"], ["trendChart", "buildReplayTrendViewModel"], ["tickDetails", "buildReplayTickDetailsViewModel"]]) {
  assert.match(page, new RegExp(`setResolver\\("${id}", ${model}\\)`), `${id} reads the replay`);
}
// A snapshot redraws every replay panel; a delta only the panels drawing its channels (events -> 事件).
assert.match(page, /const REPLAY_PANELS = \["trendChart", "orderbook", "tickDetails", "priceFlow", "tradeFlow", "eventFeed"\];/);
assert.match(page, /events: \["eventFeed"\]/);
assert.match(page, /trades: \["tickDetails"\]/);
// The tape's 大單 badges are the tradeflow's large prints, which Rust B publishes after the prints: a paused replay
// redrew the tape only on trades, so the badges never appeared.
assert.match(page, /tradeflow: \["tradeFlow", "tickDetails"\]/);
assert.match(page, /const redraw = new Set\(all \? REPLAY_PANELS : \[\.\.\.channels\]\.flatMap\(\(channel\) => PANELS_BY_CHANNEL\[channel\] \|\| \[\]\)\);/);
assert.match(page, /function replayEventRows\(\) \{[\s\S]*?const events = live\.state\(\)\?\.events;[\s\S]*?normalizeHistoryEvents\(events/);
const html = readFileSync(new URL("../ui/renderer/pages/history.html", import.meta.url), "utf8");
for (const speed of [1, 2, 5, 10]) assert.match(html, new RegExp(`data-history-speed="${speed}"`));

// The realtime client carries the replay commands and keeps a replay view apart from the live view of the stock.
const store = await import("../ui/renderer/js/market_data/realtime_view_store.js");
const live = { source: "shioaji", market: "STK", code: "2330", trading_date: "2026-09-29", session: "DAY" };
assert.notEqual(store.realtimeViewSpecKey(live), store.realtimeViewSpecKey({ ...live, replay_id: "replay-1-1" }));
const client = readFileSync(new URL("../ui/renderer/js/market_data/realtime.js", import.meta.url), "utf8");
for (const command of ["replay.open", "replay.control", "replay.close"]) assert.match(client, new RegExp(`"${command}"`));
// The replay's predictions are read by the live page's one mapper: OK carries the number, others "--" with the reason.
const { metrics, notes } = modelPredictionMetrics({ model_predictions: {
  "3m_up": { status: "OK", probability: 0.62, test_only: true }, "3m_down": { status: "FAILED", probability: null, reason: "no model" },
  "5m_up": { status: "DISABLED" }, junk: { status: "OK", probability: 1 } } });
assert.deepEqual(metrics, { up3m: 0.62, down3m: null });
assert.equal(notes.up3m.testOnly, true);
assert.equal(notes.down3m.reason, "no model");
assert.deepEqual(modelPredictionMetrics(null), { metrics: {}, notes: {} });
// A reply lands only on the replay it was for. (No socket here: every request answers DISCONNECTED.)
{
  const { EngineReplay } = await import("../ui/renderer/js/features/history/engine_replay.js");
  const engine = new EngineReplay();
  engine.replayId = "replay-a";
  const reply = engine.control("play");
  engine.replayId = "replay-b";          // another product's replay took over before the reply arrived
  assert.deepEqual(await reply, { ok: false, error: "SUPERSEDED", replay_id: "replay-a" });
  engine.replayId = null;
  // A close issued while an open is in flight supersedes it.
  const opening = engine.open({ code: "2330", tradingDate: "2026-09-29", clock: "09:30:00" });
  void engine.close();
  assert.equal((await opening).error, "SUPERSEDED");
  assert.equal(engine.active, false);
  // A command that throws settles as a reply (recorded), never an unhandled rejection; dispose() can be awaited.
  const failed = await engine.command("close", "replay-x", () => { throw new Error("socket gone"); });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "FAILED");
  assert.equal((await engine.dispose())?.ok ?? true, true);
}

// A refusal names why on every panel; dragging the bar sends one seek at a time and only the newest target waits
// behind it (the seconds passed over are never sent).
{
  const { isPermanentReplayOpenError } = await import("../ui/renderer/js/features/history/engine_replay.js");
  assert.equal(isPermanentReplayOpenError("NOT_AVAILABLE"), true);
  assert.equal(isPermanentReplayOpenError("OLD_FORMAT"), true);
  for (const transient of ["TIMEOUT", "DISCONNECTED", "REPLAY_BUSY", "SUPERSEDED", "FAILED"]) assert.equal(isPermanentReplayOpenError(transient), false, transient);
  const { historyPage, historyState, historyHooks } = await import("../ui/renderer/js/features/history/history_state.js");
  const { openHistoryEngine, seekHistoryEngine } = await import("../ui/renderer/js/features/history/engine_controller.js");
  for (const hook of ["invalidateReplayComponents", "updateHistoryTimeLabel", "updatePlayButton"]) historyHooks[hook] = () => {};
  Object.assign(historyState, { selectedCode: "2330", selectedDate: "2026-09-29" });
  historyPage.engine = { active: false, open: async () => ({ ok: false, error: "NOT_AVAILABLE" }) };
  assert.equal(await openHistoryEngine("09:30:00"), false);
  assert.equal(historyState.replayUnavailable, "這一天沒有這檔商品的回放資料");

  const sent = [];
  let release = null;
  const { EngineReplay } = await import("../ui/renderer/js/features/history/engine_replay.js");
  historyPage.engine = { active: true, code: "2330", spec: { trading_date: "2026-09-29" },
    requestSeek: EngineReplay.prototype.requestSeek, drainSeeks: EngineReplay.prototype.drainSeeks,
    seek: (atNs) => { sent.push(nsToTaipeiClock(atNs)); return new Promise((resolve) => { release = resolve; }); } };
  for (const second of [34_200, 34_201, 34_202, 34_203]) seekHistoryEngine(second);   // 09:30:00 .. 09:30:03 within one frame
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ["09:30:00"], "one seek in flight");
  release({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ["09:30:00", "09:30:03"], "then only the newest target");
  release({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(historyPage.engine.seeking, false, "the queue is idle again");
  historyPage.engine = null;
  historyState.replayUnavailable = "";
}
console.log("renderer engine replay contract passed");
