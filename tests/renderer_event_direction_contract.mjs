import assert from "node:assert/strict";
import fs from "node:fs";

// An event's direction and rank have one owner, Rust B's rule (events.rs EventRecord `direction` / `priority`). The
// chart markers and the 即時資訊 feed read those fields; nothing is read out of the label text, so a renamed or
// user-written label is drawn the way its rule says.
const vars = { "--price-up-color": "#e11919", "--price-down-color": "#00993d", "--chart-marker": "#888888" };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => vars[name] || "" });
const markers = await import("../ui/renderer/js/core/event_markers.js");
const { normalizeMonitorEvent, renderEventInfoHtml } = await import("../ui/renderer/js/core/event_feed_format.js");

const record = (id, minute, label, direction, priority) => normalizeMonitorEvent({
  event_id: id, event_origin: "analysis_runtime", code: "2330", trading_date: "2026-11-03", trigger_minute: minute,
  label, rule_id: id, direction, priority, state: "ACTIVE", revision: 1,
});

// A label no built-in vocabulary knows: before, it was "auto"/flat and ranked at the base.
const custom = record("my_rule", 545, "自訂訊號", "down", 900);
assert.equal(markers.eventMarkerLabel(custom), "自訂訊號");
assert.equal(markers.eventMarkerPlacement(custom), "above");
assert.equal(markers.eventMarkerColor(custom), "#00993d");
assert.equal(markers.eventMarkerPriority(custom), 900);
assert.match(renderEventInfoHtml(custom), /event-feed-token down">自訂訊號</);

// A label that reads like a rise but whose rule says down is drawn down: the text is not consulted.
const misleading = record("renamed", 545, "急拉", "down", 100);
assert.equal(markers.eventMarkerPlacement(misleading), "above");
assert.match(renderEventInfoHtml(misleading), /event-feed-token down">急拉</);
const flat = record("flat", 545, "觀察", null, 100);
assert.equal(markers.eventMarkerPlacement(flat), "auto");
assert.equal(markers.eventMarkerColor(flat), "#888888");

// The minute's marker is the event with B's highest priority, whatever the labels say.
const points = [{ minute_timestamp: "2026-11-03T09:05:00+08:00", price: 100 }];
const shown = markers.liveEventMarkers([record("a", 545, "開盤急拉", "up", 450), custom, record("b", 545, "1分急拉", "up", 400)],
  { code: "2330", points });
assert.deepEqual(shown.map((m) => [m.label, m.priority, m.placement]), [["自訂訊號", 900, "above"]]);

// No second vocabulary is left in the renderer.
assert.equal(fs.existsSync(new URL("../ui/renderer/js/core/event_rules.js", import.meta.url)), false);
for (const file of ["core/event_markers.js", "core/event_feed_format.js", "features/history/history_event_markers.js"]) {
  const source = fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /classifyEventLabel|event_rules\.js|漲停|急殺/, `${file} reads no label text`);
}
console.log("renderer event direction contract passed");
