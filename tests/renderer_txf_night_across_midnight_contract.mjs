// FUT is stored per business session: a 夜盤 is ONE partition, dated by the day it opens, across
// midnight; 全日 reads two partitions -- the night before its day, and the day. The tab is composed on read from those
// partitions' views (txfDisplay): no page copy merged from their events. Driven through the real page: the session
// authority names each tab's partitions, the page subscribes their views over the live socket, and B's minutes
// (minutes.upsert) reach the view's trend through the real view store.
import assert from "node:assert/strict";
import { realtimePageSource } from "./lib/realtime_sources.mjs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";
import { txfSessionPartitions } from "../ui/renderer/js/features/realtime/txf_session_identity.js";

assert.doesNotMatch(realtimePageSource(), /txfTrendSnapshot\b|txfPoints\b|mergeTxfSecondaryState|CanonicalTxfMarketState/, "no TXF page copy");

const NIGHT = { session: "night", trading_date: "2026-10-01", display_date: "2026-09-30",
  window_start: "2026-09-30T15:00:00+08:00", window_end: "2026-10-01T05:00:00+08:00",
  partitions: [{ trading_date: "2026-09-30", session: "NIGHT" }] };
const DAY = { session: "day", trading_date: "2026-09-30", display_date: "2026-09-30",
  window_start: "2026-09-30T08:45:00+08:00", window_end: "2026-09-30T13:45:00+08:00",
  partitions: [{ trading_date: "2026-09-30", session: "DAY" }] };
const FULL = { session: "full", trading_date: "2026-10-01", display_date: "2026-09-30",
  window_start: "2026-09-30T15:00:00+08:00", window_end: "2026-10-01T13:45:00+08:00",
  partitions: [{ trading_date: "2026-09-30", session: "NIGHT" }, { trading_date: "2026-10-01", session: "DAY" }] };

const page = await startRealtimePage({ displayContext: { equity: { trading_date: "2026-09-30" },
  futures: { NIGHT, DAY, FULL } } });
const { txfViewSpecs, setActiveTxfSession } = page.sessionState;
const { txfDisplay } = page.owner;
// The tab `session` showing, its partitions' views holding `states` ("date:SESSION" -> view state).
function showTab(session, states = new Map()) {
  setActiveTxfSession(session);
  for (const spec of txfViewSpecs(session)) {
    const state = states.get(`${spec.trading_date}:${spec.session}`);
    if (state) page.serve(spec, state);
  }
  return { txfDisplay: () => txfDisplay(session), txfViewSpecs: () => txfViewSpecs(session) };
}

const point = (date, hhmm, price) => ({ timestamp: `${date}T${hhmm}:00+08:00`, minute_timestamp: `${date}T${hhmm}:00+08:00`, price, close: price, volume: 1 });

// 1. Each tab's partitions: a night is one partition dated by its open; 全日 is that night and its day.
{
  assert.deepEqual(txfSessionPartitions(NIGHT), [{ trading_date: "2026-09-30", session: "NIGHT" }]);
  assert.deepEqual(txfSessionPartitions(DAY), [{ trading_date: "2026-09-30", session: "DAY" }]);
  assert.deepEqual(txfSessionPartitions(FULL), [{ trading_date: "2026-09-30", session: "NIGHT" }, { trading_date: "2026-10-01", session: "DAY" }]);
  // An identity without the owner's partitions reads nothing: the renderer never derives a night from dates.
  assert.deepEqual(txfSessionPartitions({ session: "night", trading_date: "2026-10-05" }), []);
  assert.deepEqual(showTab("full").txfViewSpecs().map((s) => `${s.trading_date}:${s.session}`),
    ["2026-10-01:DAY", "2026-09-30:NIGHT"], "全日 binds its day and reads the night before it too");
}

