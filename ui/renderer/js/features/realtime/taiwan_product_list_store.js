import { callListener, notifyEach } from "../../core/listeners.js";

let current = null;
const listeners = new Set();

export function publishTaiwanProductListView(view = {}) {
  current = {
    rows: Array.isArray(view.rows) ? view.rows : [],
    selectedCode: String(view.selectedCode || ""),
    emptyText: String(view.emptyText || "尚無自選商品"),
    onSelect: typeof view.onSelect === "function" ? view.onSelect : null,
    // A row's side picker (現／月份): (code, pick).
    onPick: typeof view.onPick === "function" ? view.onPick : null,
    changedCodes: view.changedCodes instanceof Set ? new Set(view.changedCodes) : null,
    topologyChanged: Boolean(view.topologyChanged),
    trace: view.trace && typeof view.trace === "object" ? { ...view.trace } : null,
    // The ledger's positions when the 實際庫存 page is shown (即時持倉 columns), else null.
    holdings: Array.isArray(view.holdings) ? view.holdings : null,
  };
  notifyEach(listeners, "Taiwan product list: rows", current);
  return current;
}

export function subscribeTaiwanProductListView(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  if (current) callListener(listener, "Taiwan product list: rows", current);
  return () => listeners.delete(listener);
}

export function taiwanProductListSnapshot() {
  return current;
}

// The list's page tabs (實際庫存, 模擬庫存, 總覽, the watch pages) are published apart from the rows: they change when a
// page or a holding changes, the rows on every quote. The list component draws both from here, so a list mounted
// after the pages were chosen (its pane tab opened later) gets its tabs like it gets its rows.
let currentPages = null;
const pageListeners = new Set();

export function publishTaiwanProductPages(pages = {}) {
  currentPages = {
    systemPages: Array.isArray(pages.systemPages) ? pages.systemPages : [],
    overview: pages.overview || null,
    pages: Array.isArray(pages.pages) ? pages.pages : [],
    activePageId: String(pages.activePageId || "overview"),
    onSelect: typeof pages.onSelect === "function" ? pages.onSelect : null,
    // Why the watch pages could not be read ("" when they were).
    loadError: String(pages.loadError || ""),
    // Whether the list shows 總覽 because it is too narrow, and how it asks for that.
    overviewOnly: Boolean(pages.overviewOnly),
    onOverviewOnly: typeof pages.onOverviewOnly === "function" ? pages.onOverviewOnly : null,
  };
  notifyEach(pageListeners, "Taiwan product list: pages", currentPages);
  return currentPages;
}

export function subscribeTaiwanProductPages(listener) {
  if (typeof listener !== "function") return () => {};
  pageListeners.add(listener);
  if (currentPages) callListener(listener, "Taiwan product list: pages", currentPages);
  return () => pageListeners.delete(listener);
}
