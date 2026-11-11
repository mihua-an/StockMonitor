import assert from "node:assert/strict";
import {
  TXF_WAL_SESSION, normalizeTxfDisplayIdentity, txfDisplayIdentityKey,
  txfIdentityMatchesDisplay, txfTickMatchesDisplayWindow, windowCalendarSpan,
} from "../ui/renderer/js/features/realtime/txf_session_identity.js";

// The 期貨走勢 panel reconciles two session vocabularies for TXFR1:
//
//   Market Runtime / WAL : session is ALWAYS "FULL", trading_date is the exchange CALENDAR day
//                          (session_identity_contract.py).
//   Display tabs         : 日盤 / 夜盤 / 全日, business sessions with business trading dates --
//                          NIGHT's is the NEXT business day, deliberately not the calendar day
//                          its own events carry.
//
// Comparing them field-by-field made 日盤 and 夜盤 structurally impossible to fill: a canonical
// snapshot can only say FULL, so DAY failed the session check and NIGHT failed the date check,
// while 全日 matched by coincidence and worked. These are the real values the app's own
// session authority produced on the audit machine.

const CANONICAL = { session: "FULL", trading_date: "2026-09-25", contract_code: "TXFR1" };

const TABS = {
  day: { trading_date: "2026-09-25", session: "DAY", live: false,
         window_start: "2026-09-25T08:45:00+08:00", window_end: "2026-09-25T13:45:00+08:00",
         partitions: [{ trading_date: "2026-09-25", session: "DAY" }] },
  night: { trading_date: "2026-09-28", session: "NIGHT", live: false,
           window_start: "2026-09-25T15:00:00+08:00", window_end: "2026-09-26T05:00:00+08:00",
           partitions: [{ trading_date: "2026-09-25", session: "NIGHT" }] },
  full: { trading_date: "2026-09-25", session: "FULL", live: false,
          window_start: "2026-09-24T15:00:00+08:00", window_end: "2026-09-25T13:45:00+08:00",
          partitions: [{ trading_date: "2026-09-24", session: "NIGHT" }, { trading_date: "2026-09-25", session: "DAY" }] },
};

const display = (tab) => normalizeTxfDisplayIdentity(TABS[tab], tab, "STATUS");
const candidate = (raw, tab) => normalizeTxfDisplayIdentity(raw, tab, "CANONICAL");

// --- 1. every tab accepts the canonical WAL identity -------------------------------------------
for (const tab of ["day", "night", "full"]) {
  assert.equal(
    txfIdentityMatchesDisplay(display(tab), candidate(CANONICAL, tab)), true,
    `${tab} tab must accept Market Runtime's canonical TXFR1 identity (session FULL, calendar date)`,
  );
}

// --- 2. staleness is still rejected --------------------------------------------------------------
// A WAL identity from a calendar day outside the tab's own window is genuinely stale.
assert.equal(
  txfIdentityMatchesDisplay(display("day"), candidate({ ...CANONICAL, trading_date: "2026-09-24" }, "day")), false,
  "a calendar day outside the DAY window is stale, not merely a different vocabulary",
);
assert.equal(
  txfIdentityMatchesDisplay(display("night"), candidate({ ...CANONICAL, trading_date: "2026-09-24" }, "night")), false,
  "the NIGHT window spans 09-25..09-26; 09-24 is outside it",
);
// ...but both calendar days the NIGHT window really spans are accepted.
for (const day of ["2026-09-25", "2026-09-26"]) {
  assert.equal(
    txfIdentityMatchesDisplay(display("night"), candidate({ ...CANONICAL, trading_date: day }, "night")), true,
    `NIGHT spans midnight, so ${day} belongs to it`,
  );
}
// A different contract is stale once one has actually been committed. With none committed there
// is nothing to contradict, which is the pre-existing tolerance rule and stays unchanged.
const committedContract = normalizeTxfDisplayIdentity({ ...TABS.full, contract_code: "TXFR1" }, "full", "CANONICAL");
assert.equal(
  txfIdentityMatchesDisplay(committedContract, candidate({ ...CANONICAL, contract_code: "TXFK6" }, "full")), false,
  "a different actual contract is never the displayed one",
);
assert.equal(
  txfIdentityMatchesDisplay(display("full"), candidate({ ...CANONICAL, contract_code: "TXFK6" }, "full")), true,
  "with no contract committed yet there is nothing for a candidate to contradict",
);
// Business-vs-business keeps the original strict rule.
assert.equal(
  txfIdentityMatchesDisplay(display("day"), candidate({ session: "NIGHT", trading_date: "2026-09-25" }, "day")), false,
  "two business sessions that disagree are still a mismatch",
);
assert.equal(
  txfIdentityMatchesDisplay(display("day"), candidate({ session: "DAY", trading_date: "2026-09-24" }, "day")), false,
  "same vocabulary, conflicting business date: stale",
);
// No committed identity at all means nothing can be displayed yet.
assert.equal(txfIdentityMatchesDisplay({}, candidate(CANONICAL, "full")), false);

