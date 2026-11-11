// A 台股 code's instrument kind (stock / etf / etn / reit): the product catalog's `type`, which the security master
// classifies once (service/market/reference/security_master_service.py instrument_kind). The renderer never derives a
// kind from a code; a code the catalog does not list has none (null), and nothing is priced on a guess.

/** The kind of a Shioaji code from the local product catalog (Electron main's copy); null when it is not listed. */
export async function lookupInstrumentKind(code) {
  const wanted = String(code || "").trim().toUpperCase();
  const search = globalThis.desktopAPI?.searchProductCatalogLocal;
  if (!wanted || typeof search !== "function") return null;
  const result = await search("shioaji", wanted, "", 5);
  const row = (Array.isArray(result?.items) ? result.items : []).find((item) => String(item?.code || "").toUpperCase() === wanted);
  return row?.type || null;
}
