import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeUnrealizedPnl, markPriceFromSummary, withUnrealizedPnl, createPositionMarkTracker }
  from "../ui/renderer/js/features/account/live_position_marks.js";
import { unrealizedRows } from "../ui/renderer/js/features/realtime/components/paper_ledger_component.js";

// 庫存's 未實現損益 is computed on the screen from Market Runtime's price over the WS; the
// account API serves the ledger rows only and does not read A once per holding.

// The ledger's closing terms (AccountingCore.closing_terms, 台股 at 2.8 折, an ordinary stock sell).
const stock = { amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: "0.003", tax_rounding: "floor" };

// Pure computation: a missing price, cost or terms is unavailable, never 0 and never a gross figure.
assert.deepEqual(computeUnrealizedPnl({ costAmount: 200080, qty: 2000, markPrice: null, closingTerms: stock }),
  { mark_price: null, mark_price_available: false, unrealized_pnl: null, unrealized_pnl_pct: null });
assert.equal(computeUnrealizedPnl({ costAmount: 200080, qty: 2000, markPrice: 110, closingTerms: null }).unrealized_pnl, null);
// Net of the sell (user 11-02): 220,000 - fee 88 - tax 660 = 219,252 against 200,080 paid.
const up = computeUnrealizedPnl({ costAmount: 200080, qty: 2000, markPrice: 110, closingTerms: stock });
assert.equal(up.unrealized_pnl, 19172);
assert.equal(up.unrealized_pnl_pct, (19172 / 200080) * 100);
// A short: what the sell brought in (cost_amount) against buying back with the fee.
assert.equal(computeUnrealizedPnl({ costAmount: 489830, qty: -1000, markPrice: 480, closingTerms: stock }).unrealized_pnl, 9638);
assert.equal(computeUnrealizedPnl({ costAmount: 100, qty: 1, markPrice: 0, closingTerms: stock }).mark_price_available, false, "0 is no price");
assert.equal(markPriceFromSummary({ last_price: 0, current: 51.2 }), 51.2);
assert.equal(markPriceFromSummary({}), null);

const rows = withUnrealizedPnl([
  { market: "台股", code: "2330", qty: 1000, avg_cost: 500.2, cost_amount: 500200, closing_terms: stock },
  { market: "美股", code: "TSM", qty: 10, avg_cost: 100, cost_amount: 1000, closing_terms: stock },
], (code) => (code === "2330" ? 520 : null));
// 520,000 - fee 208 - tax 1,560 - 500,200.
assert.equal(rows[0].unrealized_pnl, 18032);
assert.equal(rows[0].mark_price_source, "market_runtime");
assert.equal(rows[1].mark_price_source, "UNSUPPORTED_MARKET");
assert.equal(rows[1].mark_price_available, false);

// One holding, one price: 帳務 庫存 (withUnrealizedPnl over the dashboard rows) and 即時報價's 模擬帳務 (unrealizedRows
// over the paper holdings) show the same 未實現 -- the 帳務 page once showed the gross (price - avg) x qty.
{
  const ledgerRow = { market: "台股", code: "2603", qty: 3000, avg_cost: 198.58, cost_amount: 595740, closing_terms: stock };
  const holdingItem = { code: "2603", position_qty: 3000, avg_cost: 198.58, cost_amount: 595740, closing_terms: stock };
  const accountPnl = withUnrealizedPnl([ledgerRow], () => 205.5)[0].unrealized_pnl;
  const realtimePnl = unrealizedRows([holdingItem], () => 205.5).rows[0].pnl;
  assert.equal(accountPnl, realtimePnl);
  assert.equal(accountPnl, 616500 - 246 - 1849 - 595740);
}

// The tracker: one summary view per Taiwan holding on A's trading date; a price move repaints; a sold holding's view
// is released; a rollover drops every view and resubscribes on the new day.
const views = [];
let changes = 0;
let pushSession, sessionReleased = 0;
const tracker = createPositionMarkTracker({
  subscribeView: (spec, callback) => { const view = { spec, callback, released: 0 }; views.push(view); return () => { view.released += 1; }; },
  subscribeSession: (callback) => { pushSession = callback; return () => { sessionReleased += 1; }; },
  onChange: () => { changes += 1; },
  schedule: (fn) => fn(),
});
tracker.sync([{ market: "台股", code: "2330", qty: 1000 }]);
assert.equal(views.length, 0, "no session pushed yet: nothing subscribed");
pushSession({ equity: { trading_date: "2026-10-05" } });
assert.equal(views.length, 1, "the pushed session subscribes the holdings it was given");
changes = 0;
tracker.sync([{ market: "台股", code: "2330", qty: 1000 }, { market: "台股", code: "2317", qty: 2000 }, { market: "美股", code: "TSM", qty: 1 }]);
assert.deepEqual(views.map((v) => [v.spec.code, v.spec.trading_date, v.spec.channels.join()]),
  [["2330", "2026-10-05", "summary"], ["2317", "2026-10-05", "summary"]]);
views[0].callback({ type: "snapshot", state: { summary: { current: 520 } } });
assert.equal(tracker.mark("2330"), 520);
assert.equal(changes, 1);
views[0].callback({ type: "batch", deltas: [{ delta_type: "trade.frame", payload: { summary: { last_price: 521 } } }] });
assert.equal(tracker.mark("2330"), 521);
assert.equal(changes, 2);
views[0].callback({ type: "delta", delta: { delta_type: "summary.updated", payload: { last_price: 521 } } });
assert.equal(changes, 2, "an unchanged price repaints nothing");
// A view error: the held price is not current any more ("-"), and the snapshot after it brings the price back.
{
  const quiet = console.warn;
  console.warn = () => {};
  try { views[0].callback({ type: "error", error: "view refused" }); } finally { console.warn = quiet; }
  assert.equal(tracker.mark("2330"), null, "an error leaves no stale price");
  assert.equal(changes, 3, "the error repaints the holding");
  views[0].callback({ type: "gap", expected_sequence: 4, received_sequence: 6 });
  assert.equal(changes, 3, "a gap (the store's resync) changes nothing");
  views[0].callback({ type: "snapshot", state: { summary: { current: 521 } } });
  assert.equal(tracker.mark("2330"), 521, "the snapshot after the error restores the price");
  assert.equal(changes, 4);
}
tracker.sync([{ market: "台股", code: "2330", qty: 1000 }]);
assert.equal(views[1].released, 1, "a holding that left releases its view");
pushSession({ equity: { trading_date: "2026-10-06" } });
views[0].callback({ type: "snapshot", state: { summary: { current: 999 } } });
assert.equal(tracker.mark("2330"), null, "a callback of the previous day's view is dropped");
assert.equal(views.at(-1).spec.trading_date, "2026-10-06", "a rollover's session resubscribes on the new trading day");
const before = views.length;
pushSession({ equity: { trading_date: "2026-10-06" } });
assert.equal(views.length, before, "the same day (a reconnect's session) keeps the views");
tracker.dispose();
assert.equal(views.at(-1).released, 1);
assert.equal(sessionReleased, 1);

// The account API wiring is gone: no per-holding Market Runtime read in FastAPI.
const api = readFileSync(new URL("../api/services/actual_account_api.py", import.meta.url), "utf8");
assert.doesNotMatch(api, /RustViewClient|get_snapshot|quote_lookup/);
console.log("renderer account live marks contract ok");
