/**
 * Owns adaptive orderbook layout observation. The orderbook data and view
 * model stay in the page/dashboard context; this module only manages the DOM
 * geometry subscription and its cleanup.
 */
export function createRealtimeOrderbookController({
  documentRef = globalThis.document,
  ResizeObserverRef = globalThis.ResizeObserver,
} = {}) {
  let observer = null;

  function update() {
    const panel = documentRef?.querySelector?.(".orderbook");
    if (!panel) return false;
    // Keep the compact price-volume panel visible whenever the orderbook has
    // enough room for it, while preserving the bottom ratio panel.
    panel.classList.toggle("orderbook-hide-price-volume", panel.clientHeight < 405);
    return true;
  }

  function bind() {
    const panel = documentRef?.querySelector?.(".orderbook");
    if (!panel) return false;
    observer?.disconnect?.();
    observer = typeof ResizeObserverRef === "function"
      ? new ResizeObserverRef(() => update())
      : null;
    observer?.observe?.(panel);
    update();
    return true;
  }

  function dispose() {
    observer?.disconnect?.();
    observer = null;
  }

  return { bind, update, dispose, diagnostics: () => ({ active: Boolean(observer) }) };
}
