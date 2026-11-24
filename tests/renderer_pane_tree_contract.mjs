// 畫面配置's pane tree (ui/renderer/js/core/pane_tree.js): any shape of panes, every tab once, no leftover splits.
import assert from "node:assert/strict";
import { normalizeTree, treePanes, findTreePane, moveTreeTab, splitTreePane, setTreePaneTabs, resizeTreeSplit, treeFromRows, pixelExtents, pinnedInPlace } from "../ui/renderer/js/core/pane_tree.js";

const pane = (id, size, ...componentIds) => ({ kind: "pane", id, size, componentIds, activeComponentId: componentIds[0] || "" });
const split = (id, dir, size, ...children) => ({ kind: "split", id, dir, size, children });
const pro = () => normalizeTree(split("root", "row", 1, pane("l", 0.2, "a"),
  split("mid", "column", 0.6, pane("t", 0.5, "b", "c"), pane("u", 0.5, "d")), pane("r", 0.2, "e")));
const tabs = (tree) => treePanes(tree).flatMap((p) => p.componentIds).sort();

// A tab moves between panes of different branches; the tree keeps its shape.
let tree = moveTreeTab(pro(), "c", "l");
assert.deepEqual(findTreePane(tree, "l").componentIds, ["a", "c"]);
assert.equal(findTreePane(tree, "l").activeComponentId, "c");
assert.deepEqual(tabs(tree), ["a", "b", "c", "d", "e"]);

// Emptying a pane removes it; a split left with one child is replaced by it, which keeps the split's share.
tree = moveTreeTab(pro(), "d", "t");
assert.equal(findTreePane(tree, "u"), null);
assert.equal(tree.children[1].id, "t");
assert.equal(tree.children[1].size, 0.6);

// Splitting across the parent's direction nests a split; along it, the neighbour halves.
tree = splitTreePane(pro(), "c", "t", "left", { newId: "n" });
const nested = tree.children[1].children[0];
assert.equal(nested.kind, "split");
assert.equal(nested.dir, "row");
assert.deepEqual(nested.children.map((c) => c.id), ["n", "t"]);
tree = splitTreePane(pro(), "c", "t", "bottom", { newId: "n" });
assert.deepEqual(tree.children[1].children.map((c) => c.id), ["t", "n", "u"]);
assert.ok(Math.abs(tree.children[1].children[0].size - 0.25) < 1e-9);

// A pane cannot split off its only tab.
const before = pro();
assert.equal(splitTreePane(before, "a", "l", "top"), before);

// Reordering inside one pane.
assert.deepEqual(findTreePane(moveTreeTab(pro(), "b", "t", 2), "t").componentIds, ["c", "b"]);

// The only pane stays when emptied, offering the add-feature page.
assert.deepEqual(treePanes(setTreePaneTabs(normalizeTree(pane("x", 1, "a")), "x", [], "")).map((p) => p.id), ["x"]);

// Normalizing: duplicates and unknown components go, sizes sum to 1, single-child splits collapse.
tree = normalizeTree(split("s", "row", 1, pane("p", 3, "a", "a", "zz"), split("o", "column", 1, pane("q", 1, "a", "b"))), { isKnown: (id) => id !== "zz" });
assert.deepEqual(tree.children.map((c) => c.id), ["p", "q"]);
assert.deepEqual(findTreePane(tree, "p").componentIds, ["a"]);
assert.deepEqual(findTreePane(tree, "q").componentIds, ["b"]);
assert.ok(Math.abs(tree.children[0].size - 0.75) < 1e-9);

// Resizing one split touches only it.
tree = resizeTreeSplit(pro(), "mid", [300, 100]);
assert.ok(Math.abs(tree.children[1].children[0].size - 0.75) < 1e-9);
assert.equal(tree.children[0].size, 0.2);

// A stored rows-of-panes layout: its rows become the same panes, tabs and shares.
tree = treeFromRows({ rows: [{ id: "r0", size: 0.5, panes: [{ id: "p0", size: 0.4, componentIds: ["a", "b"], activeComponentId: "b" }, { id: "p1", size: 0.6, componentIds: ["c"] }] },
  { id: "r1", size: 0.5, panes: [{ id: "p2", size: 1, componentIds: ["d"] }] }] });
assert.equal(tree.dir, "column");
assert.deepEqual(tree.children[0].children.map((c) => c.id), ["p0", "p1"]);
assert.equal(findTreePane(tree, "p0").activeComponentId, "b");
assert.equal(tree.children[1].id, "p2");
// Pixel extents land on whole pixels and fill the space exactly; a pinned element keeps its own width.
assert.deepEqual(pixelExtents([0.3333, 0.3333, 0.3334], 1001, 8), [328, 329, 328], "edges at round(985 x 1/3), round(985 x 2/3)");
assert.equal(pixelExtents([0.22, 0.18, 0.15, 0.15, 0.15, 0.15], 1663.5, 8).reduce((a, b) => a + b, 0), 1663 - 40);
assert.deepEqual(pixelExtents([0.5, 0.5, 0], 1192, 8, [null, null, 176]), [500, 500, 176]);

// A pinned element: no pane of tabs, no share, kept through edits, never left without panes beside it in its row.
const pinned = () => normalizeTree(split("root", "column", 1, split("up", "row", 0.5, pane("l", 1, "a", "b"), { kind: "pane", id: "pin", pinned: true, size: 9 }), pane("low", 0.5, "c")),
  { isPinned: (id) => id === "pin" });
assert.deepEqual(treePanes(pinned()).map((p) => p.id), ["l", "low"]);
assert.equal(pinned().children[0].children[1].size, 0);
assert.equal(normalizeTree(pinned()).children[0].id, "l", "a page without the element does not get it");
tree = moveTreeTab(pinned(), "a", "low");
assert.ok(pinnedInPlace(tree));
assert.equal(moveTreeTab(tree, "b", "low"), tree, "the last pane beside it stays");
tree = splitTreePane(pinned(), "c", "l", "right");
assert.deepEqual([tree.dir, tree.children.map((c) => c.id).at(-1), tree.children.length], ["row", "pin", 3], "a new pane opens before it; the emptied row goes");
assert.deepEqual(resizeTreeSplit(pinned(), "up", [700, 176]).children[0].children.map((c) => c.size), [1, 0], "a drag leaves its width to it");
console.log("pane tree contract ok");
