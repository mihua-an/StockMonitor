// 即時報價's screens: 標準 / 完整 / 專業 / 台股 and any the user adds, each a named pane tree (core/pane_tree.js), and which
// one is shown. One record for every window: the 版型 editor window changes it and the main window follows at once.
import { layoutStateStore } from "../../core/layout_state_store.js";
import { emptyTree } from "../../core/pane_tree.js";

const STORAGE_KEY = "monitorScreenLayouts";
const OWN_WRITE = "screen-layouts";

const pane = (id, size, ...componentIds) => ({ kind: "pane", id, size, componentIds, activeComponentId: componentIds[0] });
const split = (id, dir, size, ...children) => ({ kind: "split", id, dir, size, children });

// The shares are the user's own arrangement (使用者 11-09): shares, so each keeps its proportions on any screen. A pane's
// id is the slot its components are offered in: "pane-..." or a named slot (component_registry.js).
const BUILT_IN = Object.freeze({
  default: { name: "標準模式", tree: () => split("default-root", "column", 1,
    split("default-top", "row", 0.5384,
      pane("pane-default-tl", 0.4937, "productList", "productListA"),
      pane("pane-default-tr", 0.5063, "marketTrend", "futuresTrend", "eventFeed")),
    split("default-bottom", "row", 0.4616,
      pane("pane-default-bl1", 0.2255, "stockTrend", "technicalAnalysis", "priceFlow"),
      pane("pane-default-bl2", 0.2532, "orderbook", "orderbookA"),
      pane("pane-default-br2", 0.2207, "tickDetails", "tickDetailsA"),
      pane("pane-default-br1", 0.3005, "tradeFlow", "stockTrendA"))) },
  full: { name: "完整模式", tree: () => split("full-root", "column", 1,
    split("full-top", "row", 0.5089,
      pane("productList", 0.3309, "productList", "paperLedger", "industryIndexList"),
      pane("pane-full-flow", 0.159, "priceFlow", "industryIndexTrend"),
      pane("topAuxiliary", 0.1941, "marketTrend", "futuresTrend", "tradeFlow"),
      pane("liveInfo", 0.316, "productListA", "eventFeed")),
    split("full-bottom", "row", 0.4911,
      pane("analysisPrimary", 0.1776, "stockTrend", "technicalAnalysis"),
      pane("analysisSecondary", 0.169, "orderbook"),
      pane("analysisTertiary", 0.1089, "tickDetails"),
      pane("analysisQuaternary", 0.1089, "tickDetailsA"),
      pane("auxiliary", 0.1583, "orderbookA"),
      pane("analysisQuinary", 0.2774, "stockTrendA"))) },
  pro: { name: "專業模式", tree: () => split("pro-root", "row", 1,
    pane("pane-pro-left", 0.107, "productList"),
    split("pro-center", "column", 0.776,
      split("pro-top", "row", 0.55, pane("pane-pro-trend", 0.4997, "stockTrend"), pane("pane-pro-trend-a", 0.5003, "stockTrendA")),
      split("pro-bottom", "row", 0.45,
        pane("pane-pro-book", 0.2093, "orderbook"), pane("pane-pro-ticks", 0.2907, "tickDetails"),
        pane("pane-pro-ticks-a", 0.25, "tickDetailsA"), pane("pane-pro-book-a", 0.25, "orderbookA"))),
    pane("pane-pro-right", 0.1171, "productListA")) },
  // The id the user's own 台股 screen was saved under: it stays that screen, now with 還原.
  "screen-mw8avsla-1": { name: "台股模式", tree: () => split("taiwan-root", "column", 1,
    split("taiwan-top", "row", 0.55,
      pane("pane-taiwan-products", 0.42, "productList"),
      pane("pane-taiwan-market", 0.2511, "marketTrend", "futuresTrend"),
      pane("pane-taiwan-events", 0.3289, "eventFeed")),
    split("taiwan-bottom", "row", 0.45,
      pane("pane-taiwan-industry", 0.1899, "industryIndexTrend"),
      pane("pane-taiwan-trend", 0.1765, "stockTrend"),
      pane("pane-taiwan-book", 0.1518, "orderbook"),
      pane("pane-taiwan-ticks", 0.154, "tickDetails"),
      pane("pane-taiwan-flow", 0.1647, "tradeFlow"),
      pane("pane-taiwan-price", 0.1631, "priceFlow"))) },
});

function firstRunRecord() {
  return { activeId: "default", items: Object.entries(BUILT_IN).map(([id, screen]) => ({ id, name: screen.name, tree: screen.tree() })) };
}

function usable(record) {
  return Array.isArray(record?.items) && record.items.length > 0
    && record.items.every((item) => item?.id && typeof item.name === "string" && item.tree);
}

function readRecord() {
  const stored = layoutStateStore.read(STORAGE_KEY, null);
  const record = usable(stored) ? stored : firstRunRecord();
  if (!record.items.some((item) => item.id === record.activeId)) record.activeId = record.items[0].id;
  return record;
}

let screenSequence = 0;

function createScreenLayouts() {
  let record = readRecord();
  const listeners = new Set();
  const find = (id) => record.items.find((item) => item.id === id);
  const active = () => find(record.activeId);
  const save = () => layoutStateStore.write(STORAGE_KEY, record, { source: OWN_WRITE });
  const announce = () => { for (const listener of [...listeners]) listener(active()); };
  const commit = () => { save(); announce(); };
  // Another window changed the record: read it again and show what it says.
  layoutStateStore.subscribe(STORAGE_KEY, (_value, { source }) => {
    if (source === OWN_WRITE) return;
    record = readRecord();
    announce();
  });
  save();
  return {
    list: () => record.items.map(({ id, name }) => ({ id, name, builtIn: Object.hasOwn(BUILT_IN, id) })),
    active,
    /** `listener(activeScreen)` after the shown screen, its list or (from another window) its panes changed. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    select(id) { if (find(id) && id !== record.activeId) { record.activeId = id; commit(); } },
    /** The panes shown were rearranged here: already on screen in this window. */
    setTree(tree) { active().tree = tree; save(); },
    /** A new screen: a copy of the one shown, or empty. It becomes the one shown. */
    add({ name, copy }) {
      screenSequence = (screenSequence + 1) % 1e6;
      const id = `screen-${Date.now().toString(36)}-${screenSequence.toString(36)}`;
      record.items.push({ id, name, tree: copy ? JSON.parse(JSON.stringify(active().tree)) : emptyTree() });
      record.activeId = id;
      commit();
    },
    rename(id, name) { if (find(id)) { find(id).name = name; commit(); } },
    /** The last screen stays: there is always one to show. */
    remove(id) {
      if (record.items.length <= 1 || !find(id)) return;
      const index = record.items.findIndex((item) => item.id === id);
      record.items.splice(index, 1);
      if (record.activeId === id) record.activeId = record.items[Math.min(index, record.items.length - 1)].id;
      commit();
    },
    /** A built-in screen goes back to the arrangement it ships with. */
    reset(id) {
      if (!Object.hasOwn(BUILT_IN, id) || !find(id)) return;
      find(id).tree = BUILT_IN[id].tree();
      commit();
    },
  };
}

let instance = null;
/** This window's screens (one record, shared with the other windows through storage). */
export function screenLayouts() {
  instance ||= createScreenLayouts();
  return instance;
}
