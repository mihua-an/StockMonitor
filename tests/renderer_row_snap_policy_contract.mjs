import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// RowSnapController's options become one named policy; a combination without a meaning is refused where it is made.
const { rowSnapPolicy } = await import("../ui/renderer/js/core/row_snap.js");
const { completeRowViewportMetrics, rowIndexFromScrollOffset } = await import("../ui/renderer/js/core/row_metrics.js");

assert.deepEqual({ ...rowSnapPolicy() }, { scroll: "free", pitch: "css", fit: "none", remainder: "masked", observe: true });
assert.deepEqual({ ...rowSnapPolicy({ rowUnit: true, fitViewportRows: true, distributeRemainder: true, maskRemainder: false, observeResize: false }) },
  { scroll: "row", pitch: "css", fit: "distributed", remainder: "shown", observe: false }, "the complete-row data grid");
assert.equal(rowSnapPolicy({ rowUnit: true, measureActualRow: true, maskRemainder: false }).pitch, "measured", "the flow lists");
assert.equal(rowSnapPolicy({ fitViewportRows: true }).fit, "whole-rows");
assert.equal(rowSnapPolicy({ smooth: true }).scroll, "smooth");
assert.throws(() => rowSnapPolicy({ rowUnit: true, smooth: true }), /rowUnit with smooth/);
assert.throws(() => rowSnapPolicy({ distributeRemainder: true }), /distributeRemainder without fitViewportRows/);
assert.ok(Object.isFrozen(rowSnapPolicy()));

// The row arithmetic is DOM-free and importable on its own.
assert.equal(rowIndexFromScrollOffset(57, 20, 10), 3);
assert.equal(completeRowViewportMetrics(100, 20, 50).visibleRows, 5);
for (const file of ["row_metrics.js"]) {
  assert.doesNotMatch(readFileSync(new URL(`../ui/renderer/js/core/${file}`, import.meta.url), "utf8"), /document|window|getComputedStyle|getBoundingClientRect/,
    `${file} reads no DOM`);
}
const snap = readFileSync(new URL("../ui/renderer/js/core/row_snap.js", import.meta.url), "utf8");
assert.doesNotMatch(snap, /this\.(smooth|rowUnit|fitViewportRows|distributeRemainder|measureActualRow|maskRemainder|observeResize)\b/,
  "the controller branches on its policy, not on loose flags");
console.log("renderer row snap policy contract passed");
