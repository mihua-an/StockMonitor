import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { desktopAPI: { sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } }, dispatchEvent() {} };
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const { resolveDashboardLoadOutcome } = await import("../ui/renderer/js/pages/account.js");

// Characterizes the fix for: `GET /api/actual-account/dashboard` (or the
// paper-wallet equivalent) returning `{ok:false, error:"..."}` used to be
// handed straight to `renderDashboard()` with no `.ok` check, so a genuine
// read failure rendered as an indistinguishable empty ledger (positions:[],
// trades:[], etc., since the error body has none of those keys). This pins
// the decision function `refreshAccountPage` now uses to tell a real load
// failure apart from a legitimately empty ledger, before any DOM is touched.

// Failure path: explicit ok:false with a backend error message.
{
  const outcome = resolveDashboardLoadOutcome({ ok: false, error: "MONITOR_RUNTIME_NOT_READY" });
  assert.equal(outcome.accepted, false);
  assert.match(outcome.message, /MONITOR_RUNTIME_NOT_READY/);
}

// Failure path: ok:false with no error field (backend contract allows this).
{
  const outcome = resolveDashboardLoadOutcome({ ok: false });
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.message && outcome.message.length > 0, "must still produce a non-empty message");
}

// Failure path: ok:false alongside stray body fields (still a failure, not data).
{
  const outcome = resolveDashboardLoadOutcome({ ok: false, error: "boom", positions: [], trades: [] });
  assert.equal(outcome.accepted, false);
}

// Success path: a genuinely empty ledger is NOT a failure.
{
  const outcome = resolveDashboardLoadOutcome({ ok: true, positions: [], trades: [], summary: {} });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.message, "");
}

// Success path: a populated dashboard.
{
  const outcome = resolveDashboardLoadOutcome({ ok: true, positions: [{ code: "2330" }] });
  assert.equal(outcome.accepted, true);
}

// Backward-compatibility: a legacy/partial payload with no `ok` field at all
// must still be treated as data (never previously carried `ok`, and callers
// upstream already throw on a truly malformed/non-JSON body before this
// function ever runs) -- this function must only react to an explicit
// `ok === false`, not to `ok` being merely falsy/absent.
{
  const outcome = resolveDashboardLoadOutcome({ positions: [], trades: [] });
  assert.equal(outcome.accepted, true);
}

console.log("account dashboard load-error contract passed");
