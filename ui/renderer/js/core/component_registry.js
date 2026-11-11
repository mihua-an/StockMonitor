import { detachedWindowFor } from "./detached_windows.js";

function chooserPlacement(id, chooser) {
  if (chooser == null) return null;
  const row = Number(chooser.row), order = Number(chooser.order ?? 0);
  if (!Number.isInteger(row) || row < 0 || !Number.isInteger(order) || order < 0) {
    throw new Error(`component ${id} chooser needs whole-number row and order (got ${JSON.stringify(chooser)})`);
  }
  return Object.freeze({ row, order });
}

export class ComponentRegistry {
  constructor() { this.items = new Map(); }

  register(definition) {
    const id = String(definition?.id || "").trim();
    if (!id) throw new Error("component id is required");
    if (typeof definition?.create !== "function") throw new Error(`component ${id} create() is required`);
    // Only fields something enforces (N08): supportedModes / supportedSlots / supportedHosts gate supports(),
    // requiredCapabilities gates ComponentHost. supportsLive / supportsReplay restated supportedModes, and
    // followsSelectedSymbol / requiredData were stored but never read -- declaring them protected nothing.
    const normalized = Object.freeze({
      id,
      title: String(definition.title || id),
      // The tab's label when it differs from the title (Futu pages drop the "Futu" prefix on their tab; the
      // component stays a Futu one, and the chooser and every other place keep the full title).
      tabTitle: String(definition.tabTitle || ""),
      titleByMode: Object.freeze({ ...(definition.titleByMode || {}) }),
      provider: String(definition.provider || "shioaji").trim().toLowerCase() || "shioaji",
      supportedHosts: Object.freeze([...(definition.supportedHosts || [])].map(String)),
      supportedSlots: Object.freeze([...(definition.supportedSlots || [])].map(String)),
      supportedModes: Object.freeze([...(definition.supportedModes || ["live", "replay"])].map(String)),
      availableInSlotEditor: definition.availableInSlotEditor !== false,
      // Where a pane's 新增功能頁 offers it: a row of the chooser (its column is the provider) and its place in that
      // cell; absent = not offered there. The chooser is derived from these (chooserRows()), not listed apart.
      chooser: chooserPlacement(id, definition.chooser),
      // Whether it can be detached, and its window sizes, are not the definition's to say: ui/main/detached_windows.json
      // is the one list, the same one Electron main opens the window from.
      supportsDetachedWindow: detachedWindowFor(id) !== null,
      detachedWindow: Object.freeze({ ...(detachedWindowFor(id) || {}) }),
      requiredCapabilities: Object.freeze([...(definition.requiredCapabilities || [])].map(String)),
      requiredCapabilitiesByMode: Object.freeze(Object.fromEntries(
        Object.entries(definition.requiredCapabilitiesByMode || {}).map(([mode, items]) => [
          String(mode), Object.freeze([...(items || [])].map(String)),
        ])
      )),
      // Its data is Rust B's (the projection blocks): ComponentHost lays 分析資料重建中 over it while B rebuilds
      // (core/analysis_rebuild_notice.js).
      analysisSourced: definition.analysisSourced === true,
      reuseGroup: String(definition.reuseGroup || ""),
      dataKey: String(definition.dataKey || id),
      variant: String(definition.variant || "auto"),
      create: definition.create,
    });
    this.items.set(id, normalized);
    return normalized;
  }

  get(id) { return this.items.get(String(id || "")) || null; }
  /** The chooser's rows in order, each { shioaji: [ids], futu: [ids] }, from the definitions' chooser placement. */
  chooserRows() {
    const rows = new Map();
    for (const item of this.items.values()) {
      if (!item.chooser) continue;
      if (!rows.has(item.chooser.row)) rows.set(item.chooser.row, { shioaji: [], futu: [] });
      const cell = rows.get(item.chooser.row)[item.provider];
      if (!cell) throw new Error(`component ${item.id} is offered for provider ${item.provider}, which has no chooser column`);
      cell.push(item);
    }
    const ids = (cell) => cell.sort((left, right) => left.chooser.order - right.chooser.order).map((item) => item.id);
    return [...rows.keys()].sort((a, b) => a - b).map((row) => ({ shioaji: ids(rows.get(row).shioaji), futu: ids(rows.get(row).futu) }));
  }
  has(id) { return this.items.has(String(id || "")); }
  list() { return [...this.items.values()]; }
  titleFor(id, mode = "") {
    const item = this.get(id);
    if (!item) return String(id || "");
    return String(item.titleByMode?.[String(mode || "")] || item.title || item.id);
  }
  tabTitleFor(id, mode = "") {
    return String(this.get(id)?.tabTitle || "") || this.titleFor(id, mode);
  }

  supports(id, { mode, slotId, hostType } = {}) {
    const item = this.get(id);
    if (!item) return false;
    if (mode && item.supportedModes.length && !item.supportedModes.includes(String(mode))) return false;
    // A pane the user opened on a pane workspace (pane_layout.js: 即時報價, 歷史回放) is the generic "workspacePane" slot.
    const slot = String(slotId || "").startsWith("pane-") ? "workspacePane" : String(slotId || "");
    if (slot && item.supportedSlots.length && !item.supportedSlots.includes(slot)) return false;
    if (hostType && item.supportedHosts.length && !item.supportedHosts.includes(String(hostType))) return false;
    return true;
  }
}

export const componentRegistry = new ComponentRegistry();
