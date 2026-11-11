/**
 * Owns the product-list viewport mechanics for the realtime page.
 *
 * Product rows and selection remain owned by the page's SelectionIntentStore;
 * this controller deliberately keeps only the disposable row-snap adapter so
 * it cannot become a second source of product state.
 */
export function createRealtimeProductListController({
  documentRef = globalThis.document,
  enableScroll,
} = {}) {
  let rowSnap = null;

  function bind() {
    rowSnap?.destroy?.();
    const result = typeof enableScroll === "function"
      ? enableScroll(documentRef)
      : null;
    rowSnap = result?.rowSnap || null;
    return result || { rowSnap: null };
  }

  function dispose() {
    rowSnap?.destroy?.();
    rowSnap = null;
  }

  return {
    bind,
    dispose,
    get rowSnap() { return rowSnap; },
    diagnostics() { return { active: Boolean(rowSnap) }; },
  };
}
