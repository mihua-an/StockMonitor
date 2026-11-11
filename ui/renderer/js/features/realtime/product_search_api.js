// The Shioaji product search behind a header's code box: the security master's matches, the products on the caller's list
// first.
import { apiGet } from "../../core/api.js";

/** `listed`: the codes (upper case) the caller already lists; `signal` aborts the request. */
export async function suggestShioajiProducts(text, { signal, listed = new Set() } = {}) {
  const query = String(text || "").trim();
  const payload = await apiGet(`/api/security-master/search?q=${encodeURIComponent(query)}&limit=12`, { signal });
  const found = (Array.isArray(payload?.items) ? payload.items : [])
    .filter((item) => ["tse", "otc"].includes(String(item?.market || "").toLowerCase()))
    .map((item) => ({ code: String(item.code || "").toUpperCase(), name: String(item.name || ""), market: String(item.market || ""),
      note: listed.has(String(item.code || "").toUpperCase()) ? "列表" : String(item.market || "").toUpperCase() }));
  return found.sort((a, b) => Number(b.note === "列表") - Number(a.note === "列表"));
}