// --- 3. the per-event window is what narrows a FULL stream ---------------------------------------
const at = (iso) => ({ session: "FULL", trading_date: "2026-09-25", datetime: iso });
const epoch = (row) => Date.parse(String(row.datetime || ""));

assert.equal(txfTickMatchesDisplayWindow(at("2026-09-25T10:00:00+08:00"), display("day"), epoch), true,
  "a 10:00 event is inside the DAY window");
assert.equal(txfTickMatchesDisplayWindow(at("2026-09-25T22:00:00+08:00"), display("day"), epoch), false,
  "a 22:00 event is outside the DAY window even though it is the same WAL session");
assert.equal(txfTickMatchesDisplayWindow(at("2026-09-25T22:00:00+08:00"), display("night"), epoch), true,
  "...and inside the NIGHT window");
assert.equal(txfTickMatchesDisplayWindow(at("2026-09-26T02:00:00+08:00"), display("night"), epoch), true,
  "NIGHT continues past midnight");
assert.equal(txfTickMatchesDisplayWindow(at("2026-09-26T06:00:00+08:00"), display("night"), epoch), false,
  "...but ends at 05:00");
assert.equal(txfTickMatchesDisplayWindow(at("2026-09-25T10:00:00+08:00"), display("full"), epoch), true,
  "全日 displays the whole stream");

// --- 4. helpers ----------------------------------------------------------------------------------
assert.deepEqual(windowCalendarSpan(display("night")), { start: "2026-09-25", end: "2026-09-26" });
assert.equal(windowCalendarSpan({}), null);
assert.equal(TXF_WAL_SESSION, "full");
// The owner's partitions are part of the identity: a changed partition list rebinds the view.
assert.equal(txfDisplayIdentityKey(display("night")), "FUT|TXFR1|2026-09-28|NIGHT||2026-09-25:NIGHT");

console.log("TXFR1 session identity contract passed (DAY/NIGHT/FULL vs WAL FULL, staleness, window narrowing)");

// --- 5. the second gate: the TXF reference ------------------------------------------------------
// The panel needs BOTH a matching identity and a reference price. The reference is Market Runtime's
// comparison price (state.rs comparison_price, sent as summary.reference_price) read through
// displayQuote(): the renderer keeps no source whitelist of its own that could disagree with A's 漲跌.
const { displayQuote } = await import("../ui/renderer/js/core/auction_price.js");
const mathModule = await import("../ui/renderer/js/market_data/realtime_market_math.js");
assert.equal(mathModule.resolveTxfReference, undefined, "no renderer-side TXF reference rule");
assert.equal(mathModule.isShioajiContractReference, undefined, "no renderer-side reference source whitelist");
assert.equal(displayQuote({ reference_price: 24960, reference_source: "contract.reference" }).reference, 24960);
assert.equal(displayQuote({ reference_price: 24960, reference_source: "anything" }).reference, 24960,
  "the source is A's; the renderer does not second-guess it");
assert.equal(displayQuote({ reference_price: 0 }).reference, null, "no positive comparison price, no baseline");
assert.equal(displayQuote({ prev_close: 24960 }).reference, null, "the renderer never falls back to prev_close itself");

console.log("TXFR1 reference contract passed (Market Runtime's comparison price only)");

// --- the canonical state key a display identity is read under -----------------------------------
// The defect this pins down: the 期貨走勢 panel asked Market Runtime for session=DAY / session=NIGHT.
// FUT's WAL session is always FULL, so those keys name state that cannot exist, the subscription
// bound to nothing and both business tabs rendered zero points and a "--" price while 全日 worked.
const { txfCanonicalStateKey } =
  await import("../ui/renderer/js/features/realtime/txf_session_identity.js");

