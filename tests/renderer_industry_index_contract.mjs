// 即時報價's 產業指數 pages (BACKLOG 1v), behavioural: one current industry index (features/realtime/industry_index_store.js)
// that both a pick on 「Shioaji產業指數」 and a stock picked on the Shioaji product list change; 「產業指數」 draws it on the
// shared trend surface with its own constituents' breadth -- never the exchange-wide counts, and "--" when it has none.
import assert from "node:assert/strict";
import { createDocument } from "./lib/mini_dom.mjs";

const liveDocument = createDocument();
const storage = new Map();
const memoryStorage = () => {
  const items = new Map();
  return { items, getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => items.set(key, String(value)) };
};
globalThis.document = {
  createElement: (tag) => liveDocument.createElement(tag),
  createDocumentFragment: () => liveDocument.createDocumentFragment(),
  getElementById: (id) => liveDocument.getElementById(id),
  querySelector: (selector) => liveDocument.querySelector(selector),
};
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, devicePixelRatio: 1 };
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));

const { createIndustryIndexStore, INDUSTRY_INDEX_STORAGE_KEY, INDUSTRY_INDEXES_PATH } = await import("../ui/renderer/js/features/realtime/industry_index_store.js");
const { industryIndexTrendViewModel, industryIndexViewSpec } = await import("../ui/renderer/js/features/realtime/industry_index_view_model.js");
const { IndustryIndexListComponent, listHtml, currentLineHtml } = await import("../ui/renderer/js/features/realtime/components/industry_index_list_component.js");
const { TrendChartComponent } = await import("../ui/renderer/js/core/components/trend_chart_component.js");
const { setMarketBreadthReader, notifyMarketBreadthChanged } = await import("../ui/renderer/js/core/market_breadth_store.js");

const INDEXES = [
  { code: "IX0028", name: "半導體類指數", market: "tse" },
  { code: "IX0010", name: "水泥類指數", market: "tse" },
  { code: "IX0053", name: "櫃買半導體類指數", market: "otc" },
];
const STOCKS = {
  2330: { ok: true, code: "2330", found: true, industry_code: "24", market: "tse", index: INDEXES[0] },
  3105: { ok: true, code: "3105", found: true, industry_code: "24", market: "otc", index: INDEXES[2] },
  "0050": { ok: true, code: "0050", found: true, industry_code: "00", market: "tse", index: null },
  1234: { ok: true, code: "1234", found: true, industry_code: "33", market: "tse", index: null },
};
function fakeApi({ hold = {} } = {}) {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    if (path === INDUSTRY_INDEXES_PATH) return { ok: true, items: INDEXES, count: INDEXES.length };
    const code = decodeURIComponent(path.slice(`${INDUSTRY_INDEXES_PATH}/stock/`.length));
    if (hold[code]) await hold[code];
    if (code === "BROKEN") throw new Error("network down");
    return STOCKS[code] || { ok: true, code, found: false, index: null };
  };
  return { calls, fetchJson };
}

// --- 1. a stock -> its industry's index; 00 and an industry without an index -> 無對應產業指數 --------------------------
{
  const api = fakeApi();
  const saved = memoryStorage();
  const store = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: saved });
  assert.equal(store.snapshot().status, "none");
  const heard = [];
  store.subscribe((state) => heard.push(state));

  await store.followStock("2330");
  assert.deepEqual(store.snapshot(), { status: "index", origin: "stock", index: INDEXES[0], stock: "2330" });
  await store.followStock("3105");
  assert.equal(store.snapshot().index.code, "IX0053", "an OTC stock takes the index its own market's table names");
  await store.followStock("0050");
  assert.deepEqual(store.snapshot(), { status: "unmapped", origin: "stock", index: null, stock: "0050" }, "00 無產業別");
  await store.followStock("1234");
  assert.equal(store.snapshot().status, "unmapped", "an industry without an index");
  await store.followStock("9999");
  assert.equal(store.snapshot().status, "unmapped", "a stock the security master does not know");
  assert.deepEqual(heard.map((state) => state.stock), ["2330", "3105", "0050", "1234", "9999"], "listeners hear each change");

  // A lookup that fails is shown and recorded, never remembered.
  const remembered = saved.items.get(INDUSTRY_INDEX_STORAGE_KEY);
  await store.followStock("BROKEN");
  assert.equal(store.snapshot().status, "failed");
  assert.ok(warnings.some((line) => line.includes("reading BROKEN's index") && line.includes("network down")), "the failure is recorded");
  assert.equal(saved.items.get(INDUSTRY_INDEX_STORAGE_KEY), remembered, "a failure is not saved over the last choice");
}

