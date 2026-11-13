// The Futu code box's search/submit, over its inputs so it is testable without the renderer: the Futu quote store
// (its product list, watchlist and select/replace), a security-master search and the product-page writer. Unsubscribed
// products are found in the master; on submit one is subscribed at once (the watchlist) and kept on a Futu product
// page, which the watchlist is rebuilt from at every start -- so the box reaches every Futu product, not only the
// listed ones, and what it added stays.

/**
 * @param {{ products: {code:string,name?:string}[], watchlist: {code:string,name?:string}[],
 *           replaceWatchlist: (items:{code:string,name:string}[]) => Promise<any>,
 *           select: (code:string) => Promise<any> }} store
 * @param {(query:string, signal?:AbortSignal) => Promise<{code:string,name:string}[]>} searchMaster
 * @param {(code:string) => Promise<string>} addToPage keeps the code on a Futu product page; answers the page's name
 */
export function createFutuSearchProvider({ store, searchMaster, addToPage }) {
  const upper = (value) => String(value || "").trim().toUpperCase();
  const listedCodes = () => store.products.map((row) => upper(row?.code)).filter(Boolean);
  const symbol = (code) => upper(code).split(".").pop();

  async function resolve(item) {
    const raw = upper(item?.code);
    if (!raw) return null;
    // A full Futu code (MARKET.SYMBOL) is taken as is; a selected suggestion always carries one.
    if (raw.includes(".")) return { code: raw, name: String(item?.name || "") };
    // A bare symbol typed and entered without a suggestion: resolve it to a full code, the list first then the master.
    const onList = store.products.find((row) => symbol(row?.code) === raw);
    if (onList) return { code: upper(onList.code), name: String(onList.name || "") };
    const rows = await searchMaster(raw);
    const exact = rows.find((row) => symbol(row?.code) === raw);
    return exact ? { code: upper(exact.code), name: String(exact.name || "") } : null;
  }

  return {
    async suggest(text, { signal } = {}) {
      const query = upper(text);
      const listed = new Set(listedCodes());
      let rows;
      try {
        rows = await searchMaster(text, signal);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // The master search is unavailable: the box still works over the already-listed products.
        console.warn("[futu search: security master] failed; showing listed products", error);
        rows = store.products
          .map((row) => ({ code: upper(row?.code), name: String(row?.name || "") }))
          .filter((row) => row.code && (row.code.includes(query) || symbol(row.code).startsWith(query) || row.name.toUpperCase().includes(query)));
      }
      // The products already on the list first (marked 列表), then the rest of the master's matches.
      return rows
        .filter((row) => row?.code)
        .map((row) => ({ code: upper(row.code), name: String(row.name || ""), note: listed.has(upper(row.code)) ? "列表" : "" }))
        .sort((a, b) => Number(b.note === "列表") - Number(a.note === "列表"))
        .slice(0, 12);
    },

    async submit(item) {
      const resolved = await resolve(item);
      if (!resolved) return { ok: false, message: "找不到此商品" };
      const { code, name } = resolved;
      if (!listedCodes().includes(code)) {
        // Not on the Futu list yet: add it (a new subscription) before showing it, as 設定 → 訂閱管理 does.
        const items = [
          ...store.watchlist.map((row) => ({ code: upper(row?.code), name: String(row?.name || "") })),
          { code, name },
        ];
        try {
          await store.replaceWatchlist(items);
        } catch (error) {
          console.warn("[futu search: adding to the watchlist] failed", { code }, error);
          return { ok: false, message: `加入商品列表失敗：${error?.message || error}` };
        }
        // The daemon refuses an instrument it cannot subscribe (UNSUPPORTED_INSTRUMENT): it is shown only if it landed.
        if (!store.watchlist.some((row) => upper(row?.code) === code)) {
          return { ok: false, message: "富途不支援此商品，無法加入商品列表" };
        }
        // Kept on a product page: the watchlist alone is rebuilt from the pages at the next start.
        try {
          await addToPage(code);
        } catch (error) {
          console.warn("[futu search: keeping the product on a product page] failed", { code }, error);
          await store.select(code);
          return { ok: false, message: `已訂閱，但沒有存進商品頁（重開 App 後不會保留）：${error?.message || error}` };
        }
      }
      await store.select(code);
      return { ok: true };
    },
  };
}
