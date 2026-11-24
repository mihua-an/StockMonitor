// 歷史回放 as one pane workspace (core/tree_workspace.js): its eight features are fixed -- a tab moves to another pane or to a
// pane's edge, and none is closed or added -- and 商品列 stands pinned at the right of the upper half.
import { layoutStateStore } from "../../core/layout_state_store.js";
import { treeFromRows } from "../../core/pane_tree.js";

// The stored name of the user's arrangement: it never changes (AGENTS.md section 0), or every saved layout resets.
const PANE_STORAGE_KEY = "historyReplayPaneLayout";
// Where the fixed upper half's sizes were kept before the whole page was one workspace: the chart's width is still read.
const UPPER_STORAGE_KEY = "historyReplayWorkspaceLayout";
export const HISTORY_WORKSPACE_SELECTOR = ".history-workspace";
export const HISTORY_STOCKS_PANE = "historyStocks";
export const HISTORY_STOCKS_WIDTH = 176;
const LOWER_HEIGHT_PX = 280;
const GAP_PX = 8;

const pane = (id, size, ...componentIds) => ({ kind: "pane", id, size, componentIds, activeComponentId: componentIds[0] });
const split = (id, dir, size, children) => ({ kind: "split", id, dir, size, children });

// The chart's share of the upper half beside 商品列, from a width the user set there; the default otherwise.
function chartShare(width) {
  const saved = String(layoutStateStore.read(UPPER_STORAGE_KEY, null)?.["--history-work-top-left"] || "").match(/^([0-9.]+)(px|%)$/);
  const room = width - HISTORY_STOCKS_WIDTH - 2 * GAP_PX;
  const share = !saved ? 0 : saved[2] === "%" ? Number(saved[1]) / 100 : room > 0 ? Number(saved[1]) / room : 0;
  return share > 0.2 && share < 0.8 ? share : 0.62;
}

function pageTree({ width, height }, lower, withPrice) {
  const lowerShare = height > LOWER_HEIGHT_PX * 2 ? LOWER_HEIGHT_PX / (height - GAP_PX) : 0.45;
  const chart = chartShare(width);
  return split("history-root", "column", 1, [
    split("history-upper", "row", 1 - lowerShare, [
      pane("replayPrimary", chart, "replayTrend"),
      pane("replayEvent", 1 - chart, "eventFeed", "tradeDetails", ...(withPrice ? ["priceFlow"] : [])),
      { kind: "pane", id: HISTORY_STOCKS_PANE, size: 0, pinned: true, componentIds: [], activeComponentId: "" },
    ]),
    { ...lower, size: lowerShare },
  ]);
}

const lowerRow = () => split("history-lower", "row", 1, [
  pane("replayTechnical", 0.3, "technicalAnalysis"), pane("replaySecondary", 0.25, "orderbook"),
  pane("replayTertiary", 0.21, "tickDetails"), pane("replayAuxiliary", 0.24, "tradeFlow"),
]);

/** The arrangement every user starts from, for a workspace `size` px large. */
export const historyDefaultTree = (size) => pageTree(size, lowerRow(), true);

// A lower row saved while it was the only workspace. One the user rearranged is kept as it is (價量 where they had it);
// one still in its five panes takes the page's present arrangement.
const FIVE_PANES = "technicalAnalysis|orderbook|tickDetails|priceFlow|tradeFlow";
function fromRows(stored, size) {
  const arrangement = stored.rows.flatMap((row) => (row.panes || []).map((item) => (item.componentIds || []).join("+"))).join("|");
  if (arrangement === FIVE_PANES) return historyDefaultTree(size);
  return pageTree(size, treeFromRows(stored), false);
}

/** The user's saved arrangement, or the default one, as the workspace's first tree. */
export function historyInitialTree(size) {
  const stored = layoutStateStore.read(PANE_STORAGE_KEY, null);
  if (stored?.tree) return stored.tree;
  return Array.isArray(stored?.rows) ? fromRows(stored, size) : historyDefaultTree(size);
}

/** 成交明細 shows no rail in 歷史回放 (the wheel scrolls it): its pane says so, wherever it is. */
export function decorateHistoryPane(element, pane) {
  if (pane.activeComponentId === "tickDetails") element.dataset.listRails = "hidden";
  else delete element.dataset.listRails;
}

export function saveHistoryTree(tree) {
  layoutStateStore.write(PANE_STORAGE_KEY, { tree, savedAt: Date.now() });
}
