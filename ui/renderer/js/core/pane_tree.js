// A pane layout of any shape: a tree of splits whose leaves are panes of tabs (畫面配置). Each split lays its children
// out in a row or a column, so 左中右 with the middle cut again is one tree. Pure functions over a plain object;
// core/tree_workspace.js renders it.
//
//   node  = pane | split
//   pane  = { kind: "pane", id, size, componentIds: [...], activeComponentId }
//   split = { kind: "split", id, dir: "row" | "column", size, children: [node, ...] }
//   size: the node's share of its parent (the children of a split sum to 1; the root's is 1).
//
// A pane whose last tab leaves disappears and its neighbours take its room, unless it is the only pane there is (it
// then offers the add-feature page). A split left with one child is replaced by that child.
import { newPaneId } from "./pane_layout.js";

const EPSILON = 1e-6;
const clone = (value) => JSON.parse(JSON.stringify(value));

let splitSequence = 0;
function newSplitId(now = Date.now()) {
  splitSequence = (splitSequence + 1) % 1e6;
  return `split-${now.toString(36)}-${splitSequence.toString(36)}`;
}

export const emptyTree = () => ({ kind: "pane", id: newPaneId(), size: 1, componentIds: [], activeComponentId: "" });

function normalizeSizes(children) {
  const positive = children.map((child) => (Number(child.size) > 0 ? Number(child.size) : 0));
  const total = positive.reduce((sum, value) => sum + value, 0);
  children.forEach((child, index) => { child.size = total > EPSILON ? positive[index] / total : 1 / children.length; });
}

function collapse(node) {
  if (node.kind === "pane") return node;
  node.children = node.children.map(collapse).filter(Boolean);
  if (!node.children.length) return null;
  if (node.children.length === 1) return { ...node.children[0], size: node.size };
  normalizeSizes(node.children);
  return node;
}

/** Repair anything stored or edited: every component once, sizes that sum to 1, no split of fewer than two children. */
export function normalizeTree(raw, { isKnown = () => true } = {}) {
  const seen = new Set();
  const read = (input) => {
    if (input?.kind === "split") {
      return { kind: "split", id: String(input.id || newSplitId()), dir: input.dir === "column" ? "column" : "row",
        size: Number(input.size) || 0, children: (Array.isArray(input.children) ? input.children : []).map(read).filter(Boolean) };
    }
    if (input?.kind !== "pane") return null;
    const componentIds = [];
    for (const id of Array.isArray(input.componentIds) ? input.componentIds : []) {
      const key = String(id || "");
      if (!key || seen.has(key) || !isKnown(key)) continue;
      seen.add(key);
      componentIds.push(key);
    }
    const active = componentIds.includes(String(input.activeComponentId || "")) ? String(input.activeComponentId) : componentIds[0] || "";
    return { kind: "pane", id: String(input.id || newPaneId()), size: Number(input.size) || 0, componentIds, activeComponentId: active };
  };
  const tree = collapse(read(raw) || emptyTree()) || emptyTree();
  tree.size = 1;
  return tree;
}

/** Every pane, in reading order. */
export function treePanes(node, out = []) {
  if (node.kind === "pane") out.push(node);
  else node.children.forEach((child) => treePanes(child, out));
  return out;
}

export function findTreePane(tree, paneId) {
  return treePanes(tree).find((pane) => pane.id === paneId) || null;
}

export function paneOfTreeComponent(tree, componentId) {
  return treePanes(tree).find((pane) => pane.componentIds.includes(componentId)) || null;
}

function parentOf(node, target) {
  if (node.kind !== "split") return null;
  if (node.children.includes(target)) return node;
  for (const child of node.children) {
    const found = parentOf(child, target);
    if (found) return found;
  }
  return null;
}

function detach(tree, componentId) {
  const pane = paneOfTreeComponent(tree, componentId);
  if (!pane) return;
  const index = pane.componentIds.indexOf(componentId);
  pane.componentIds.splice(index, 1);
  if (pane.activeComponentId === componentId) pane.activeComponentId = pane.componentIds[Math.min(index, pane.componentIds.length - 1)] || "";
}

