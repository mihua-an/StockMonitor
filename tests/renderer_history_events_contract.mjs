// 歷史回放: Rust B rule records reached the replay raw -- no `info`, an HH:MM `time` -- so every row showed "--" and
// every chart marker read 「事件」. The replay now adapts them as the live feed does.
import assert from "node:assert/strict";
import { normalizeHistoryEvents, eventDisplayTime, eventInfoClass, renderEventInfoHtml } from "../ui/renderer/js/core/event_feed_format.js";
import { eventMarkerLabel } from "../ui/renderer/js/core/event_markers.js";
import { readFileSync } from "node:fs";
import { EVENT_FEED_COLUMNS } from "../ui/renderer/js/core/column_schemas.js";

const record = (id, minute, label, extra = {}) => ({
  event_id: id, event_origin: "analysis_runtime", code: "00403A", trading_date: "2026-09-30",
  time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
  trigger_minute: minute, label, rule_id: "win3_up", direction: "up", state: "ACTIVE", revision: 1, ...extra,
});

const rows = normalizeHistoryEvents([
  record("a", 542, "3分急拉"),
  record("b", 786, "爆量", { direction: null, type: "volume_spike" }),
  record("b", 786, "爆量", { direction: null, type: "volume_spike", revision: 3, state: "UPDATED" }),
  record("c", 600, "5分急拉"),
  record("c", 600, "5分急拉", { revision: 2, state: "REVOKED" }),
]);
assert.deepEqual(rows.map((r) => r.event_id), ["b", "a"], "newest revision wins, revoked withdrawn, newest time first");
assert.equal(eventDisplayTime(rows[1]), "09:02:00", "a time the feed can show");
assert.equal(rows[1].info, "3分急拉");
assert.equal(eventMarkerLabel(rows[1]), "3分急拉", "the chart marker names the event");
assert.equal(rows[0].revision, 3);

// The trigger second comes from triggered_at_ns (2026-09-30 01:42:37 UTC = 09:42:37 Taipei), not :00, and
// orders events inside one minute; an UPDATED revision keeps it. Old records without it still show :00.
const at = (minute, second) => String(BigInt(Date.UTC(2026, 8, 30, Math.floor(minute / 60) - 8, minute % 60, second)) * 1000000n);
const timed = normalizeHistoryEvents([
  record("early", 582, "3分急拉", { triggered_at_ns: at(582, 7) }),
  record("late", 582, "5分急拉", { triggered_at_ns: at(582, 37) }),
  record("late", 582, "5分急拉", { triggered_at_ns: at(582, 37), as_of_ns: at(582, 55), revision: 2, state: "UPDATED" }),
  record("old", 582, "爆量"),
]);
assert.deepEqual(timed.map((r) => [r.event_id, eventDisplayTime(r)]),
  [["late", "09:42:37"], ["early", "09:42:07"], ["old", "09:42:00"]], "seconds shown and sorted by the real trigger time");
// 3分／5分 上漲・下跌: the model predictions Rust B wrote into the event when it triggered (events.rs model_predictions),
// survive the adapter, and are what the four columns read.
const predicted = normalizeHistoryEvents([record("p", 600, "1分急拉", { model_predictions: { "3m_up": { probability: 0.7 } } })])[0];
assert.equal(predicted.model_predictions["3m_up"].probability, 0.7);
assert.deepEqual(EVENT_FEED_COLUMNS.filter((c) => c.slot).map((c) => [c.slot, c.title]),
  [["3m_up", "3分上漲"], ["3m_down", "3分下跌"], ["5m_up", "5分上漲"], ["5m_down", "5分下跌"]]);
const feed = readFileSync(new URL("../ui/renderer/js/core/components/event_feed_component.js", import.meta.url), "utf8");
assert.match(feed, /event\?\.model_predictions\?\.\[column\.slot\]\?\.probability/);
assert.doesNotMatch(feed, /orderbook_(up|down)_prob/, "no field nothing produces");

// 量比 (user 10-14, replaces 爆量): every price event with a usual volume says how many times it is, even below 1.
const [thin] = normalizeHistoryEvents([record("v", 601, "3分急拉", { detail: { volume_ratio: 0.6 } })]);
assert.match(renderEventInfoHtml(thin), /3分急拉.*\(0\.6x\)/);
assert.equal(eventInfoClass(thin), "price-up");
const [bare] = normalizeHistoryEvents([record("b", 602, "3分急拉")]);
assert.doesNotMatch(renderEventInfoHtml(bare), /x\)/, "no usual volume: no 量比");
// An archived 爆量 (no direction) is no longer coloured as a rise.
const [spike] = normalizeHistoryEvents([record("s", 603, "爆量", { direction: null, type: "volume_spike" })]);
assert.equal(eventInfoClass(spike), "price-flat");

console.log("renderer history events contract ok");
