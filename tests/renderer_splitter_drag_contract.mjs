// One splitter drag for every resizable layout (core/splitter_drag.js), and the product lists' sideways rail.
// 10-19: 歷史回放's lower panels crept 2 px per drag -- the drag measured each panel's border box (a 1 px border
// outside width: 100%) and wrote it back into the grid tracks. The tracks are now read from the grid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beginSplitterDrag, splitPair } from "../ui/renderer/js/core/splitter_drag.js";

assert.deepEqual(splitPair([300, 200, 100], 0, 40, 120), [340, 160], "the pair keeps its total");
assert.deepEqual(splitPair([300, 200, 100], 0, 500, 120), [380, 120], "the second side stops at its minimum");
assert.deepEqual(splitPair([300, 200, 100], 0, -500, 120), [120, 380], "the first side stops at its minimum");
assert.deepEqual(splitPair([300.4, 199.6], 0, 0, 50), [300, 200], "whole pixels");
// Both sides whole px whatever the pair's total, and the total kept (rounded).
for (const [starts, delta] of [[[300.3, 200.4], 10.6], [[120.5, 120.4], -3.2], [[250.25, 250.25], 0]]) {
  const [first, second] = splitPair(starts, 0, delta, 100);
  assert.ok(Number.isInteger(first) && Number.isInteger(second), `${starts} ${delta}: ${first} / ${second}`);
  assert.equal(first + second, Math.round(starts[0] + starts[1]));
}
// A pair smaller than two minimums cannot give both sides theirs: the boundary does not move, and neither side
// is pushed below where it already is.
assert.deepEqual(splitPair([150, 90.4], 0, 60, 200), [150, 90], "too small a pair keeps its boundary");
assert.deepEqual(splitPair([150, 90], 0, -60, 200), [150, 90]);

// The drag follows its own pointer only, and a cancelled pointer is a cancelled drag.
function fakeDocument() {
  const listeners = new Map();
  return {
    body: { classList: { add() {}, remove() {} }, dataset: {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    fire: (type, event) => listeners.get(type)?.({ preventDefault() {}, ...event }),
    listening: () => listeners.size,
  };
}
const splitter = { setPointerCapture() {}, releasePointerCapture() {} };
const down = (pointerId, clientX) => ({ pointerId, clientX, clientY: 0, preventDefault() {}, stopPropagation() {} });
{
  const doc = fakeDocument();
  const moves = [], ends = [];
  beginSplitterDrag(down(1, 100), splitter, { documentRef: doc, onMove: (d) => moves.push(d), onEnd: (e) => ends.push(e) });
  doc.fire("pointermove", { pointerId: 2, clientX: 500 });
  doc.fire("pointerup", { pointerId: 2, clientX: 500 });
  doc.fire("pointercancel", { pointerId: 2 });
  assert.deepEqual([moves, ends], [[], []], "another pointer neither moves nor ends the drag");
  doc.fire("pointermove", { pointerId: 1, clientX: 130 });
  doc.fire("pointerup", { pointerId: 1, clientX: 130 });
  assert.deepEqual(moves, [30]);
  assert.deepEqual(ends, [{ cancelled: false }], "its own pointer up completes it");
  assert.equal(doc.listening(), 0, "the drag's listeners are gone");
}
{
  const doc = fakeDocument();
  const ends = [];
  beginSplitterDrag(down(7, 100), splitter, { documentRef: doc, onMove() {}, onEnd: (e) => ends.push(e) });
  doc.fire("pointermove", { pointerId: 7, clientX: 160 });
  doc.fire("pointercancel", { pointerId: 7 });
  doc.fire("pointerup", { pointerId: 7, clientX: 160 });
  assert.deepEqual(ends, [{ cancelled: true }], "pointercancel cancels (the caller restores and saves nothing), once");
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
for (const path of ["ui/renderer/js/core/pane_workspace.js", "ui/renderer/js/features/history/workspace_layout.js"]) {
  const source = read(path);
  assert.match(source, /from "(?:\.\/|\.\.\/\.\.\/core\/)splitter_drag\.js"/, `${path} uses the shared drag`);
  assert.doesNotMatch(source, /addEventListener\("pointermove"/, `${path} binds no drag listeners of its own`);
}
assert.match(read("ui/renderer/styles/layout/workspace.css"), /\.pane-mode > \.pane-row > \[data-pane-id\] \{[^}]*box-sizing: border-box;/,
  "a pane's border stays inside the extent the workspace gives it (歷史回放's lower row is a pane workspace)");
assert.match(read("ui/renderer/styles/layout/workspace.css"), /body\.workspace-resizing\[data-resize-cursor="col-resize"\]/,
  "the drag cursor is the shared layout's, not one page's");

// The product lists scroll sideways when their columns keep their minimum widths, with a visible rail.
assert.match(read("ui/renderer/js/core/data_grid.js"), /\{ selector: "\.product-list-table-wrap", x: "auto", width: "fill", xRail: true \}/);
assert.match(read("ui/renderer/js/core/data_grid.js"), /if \(options\.xRail\) state\.xRail = mountHorizontalRail\(/);
assert.match(read("ui/renderer/js/core/data_grid.js"), /state\?\.xRail\?\.destroy\?\.\(\);/, "the rail goes with the grid");
console.log("renderer splitter drag contract passed");
