// 歷史回放: every seek and every played second filtered the whole day's recorded tape of every stock again (歷史事件 and
// the chart's markers), and handed the list a new array even when no event crossed the time -- about 5% of the
// renderer's main thread while dragging. The tape is now ordered once and cut at the replay time by a binary search;
// the list is the same array until an event crosses the time, and the feed draws nothing for an unchanged view model.
import assert from "node:assert/strict";

globalThis.document ??= { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { style: {} } };
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });

const { historyState } = await import("../ui/renderer/js/features/history/history_state.js");
const { recordedEventsAtReplayTime, buildHistoryEventMarkers } = await import("../ui/renderer/js/features/history/history_event_markers.js");

const event = (id, code, time) => ({ event_id: id, code, time, label: "3分急拉" });
historyState.intradayEvents = [event("a", "2303", "09:05:10"), event("b", "2330", "09:01:00"), event("c", "2303", "10:00:00"),
  event("d", "2303", ""), event("e", "2330", "09:05:10")];

const at = (clock) => { historyState.replayCurrentTime = clock; return recordedEventsAtReplayTime(); };
const ids = (rows) => rows.map((e) => e.event_id);
assert.deepEqual(ids(at("09:00:00")), ["d"], "an event with no time is always shown");
assert.deepEqual(ids(at("09:05:10")), ["e", "a", "b", "d"], "events at the time are shown, newest first");
const shown = at("09:30:00");
assert.equal(at("09:59:59"), shown, "no event crossed the time: the same array");
assert.deepEqual(ids(at("10:00:00")), ["c", "e", "a", "b", "d"]);
assert.notEqual(at("10:00:00"), shown);
assert.deepEqual(ids(at("")), ["c", "e", "a", "b", "d"], "no replay time: the whole tape");
assert.deepEqual(ids(at("09:01:00")), ["b", "d"], "back again");

// A new tape (another date) is ordered again.
historyState.intradayEvents = [event("x", "2303", "09:00:30")];
assert.deepEqual(ids(at("09:01:00")), ["x"]);

// The chart's markers read the selected code's part of the tape at the replay time.
historyState.intradayEvents = [event("a", "2303", "09:05:10"), event("b", "2330", "09:01:00"), event("c", "2303", "10:00:00")];
historyState.selectedCode = "2303";
historyState.showAllEventMarkers = true;
historyState.replayCurrentTime = "09:30:00";
const points = [{ time: "09:05:00", close: 50 }, { time: "10:00:00", close: 51 }];
assert.deepEqual(buildHistoryEventMarkers(points).map((m) => m.key), ["id:a"], "only 2303's, only those at or before the time");
historyState.replayCurrentTime = "10:00:00";
assert.deepEqual(buildHistoryEventMarkers(points).map((m) => m.key), ["id:a", "id:c"]);

// The feed redraws nothing for a view model naming the same rows and selection; a new rows array redraws.
const { EventFeedComponent } = await import("../ui/renderer/js/core/components/event_feed_component.js");
const feed = new EventFeedComponent();
let drawn = 0;
feed._renderFilters = () => {};
feed._renderRows = () => { drawn += 1; return 0; };
const rows = [event("a", "2303", "09:05:10")];
let delivery = 0;
const vm = (extra = {}) => ({ availability: "AVAILABLE", rows, selectedSymbol: "2303", selectedEventKey: "", presentationRevision: ++delivery, ...extra });
feed.update(vm());
feed.update(vm());
assert.equal(drawn, 1, "the same rows and selection (a later delivery): not drawn again");
feed.update(vm({ selectedEventKey: "a" }));
feed.update(vm({ rows: [...rows] }));
assert.equal(drawn, 3, "a selection or new rows redraw");

console.log("renderer history event tape contract ok");
