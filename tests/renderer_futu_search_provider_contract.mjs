// The Futu code box reaches every Futu product: suggest searches the whole security master (not only the listed
// products), and submit subscribes an unsubscribed product and keeps it on a Futu product page before showing it.
import assert from "node:assert/strict";
import { createFutuSearchProvider as create } from "../ui/renderer/js/features/realtime/components/futu/search_provider_logic.js";
import { pickFutuPage } from "../ui/renderer/js/features/realtime/components/futu/futu_watch_page_logic.js";

// Pages written by the tests: the codes each submit kept on a product page.
let kept = [];
const createFutuSearchProvider = (deps) => create({ addToPage: async (code) => { kept.push(code); return "美股"; }, ...deps });

function fakeStore() {
  kept = [];
  return {
    products: [{ code: "US.AAPL", name: "Apple" }],
    watchlist: [{ code: "US.AAPL", name: "Apple" }],
    replaced: null,
    selected: null,
    async replaceWatchlist(items) {
      this.replaced = items;
      // The daemon keeps what it accepts: by default every item lands on the watchlist.
      this.watchlist = items.map((item) => ({ code: item.code, name: item.name }));
      return this.watchlist;
    },
    async select(code) { this.selected = code; return code; },
  };
}

// --- suggest searches the master, not just the listed products, and marks the listed ones ---------------------
{
  const store = fakeStore();
  const master = async () => [{ code: "US.AAPL", name: "Apple" }, { code: "US.AMD", name: "AMD" }];
  const provider = createFutuSearchProvider({ store, searchMaster: master });
  const items = await provider.suggest("A");
  const codes = items.map((item) => item.code);
  assert.deepEqual(codes, ["US.AAPL", "US.AMD"], "an unsubscribed master hit (US.AMD) is offered, listed first");
  assert.equal(items.find((item) => item.code === "US.AAPL").note, "列表", "a listed product is marked 列表");
  assert.equal(items.find((item) => item.code === "US.AMD").note, "", "an unlisted product has no 列表 mark");
}

// --- suggest falls back to the listed products when the master search is unavailable ---------------------------
{
  const store = fakeStore();
  const master = async () => { throw new Error("master down"); };
  const provider = createFutuSearchProvider({ store, searchMaster: master });
  const items = await provider.suggest("AAPL");
  assert.deepEqual(items.map((item) => item.code), ["US.AAPL"], "the box still lists its own products on master failure");
}

// --- an AbortError from the master propagates (a superseded keystroke must not render) --------------------------
{
  const store = fakeStore();
  const master = async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; };
  const provider = createFutuSearchProvider({ store, searchMaster: master });
  await assert.rejects(() => provider.suggest("A"), /aborted/, "an abort is not swallowed into a product fallback");
}

// --- submit of a listed product selects it, nothing is added --------------------------------------------------
{
  const store = fakeStore();
  const provider = createFutuSearchProvider({ store, searchMaster: async () => [] });
  const result = await provider.submit({ code: "US.AAPL", name: "Apple" });
  assert.deepEqual(result, { ok: true });
  assert.equal(store.replaced, null, "a listed product is not re-added to the watchlist");
  assert.deepEqual(kept, [], "nor written to a page");
  assert.equal(store.selected, "US.AAPL");
}

