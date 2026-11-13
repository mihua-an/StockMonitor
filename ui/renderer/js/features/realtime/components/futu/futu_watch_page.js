// A product the Futu code box found is kept on a Futu product page, as 商品頁設定 adds one: the page the Futu list
// shows (a watch page), else the first Futu page, else a new 美股 page. The Futu watch list is rebuilt from the pages
// whenever they load (product_list_components.js syncProductUniverse), so a product only on the watch list was dropped
// and unsubscribed at the next start.
import { apiGet, apiJsonPost } from "../../../../core/api.js";
import { opsBatch } from "../../../watch_pages/watch_page_ops.js";
import { pickFutuPage } from "./futu_watch_page_logic.js";

/** Fired in this window after a page was saved here (Electron main tells only the other windows). */
export const FUTU_WATCH_PAGE_SAVED = "futu-watch-page-saved";

/** Adds `code` to a Futu product page through settings_api; answers the page's name. Throws when it was not saved. */
export async function addToFutuWatchPage(code) {
  const payload = await apiGet("/api/watch-pages");
  if (payload?.ok === false || !Array.isArray(payload?.pages)) throw new Error(payload?.error || "讀不到商品頁");
  const plan = pickFutuPage(payload.pages, localStorage.getItem("moomooWatchPageActiveV1") || "", code,
    `page_${Date.now().toString(36)}`);
  if (!plan.ops.length) return plan.pageName;
  const result = await apiJsonPost("/api/subscriptions/ops", opsBatch(plan.ops, "futu_search"));
  if (!result || result.ok === false) throw new Error(result?.message || result?.error || "存進商品頁失敗");
  window.desktopAPI?.notifyWatchPagesChanged?.({ kind: "saved" });
  window.dispatchEvent(new Event(FUTU_WATCH_PAGE_SAVED));
  return plan.pageName;
}
