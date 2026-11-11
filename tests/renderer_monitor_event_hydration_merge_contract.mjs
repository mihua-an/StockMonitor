import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// The 事件列表 tape: Market Runtime's events.snapshot says what to show -- CURRENT (its events) or
// ARCHIVE (exactly one date's event file) -- and events.tape pushes of the current session apply on top. No date
// search, no clock-time quarantine, no re-subscribe from the page. Driven through the real module
// (features/realtime/live_monitor_events.js); an archive read is answered by the test.
const MONITOR = readFileSync(new URL("../ui/renderer/js/features/realtime/live_monitor_events.js", import.meta.url), "utf8");
assert.doesNotMatch(MONITOR, /events\/dates|plausibleStockDayEventTime|subscribeRealtimeConnectionState|subscribeRealtimeSessionRollover/,
  "no date search, no clock quarantine, no reconnect/rollover re-subscribe");

installRealtimeHarness();
let archive = {};
let archiveRead = null;
const reads = [];
globalThis.fetch = async (url) => {
  reads.push(String(url));
  const body = archiveRead ? await archiveRead(String(url)) : (archive[new URL(String(url)).searchParams.get("date")] || { events: [] });
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
const tape = await import("../ui/renderer/js/features/realtime/live_monitor_events.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
let invalidations = 0;
const invalidate = realtimeContext.dataSource.invalidate.bind(realtimeContext.dataSource);
realtimeContext.dataSource.invalidate = (id, request) => { if (id === "eventFeed") invalidations += 1; return invalidate(id, request); };

// Rust B's rule record: trigger_minute plus triggered_at_ns for the second (events.rs).
const ev = (id, time, date = "2026-10-02", extra = {}) => {
  const [h, m, s] = time.split(":").map(Number);
  const triggeredAtNs = ((1_760_000_000n / 60n) * 60n + BigInt(s)) * 1_000_000_000n;
  return { event_id: id, code: "2330", trading_date: date, session: "DAY", trigger_minute: h * 60 + m,
    triggered_at_ns: String(triggeredAtNs), label: id, event_origin: "analysis_runtime", ...extra };
};

// Each scenario starts from a snapshot (a whole tape); `answers` are the archive reads it may make.
function load(answers = {}) {
  archive = answers;
  archiveRead = null;
  reads.length = 0;
  // The consumers are told in a microtask: the count is read once the pending ones have run.
  const settled = async () => { for (let turn = 0; turn < 3; turn += 1) await Promise.resolve(); return invalidations; };
  return { api: { ...tape, invalidations: settled }, reads };
}

// CURRENT: the snapshot's events are the tape; a push of the current date merges, one of another date is ignored.
{
  const { api, reads } = load();
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-02", presentation: "CURRENT",
    presentation_trading_date: "2026-10-02", events: [ev("a", "09:10:00"), ev("r", "09:11:00")] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["r", "a"]);
  assert.equal(reads.length, 0, "a CURRENT tape is never read over REST");
  api.applyEventTapePush({ trading_date: "2026-10-02", events: [ev("b", "09:12:00")] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["b", "r", "a"]);
  const before = await api.invalidations();
  assert.ok(before > 0, "a changed tape tells its consumers");
  api.applyEventTapePush({ trading_date: "2026-10-02", events: [ev("b", "09:12:00")] });
  assert.equal(await api.invalidations(), before, "an unchanged re-delivery rebuilds nothing");
  api.applyEventTapePush({ trading_date: "2026-10-01", events: [ev("old", "13:00:00", "2026-10-01")] });
  assert.equal(api.getLiveMonitorEvents().some((e) => e.event_id === "old"), false, "another date's push is not this tape's");
  // A revoked revision withdraws the alert.
  api.applyEventTapePush({ trading_date: "2026-10-02", events: [ev("r", "09:11:00", "2026-10-02", { state: "REVOKED" })] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["b", "a"]);
}

// The archive's own answer: ok, the date it is of, and its coverage.
const archiveOf = (date, events, extra = {}) => ({ ok: true, date, coverage: "COMPLETE", events, ...extra });

// ARCHIVE: exactly the named date is read; the current session's first push moves the tape off it, and an archive of
// another day goes (Market Runtime names only the current day since 10-22 -- the pre-open shows the new day, empty).
{
  const { api, reads } = load({ "2026-10-08": archiveOf("2026-10-08", [ev("y1", "13:20:00", "2026-10-08"), ev("y2", "10:00:00", "2026-10-08")]) });
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-12", presentation: "ARCHIVE",
    presentation_trading_date: "2026-10-08", events: [] });
  assert.equal(reads.length, 1);
  assert.match(reads[0], /date=2026-10-08/, "the date Market Runtime names, nothing searched");
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["y1", "y2"]);
  api.applyEventTapePush({ trading_date: "2026-10-12", events: [ev("t1", "09:01:00", "2026-10-12")] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["t1"], "the open replaces the archive day");
}

// ARCHIVE of the current day (a restart outside the live session dropped Market Runtime's events): pushes of that day
// add to the archive's rows -- clearing them showed only the re-sent events, the rest returning a push at a time
// (10-22 recording).
{
  const { api } = load({ "2026-10-21": archiveOf("2026-10-21", [ev("d1", "13:24:00", "2026-10-21"), ev("d2", "13:10:00", "2026-10-21"), ev("d3", "09:05:00", "2026-10-21")]) });
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-21", presentation: "ARCHIVE", presentation_trading_date: "2026-10-21", events: [] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["d1", "d2", "d3"]);
  api.applyEventTapePush({ trading_date: "2026-10-21", events: [ev("d2", "13:10:00", "2026-10-21")] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["d1", "d2", "d3"], "the same day's archive rows stay");
  api.applyEventTapePush({ trading_date: "2026-10-21", events: [ev("d4", "13:30:00", "2026-10-21")] });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["d4", "d1", "d2", "d3"]);
}

// An answer that does not say it is the complete archive of that day is unavailable, never an empty day.
for (const [answer, why] of [
  [{ events: [] }, "CONTRACT_NO_OK"],
  [{ ok: true, coverage: "COMPLETE", events: [] }, "CONTRACT_NO_DATE"],
  [{ ok: true, date: "2026-10-08", events: [] }, "CONTRACT_COVERAGE_NONE"],
  [{ ok: true, date: "2026-10-08", coverage: "SOMETHING", events: [] }, "CONTRACT_COVERAGE_SOMETHING"],
  [{ ok: true, date: "2026-10-08", coverage: "MISSING", events: [] }, "MISSING"],
  [{ ok: true, date: "2026-10-07", coverage: "COMPLETE", events: [] }, "ANSWERED_2026-10-07"],
]) {
  const { api } = load({ "2026-10-08": answer });
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-12", presentation: "ARCHIVE", presentation_trading_date: "2026-10-08" });
  assert.equal(api.liveMonitorEventsUnavailable(), why, JSON.stringify(answer));
}
// A PARTIAL archive (damaged lines) shows what it has and says it is not the whole day.
{
  const { api } = load({ "2026-10-08": archiveOf("2026-10-08", [ev("p1", "11:00:00", "2026-10-08")], { coverage: "PARTIAL" }) });
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-12", presentation: "ARCHIVE", presentation_trading_date: "2026-10-08" });
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["p1"]);
  assert.equal(api.liveMonitorEventsUnavailable(), "PARTIAL");
}

// A newer snapshot fences out an archive read still in flight.
{
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const { api } = load();
  archiveRead = async () => { await slow; return archiveOf("2026-10-08", [ev("late", "13:00:00", "2026-10-08")]); };
  const pending = api.applyEventTapeSnapshot({ current_trading_date: "2026-10-12", presentation: "ARCHIVE", presentation_trading_date: "2026-10-08" });
  await api.applyEventTapeSnapshot({ current_trading_date: "2026-10-12", presentation: "CURRENT", events: [ev("now", "09:05:00", "2026-10-12")] });
  release();
  await pending;
  assert.deepEqual(api.getLiveMonitorEvents().map((e) => e.event_id), ["now"], "the late archive answer does not overwrite");
}
console.log("monitor event tape contract passed (S2c-08, S1-81)");
