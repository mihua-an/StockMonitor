// 個股走勢's 期貨 overlay is TXF's DAY partition of the stock's own trading date, whatever 期貨走勢 tab is shown.
// 10-27: the 期貨走勢 panel was on 夜盤 (the night of 10-22, 15:00 -> 01:38 the next morning) and the overlay drew that
// night, which never overlaps a stock's 09:00-13:30: the overlay stayed empty while TXF's 10-27 DAY had 200 minutes.
// Driven through the real page modules over the live socket (support/realtime_page_harness.mjs).
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, items: [] }), { status: 200, headers: { "content-type": "application/json" } });

// The session authority on 10-27 (Market Runtime session.current): 10-23 a typhoon, 10-26 a holiday, so 夜盤 is 10-22's.
const displayContext = {
  equity: { trading_date: "2026-10-27", live: true },
  taiex: { trading_date: "2026-10-27", live: true },
  futures: {
    DAY: { trading_date: "2026-10-27", display_date: "2026-10-27", session: "DAY", live: true,
      window_start: "2026-10-27T08:45:00+08:00", window_end: "2026-10-27T13:45:00+08:00",
      partitions: [{ trading_date: "2026-10-27", session: "DAY" }] },
    NIGHT: { trading_date: "2026-10-27", display_date: "2026-10-22", session: "NIGHT", live: false,
      window_start: "2026-10-22T15:00:00+08:00", window_end: "2026-10-23T05:00:00+08:00",
      partitions: [{ trading_date: "2026-10-22", session: "NIGHT" }] },
    FULL: { trading_date: "2026-10-27", display_date: "2026-10-27", session: "FULL", live: true,
      window_start: "2026-10-22T15:00:00+08:00", window_end: "2026-10-27T13:45:00+08:00",
      partitions: [{ trading_date: "2026-10-22", session: "NIGHT" }, { trading_date: "2026-10-27", session: "DAY" }] },
  },
};
const page = await startRealtimePage({ displayContext });
page.sessionState.commitTxfDisplayContext(displayContext, "STATUS");
page.sessionState.setActiveTxfSession("night");
const { buildTrendOverlaySeries, ensureTrendOverlayData } = await import("../ui/renderer/js/features/realtime/live_view_models.js");

const point = (date, clock, price) => ({ minute: Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), time: clock,
  timestamp: `${date}T${clock}:00+08:00`, price, close: price });
const night = { trading_date: "2026-10-22", session: "NIGHT" };
const day = { trading_date: "2026-10-27", session: "DAY" };
const txf = (part) => ({ market: "FUT", code: "TXFR1", ...part, channels: ["summary", "trend"] });

await ensureTrendOverlayData("futures");
page.acceptPending();
const subscribed = page.socket.sentOfType("view.subscribe").map(({ payload }) => `${payload.code}@${payload.trading_date}:${payload.session}`);
assert.ok(subscribed.includes("TXFR1@2026-10-27:DAY"), `the overlay declares TXF's DAY of the stock's date, whatever tab is shown: ${subscribed}`);
assert.ok(subscribed.includes("TXFR1@2026-10-22:NIGHT"), "the 夜盤 tab keeps its own view");

page.serve(txf(night), { summary: { open: 46270 }, trend: [point("2026-10-22", "15:00", 46270), point("2026-10-22", "23:00", 46000)] });
page.serve(txf(day), { summary: { open: 46505, reference_price: 46400 }, trend: [point("2026-10-27", "09:00", 46505), point("2026-10-27", "09:01", 46600), point("2026-10-27", "09:02", 46700)] });

const stock = { points: [point("2026-10-27", "09:00", 100), point("2026-10-27", "09:01", 101)], openPrice: 100, prevClose: 99 };
const series = buildTrendOverlaySeries({ kind: "futures", variant: "stock", frame: stock });
assert.ok(series, "the overlay is drawn while 期貨走勢 shows 夜盤");
assert.deepEqual(series.points.map((p) => p.minute), [0, 1, 2], "TXF's 09:00-09:02 of 10-27 on the stock's axis");
assert.ok(Math.abs(series.points[2].price - 99 * 46700 / 46400) < 1e-9, "projected from TXF's DAY 參考價 onto the stock's 昨收");
console.log("txf benchmark overlay contract passed");
