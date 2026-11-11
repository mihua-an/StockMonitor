import { readJsonPreference, writeJsonPreference } from "./preferences.js";

const STORAGE_KEY = "shioajiSlotLayoutConfigV9";
// A stored layout of any other version is refused (logged) and replaced by the page's default.
export const LAYOUT_VERSION = 10;

const REALTIME_TABBED_SLOT_DEFAULTS = Object.freeze({
  productList: Object.freeze({ activeComponentId: "productList", componentIds: Object.freeze(["productList"]) }),
  liveInfo: Object.freeze({ activeComponentId: "productListA", componentIds: Object.freeze(["productListA", "eventFeed"]) }),
  topAuxiliary: Object.freeze({
    activeComponentId: "marketTrend",
    componentIds: Object.freeze(["marketTrend", "futuresTrend", "tradeFlow", "priceFlow"]),
  }),
  analysisPrimary: Object.freeze({
    activeComponentId: "stockTrend",
    componentIds: Object.freeze(["stockTrend", "technicalAnalysis"]),
  }),
  analysisSecondary: Object.freeze({ activeComponentId: "orderbook", componentIds: Object.freeze(["orderbook"]) }),
  analysisTertiary: Object.freeze({ activeComponentId: "tickDetails", componentIds: Object.freeze(["tickDetails"]) }),
  analysisQuaternary: Object.freeze({ activeComponentId: "tickDetailsA", componentIds: Object.freeze(["tickDetailsA"]) }),
  auxiliary: Object.freeze({ activeComponentId: "orderbookA", componentIds: Object.freeze(["orderbookA"]) }),
  analysisQuinary: Object.freeze({ activeComponentId: "stockTrendA", componentIds: Object.freeze(["stockTrendA"]) }),
});

const PAGE_MODE = Object.freeze({
  realtime: "live",
  history: "replay",
});

