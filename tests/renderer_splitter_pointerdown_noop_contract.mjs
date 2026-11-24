import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../ui/renderer/js/core/tree_workspace.js", import.meta.url),
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

// Every layout drags through one routine (core/splitter_drag.js), which changes nothing on pointerdown.
const dragStart = shared.indexOf("export function beginSplitterDrag(");
const dragBody = shared.slice(dragStart, shared.indexOf("export function splitPair", dragStart));
assert.ok(dragStart >= 0, "the shared splitter drag must remain discoverable");
assert.doesNotMatch(dragBody.slice(0, dragBody.indexOf("const move =")), /onMove\(|setProperty|style\./,
  "a splitter pointerdown must not change any geometry before the pointer moves");
assert.match(shared, /Math\.round\(Math\.max\(min, Math\.min\(pair - min, starts\[index\] \+ delta\)\)\)/,
  "a moved boundary is whole pixels and keeps both neighbours at their minimum");

// The pane workspaces (tree_workspace.js): one splitter routine for every split.
const resizeStart = source.indexOf("_beginResize(event, splitter, splitId, dir, index) {");
const resizeEnd = source.indexOf("/** Where a drop at", resizeStart);
const resizeBody = source.slice(resizeStart, resizeEnd);
assert.ok(resizeStart > 0 && resizeBody, "pane splitter resize must remain discoverable");
assert.match(resizeBody, /beginSplitterDrag\(event, splitter,/, "the panes use the shared drag");
assert.doesNotMatch(resizeBody.slice(0, resizeBody.indexOf("onMove:")), /_applyGeometry\(|setExtent\(/,
  "pane splitter pointerdown must not mutate pane geometry before a pointer move");
assert.match(resizeBody, /if \(cancelled\) \{\s+if \(sizes\) \{[^}]*_applyGeometry\(\); \}\s+return;\s+\}\s+if \(!sizes \|\| sizes\[index\] === start\[index\]\) return;/,
  "a cancelled drag restores the layout's sizes; a click-only interaction must not persist or broadcast a resize");

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