// --- submit of an unsubscribed full code adds it to the watchlist, then selects it -----------------------------
{
  const store = fakeStore();
  const provider = createFutuSearchProvider({ store, searchMaster: async () => [] });
  const result = await provider.submit({ code: "US.NVDA", name: "NVIDIA" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.replaced, [{ code: "US.AAPL", name: "Apple" }, { code: "US.NVDA", name: "NVIDIA" }],
    "the new code is appended to the existing watchlist");
  assert.deepEqual(kept, ["US.NVDA"], "and kept on a product page, so the next start keeps it");
  assert.equal(store.selected, "US.NVDA");
}

// --- submit of a bare symbol with no suggestion resolves it against the master, then adds it --------------------
{
  const store = fakeStore();
  const master = async () => [{ code: "US.NVDA", name: "NVIDIA" }];
  const provider = createFutuSearchProvider({ store, searchMaster: master });
  const result = await provider.submit({ code: "NVDA" });
  assert.deepEqual(result, { ok: true });
  assert.equal(store.selected, "US.NVDA", "the bare symbol was resolved to its full Futu code");
  assert.ok(store.watchlist.some((row) => row.code === "US.NVDA"), "the resolved code was added");
}

// --- a code the daemon refuses (not on the watchlist after the write) is reported, not shown -------------------
{
  const store = fakeStore();
  store.replaceWatchlist = async function (items) {
    // The daemon dropped the unsupported code: the watchlist comes back without it.
    this.replaced = items;
    this.watchlist = items.filter((item) => item.code !== "US.BADCODE").map((item) => ({ code: item.code, name: item.name }));
    return this.watchlist;
  };
  const provider = createFutuSearchProvider({ store, searchMaster: async () => [] });
  const result = await provider.submit({ code: "US.BADCODE", name: "" });
  assert.equal(result.ok, false, "an unsupported instrument is reported");
  assert.match(result.message, /無法加入/);
  assert.equal(store.selected, null, "a product that could not be added is not selected");
  assert.deepEqual(kept, [], "nor kept on a page");
}

// --- a bare symbol that matches nothing is reported -----------------------------------------------------------
{
  const store = fakeStore();
  const provider = createFutuSearchProvider({ store, searchMaster: async () => [] });
  const result = await provider.submit({ code: "ZZZZ" });
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到/);
}

// --- a page that could not be written is reported: the product is subscribed now but would be gone after a restart ---
{
  const store = fakeStore();
  const provider = create({ store, searchMaster: async () => [], addToPage: async () => { throw new Error("settings_api down"); } });
  const result = await provider.submit({ code: "US.NVDA", name: "NVIDIA" });
  assert.equal(result.ok, false);
  assert.match(result.message, /沒有存進商品頁/);
  assert.equal(store.selected, "US.NVDA", "it is subscribed and shown meanwhile");
}

// --- which page: the one the Futu list shows, else the first Futu page, else a new 美股 page ----------------------
{
  const pages = [
    { id: "tw1", name: "台股", source: "shioaji", items: [{ code: "2330" }] },
    { id: "us1", name: "美股", source: "futu", items: [{ code: "US.AAPL" }, { code: "US.MU" }] },
    { id: "us2", name: "加密", source: "futu", items: [{ code: "CC.BTCUSD" }] },
  ];
  assert.deepEqual(pickFutuPage(pages, "us2", "US.NVDA", "new"),
    { pageName: "加密", ops: [{ op: "item.add", page_id: "us2", code: "US.NVDA", after_code: "CC.BTCUSD" }] },
    "the page the list shows, at its end");
  assert.deepEqual(pickFutuPage(pages, "overview", "US.NVDA", "new").ops,
    [{ op: "item.add", page_id: "us1", code: "US.NVDA", after_code: "US.MU" }], "總覽 is no page: the first Futu page");
  assert.deepEqual(pickFutuPage(pages, "tw1", "US.NVDA", "new").ops[0].page_id, "us1", "a Shioaji page is never written");
  assert.deepEqual(pickFutuPage(pages, "us1", "US.MU", "new"), { pageName: "美股", ops: [] }, "already on the page: nothing");
  assert.deepEqual(pickFutuPage([pages[0]], "overview", "US.NVDA", "new"), { pageName: "美股", ops: [
    { op: "page.add", page_id: "new", name: "美股", source: "futu", after: "tw1" },
    { op: "item.add", page_id: "new", code: "US.NVDA", after_code: "" },
  ] }, "no Futu page: a new 美股 page holding it");
}

console.log("futu search provider contract passed");
