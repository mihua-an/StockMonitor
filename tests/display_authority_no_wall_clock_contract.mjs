// Invariant under test: the renderer never infers a trading date from the host's wall clock.
//
// On any day whose session authority resolves to an earlier trading date (every weekend and holiday -- the authority
// reports the previous Friday while the clock says Saturday), a guessed date binds the equity and TAIEX canonical views
// to a partition that holds nothing, and a closed market never corrects it: 加權走勢 and 個股走勢 show a live price and
// draw no line. So an unknown authority yields an EMPTY trading date -- which callers refuse to subscribe -- and never a
// guess. Executed for real: the page's two spec builders run against a spied Date constructor.
import assert from "node:assert/strict";
import { realtimeModuleSource } from "./lib/realtime_sources.mjs";

globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
const sessionState = await import("../ui/renderer/js/features/realtime/session_state.js");
// The view owner that declares, and so refuses, the subscriptions.
const owner = realtimeModuleSource("canonical_view_owner");

// A fixed instant chosen so the UTC calendar date and the Asia/Taipei (UTC+8) date disagree:
// 2026-01-01T20:00:00Z is 2026-01-02 04:00 in Taipei. Any wall-clock read shows up as a non-empty
// trading_date below, whichever calendar it used.
const FIXED_EPOCH = Date.parse("2026-01-01T20:00:00Z");

function run(builder, context) {
  let dateReads = 0;
  const RealDate = Date;
  class SpiedDate extends RealDate {
    constructor(...args) {
      if (!args.length) dateReads += 1;
      super(...(args.length ? args : [FIXED_EPOCH]));
    }

    static now() { dateReads += 1; return FIXED_EPOCH; }
  }

  sessionState.setRealtimeDisplayContext(context);
  globalThis.Date = SpiedDate;
  try {
    const spec = builder === "stock" ? sessionState.stockCanonicalViewSpec("2330") : sessionState.taiexCanonicalViewSpec();
    return { spec, dateReads };
  } finally {
    globalThis.Date = RealDate;
  }
}

for (const builder of ["stock", "taiex"]) {
  // Authority known: the spec uses it verbatim, and never consults the clock.
  const known = run(builder, { equity: { trading_date: "2026-09-25", live: false }, taiex: { trading_date: "2026-09-25", live: false } });
  assert.equal(known.spec.trading_date, "2026-09-25", `${builder}: the session authority's date is used as-is`);
  assert.equal(known.dateReads, 0, `${builder}: the wall clock is not read when the authority is known`);

  // Authority unknown: an EMPTY date ("not subscribable yet", which is what the callers check).
  const unknown = run(builder, {});
  assert.equal(unknown.spec.trading_date, "", `${builder}: an unknown authority yields an empty date, never a guess`);
  assert.equal(unknown.dateReads, 0, `${builder}: the wall clock is not read when the authority is unknown`);
}

// The caller must actually refuse an empty identity, or the rule above buys nothing. desiredCanonicalViews is the one
// place a view is declared: ensureTaiexCanonicalView / ensureTxfCanonicalView only ask it to reconcile.
for (const [label, pattern] of [
  ["desiredCanonicalViews", /const add = \(kind, spec, code = ""\) => \{ if \(spec\?\.trading_date\) views\.set\(/],
  ["ensureTaiexCanonicalView", /function ensureTaiexCanonicalView\(\) \{\s*reconcileCanonicalViews\("TAIEX"\);/],
]) {
  assert.ok(pattern.test(owner), `${label} must refuse to subscribe an identity with no trading date`);
}

console.log("frontend display authority: no wall-clock identity, and an unknown authority is never guessed");
