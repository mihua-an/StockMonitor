const BENCHMARK_CODES = new Set(["TAIEX", "TXF", "TXFR1"]);

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeStockCode(value) {
  const code = normalizeCode(value);
  return code && !BENCHMARK_CODES.has(code) ? code : "";
}

function normalizeTrendCode(value) {
  const code = normalizeCode(value);
  if (!code || code === "TAIEX") return "TAIEX";
  if (code === "TXF" || code === "TXFR1") return "TXF";
  return code;
}

function normalizeDetailCode(value) {
  const code = normalizeCode(value);
  return code === "TXF" ? "TXFR1" : code;
}

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch (_error) { /* not an error: structuredClone cannot copy that value; the JSON copy below is used */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function initialFromPanelState(panelState = {}, { fallbackStock = "" } = {}) {
  const selectedSymbol = normalizeStockCode(panelState.selectedSymbol);
  const lastStockDetailCode = selectedSymbol || normalizeStockCode(fallbackStock);
  const market = String(panelState.activeTrendMarket || "taiex").trim().toLowerCase();
  const trendCode = market === "futures"
    ? "TXF"
    : market === "stock" && selectedSymbol ? selectedSymbol : "TAIEX";
  return {
    generation: 0,
    trendCode,
    // Product selection owns OrderBook/TradeDetail/TradeFlow independently of
    // the chart market.  Keep the restored stock selected even when the main
    // chart was last left on TAIEX or TXF; clearing it here made startup render
    // the remembered detail code without creating its focus/view subscription.
    selectedSymbol,
    detailCode: selectedSymbol || lastStockDetailCode,
    lastStockDetailCode,
    searchFocusCode: "",
    searchFocusMode: "NONE",
    lastReason: "INITIAL_MOUNT",
    lastSource: "market_panel_ui_state",
    lastTrigger: "restore",
    lastExternalGeneration: 0,
    updatedAt: new Date().toISOString(),
  };
}

export class SelectionIntentStore {
  constructor({ panelState = {}, fallbackStock = "", historyLimit = 100 } = {}) {
    this.historyLimit = Math.max(10, Number(historyLimit) || 100);
    this.state = initialFromPanelState(panelState, { fallbackStock });
    this.events = [];
    this.listeners = new Set();
  }

  snapshot() { return clone(this.state); }
  get generation() { return Number(this.state.generation || 0); }
  get trendCode() { return this.state.trendCode; }
  get selectedSymbol() { return this.state.selectedSymbol; }
  get detailCode() { return this.state.detailCode; }
  get lastStockDetailCode() { return this.state.lastStockDetailCode; }
  get searchFocusCode() { return this.state.searchFocusCode; }
  get searchFocusMode() { return this.state.searchFocusMode; }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _commit(patch = {}, meta = {}) {
    const next = { ...this.state, ...patch };
    const changedKeys = Object.keys(patch).filter((key) => !Object.is(this.state[key], next[key]));
    if (!changedKeys.length) return this.snapshot();
    const previous = this.snapshot();
    next.generation = Number(this.state.generation || 0) + 1;
    next.lastReason = String(meta.reason || "INTERNAL_SYNC");
    next.lastSource = String(meta.source || "selection_intent");
    next.lastTrigger = String(meta.trigger || "selection");
    next.lastExternalGeneration = Number(meta.externalGeneration || 0);
    next.updatedAt = new Date().toISOString();
    this.state = next;
    const event = {
      generation: next.generation,
      changedKeys,
      previous,
      current: this.snapshot(),
      reason: next.lastReason,
      source: next.lastSource,
      trigger: next.lastTrigger,
      externalGeneration: next.lastExternalGeneration,
      timestamp: next.updatedAt,
    };
    this.events.push(event);
    if (this.events.length > this.historyLimit) this.events.splice(0, this.events.length - this.historyLimit);
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot(), clone(event)); } catch (error) { console.warn("[selection intent: a listener] failed", error); }
    }
    return this.snapshot();
  }

  restoreFromPanelState(panelState = {}, meta = {}) {
    const restored = initialFromPanelState(panelState, { fallbackStock: this.state.lastStockDetailCode || "" });
    return this._commit({
      trendCode: restored.trendCode,
      selectedSymbol: restored.selectedSymbol,
      detailCode: restored.detailCode,
      lastStockDetailCode: restored.lastStockDetailCode,
      searchFocusCode: "",
      searchFocusMode: "NONE",
    }, { reason: "RESTORE_STATE", source: "market_panel_ui_state", trigger: "restore", ...meta });
  }

  setTrendCode(value, meta = {}) {
    return this._commit({ trendCode: normalizeTrendCode(value) }, meta);
  }

  setSelectedSymbol(value, meta = {}) {
    const selectedSymbol = normalizeStockCode(value);
    const patch = { selectedSymbol };
    if (selectedSymbol) {
      patch.lastStockDetailCode = selectedSymbol;
      patch.detailCode = selectedSymbol;
    }
    return this._commit(patch, meta);
  }

  setDetailCode(value, meta = {}) {
    const detailCode = normalizeDetailCode(value);
    const patch = { detailCode };
    const stockCode = normalizeStockCode(detailCode);
    if (stockCode) patch.lastStockDetailCode = stockCode;
    return this._commit(patch, meta);
  }

  setSearchFocus(value, { mode = "LIVE", ...meta } = {}) {
    const searchFocusCode = normalizeStockCode(value);
    return this._commit({
      searchFocusCode,
      searchFocusMode: searchFocusCode ? String(mode || "LIVE").trim().toUpperCase() : "NONE",
    }, meta);
  }

  setSearchFocusMode(mode, meta = {}) {
    if (!this.state.searchFocusCode) return this.snapshot();
    return this._commit({ searchFocusMode: String(mode || "LIVE").trim().toUpperCase() }, meta);
  }

  clearSearchFocus(meta = {}) {
    return this._commit({ searchFocusCode: "", searchFocusMode: "NONE" }, meta);
  }

  diagnostics() {
    return {
      state: this.snapshot(),
      events: this.events.map((event) => clone(event)),
    };
  }
}

export function createSelectionIntentStore(options) {
  return new SelectionIntentStore(options);
}
