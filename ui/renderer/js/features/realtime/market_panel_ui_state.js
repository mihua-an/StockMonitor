const STORAGE_KEY = "shioajiMarketPanelUiStateV1";
const ALLOWED_REASONS = new Set(["USER_CLICK", "INITIAL_MOUNT", "RESTORE_STATE"]);
const TREND_MARKETS = new Set(["taiex", "futures", "stock"]);
const FUTURES_SESSIONS = new Set(["day", "night", "full"]);
const DETAIL_TABS = new Set(["orderbook", "trades", "tradeflow"]);

function safeParse(text) {
  try { return JSON.parse(text || "null"); } catch (error) { console.warn("[market panel: decoding the stored state] failed", error); return null; }
}

function normalizeState(raw = {}) {
  const trend = String(raw.activeTrendMarket || "taiex").toLowerCase();
  const session = String(raw.futuresSession || "full").toLowerCase();
  const detail = String(raw.activeDetailTab || "orderbook").toLowerCase();
  return {
    activeTrendMarket: TREND_MARKETS.has(trend) ? trend : "taiex",
    futuresSession: FUTURES_SESSIONS.has(session) ? session : "full",
    activeDetailTab: DETAIL_TABS.has(detail) ? detail : "orderbook",
    selectedSymbol: String(raw.selectedSymbol || "").trim().toUpperCase(),
    // The average-price line's stored default (true: shown whenever average-price points exist).
    showAveragePrice: raw.showAveragePrice !== false,
  };
}

// The realtime page's market panel choices (trend market, futures session, selected symbol), restored across restarts.
// The page reads them back with snapshot(); nothing listens for changes, so a change is only validated and saved.
export class MarketPanelUiState {
  constructor({ storage = globalThis.localStorage } = {}) {
    this.storage = storage;
    this.state = normalizeState(safeParse(this.storage?.getItem?.(STORAGE_KEY)) || {});
  }

  snapshot() { return { ...this.state }; }

  _persist() {
    try { this.storage?.setItem?.(STORAGE_KEY, JSON.stringify(this.state)); } catch (error) { console.warn("[market panel: saving the state] failed", error); }
  }

  setTrendMarket(value, { reason, selectedSymbol = undefined } = {}) {
    if (!ALLOWED_REASONS.has(reason)) throw new Error(`invalid trend-tab change reason: ${reason || "<missing>"}`);
    const next = String(value || "").toLowerCase();
    if (!TREND_MARKETS.has(next)) throw new Error(`invalid activeTrendMarket: ${value}`);
    if (selectedSymbol !== undefined) this.state.selectedSymbol = String(selectedSymbol || "").trim().toUpperCase();
    this.state.activeTrendMarket = next;
    this._persist();
    return this.snapshot();
  }

  setSelectedSymbol(value, { reason = "USER_CLICK" } = {}) {
    if (!ALLOWED_REASONS.has(reason)) throw new Error(`invalid selected-symbol reason: ${reason}`);
    const next = String(value || "").trim().toUpperCase();
    if (this.state.selectedSymbol === next) return this.snapshot();
    this.state.selectedSymbol = next;
    this._persist();
    return this.snapshot();
  }

  setFuturesSession(value, { reason } = {}) {
    if (!ALLOWED_REASONS.has(reason)) throw new Error(`invalid futures-session reason: ${reason || "<missing>"}`);
    const next = String(value || "").toLowerCase();
    if (!FUTURES_SESSIONS.has(next)) throw new Error(`invalid futuresSession: ${value}`);
    this.state.futuresSession = next;
    this._persist();
    return this.snapshot();
  }
}

export function createMarketPanelUiState(options) { return new MarketPanelUiState(options); }
