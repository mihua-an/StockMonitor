import assert from "node:assert/strict";
import { startHistoryPage } from "./support/history_page_harness.mjs";

// Switching the history date A -> B while A's TAIEX / TXF / event requests were still in flight let
// A's replies land in the shared historyState, so date B showed A's market, futures and events.
// Driven through the real page modules: each request is answered when the test releases it.
const pending = [];
const dateOf = (url) => url.match(/date=([0-9-]+)/)?.[1] || "";
const answer = (url) => {
  const date = dateOf(url);
  if (url.includes("/api/monitor/events")) {
    // A Rust B rule record (the only event producer the feed accepts).
    return { ok: true, events: [{ event_id: `e-${date}`, event_origin: "analysis_runtime", trigger_minute: 540, code: "2330",
      event_type: "large_order", time: "09:00:00", timestamp: `${date}T09:00:00+08:00`, message: date }] };
  }
  return { ok: true, date, points: [{ time: "09:00:00", price: 1 }] };
};
const page = await startHistoryPage({ date: "2026-09-30", route: (url) => new Promise((resolve) => pending.push(() => resolve(answer(url)))) });
const { historyState } = await import("../ui/renderer/js/features/history/history_state.js");
const { loadHistoryMarketSession, loadHistoryTxfSession } = await import("../ui/renderer/js/features/history/market_session.js");
const { loadHistoryIntradayEvents } = await import("../ui/renderer/js/pages/history.js");
const select = page.element("historyDateSelect");
historyState.selectedDate = "2026-09-30";

// Date A's loads start and stall.
const loadsA = [loadHistoryIntradayEvents(), loadHistoryMarketSession("2026-09-30"), loadHistoryTxfSession("2026-09-30")];
await page.settle();
const stalled = pending.splice(0);
assert.equal(stalled.length, 3, "date A asked for its events, TAIEX and TXF");
// The user moves to B; B's loads complete first.
select.value = historyState.selectedDate = "2026-10-01";
const loadsB = [loadHistoryIntradayEvents(), loadHistoryMarketSession("2026-10-01"), loadHistoryTxfSession("2026-10-01")];
await page.settle();
for (const release of pending.splice(0)) release();
await Promise.all(loadsB);
// Now A's replies arrive late.
for (const release of stalled) release();
await Promise.all(loadsA);

assert.equal(historyState.marketSession.date, "2026-10-01");
assert.equal(historyState.marketDate, "2026-10-01");
assert.equal(historyState.txfSession.date, "2026-10-01");
assert.equal(historyState.txfDate, "2026-10-01");
assert.deepEqual(historyState.intradayEvents.map((event) => event.event_id), ["e-2026-10-01"]);
console.log("renderer history date-switch fencing contract ok");
