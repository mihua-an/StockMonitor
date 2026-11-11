// 期貨走勢 日盤 / 夜盤 after the close: a FUT partition is one business session (日盤 reads its DAY, 夜盤 its NIGHT),
// so Market Runtime's summary of that partition is the session's last price and its 漲跌. The tab shows them as sent;
// the renderer no longer takes the last trend point inside the window and subtracts the reference itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

const DAY = { trading_date: "2026-11-03", session: "day", live: false, actual_contract: "TXFL6",
  window_start: "2026-11-03T08:45:00+08:00", window_end: "2026-11-03T13:45:00+08:00",
  partitions: [{ trading_date: "2026-11-03", session: "DAY" }] };
const page = await startRealtimePage({ tradingDate: "2026-11-03", displayContext: {
  equity: { trading_date: "2026-11-03", live: false }, taiex: { trading_date: "2026-11-03", live: false }, futures: { DAY } } });
page.sessionState.setActiveTxfSession("day");
page.sessionState.commitTxfDisplayContext({ futures: { DAY } });
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
registerLiveViewModelResolvers();

// Market Runtime's summary of the closed DAY: 43376, -1851 against 45227. The trend's last point says another price
// (a later correction of the minute bar): the header is the summary's, not a renderer subtraction from the trend.
page.serve(page.sessionState.txfCanonicalViewSpec("day"), {
  summary: { current: 43376, reference_price: 45227, reference_source: "contract_info.reference", change: -1851,
    change_pct: -4.0927, open: 45100, high: 45300, low: 43200, session: "DAY", contract_code: "TXFL6" },
  trend: [{ timestamp: "2026-11-03T13:44:00+08:00", minute_timestamp: "2026-11-03T13:44:00+08:00", close: 43390, price: 43390, volume: 10 },
    { timestamp: "2026-11-03T13:45:00+08:00", minute_timestamp: "2026-11-03T13:45:00+08:00", close: 43000, price: 43000, volume: 5 }],
});
const vm = realtimeContext.dataSource.resolve("futuresTrend", {});
assert.equal(vm.session, "day");
assert.equal(vm.currentPrice, 43376, "the closed 日盤 shows Market Runtime's price of its partition");
assert.deepEqual([vm.metrics.change, vm.metrics.changePct], [-1851, -4.0927], "and Market Runtime's 漲跌, as sent");

const source = readFileSync(new URL("../ui/renderer/js/features/realtime/live_view_models.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /closedSessionChange|txfSessionClose/, "no closed-session price or change of the renderer's own");
console.log("renderer TXF closed session change contract passed");