// 2. 全日: the night's minutes on both sides of midnight join the day's; the price is the partition that traded last.
{
  const views = new Map([
    ["2026-09-30:NIGHT", { summary: { current: 20020, price_exchange_ts_ns: "1790785800000000000", reference_price: 19990, reference_source: "TAIFEX" },
      trend: [point("2026-09-30", "15:00", 20000), point("2026-09-30", "23:59", 20010), point("2026-10-01", "00:30", 20020)] }],
    ["2026-10-01:DAY", { summary: { open: 20030 }, session_key: { trading_date: "2026-10-01", session: "DAY" }, trend: [] }],
  ]);
  const shown = showTab("full", views).txfDisplay();
  assert.equal(shown.points.length, 3, "the night's minutes on both sides of midnight join 全日");
  assert.equal(shown.current, 20020, "before the day trades, the price is the night's");
  assert.equal(shown.reference_price, 19990, "the reference is whichever partition carries one, with its source");
  assert.equal(shown.reference_source, "TAIFEX");
  // The day trades: its newer price wins; an older partition's price never replaces it.
  views.set("2026-10-01:DAY", { summary: { open: 20030, current: 20050, price_exchange_ts_ns: "1790816400000000000" },
    trend: [point("2026-10-01", "08:45", 20050)] });
  const later = showTab("full", views).txfDisplay();
  assert.equal(later.current, 20050);
  assert.equal(later.points.length, 4);
}

// 3. Points outside the tab's window never enter it.
{
  const views = new Map([["2026-09-30:NIGHT", { summary: {}, trend: [point("2026-10-01", "04:59", 1), point("2026-10-01", "08:45", 2)] }]]);
  assert.deepEqual(showTab("night", views).txfDisplay().points.map((p) => p.price), [1]);
}

// 4. B's minutes (minutes.upsert) reach the tab through the view store's reducer -- inside the window only.
{
  const tab = showTab("day", new Map([["2026-09-30:DAY", { summary: {}, trend: [] }]]));
  const [spec] = txfViewSpecs("day");
  page.delta(spec, "minutes.upsert",
    { points: [point("2026-09-30", "13:44", 48680), point("2026-09-30", "15:00", 48410)], current: point("2026-09-30", "13:45", 48685) });
  assert.deepEqual(tab.txfDisplay().points.map((p) => p.price), [48680, 48685],
    "B's minutes inside the 日盤 window join the series; the night's 15:00 does not");
}

// 5. The row under the chart (使用者 11-02): 全日 in the evening, its day not opened yet, still shows 開盤 / 最高 /
//    最低 -- the tab's own sessions, not its last partition only -- and 振幅 from them.
{
  const views = new Map([
    ["2026-09-30:NIGHT", { summary: { open: 20000, high: 20033, low: 19950, current: 20020, price_exchange_ts_ns: "1790785800000000000",
      reference_price: 20000, reference_source: "contract.reference" }, session_key: { trading_date: "2026-09-30", session: "NIGHT" },
      trend: [point("2026-09-30", "15:00", 20000), point("2026-09-30", "15:01", 20020)] }],
    ["2026-10-01:DAY", { summary: {}, session_key: { trading_date: "2026-10-01", session: "DAY" }, trend: [] }],
  ]);
  const evening = showTab("full", views).txfDisplay();
  assert.deepEqual([evening.open, evening.high, evening.low], [20000, 20033, 19950], "全日 before its day opens: the night's open / high / low");
  // The day trades: 開盤 stays the night's (it opened first), 最高 / 最低 span both sessions.
  views.set("2026-10-01:DAY", { summary: { open: 20040, high: 20090, low: 19990, current: 20050, price_exchange_ts_ns: "1790816400000000000" },
    session_key: { trading_date: "2026-10-01", session: "DAY" }, trend: [point("2026-10-01", "08:45", 20050)] });
  const both = showTab("full", views).txfDisplay();
  assert.deepEqual([both.open, both.high, both.low], [20000, 20090, 19950], "全日: the night's open, the extremes of both sessions");
  // 夜盤 alone is the night's own.
  const night = showTab("night", views).txfDisplay();
  assert.deepEqual([night.open, night.high, night.low], [20000, 20033, 19950]);
  // The view model the chart and its row read: 開盤 / 最高 / 最低 and 振幅 from the tab's own sessions.
  showTab("full", views);
  const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
  const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
  registerLiveViewModelResolvers();
  const { trendReadView } = await import("../ui/renderer/js/core/market_read_model.js");
  const vm = realtimeContext.dataSource.resolve("futuresTrend", {});
  const read = trendReadView(vm) || vm;
  assert.deepEqual([read.stockInfo.open, read.stockInfo.high, read.stockInfo.low], [20000, 20090, 19950], JSON.stringify(read.stockInfo));
  assert.ok(Math.abs(vm.metrics.amplitude - (20090 - 19950) / vm.referencePrice * 100) < 1e-9,
    `振幅 from the tab's range: ${vm.metrics.amplitude} (reference ${vm.referencePrice} ${vm.referenceSource})`);
}

console.log("renderer txf night across midnight contract ok (composed from the partitions' views)");
