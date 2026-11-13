import { registerProductQuoteSearchProvider } from "../../../../core/components/product_quote_search.js";
import { apiGet } from "../../../../core/api.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { createFutuSearchProvider } from "./search_provider_logic.js";
import { addToFutuWatchPage } from "./futu_watch_page.js";

// The Futu headers' code box searches the whole Futu security master (US stocks/ETFs, crypto), so an unsubscribed
// product can be found; submitting one that is not on the list yet subscribes it and keeps it on a Futu product page.
async function searchMaster(query, signal) {
  const q = String(query || "").trim();
  const payload = await apiGet(`/api/futu/security-master/search?q=${encodeURIComponent(q)}&limit=12`, { signal });
  return (Array.isArray(payload?.items) ? payload.items : [])
    .map((row) => ({ code: String(row?.code || "").toUpperCase(), name: String(row?.name || "") }))
    .filter((row) => row.code);
}

registerProductQuoteSearchProvider("futu", createFutuSearchProvider({ store: moomooQuoteStore, searchMaster, addToPage: addToFutuWatchPage }));
