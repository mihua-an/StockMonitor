import assert from "node:assert/strict";
import fs from "node:fs";
import { realtimePageSource } from "./lib/realtime_sources.mjs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

// Invariant under test (unchanged): selecting a stock, recovering from a daemon reconnect, or
// starting the renderer must never leave 個股走勢 blank waiting for the next tick -- the
// already-known timeline has to be restored immediately.
//
// The MECHANISM changed. This contract used to pin a REST durable-trend fetch
// (`if (!getRealtimeTrendPoints(code).length) { void refreshRealtimeTrendChart(code) }`) inside
// realtime.js's selection block. M8/M9 made Market Runtime the source of that timeline: a
// canonical view snapshot already carries `trend`, so selection/reconnect/startup each
// (re)subscribe the canonical view and the snapshot handler merges the trend it brings.
// There is no REST loader (`refreshRealtimeTrendChart`, /api/intraday-chart):
// the canonical view is the only source of the stock trend. Driven through the real page over the live socket.

// Market Runtime's session.current names the trading date; the status read (/api/status) only availability; the
// selected product's 成交明細 page count reads an empty page. Nothing else is fetched -- in particular no trend.
const statusReads = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  statusReads.push(String(url));
  if (String(url).includes("/api/trade-detail/page")) return json({ ok: true, rows: [], page: 1, total_pages: 1, total_rows: 0, snapshot_watermark: 0 });
  if (!String(url).includes("/api/status")) throw new Error(`unexpected fetch ${url}`);
  return json({});
};
const page = await startRealtimePage({ displayContext: {} });
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
const { bindProductSelectionExtras } = await import("../ui/renderer/js/features/realtime/selection_controller.js");
const { startRealtimeSessionSync } = await import("../ui/renderer/js/features/realtime/session_controller.js");
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
registerLiveViewModelResolvers();
const invalidations = [];
const invalidateAll = realtimeContext.dataSource.invalidateAll.bind(realtimeContext.dataSource);
realtimeContext.dataSource.invalidateAll = (request) => { invalidations.push(request?.reason || ""); return invalidateAll(request); };

// 1. The session authority arriving is a prerequisite change: the canonical view owner binds what it names, and every
//    panel redraws once (SESSION_AUTHORITY). A daemon recovery needs no forced re-subscribe.
page.showProducts(["2330"]);
assert.deepEqual(page.subscribedCodes(), [], "no session authority yet: nothing is subscribable");
startRealtimeSessionSync();
page.socket.frame({ type: "session.current", payload: { equity: { trading_date: "2026-10-27", phase: "LIVE", live: true }, futures: {} } });
await page.live.settle(() => page.subscribedCodes().includes("2330"));
assert.ok(page.subscribedCodes().includes("2330"), "the session authority re-declares the canonical views");
assert.ok(invalidations.includes("SESSION_AUTHORITY"));

// 2. Selecting a product (the product list's fan-out, LiveSelectedSymbolStore) re-points the canonical view at the
//    newly selected code -- the detail target is a declared view -- so its snapshot arrives without waiting for a tick.
bindProductSelectionExtras();
realtimeContext.symbolStore.setSelectedSymbol("2603");
assert.ok(page.subscribedCodes().includes("2603"), "switching product must re-point the canonical view at the new code");

// 3. The trend is the view's: 個股走勢 draws the snapshot's own trend at once, no page cache merged from snapshots.
const trend = [
  { minute_timestamp: "2026-10-27T09:00:00+08:00", timestamp: "2026-10-27T09:00:00+08:00", price: 100, close: 100, volume: 5 },
  { minute_timestamp: "2026-10-27T09:01:00+08:00", timestamp: "2026-10-27T09:01:00+08:00", price: 101, close: 101, volume: 3 },
];
page.serve(page.stockSpec("2603"), { summary: { current: 101, prev_close: 99 }, trend });
assert.deepEqual(realtimeContext.dataSource.resolve("stockTrend", {}).points.map((point) => point.price), [100, 101],
  "個股走勢 draws the canonical view's trend");

// 4. And no REST trend loader or page trend cache comes back next to it.
const realtime = realtimePageSource();
assert.doesNotMatch(realtime, /setRealtimeTrendPoints|getRealtimeTrendPoints/, "no page trend cache");
assert.ok(!fs.existsSync(new URL("../ui/renderer/js/pages/monitor.js", import.meta.url)), "pages/monitor.js was retired");
assert.doesNotMatch(realtime, /\/api\/intraday-chart|refreshRealtimeTrendChart/,
  "the stock trend must not be fetched over REST again");

console.log("stock trend restart/switch durable restore contract passed");
