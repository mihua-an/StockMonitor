// The 即時報價 page's product pages: the user's watch pages, 總覽 (every listed product once) and the holdings pages
// (實際庫存, 模擬庫存), and which one is showing.
import { HOLDINGS_LEDGERS } from "./ledger_holdings.js";

// The product pages as last read (written by selection_controller.js loadWatchPages and the page tabs).
export let watchPages = [];
// Why the custom pages are missing, when they are: a failed read must not look exactly like having none.
export let watchPagesLoadError = "";
// The TW holdings pages, one per ledger (實際庫存, 模擬庫存), as their stores last reported them.
export const holdingPages = new Map(HOLDINGS_LEDGERS.map((ledger) => [ledger.pageIds.tw, ledger.pages().tw]));
export let activeWatchPageId = "";
export function setWatchPages(pages, loadError = "") { watchPages = pages; watchPagesLoadError = loadError; }
export function setActiveWatchPageId(id) { activeWatchPageId = id; }
// A list too narrow for its table shows 總覽 whatever page is chosen; the choice itself stays.
export let productListOverviewOnly = false;
export function setProductListOverviewOnly(on) { productListOverviewOnly = Boolean(on); }

export function overviewPage() {
  const seen = new Set();
  const codes = [];
  const items = [];
  for (const page of watchPages) {
    if (String(page?.market || "tw").toLowerCase() === "us") continue;
    const metaByCode = new Map((Array.isArray(page?.items) ? page.items : []).map((item) => [String(item?.code || ""), item]));
    for (const rawCode of Array.isArray(page?.codes) ? page.codes : []) {
      const code = String(rawCode || "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
      const meta = metaByCode.get(code);
      if (meta) items.push({ ...meta, code });
    }
  }
  return { id: "overview", name: "總覽", codes, items, count: codes.length, virtual: true };
}

// Before loadWatchPages has chosen the page (it waits for both ledgers' holdings first), there is no page: falling
// back to 總覽 there subscribed every listed product's view whenever something reconciled during that wait, and
// released them all a few hundred ms later when the saved page was chosen (a startup burst of views opened only to be
// closed again, 144 on 10-19).
const NO_PAGE_YET = Object.freeze({ id: "", name: "", codes: Object.freeze([]), items: Object.freeze([]), count: 0, virtual: true });

export function activePage() {
  if (!activeWatchPageId) return NO_PAGE_YET;
  if (productListOverviewOnly || activeWatchPageId === "overview") return overviewPage();
  if (holdingPages.has(activeWatchPageId)) return holdingPages.get(activeWatchPageId);
  return watchPages.find((page) => String(page?.market || "tw").toLowerCase() !== "us" && String(page.id) === String(activeWatchPageId)) || overviewPage();
}