// These are verbatim /api/market/display-session futures blocks: display_date is 2026-09-25 for
// all three tabs while trading_date and the windows disagree, which is the whole point.
const dayIdentity = normalizeTxfDisplayIdentity({
  session: "DAY", trading_date: "2026-09-25", display_date: "2026-09-25",
  window_start: "2026-09-25T08:45:00+08:00", window_end: "2026-09-25T13:45:00+08:00",
  partitions: [{ trading_date: "2026-09-25", session: "DAY" }],
}, "day", "STATUS");
// NIGHT's business date is the NEXT business day; its events are written under the calendar day
// the window opens on, which is the partition that must be read.
const nightIdentity = normalizeTxfDisplayIdentity({
  session: "NIGHT", trading_date: "2026-09-28", display_date: "2026-09-25",
  window_start: "2026-09-25T15:00:00+08:00", window_end: "2026-09-26T05:00:00+08:00",
  partitions: [{ trading_date: "2026-09-25", session: "NIGHT" }],
}, "night", "STATUS");
// 全日's window OPENS at 15:00 on the previous calendar day, so the window start is NOT the
// partition -- reading it there blanked the one tab that had always worked.
const fullIdentity = normalizeTxfDisplayIdentity({
  session: "FULL", trading_date: "2026-09-25", display_date: "2026-09-25",
  window_start: "2026-09-24T15:00:00+08:00", window_end: "2026-09-25T13:45:00+08:00",
  partitions: [{ trading_date: "2026-09-24", session: "NIGHT" }, { trading_date: "2026-09-25", session: "DAY" }],
}, "full", "STATUS");

// FUT is stored per business session: 日盤 reads its DAY partition, 夜盤 the NIGHT partition dated
// by the day it opened (09-25, a Friday night of the 09-28 trading date), and 全日 binds its DAY while also reading
// the night before it (txfSessionPartitions).
const { txfSessionPartitions } = await import("../ui/renderer/js/features/realtime/txf_session_identity.js");
assert.deepEqual(txfCanonicalStateKey(dayIdentity), { session: "DAY", trading_date: "2026-09-25" });
assert.deepEqual(txfCanonicalStateKey(nightIdentity), { session: "NIGHT", trading_date: "2026-09-25" });
assert.deepEqual(txfCanonicalStateKey(fullIdentity), { session: "DAY", trading_date: "2026-09-25" });
assert.deepEqual(txfSessionPartitions(fullIdentity),
  [{ trading_date: "2026-09-24", session: "NIGHT" }, { trading_date: "2026-09-25", session: "DAY" }]);
assert.deepEqual(txfCanonicalStateKey({}), { session: "DAY", trading_date: "" });

// A per-session partition belongs to a tab exactly when the tab reads it.
const partition = (session, trading_date) => normalizeTxfDisplayIdentity({ session, trading_date, contract_code: "TXFR1" }, session.toLowerCase(), "CANONICAL");
assert.equal(txfIdentityMatchesDisplay(nightIdentity, partition("NIGHT", "2026-09-25")), true, "夜盤 reads the night that opened 09-25");
assert.equal(txfIdentityMatchesDisplay(nightIdentity, partition("NIGHT", "2026-09-28")), false, "not the night that opens on its trading date");
assert.equal(txfIdentityMatchesDisplay(dayIdentity, partition("DAY", "2026-09-25")), true);
assert.equal(txfIdentityMatchesDisplay(dayIdentity, partition("NIGHT", "2026-09-25")), false, "a night is never the 日盤");
assert.equal(txfIdentityMatchesDisplay(fullIdentity, partition("NIGHT", "2026-09-24")), true, "全日 reads the night before its day");
assert.equal(txfIdentityMatchesDisplay(fullIdentity, partition("DAY", "2026-09-25")), true, "...and its day");
assert.equal(txfIdentityMatchesDisplay(fullIdentity, partition("NIGHT", "2026-09-25")), false, "...not the night after it");

console.log("TXFR1 canonical state-key contract passed (each tab reads its own session partitions)");

