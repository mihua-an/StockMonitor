// Behavioral replacement for the live_trade_pager.js slice of
// test_frontend_display_authority.py::
//   test_async_bootstrap_paths_reject_stale_symbol_or_generation_results
//
// Invariant under test: an in-flight page request whose generation/intent
// has been superseded by a newer request for the same target must never be
// allowed to overwrite state with its (stale) response, even if it resolves
// *after* the newer request has already applied its own (fresher) result.
//
// This file deliberately does NOT assert against the literal
// `requestGeneration` field name or any other internal variable name: a
// planned follow-up migrates this staleness mechanism to the shared
// LatestIntentGate primitive (ui/renderer/js/market_data/latest_intent_gate.js).
// Only the observable
// outcome -- the stale response never lands -- is asserted, so this contract
// survives that migration regardless of whether it lands on a raw counter or
// LatestIntentGate.
//
// createLiveTradePager() is already a small dependency-injected factory with
// no DOM dependency of its own (only requestAnimationFrame/
// cancelAnimationFrame, polyfilled below), so it is imported and driven for
// real rather than text-matched.
import assert from "node:assert/strict";
import { createLiveTradePager } from "../ui/renderer/js/market_data/live_trade_pager.js";

globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));

const pending = [];
function mockApiGet(_url, _opts) {
  return new Promise((resolve) => { pending.push(resolve); });
}

const pager = createLiveTradePager({
  apiGet: mockApiGet,
  // A stock read names its day (the pager sends nothing without one).
  getQuery: () => ({ market: "STK", session: "DAY", tradingDate: "2026-11-11", actualContract: "", requestIdentityKey: "IDK", target: "2330" }),
  getEquityDate: () => "2026-11-11",
  futuresIdentityMatches: () => true,
  invalidateDetails() {}, applyBook() {}, applyTrend() {}, invalidateTrend() {},
});

function page(overrides = {}) {
  return { ok: true, page: 2, total_rows: 1, total_pages: 1, snapshot_watermark: 0, rows: [{ price: "1", volume: 1, ...overrides }] };
}

// Call A: the request that will end up stale.
const callA = pager.load({ page: 2 });
assert.equal(pending.length, 1, "the first page request must actually reach the network layer");

// Simulate the renderer independently advancing past call A's intent (e.g. a
// reconnect, selection refresh, or explicit resync) for the SAME target,
// before call A's response has come back.
pager.reset("2330");

// Call B: the newer, current request for the same target.
const callB = pager.load({ page: 2 });
assert.equal(pending.length, 2, "the second page request must also reach the network layer");

// Resolve the NEWER request first and let it apply.
pending[1](page({ trade_origin: "FRESH_RESULT" }));
await callB;
assert.equal(pager.state.rows.length, 1);
assert.equal(pager.state.rows[0].trade_origin, "FRESH_RESULT", "the fresh response must be applied");

// Now resolve the STALE request, arriving late. It must be discarded rather
// than clobbering the already-applied fresh result.
pending[0](page({ trade_origin: "STALE_RESULT" }));
await callA;

assert.equal(pager.state.rows.length, 1, "a late stale response must not add/replace rows");
assert.equal(pager.state.rows[0].trade_origin, "FRESH_RESULT",
  "a late stale response must never overwrite an already-applied fresher result");

console.log("live trade pager stale-result rejection contract passed");
