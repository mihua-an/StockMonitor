import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../ui/renderer/js/core/pane_workspace.js", import.meta.url),
  "utf8",
);
const history = fs.readFileSync(
  new URL("../ui/renderer/js/features/history/workspace_layout.js", import.meta.url),
  "utf8",
);
const shared = fs.readFileSync(
  new URL("../ui/renderer/js/core/splitter_drag.js", import.meta.url),
  "utf8",
);
const columnTitle = fs.readFileSync(
  new URL("../ui/renderer/js/core/column_title.js", import.meta.url),
  "utf8",
);
const dataGrid = fs.readFileSync(
  new URL("../ui/renderer/js/core/data_grid.js", import.meta.url),
  "utf8",
);

// Both layouts drag through one routine (core/splitter_drag.js), which changes nothing on pointerdown.
const dragStart = shared.indexOf("export function beginSplitterDrag(");
const dragBody = shared.slice(dragStart, shared.indexOf("export function splitPair", dragStart));
assert.ok(dragStart >= 0, "the shared splitter drag must remain discoverable");
assert.doesNotMatch(dragBody.slice(0, dragBody.indexOf("const move =")), /onMove\(|setProperty|style\./,
  "a splitter pointerdown must not change any geometry before the pointer moves");
assert.match(shared, /Math\.round\(Math\.max\(min, Math\.min\(pair - min, starts\[index\] \+ delta\)\)\)/,
  "a moved boundary is whole pixels and keeps both neighbours at their minimum");

// 即時報價's panes (pane_workspace.js): one splitter routine for pane edges and row edges.
const resizeStart = source.indexOf("_beginResize(event, splitter, kind, rowId, index) {");
const resizeEnd = source.indexOf("// ------", resizeStart);
const resizeBody = source.slice(resizeStart, resizeEnd);
assert.ok(resizeStart > 0 && resizeBody, "pane splitter resize must remain discoverable");
assert.match(resizeBody, /beginSplitterDrag\(event, splitter,/, "the panes use the shared drag");
assert.doesNotMatch(resizeBody.slice(0, resizeBody.indexOf("onMove:")), /setExtent\(/,
  "pane splitter pointerdown must not mutate pane geometry before a pointer move");
assert.match(resizeBody, /if \(cancelled\) \{ if \(sizes\) this\._applyGeometry\(\); return; \}\s+if \(!sizes \|\| sizes\[index\] === start\[index\]\) return;/,
  "a cancelled drag restores the layout's sizes; a click-only interaction must not persist or broadcast a resize");

// 歷史回放 (workspace_layout.js): the same drag; sizes read from the grid tracks, never a panel's border box.
// Its lower row is a pane workspace (the pane splitters above); the page keeps the top half's two splitters.
assert.equal((history.match(/drag\((?:event\.currentTarget|splitter), event, "[xy]",/g) || []).length, 2, "both history splitters use the shared drag");
assert.equal((history.match(/gridTrackSizes\(/g) || []).length, 2, "every history splitter measures grid tracks");
assert.doesNotMatch(history, /getBoundingClientRect/, "no panel border box is measured (it drifted 2 px per drag)");
assert.equal((history.match(/if \(changed\) \{ save\(page\); resize\(\); \}/g) || []).length, 2,
  "all history splitters skip persistence and the resize broadcast after a click-only interaction");
assert.equal((history.match(/&& !changed\) return;/g) || []).length, 2, "all history splitters ignore a move that changes nothing");
assert.doesNotMatch(history, /data-history-workspace-bottom-splitter/, "the lower row has no splitters of the page's own");
assert.doesNotMatch(history, /percent\(/,
  "history splitter writes must use exact pixels rather than percentage tracks that include fixed rails");

const columnDownStart = columnTitle.indexOf("const onPointerDown = (event) =>");
const columnDownEnd = columnTitle.indexOf("const onDoubleClick = (event) =>", columnDownStart);
const columnDownBody = columnTitle.slice(columnDownStart, columnDownEnd);
assert.ok(columnDownBody, "shared table-column splitter must remain discoverable");
assert.doesNotMatch(
  columnDownBody.slice(0, columnDownBody.indexOf("const onMove")),
  /applyWidths\(/,
  "shared table-column pointerdown must not refit or mutate column geometry",
);
assert.match(
  columnDownBody,
  /const rawDelta = moveEvent\.clientX - startX;\s*if \(rawDelta === 0\) return;/,
  "shared table-column splitter must ignore zero-distance movement",
);
assert.match(
  columnDownBody,
  /if \(!changed\) \{ state\.refit\?\.\(\); return; \}\s*const before = startWidths\[index\]/,
  "shared table-column splitter must not persist a click-only interaction (it only fits minimums raised while held)",
);

const gridPointerStart = dataGrid.indexOf('headerBand.addEventListener("pointerdown"');
const gridPointerEnd = dataGrid.indexOf("state.headerObserver", gridPointerStart);
const gridPointerBody = dataGrid.slice(gridPointerStart, gridPointerEnd);
assert.match(
  gridPointerBody,
  /if \(started \|\| moveEvent\.clientX === startX\) return;/,
  "table body/header synchronization must wait for real boundary movement",
);
assert.doesNotMatch(
  gridPointerBody.slice(0, gridPointerBody.indexOf("const start =")),
  /\btick\(\)/,
  "table splitter pointerdown must not start geometry synchronization",
);

console.log("All panel and table splitters keep pointerdown and zero-distance moves geometry-neutral");