// --- minute trend points must actually be narrowed -----------------------------------------------
// The narrowing is only as good as the timestamp resolver it is given. Canonical minute points are
// stamped `minute_timestamp`, which the tick-oriented eventEpochMs() does not read, so passing that
// resolver made every window comparison vacuously true: 日盤 and 夜盤 accumulated each other's
// points and 全日 ended up SMALLER than either.
const minutePoint = (stamp) => ({ minute_timestamp: stamp, price: 24970 });
const minuteEpoch = (point) => Date.parse(String(point.minute_timestamp).replace(" ", "T") + "+08:00");
const tickOnlyEpoch = (point) => {
  const parsed = Date.parse(String(point.datetime || point.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const nine = minutePoint("2026-09-25 09:30:00");
const seventeen = minutePoint("2026-09-25 17:30:00");

assert.equal(txfTickMatchesDisplayWindow(nine, dayIdentity, minuteEpoch), true,
  "a 09:30 minute belongs to the 日盤 window");
assert.equal(txfTickMatchesDisplayWindow(seventeen, dayIdentity, minuteEpoch), false,
  "a 17:30 minute must not appear on the 日盤 tab");
assert.equal(txfTickMatchesDisplayWindow(nine, nightIdentity, minuteEpoch), false,
  "a 09:30 minute must not appear on the 夜盤 tab");
assert.equal(txfTickMatchesDisplayWindow(seventeen, nightIdentity, minuteEpoch), true,
  "a 17:30 minute belongs to the 夜盤 window");

// The regression itself: with a resolver blind to minute_timestamp, nothing is ever narrowed.
assert.equal(txfTickMatchesDisplayWindow(seventeen, dayIdentity, tickOnlyEpoch), true);
assert.equal(txfTickMatchesDisplayWindow(nine, nightIdentity, tickOnlyEpoch), true);

console.log("TXFR1 minute-point narrowing contract passed (日盤/夜盤 keep only their own window)");

// --- the canonical view is addressed by the state key, never by the business tab -----------------
// The view spec used to carry the identity's business session and trading_date -- a business tab
// (日盤/夜盤/全日) where Market Runtime keys FUT partitions by WAL session -- and NIGHT's business
// trading_date, a partition it does not live in. On those two tabs the subscription bound to nothing
// while the view store held all 60 minute bars, so 期貨走勢 drew nothing. The spec builder
// (features/realtime/session_state.js) resolves the identity to its canonical state key and
// addresses the view with that, so this asserts that relationship directly.
// The page's own spec builder (features/realtime/session_state.js), each tab's identity named by the session authority.
globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
const { setRealtimeDisplayContext, txfCanonicalViewSpec } = await import('../ui/renderer/js/features/realtime/session_state.js');
setRealtimeDisplayContext({ futures: { DAY: dayIdentity, NIGHT: nightIdentity, FULL: fullIdentity } });
for (const [tab, identity] of [['day', dayIdentity], ['night', nightIdentity], ['full', fullIdentity]]) {
  const spec = txfCanonicalViewSpec(tab);
  const stateKey = txfCanonicalStateKey(identity);
  assert.deepEqual([spec.trading_date, spec.session], [stateKey.trading_date, stateKey.session],
    `the ${tab} tab's view is addressed by its canonical state key`);
}
assert.notEqual(txfCanonicalViewSpec('night').trading_date, nightIdentity.trading_date,
  'the spec must not carry the 夜盤 identity\'s BUSINESS trading_date (the next business day)');

// Each tab's state key is one of the partitions the tab reads (per-session FUT partitions).
for (const identity of [dayIdentity, nightIdentity, fullIdentity]) {
  const stateKey = txfCanonicalStateKey(identity);
  assert.ok(['DAY', 'NIGHT'].includes(stateKey.session));
  assert.equal(stateKey.trading_date, '2026-09-25');
}

console.log('TXFR1 view addressing contract passed (spec addressed by the state key)');

// --- 6. 全日 is a business window too ------------------------------------------------------------------
// Named like the WAL session, the 全日 tab of trading date 10-02 opens at 10-01 15:00: the FULL partition of
// 10-01 holds its first half and was rejected on the calendar date, leaving the tab with one point.
{
  const { txfIdentityMatchesDisplay: matches } = await import("../ui/renderer/js/features/realtime/txf_session_identity.js");
  const fullTab = { session: "full", trading_date: "2026-10-02",
    window_start: "2026-10-01T15:00:00+08:00", window_end: "2026-10-02T13:45:00+08:00" };
  assert.equal(matches(fullTab, { session: "full", trading_date: "2026-10-01" }), true, "the partition the window opens in");
  assert.equal(matches(fullTab, { session: "full", trading_date: "2026-10-02" }), true);
  assert.equal(matches(fullTab, { session: "full", trading_date: "2026-09-30" }), false, "a partition outside the window");
  console.log("全日 window identity contract passed");
}
