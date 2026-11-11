import { callListener, notifyEach } from "./listeners.js";

export class ScopedValueStore {
  constructor(scopeId, initialValue = null) {
    this.scopeId = String(scopeId || "scope");
    this.value = initialValue;
    this.listeners = new Set();
  }

  get() { return this.value; }

  set(nextValue) {
    if (Object.is(this.value, nextValue)) return false;
    const previous = this.value;
    this.value = nextValue;
    notifyEach(this.listeners, `ScopedValueStore:${this.scopeId}: change`, nextValue, previous, this.scopeId);
    return true;
  }

  subscribe(listener, { immediate = false } = {}) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    if (immediate) callListener(listener, `ScopedValueStore:${this.scopeId}: immediate`, this.value, undefined, this.scopeId);
    return () => this.listeners.delete(listener);
  }

  clear() { this.listeners.clear(); }
  listenerCount() { return this.listeners.size; }
}

export function createSelectedSymbolStore(scopeId, initialSymbol = "") {
  const store = new ScopedValueStore(scopeId, String(initialSymbol || ""));
  return {
    scopeId: store.scopeId,
    getSelectedSymbol: () => String(store.get() || ""),
    setSelectedSymbol: (code) => store.set(String(code || "").trim()),
    subscribe: (listener, options) => store.subscribe(listener, options),
    clear: () => store.clear(),
    listenerCount: () => store.listenerCount(),
  };
}
