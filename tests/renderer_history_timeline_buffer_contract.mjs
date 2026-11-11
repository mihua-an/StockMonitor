// 歷史回放: Market Runtime holds Rust B's analysis of the replayed day as B builds it, and a seek outside what is built
// shows 計算中. Under the time bar the built times are drawn (status.analysis.buffered, like YouTube's buffer): its
// segments follow the ranges, kept and only moved as they grow and merge.
import assert from "node:assert/strict";

function element(tag = "div") {
  const node = {
    tagName: tag, style: {}, children: [],
    append(child) { node.children.push(child); },
    replaceChildren() { node.children = []; },
    get lastElementChild() { return node.children[node.children.length - 1] || null; },
  };
  return node;
}
const range = { min: "32400", max: "48600" };
const buffer = element();
buffer.children = [];
const removing = (child) => { buffer.children = buffer.children.filter((c) => c !== child); };
buffer.append = (child) => { child.remove = () => removing(child); buffer.children.push(child); };
const elements = { historyTimeRange: range, historyTimeBuffer: buffer };
globalThis.document = { getElementById: (id) => elements[id] || null, createElement: (tag) => element(tag), querySelector: () => null,
  querySelectorAll: () => [], documentElement: { style: {} } };
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });

const { showHistoryTimelineBuffer, clearHistoryTimeline } = await import("../ui/renderer/js/features/history/timeline.js");

// 2026-10-30, Taipei time of day in seconds -> epoch ns.
const ns = (second) => ((BigInt(Date.UTC(2026, 9, 30)) / 1000n + BigInt(second) - 8n * 3600n) * 1_000_000_000n).toString();
const hour = (h) => h * 3600;

showHistoryTimelineBuffer({ ranges: [[ns(hour(9)), ns(hour(10))], [ns(hour(12)), ns(hour(13.5))]], complete: false });
assert.equal(buffer.children.length, 2, "a segment per range held");
const [first, second] = buffer.children;
assert.equal(first.style.left, "0.000%");
assert.equal(first.style.width, `${((3601 / 16200) * 100).toFixed(3)}%`, "09:00 to 10:00 inclusive of its last second");
assert.equal(second.style.left, `${((hour(3) / 16200) * 100).toFixed(3)}%`);

showHistoryTimelineBuffer({ ranges: [[ns(hour(9)), ns(hour(13.5))]], complete: true });
assert.equal(buffer.children.length, 1, "merged as B fills the gap");
assert.equal(buffer.children[0], first, "the segment kept, only moved");
assert.equal(first.style.width, "100.000%", "the whole day, clamped to the bar");

showHistoryTimelineBuffer({ ranges: [[ns(hour(8)), ns(hour(8.5))]] });
assert.equal(buffer.children.length, 0, "times before the bar draw nothing");
showHistoryTimelineBuffer(undefined);
assert.equal(buffer.children.length, 0, "a status without analysis draws nothing");

showHistoryTimelineBuffer({ ranges: [[ns(hour(9)), ns(hour(10))]] });
globalThis.historyPage = undefined;
clearHistoryTimeline();
assert.equal(buffer.children.length, 0, "no replay: no buffer");
console.log("renderer_history_timeline_buffer_contract: ok");