// --- 2. both sources change the one current index; the latest intent wins -------------------------------------------
{
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const api = fakeApi({ hold: { 2330: slow } });
  const saved = memoryStorage();
  const store = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: saved });
  const pending = store.followStock("2330");
  store.selectIndex(INDEXES[1]);
  release();
  await pending;
  assert.deepEqual(store.snapshot(), { status: "index", origin: "list", index: INDEXES[1], stock: "" },
    "a list pick made after the click stays: the click's late answer is dropped");

  await store.followStock("2330");
  assert.equal(store.snapshot().index.code, "IX0028", "a product-list stock replaces a list pick");
  store.selectIndex(INDEXES[2]);
  assert.equal(store.snapshot().index.code, "IX0053", "and a list pick replaces a stock's index");

  // Remembered under one unversioned name, and read back by the next start.
  assert.equal(JSON.parse(saved.items.get(INDUSTRY_INDEX_STORAGE_KEY)).index.code, "IX0053");
  const restarted = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: saved });
  assert.deepEqual(restarted.snapshot(), store.snapshot());

  // The list is read once.
  await Promise.all([store.loadCatalog(), store.loadCatalog()]);
  await store.loadCatalog();
  assert.equal(api.calls.filter((path) => path === INDUSTRY_INDEXES_PATH).length, 1);
  assert.deepEqual(store.catalog().items.map((item) => item.code), ["IX0028", "IX0010", "IX0053"]);
}

// --- 2b. the stock 即時報價 opens on sets the index only while none was chosen ---------------------------------------
{
  const api = fakeApi();
  const saved = memoryStorage();
  const fresh = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: saved });
  await fresh.followStartupStock("2330");
  assert.equal(fresh.snapshot().index.code, "IX0028", "nothing chosen yet: the restored stock's index");
  fresh.selectIndex(INDEXES[1]);
  const restarted = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: saved });
  await restarted.followStartupStock("3105");
  assert.equal(restarted.snapshot().index.code, "IX0010", "a remembered choice stays");
}

// --- 3. the trend view model: with data, without data, and without an index -----------------------------------------
{
  const current = { status: "index", origin: "list", index: INDEXES[0], stock: "" };
  assert.deepEqual(industryIndexViewSpec(current, "2026-10-20T00:00:00"),
    { market: "IDX", code: "IX0028", trading_date: "2026-10-20", session: "DAY", channels: ["summary", "trend"] });
  assert.equal(industryIndexViewSpec(current, ""), null, "no view before the session authority names the date");
  assert.equal(industryIndexViewSpec({ status: "unmapped", stock: "0050" }, "2026-10-20"), null);

  const state = {
    summary: { trading_date: "2026-10-20", current: 1543, prev_close: 1552.16, reference_price: 1552.16, open: 1550.06, high: 1554.55, low: 1537.84,
      advance_count: 50, decline_count: 37, flat_count: 8, limit_up_count: 1, limit_down_count: 0 },
    trend: [{ minute_timestamp: "2026-10-20T09:01:00+08:00", close: 1550 }, { minute_timestamp: "2026-10-20T09:02:00+08:00", close: 1548 }],
  };
  const vm = industryIndexTrendViewModel({ current, state });
  assert.equal(vm.displayName, "半導體類指數");
  assert.equal(vm.displayCode, "IX0028");
  assert.equal(vm.points.length, 2);
  assert.equal(vm.prevClose, 1552.16);
  assert.deepEqual(vm.breadth, { trading_date: "2026-10-20", up_count: 50, down_count: 37, limit_up_count: 1, limit_down_count: 0, flat_count: 8 });
  assert.equal(vm.emptyOverlayText, "");
  assert.equal(vm.options.adapterType, "index", "drawn on the index axis without 加權指數's fixed identity");

  const cold = industryIndexTrendViewModel({ current, state: {} });
  assert.equal(cold.points.length, 0);
  assert.deepEqual(cold.breadth, {});
  assert.equal(cold.emptyOverlayText, "尚無產業指數走勢資料");

  const unmapped = industryIndexTrendViewModel({ current: { status: "unmapped", origin: "stock", index: null, stock: "0050" }, state });
  assert.equal(unmapped.emptyOverlayText, "無對應產業指數");
  assert.equal(unmapped.displayName, "0050 無對應產業指數");
  assert.deepEqual(unmapped.points, [], "another index's points never show under 無對應產業指數");
  assert.deepEqual(unmapped.breadth, {});
  assert.equal(industryIndexTrendViewModel({ current: { status: "none" } }).emptyOverlayText, "請在「Shioaji產業指數」選擇產業指數");
}