function prune(tree) {
  const drop = (node) => {
    if (node.kind === "pane") return node.componentIds.length ? node : null;
    node.children = node.children.map(drop).filter(Boolean);
    return node.children.length ? node : null;
  };
  if (treePanes(tree).every((pane) => !pane.componentIds.length)) return { ...treePanes(tree)[0], size: 1 };
  const result = collapse(drop(tree));
  result.size = 1;
  return result;
}

/** A tab joins pane `paneId` at `index` (end when null) and becomes its active tab. */
export function moveTreeTab(input, componentId, paneId, index = null) {
  const tree = clone(input);
  const target = findTreePane(tree, paneId);
  if (!target) return input;
  const from = target.componentIds.indexOf(componentId);
  detach(tree, componentId);
  const adjusted = from >= 0 && index != null && index > from ? index - 1 : index;
  const at = adjusted == null ? target.componentIds.length : Math.max(0, Math.min(target.componentIds.length, adjusted));
  target.componentIds.splice(at, 0, componentId);
  target.activeComponentId = componentId;
  return prune(tree);
}

/** A tab opens a new pane on `edge` ("left" | "right" | "top" | "bottom") of `paneId`, taking half of that pane. */
export function splitTreePane(input, componentId, paneId, edge, { newId = null } = {}) {
  const tree = clone(input);
  const target = findTreePane(tree, paneId);
  if (!target) return input;
  if (target.componentIds.includes(componentId) && target.componentIds.length === 1) return input;   // nothing to split off
  detach(tree, componentId);
  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const fresh = { kind: "pane", id: newId || newPaneId(), size: 0.5, componentIds: [componentId], activeComponentId: componentId };
  const parent = parentOf(tree, target);
  if (parent?.dir === dir) {
    fresh.size = target.size / 2;
    target.size /= 2;
    parent.children.splice(parent.children.indexOf(target) + (before ? 0 : 1), 0, fresh);
    return prune(tree);
  }
  const split = { kind: "split", id: newSplitId(), dir, size: target.size, children: before ? [fresh, target] : [target, fresh] };
  target.size = 0.5;
  if (!parent) { split.size = 1; return prune(split); }
  parent.children[parent.children.indexOf(target)] = split;
  return prune(tree);
}

/** A pane's tab list changed in place (closed, reordered, added from its own chooser, activated). */
export function setTreePaneTabs(input, paneId, componentIds, activeComponentId) {
  const tree = clone(input);
  const target = findTreePane(tree, paneId);
  if (!target) return input;
  target.componentIds = [...componentIds];
  target.activeComponentId = componentIds.includes(activeComponentId) ? activeComponentId : componentIds[0] || "";
  return prune(tree);
}

/** New shares for the children of one split. */
export function resizeTreeSplit(input, splitId, sizes) {
  const tree = clone(input);
  const find = (node) => (node.kind !== "split" ? null : node.id === splitId ? node : node.children.map(find).find(Boolean) || null);
  const split = find(tree);
  if (!split || split.children.length !== sizes.length) return input;
  split.children.forEach((child, index) => { child.size = Number(sizes[index]) || 0; });
  normalizeSizes(split.children);
  return tree;
}

/** The rows-of-panes layout of 即時報價 (pane_layout.js) as a tree: the same panes, tabs and shares. */
export function treeFromRows(layout) {
  const rows = (layout?.rows || []).map((row) => {
    const panes = (row.panes || []).map((pane) => ({ kind: "pane", id: String(pane.id), size: Number(pane.size) || 0,
      componentIds: [...(pane.componentIds || [])], activeComponentId: String(pane.activeComponentId || "") }));
    return { kind: "split", id: `split-${row.id}`, dir: "row", size: Number(row.size) || 0, children: panes };
  });
  return normalizeTree({ kind: "split", id: "split-rows", dir: "column", size: 1, children: rows });
}
