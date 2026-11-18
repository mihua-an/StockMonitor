import assert from "node:assert/strict";

// Every screen that keys its views on Market Runtime's 台股 trading day follows it one way
// (market_data/equity_trading_date.js): only a valid day other than the one shown moves it. A session whose equity is
// null (A could not open the equity session) used to turn the detached 技術分析 window's day into "" and empty it.
globalThis.window = globalThis.window || { desktopAPI: null, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const { createEquityDateFollower, equityTradingDateOf, subscribeEquityDate } = await import("../ui/renderer/js/market_data/equity_trading_date.js");
const { createTechnicalWindowService } = await import("../ui/renderer/js/features/realtime/technical_window_service.js");

const day = (date) => ({ equity: date === null ? null : { trading_date: date } });

assert.equal(equityTradingDateOf(day("2026-11-16T00:00:00")), "2026-11-16");
assert.equal(equityTradingDateOf(day(null)), "");
assert.equal(equityTradingDateOf(day("not a day")), "");

const follower = createEquityDateFollower();
assert.deepEqual([day("2026-11-16"), day(null), day("2026-11-16"), day("2026-11-17")].map((s) => follower.follow(s)),
  ["2026-11-16", "", "", "2026-11-17"], "a session naming no day is no move, and the same day back is not a new one");

// The shared subscription.
let push = null;
const subscribeSession = (callback) => { push = callback; return () => { push = null; }; };
const moved = [];
const release = subscribeEquityDate(subscribeSession, (date) => moved.push(date));
for (const session of [day("2026-11-16"), day(null), day("2026-11-16"), day("2026-11-17")]) push(session);
assert.deepEqual(moved, ["2026-11-16", "2026-11-17"]);
release();
assert.equal(push, null);

// The detached 技術分析 window keeps its day through a session that names none.
const views = [];
const service = createTechnicalWindowService({ subscribeSession, subscribeView: (spec) => { views.push(spec); return () => {}; },
  getSnapshot: () => null });
let keyChanges = 0;
service.onKeyChange(() => { keyChanges += 1; });
push(day("2026-11-16"));
assert.equal(service.sessionDate(), "2026-11-16");
push(day(null));
assert.equal(service.sessionDate(), "2026-11-16", "a session without a 台股 day keeps the window's day");
assert.equal(service.key("2330"), "2330|2026-11-16");
push(day("2026-11-17"));
assert.equal(service.sessionDate(), "2026-11-17");
assert.equal(keyChanges, 2, "only the two real days moved the views");
service.dispose();

console.log("renderer equity trading date contract passed");