// --- 4. the 產業指數 surface shows its index's own breadth, not the exchange's, and "--" without it -------------------
{
  setMarketBreadthReader(() => ({ trading_date: "2026-10-20", advance_count: 411, decline_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
  notifyMarketBreadthChanged();
  const host = liveDocument.createElement("div");
  liveDocument.body.appendChild(host);
  const context = {
    mode: "live", services: {},
    dataSource: { subscribe: () => () => {}, invalidate: () => {} },
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { subscribe: () => () => {} },
  };
  const surface = new TrendChartComponent({ dataKey: "industryIndexTrend", variant: "sector" });
  surface.mount({ host, context, hydrate: false, slotId: "pane-1" });
  const roles = ["breadth-up", "breadth-down", "breadth-flat", "breadth-limit-up", "breadth-limit-down"];
  const shown = () => roles.map((role) => host.querySelector(`[data-role="${role}"]`)?.textContent ?? null);
  assert.deepEqual(host.querySelectorAll("[data-secondary-row]").map((row) => row.dataset.secondaryRow), ["session", "market"]);
  assert.deepEqual(shown(), ["--", "--", "--", "--", "--"], "the exchange breadth never fills the 產業指數 counters");
  assert.equal(host.querySelector('[data-role="product-name"]').textContent, "產業指數");

  const current = { status: "index", origin: "list", index: INDEXES[0], stock: "" };
  const state = { summary: { trading_date: "2026-10-20", current: 1543, prev_close: 1552.16, reference_price: 1552.16, open: 1550.06, high: 1554.55, low: 1537.84,
    advance_count: 50, decline_count: 37, flat_count: 8, limit_up_count: 1, limit_down_count: 0 }, trend: [] };
  surface.update(industryIndexTrendViewModel({ current, state }));
  assert.deepEqual(shown(), ["50", "37", "8", "1", "0"]);
  assert.equal(host.querySelector('[data-role="product-name"]').textContent, "半導體類指數");
  assert.ok(host.querySelector(".product-quote-code").hidden, "名稱 only: the IX code is not shown (使用者 10-22)");
  assert.equal(host.querySelector('[data-role="stock-high"]').textContent, "1554.55");

  notifyMarketBreadthChanged();
  setMarketBreadthReader(() => ({ trading_date: "2026-10-20", advance_count: 500, decline_count: 300, limit_up_count: 9, limit_down_count: 2, flat_count: 70 }));
  notifyMarketBreadthChanged();
  assert.deepEqual(shown(), ["50", "37", "8", "1", "0"], "an exchange breadth change leaves the index's own counts");

  surface.update(industryIndexTrendViewModel({ current: { status: "unmapped", origin: "stock", index: null, stock: "0050" }, state }));
  assert.deepEqual(shown(), ["--", "--", "--", "--", "--"], "the previous index's counts do not stay under 無對應產業指數");
  assert.equal(host.querySelector('[data-role="product-name"]').textContent, "0050 無對應產業指數");
  surface.destroy();
}

// --- 5. 「Shioaji產業指數」: lists 上市 then 上櫃, marks the current one, a click picks it, updates morph -----------------
{
  const api = fakeApi();
  const store = createIndustryIndexStore({ fetchJson: api.fetchJson, storage: memoryStorage() });
  assert.match(listHtml({ items: [], error: "" }, {}), /讀取產業指數清單中/);
  assert.match(listHtml({ items: [], error: "HTTP 500" }, {}), /讀取產業指數清單失敗：HTTP 500/);
  assert.match(currentLineHtml({ status: "unmapped", stock: "0050" }), /0050<\/b> 無對應產業指數/);

  const host = liveDocument.createElement("div");
  liveDocument.body.appendChild(host);
  const list = new IndustryIndexListComponent({ store });
  list.mount({ host, hydrate: false });
  await store.loadCatalog();
  const titles = host.querySelectorAll(".industry-index-list-group-title").map((node) => node.textContent);
  assert.deepEqual(titles, ["上市", "上櫃"]);
  const buttons = () => host.querySelectorAll("[data-industry-index]");
  assert.deepEqual(buttons().map((node) => node.dataset.industryIndex), ["IX0028", "IX0010", "IX0053"]);
  const body = host.querySelector('[data-role="industry-index-body"]');
  const first = buttons()[0];

  await store.followStock("2330");
  assert.deepEqual(buttons().filter((node) => node.classList.contains("current")).map((node) => node.dataset.industryIndex), ["IX0028"],
    "a stock's index is marked on the list too");
  assert.match(host.querySelector('[data-role="industry-index-current"]').textContent, /^目前 半導體類指數2330 所屬$/);

  // mini_dom does not bubble events: the list's delegated click listener is called with the clicked button's inner
  // span as its target, as the browser would deliver it.
  const root = host.querySelector(".industry-index-list");
  const clicks = root.listeners.filter(([type]) => type === "click").map(([, handler]) => handler);
  assert.equal(clicks.length, 1);
  clicks[0]({ target: buttons()[2].querySelector(".industry-index-list-name") });
  assert.equal(store.snapshot().index.code, "IX0053");
  assert.equal(store.snapshot().origin, "list");
  assert.deepEqual(buttons().filter((node) => node.classList.contains("current")).map((node) => node.dataset.industryIndex), ["IX0053"]);
  assert.equal(host.querySelector('[data-role="industry-index-body"]'), body, "the list body is patched, not rebuilt");
  assert.equal(buttons()[0], first, "an unchanged row keeps its element");
  list.destroy();
}

console.warn = realWarn;
console.log("renderer industry index contract passed");