export const DEFAULT_LAYOUTS = Object.freeze({
  realtime: Object.freeze({
    version: LAYOUT_VERSION,
    page: "realtime",
    slots: Object.freeze({
      productList: "productList",
      liveInfo: "productListA",
      topAuxiliary: "marketTrend",
      // The first lower panel is explicitly the selected-stock trend.
      analysisPrimary: "stockTrend",
      analysisQuaternary: "tickDetailsA",
      analysisSecondary: "orderbook",
      analysisTertiary: "tickDetails",
      auxiliary: "orderbookA",
      analysisQuinary: "stockTrendA",
    }),
    tabbedSlots: REALTIME_TABBED_SLOT_DEFAULTS,
  }),
  // 歷史回放's fixed top half; its lower row is a pane workspace of its own (features/history/pane_defaults.js).
  history: Object.freeze({
    version: LAYOUT_VERSION,
    page: "history",
    slots: Object.freeze({
      replayPrimary: "replayTrend",
      replayEvent: "eventFeed",
      replayTradeDetails: "tradeDetails",
    }),
    tabbedSlots: Object.freeze({
      replayPrimary: Object.freeze({ activeComponentId: "replayTrend", componentIds: Object.freeze(["replayTrend"]) }),
    }),
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function supportsPageSlot(registry, page, slotId, componentId) {
  return Boolean(registry?.supports?.(componentId, {
    mode: PAGE_MODE[String(page || "")] || "",
    slotId: String(slotId || ""),
    hostType: "inline",
  }));
}

function uniqueSupportedComponents(registry, page, slotId, componentIds = []) {
  const seen = new Set();
  return (Array.isArray(componentIds) ? componentIds : []).map(String).filter((componentId) => {
    if (!componentId || seen.has(componentId) || !supportsPageSlot(registry, page, slotId, componentId)) return false;
    const definition = registry?.get?.(componentId);
    if (definition && definition.availableInSlotEditor === false) return false;
    seen.add(componentId);
    return true;
  });
}

function validateTabbedSlots(raw, page, registry, fallback) {
  const defaults = fallback.tabbedSlots || {};
  if (!Object.keys(defaults).length) return {};
  const result = {};
  for (const [slotId, defaultEntry] of Object.entries(defaults)) {
    const hasTabbedCandidate = Boolean(raw?.tabbedSlots?.[slotId]);
    const candidate = raw?.tabbedSlots?.[slotId] || {};
    const defaultIds = uniqueSupportedComponents(registry, page, slotId, defaultEntry.componentIds);
    const explicitlyEmpty = hasTabbedCandidate && Array.isArray(candidate.componentIds) && candidate.componentIds.length === 0;
    const requestedIds = uniqueSupportedComponents(registry, page, slotId, candidate.componentIds);
    const componentIds = explicitlyEmpty ? [] : (requestedIds.length ? requestedIds : defaultIds);
    const requestedActive = String(candidate.activeComponentId || "");
    const activeComponentId = componentIds.includes(requestedActive)
      ? requestedActive
      : componentIds.includes(String(defaultEntry.activeComponentId || ""))
        ? String(defaultEntry.activeComponentId)
        : componentIds[0] || "";
    result[slotId] = { activeComponentId, componentIds };
  }
  return result;
}

export function validateLayoutConfig(raw, page, registry) {
  const fallback = clone(DEFAULT_LAYOUTS[page] || { version: LAYOUT_VERSION, page, slots: {} });
  if (!raw || typeof raw !== "object") return { config: fallback, recovered: true, reason: "missing" };
  if (Number(raw.version) !== LAYOUT_VERSION || String(raw.page || "") !== String(page)) {
    console.warn(`[layout config] stored ${page} layout refused (version ${raw.version}, page ${raw.page}); `
      + `only version ${LAYOUT_VERSION} is read, the default layout replaces it`);
    return { config: fallback, recovered: true, reason: "version" };
  }

  const slots = { ...fallback.slots };
  let recovered = false;
  for (const slotId of Object.keys(slots)) {
    const candidate = String(raw.slots?.[slotId] || "");
    if (candidate && supportsPageSlot(registry, page, slotId, candidate)) slots[slotId] = candidate;
    else if (candidate) recovered = true;
  }
  const tabbedSlots = validateTabbedSlots(raw, page, registry, fallback);
  return {
    config: { version: LAYOUT_VERSION, page, slots, ...(Object.keys(tabbedSlots).length ? { tabbedSlots } : {}) },
    recovered,
    reason: recovered ? "invalid_component" : "",
  };
}

// The stored layouts of every page, keyed by page. Unreadable or not JSON (both logged by preferences.js): no
// page has a stored layout, and each page starts from its default.
function readAllLayouts(storage, context) {
  const all = readJsonPreference(STORAGE_KEY, { storage, context });
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

export function loadLayoutConfig(page, registry, storage = null) {
  const result = validateLayoutConfig(readAllLayouts(storage, `${page} layout`)?.[String(page)], page, registry);
  // The repaired layout is written back; a refused write is logged there and the repaired layout is still used.
  if (result.recovered) saveLayoutConfig(result.config, storage);
  return result.config;
}

/**
 * Replace one page's layout in the stored layouts (read, change that page, write). `{ ok: true }` once kept;
 * `{ ok: false, error: "persist_failed" }` (logged with the page) when storage refused the write.
 */
export function saveLayoutConfig(config, storage = null) {
  const context = `saving the ${config.page} layout`;
  const all = readAllLayouts(storage, context);
  all[String(config.page)] = clone(config);
  return writeJsonPreference(STORAGE_KEY, all, { storage, context });
}

export function setSlotComponent(page, slotId, componentId, registry, storage = null) {
  const current = loadLayoutConfig(page, registry, storage);
  if (!supportsPageSlot(registry, page, slotId, componentId)) {
    return { ok: false, config: current, error: "unsupported_component" };
  }
  const next = clone(current);
  next.slots[String(slotId)] = String(componentId);
  const saved = saveLayoutConfig(next, storage);
  return saved.ok ? { ok: true, config: next } : { ok: false, config: current, error: saved.error };
}

export function setTabbedSlot(page, slotId, { componentIds = [], activeComponentId = "" } = {}, registry, storage = null) {
  const current = loadLayoutConfig(page, registry, storage);
  const defaults = current.tabbedSlots || {};
  if (!Object.prototype.hasOwnProperty.call(defaults, String(slotId))) {
    return { ok: false, config: current, error: "slot_not_tabbed" };
  }
  const normalizedIds = uniqueSupportedComponents(registry, page, slotId, componentIds);
  const requestedActive = String(activeComponentId || "");
  const normalizedActive = normalizedIds.includes(requestedActive) ? requestedActive : (normalizedIds[0] || "");
  const next = clone(current);
  next.tabbedSlots[String(slotId)] = { componentIds: normalizedIds, activeComponentId: normalizedActive };
  const saved = saveLayoutConfig(next, storage);
  return saved.ok ? { ok: true, config: next } : { ok: false, config: current, error: saved.error };
}
