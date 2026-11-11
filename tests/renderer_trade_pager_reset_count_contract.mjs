// Switching the selected stock by any path resets the trade pager; the reset itself asks for the new stock's page
// count (a product-list click reset the pager without opening page 1, and the count stayed 1).
import assert from "node:assert/strict";
import { createLiveTradePager } from "../ui/renderer/js/market_data/live_trade_pager.js";

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const pending = [];
let redraws = 0;
let query = { target: "4958", market: "STK", session: "DAY", tradingDate: "2026-10-16", actualContract: "4958", requestIdentityKey: "STK|4958|2026-10-16|DAY|4958" };
const pager = createLiveTradePager({
  apiGet: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve })),
  getQuery: () => query, getEquityDate: () => query.tradingDate, futuresIdentityMatches: () => true, invalidateDetails: () => { redraws += 1; },
});
pager.reset("4958");
await Promise.resolve();
assert.equal(pending.length, 1, "the reset asked once");
const params = new URL(pending[0].url, "http://offline").searchParams;
assert.equal(params.get("metadata_only"), "true");
assert.equal(params.get("logical_code"), "4958");
assert.equal(params.get("trading_date"), "2026-10-16");
pending[0].resolve({ ok: true, page: 1, total_rows: 8865, total_pages: 89, snapshot_watermark: 8865, rows: [] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pager.state.totalPages, 89);
// A reset to another stock that the caller then abandons asks nothing for the old one.
pager.reset("2330");
query = { ...query, target: "2327" };
pager.reset("2327");
await Promise.resolve();
assert.deepEqual(pending.slice(1).map((r) => new URL(r.url, "http://offline").searchParams.get("logical_code")), ["2327"]);
// At startup the reset's count read is still in flight when page 1 opens (a new page generation): the count still
// lands -- dropping it marked the stock as counted and left 1 / 1 for good.
pending.length = 0;
query = { ...query, target: "2327", actualContract: "2327", requestIdentityKey: "STK|2327|2026-10-16|DAY|2327" };
pager.reset("2327");
await Promise.resolve();
assert.equal(pending.length, 1, "the reset asked for the count");
await pager.load({ page: 1, latest: true });
assert.equal(pending.length, 1, "page 1 reuses the read in flight");
pending[0].resolve({ ok: true, page: 1, total_rows: 11076, total_pages: 111, snapshot_watermark: 11076, rows: [] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pager.state.totalPages, 111);
// The list is drawn before the count lands (a UI-only reopen: every service answers at once; after hours no trade
// follows to redraw it): the count's arrival redraws it, or the selector stays at 1 / 1. An unchanged count does not.
pending.length = 0;
pager.reset("2327");
await Promise.resolve();
redraws = 0;
pending[0].resolve({ ok: true, page: 1, total_rows: 11076, total_pages: 111, snapshot_watermark: 11076, rows: [] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(redraws, 1, "a count that changed the page bounds redraws the list");

// A count read the pager aborts itself (a reset while it is in flight, as at every window open) is dropped, not failed
// (10-19: each open logged "[TRADE PAGE COUNT] failed AbortError").
{
  const { tradePageTraceSnapshot } = await import("../ui/renderer/js/market_data/trade_detail/perf_trace.js");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const aborting = createLiveTradePager({
    apiGet: (_url, { signal } = {}) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("signal is aborted without reason", "AbortError")))),
    getQuery: () => query, getEquityDate: () => query.tradingDate, futuresIdentityMatches: () => true, invalidateDetails: () => {},
  });
  aborting.reset("2327");
  await Promise.resolve();
  aborting.reset("2327");
  await new Promise((resolve) => setImmediate(resolve));
  console.warn = originalWarn;
  const last = tradePageTraceSnapshot().filter((entry) => entry.kind === "page_count").at(-1);
  assert.equal(last.outcome, "dropped");
  assert.equal(last.reason, "pager_reset");
  assert.ok(!warnings.some((args) => args[1]?.outcome === "failed"), "no failed count read was logged");
}
console.log("renderer trade pager reset count contract passed");
