// The one read of a product row's market summary. The page that owns the canonical views installs
// the reader -- it projects the view store's current state, so there is no second copy (a page copy merged from every
// snapshot and delta keeps values the view has cleared and invents a pre-open "reference only" row of its own).
let reader = () => null;

export function setProductSummaryReader(fn) {
  reader = typeof fn === "function" ? fn : () => null;
  return () => { if (reader === fn) reader = () => null; };
}

/** The summary of `code` as its view holds it now; {} when no view of it holds state. */
export function productSummaryOf(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return {};
  try { return reader(normalized) || {}; } catch (error) { console.warn("[product summary] reading failed", error); return {}; }
}
