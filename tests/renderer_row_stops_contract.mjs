// Rows of different heights scrolled one row at a time (row_metrics.js, used by row_snap.js RowStopController for 帳務's
// 個股數據 / 每日明細 / 配對明細, user 11-01): every resting position is a row's top, and an open row's detail is a row
// of its own -- one step down from an open row rests on its detail's top, the next on the next row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nearestRowStop, rowStopIndex, rowStopSettle, rowStopStep, rowStopTarget } from "../ui/renderer/js/core/row_metrics.js";

// Rows 40 px high; the second row is open and its detail (300 px) is a row of its own: tops 0, 40, 80 (detail), 380.
const stops = [0, 40, 80, 380, 420, 460];
assert.equal(rowStopIndex(stops, 0), 0);
assert.equal(rowStopIndex(stops, 100), 2, "inside the detail: its stop");
assert.equal(rowStopIndex([], 10), -1);

assert.equal(rowStopTarget(stops, 40, 1), 80, "one step from the open row rests on its detail's top");
assert.equal(rowStopTarget(stops, 80, 1), 380, "the next step goes past the detail to the next row");
assert.equal(rowStopTarget(stops, 380, -1), 80, "and back up onto the detail");
assert.equal(rowStopTarget(stops, 200, -1), 80, "between two stops, one row up is the top of the row the list is in");
assert.equal(rowStopTarget(stops, 200, 1), 380);
assert.equal(rowStopTarget(stops, 460, 1), 460, "the last stop holds");
assert.equal(rowStopTarget(stops, 0, -1), 0, "the first stop holds");
assert.equal(rowStopTarget(stops, 0, 3), 380, "several rows at once");
assert.equal(rowStopTarget([], 25, 1), 25, "no rows: nothing moves");

assert.equal(nearestRowStop(stops, 250), 380);
assert.equal(nearestRowStop(stops, 61), 80);

// A detail taller than the view (an open 配對回放, 800 px in a 590 px view) is scrolled through, never snapped back to
// its top: from its top (80) to where its bottom meets the view's bottom (880 - 590 = 290) the list moves a pixel step
// at a time and rests anywhere; 290 is a stop, so the next step goes on to the next row (880).
const tall = [0, 40, 80, 290, 880, 920];
const ranges = [{ from: 80, to: 290 }];
assert.equal(rowStopStep(tall, ranges, 80, 1), 180, "one wheel step into the tall detail");
assert.equal(rowStopStep(tall, ranges, 180, 2), 290, "no further than where its bottom shows");
assert.equal(rowStopStep(tall, ranges, 290, 1), 880, "then on to the next row");
assert.equal(rowStopStep(tall, ranges, 880, -1), 290, "back up onto the detail's bottom");
assert.equal(rowStopStep(tall, ranges, 290, -1), 190, "and up through it");
assert.equal(rowStopStep(tall, ranges, 120, -3), 80, "no further up than its top");
assert.equal(rowStopStep(tall, ranges, 40, 1), 80, "a row step onto the detail's top");
assert.equal(rowStopSettle(tall, ranges, 233), 233, "a dragged scrollbar rests inside the tall detail");
assert.equal(rowStopSettle(tall, ranges, 500), 290, "outside it, the nearest stop");
assert.equal(rowStopSettle(stops, [], 61), 80, "rows within the view still settle on a stop");

// The three expandable account tables rest on rows; the trades table (rows of one height) keeps the row-unit grid.
const html = readFileSync(new URL("../ui/renderer/pages/account.html", import.meta.url), "utf8");
for (const wrap of ["account-stock-stats-table-wrap", "account-daily-table-wrap", "account-pair-table-wrap"]) {
  assert.match(html, new RegExp(`${wrap}"[^>]*data-row-stops="1"`), wrap);
}
console.log("renderer row stops contract passed");
