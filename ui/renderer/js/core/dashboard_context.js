import { ScopedValueStore, createSelectedSymbolStore } from "./scoped_state.js";

export class ScopedDataAdapter {
  constructor({ mode, contextId }) {
    this.mode = String(mode || "live");
    this.contextId = String(contextId || `${this.mode}:context`);
    this.resolvers = new Map();
    this.listeners = new Map();
    this.lastValues = new Map();
    // The presentation revision of each component's deliveries: what a component's gate orders frames by.
    this.revisions = new Map();
  }

  setResolver(componentId, resolver) {
    if (typeof resolver === "function") this.resolvers.set(String(componentId), resolver);
    else this.resolvers.delete(String(componentId));
  }

  resolve(componentId, request = {}) {
    const id = String(componentId || "");
    const resolver = this.resolvers.get(id);
    if (!resolver) return this.lastValues.get(id) ?? null;
    const value = resolver({ ...request, mode: this.mode, contextId: this.contextId });
    this.lastValues.set(id, value);
    return value;
  }

  subscribe(componentId, listener) {
    const id = String(componentId || "");
    if (typeof listener !== "function") return () => {};
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    const set = this.listeners.get(id);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  invalidate(componentId, request = {}) {
    const id = String(componentId || "");
    let value;
    try { value = this.resolve(id, request); }
    catch (error) {
      value = { availability: "UNAVAILABLE", error: error?.message || String(error) };
      console.error(`[DataAdapter:${this.contextId}] ${id} resolve failed`, error);
    }
    const revision = (this.revisions.get(id) || 0) + 1;
    this.revisions.set(id, revision);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value = { ...value, presentationRevision: revision };
      this.lastValues.set(id, value);
    }
    for (const listener of [...(this.listeners.get(id) || [])]) {
      try { listener(value); }
      catch (error) { console.error(`[DataAdapter:${this.contextId}] ${id} listener failed`, error); }
    }
    return value;
  }

  invalidateAll(request = {}) {
    for (const componentId of this.listeners.keys()) this.invalidate(componentId, request);
  }

  listenerCount(componentId = null) {
    if (componentId != null) return this.listeners.get(String(componentId))?.size || 0;
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  destroy() {
    this.listeners.clear();
    this.resolvers.clear();
    this.lastValues.clear();
    this.revisions.clear();
  }
}

export function createDashboardContext({ id, mode, capabilities = [], services = {} }) {
  const contextId = String(id || `${mode || "live"}:context`);
  const selectedSymbol = createSelectedSymbolStore(`${contextId}:selected-symbol`, "");
  const currentTimestamp = new ScopedValueStore(`${contextId}:timestamp`, "");
  const dataSource = new ScopedDataAdapter({ mode, contextId });
  const capabilitySet = new Set((capabilities || []).map(String));
  return {
    id: contextId,
    mode: String(mode || "live"),
    symbolStore: selectedSymbol,
    currentTimestamp,
    dataSource,
    capabilities: capabilitySet,
    services: { ...(services || {}) },
    supports(capability) { return !capability || capabilitySet.has(String(capability)); },
    setCapabilities(items = []) {
      capabilitySet.clear();
      for (const item of items) capabilitySet.add(String(item));
    },
    destroy() {
      selectedSymbol.clear();
      currentTimestamp.clear();
      dataSource.destroy();
    },
  };
}

export const realtimeContext = createDashboardContext({
  id: "live:realtime",
  mode: "live",
  capabilities: ["tick", "bidask", "tradeflow", "trend", "production_model", "monitor_events"],
});

export const replayHistoryContext = createDashboardContext({
  id: "replay:history",
  mode: "replay",
  capabilities: ["historical_tick", "historical_bidask", "tradeflow", "trend", "replay", "historical_events", "actual_trades"],
});
