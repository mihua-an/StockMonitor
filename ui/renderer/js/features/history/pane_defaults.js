// 歷史回放's lower row as a pane workspace (core/pane_workspace.js): one row holding its five features. A feature's tab
// moves to another pane (two then share it), or to a pane's edge to stand on its own again; none is closed or added.
import { layoutFromSlots } from "../../core/pane_workspace.js";
import { layoutStateStore } from "../../core/layout_state_store.js";
import { HISTORY_WORKSPACE_LAYOUT_KEY } from "./workspace_layout.js";

// The stored name of the user's arrangement: it never changes (AGENTS.md section 0), or every saved layout resets.
export const HISTORY_PANE_STORAGE_KEY = "historyReplayPaneLayout";
export const HISTORY_PANE_ROWS = 1;
export const HISTORY_PANE_SELECTOR = ".history-bottom-tools";

// Left to right: 技術分析, 買賣報價, 成交明細, 價量, 大單流向 (the panes the page markup ships, by slot id).
const PANES = Object.freeze(["replayTechnical", "replaySecondary", "replayTertiary", "replayPriceFlow", "replayAuxiliary"]);
const COMPONENTS = Object.freeze({
  replayTechnical: "technicalAnalysis", replaySecondary: "orderbook", replayTertiary: "tickDetails",
  replayPriceFlow: "priceFlow", replayAuxiliary: "tradeFlow",
});
const DEFAULT_WIDTHS = Object.freeze(["24%", "20%", "17%", "20%"]);
const SAVED_WIDTH_KEYS = Object.freeze(["--history-work-bottom-1", "--history-work-bottom-2", "--history-work-bottom-3", "--history-work-bottom-4"]);

export function historyPaneDefaultLayout() {
  // The widths the user set on the row before it was a workspace (the page's layout store), else the defaults.
  const saved = layoutStateStore.read(HISTORY_WORKSPACE_LAYOUT_KEY, null) || {};
  const widths = SAVED_WIDTH_KEYS.every((key) => saved[key]) ? SAVED_WIDTH_KEYS.map((key) => String(saved[key])) : [...DEFAULT_WIDTHS];
  const element = globalThis.document?.querySelector?.(HISTORY_PANE_SELECTOR);
  const tabbedSlots = Object.fromEntries(PANES.map((id) => [id, { componentIds: [COMPONENTS[id]], activeComponentId: COMPONENTS[id] }]));
  return layoutFromSlots({ rows: [[...PANES]], tabbedSlots, widths: [widths], rowWidth: element?.clientWidth || 0 });
}
