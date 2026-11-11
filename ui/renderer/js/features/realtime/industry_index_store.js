// 目前產業指數 (BACKLOG 1v): the one current industry index of 即時報價. 「產業指數」 shows it, 「Shioaji產業指數」 picks it,
// and a stock picked on the Shioaji product list makes its own industry's index current. Both pages read this owner; neither
// keeps a copy.
//
// The indexes and a stock's index come from app_api (/api/product-catalog/industry-indexes...): the mapping stock ->
// industry_code -> index has one owner, service/market/reference/sector_indexes.py, which also brings those indexes onto
// the background list. The current index is remembered across restarts under one stored name.

export const INDUSTRY_INDEX_STORAGE_KEY = "realtimeIndustryIndex";
export const INDUSTRY_INDEXES_PATH = "/api/product-catalog/industry-indexes";

// What the current index is:
//   none     -- nothing chosen yet
//   index    -- an index (`index` set): picked from the list (origin "list") or a stock's (origin "stock")
//   unmapped -- the picked stock has no industry index (00 無產業別, or its industry has none)
//   failed   -- the picked stock's index could not be read (recorded)
const EMPTY = Object.freeze({ status: "none", origin: "", index: null, stock: "" });

function normalizedIndex(raw) {
  const code = String(raw?.code || "").trim().toUpperCase();
  if (!code) return null;
  return Object.freeze({ code, name: String(raw?.name || code), market: String(raw?.market || "").toLowerCase() });
}

function normalizedState(raw) {
  const status = String(raw?.status || "");
  const index = normalizedIndex(raw?.index);
  const stock = String(raw?.stock || "").trim().toUpperCase();
  const origin = raw?.origin === "stock" ? "stock" : raw?.origin === "list" ? "list" : "";
  if (status === "index" && index) return Object.freeze({ status, origin: origin || "list", index, stock: origin === "stock" ? stock : "" });
  if (status === "unmapped" && stock) return Object.freeze({ status, origin: "stock", index: null, stock });
  return EMPTY;
}

function defaultStorage() {
  try { return globalThis.localStorage || null; }
  catch (error) { console.warn("[industry index: opening the stored choice] failed", error); return null; }
}

async function defaultFetchJson(path) {
  const { apiGet } = await import("../../core/api.js");
  return apiGet(path);
}

export function createIndustryIndexStore({ fetchJson = defaultFetchJson, storage = defaultStorage() } = {}) {
  const listeners = new Set();
  let state = EMPTY;
  // Latest intent wins: a stock's lookup that lands after a newer choice (another stock, or a list pick) is dropped.
  let intent = 0;
  let catalog = Object.freeze({ items: [], loaded: false, error: "" });
  let catalogLoad = null;

  try {
    const stored = storage?.getItem?.(INDUSTRY_INDEX_STORAGE_KEY);
    if (stored) state = normalizedState(JSON.parse(stored));
  } catch (error) {
    console.warn("[industry index: reading the stored choice] failed", error);
  }

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(state); }
      catch (error) { console.error("[industry index: listener] failed", error); }
    }
  }

  function commit(next) {
    const normalized = normalizedState(next);
    // A failure is shown but never remembered: the next start shows the last real choice.
    const shown = next?.status === "failed"
      ? Object.freeze({ status: "failed", origin: "stock", index: null, stock: String(next.stock || "").toUpperCase() })
      : normalized;
    if (JSON.stringify(shown) === JSON.stringify(state)) return state;
    state = shown;
    if (shown.status !== "failed") {
      try { storage?.setItem?.(INDUSTRY_INDEX_STORAGE_KEY, JSON.stringify(shown)); }
      catch (error) { console.warn("[industry index: saving the choice] failed", error); }
    }
    emit();
    return state;
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 「Shioaji產業指數」: the user picked `index` ({ code, name, market }). */
    selectIndex(index) {
      intent += 1;
      const normalized = normalizedIndex(index);
      if (!normalized) return state;
      return commit({ status: "index", origin: "list", index: normalized });
    },
    /** The stock 即時報價 opens on (restored at startup): its industry's index, only while none was ever chosen --
     * a remembered choice (a list pick, or the stock picked last time) stays. */
    followStartupStock(code) {
      return state.status === "none" ? this.followStock(code) : Promise.resolve(state);
    },
    /** A stock picked on the Shioaji product list: its own industry's index becomes current. */
    async followStock(code) {
      const stock = String(code || "").trim().toUpperCase();
      if (!stock) return state;
      const mine = ++intent;
      let payload;
      try {
        payload = await fetchJson(`${INDUSTRY_INDEXES_PATH}/stock/${encodeURIComponent(stock)}`);
      } catch (error) {
        // not an error: a newer pick superseded this read; its own result is what the store shows.
        if (mine !== intent) return state;
        console.warn(`[industry index: reading ${stock}'s index] failed`, error);
        return commit({ status: "failed", stock });
      }
      if (mine !== intent) return state;
      if (!payload || payload.ok === false) {
        console.warn(`[industry index: reading ${stock}'s index] failed`, payload?.error || payload);
        return commit({ status: "failed", stock });
      }
      const index = normalizedIndex(payload.index);
      return commit(index ? { status: "index", origin: "stock", index, stock } : { status: "unmapped", stock });
    },
    /** The indexes the user can pick, read once (a failed read is recorded and tried again by the next caller). */
    catalog: () => catalog,
    loadCatalog() {
      if (catalog.loaded) return Promise.resolve(catalog);
      if (catalogLoad) return catalogLoad;
      catalogLoad = (async () => {
        try {
          const payload = await fetchJson(INDUSTRY_INDEXES_PATH);
          if (!payload || payload.ok === false || !Array.isArray(payload.items)) throw new Error(payload?.error || "no items");
          catalog = Object.freeze({ items: Object.freeze(payload.items.map(normalizedIndex).filter(Boolean)), loaded: true, error: "" });
        } catch (error) {
          console.warn("[industry index: reading the index list] failed", error);
          catalog = Object.freeze({ items: catalog.items, loaded: false, error: String(error?.message || error) });
        } finally {
          catalogLoad = null;
        }
        emit();
        return catalog;
      })();
      return catalogLoad;
    },
  };
}

export const industryIndexStore = createIndustryIndexStore();
