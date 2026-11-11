import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderedCells } from "./lib/rendered_cells.mjs";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";
import { realtimePageSource } from "./lib/realtime_sources.mjs";

// 即時持倉: the positions-changed chain must be live (a ledger publisher that was an empty function
// and a screen listening for `stock-monitor:actual-positions-changed`, which nothing sent, left it dead). app_api pushes
// the positions revision over Server-Sent Events, and the holdings pages (實際庫存, 模擬庫存) of both product lists show 持股／成本／
// 損益／損益% with the P&L computed on the screen from the row's live price (live_position_marks.js rule).
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
globalThis.window ??= globalThis;
globalThis.window.desktopAPI ??= { networkManifest: rendererNetworkManifest() };
globalThis.window.addEventListener ??= () => {};

const table = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
const { withProductRead } = await import("../ui/renderer/js/core/market_read_adapters.js");
// Rows as the product list hands them over: through the data boundary, carrying their read model.
const rowCells = (row, ...rest) => table.realtimeRowCells(withProductRead(row, "shioaji"), ...rest);
const holdingsModule = await import("../ui/renderer/js/features/realtime/ledger_holdings.js");

// --- cells: the four columns follow the user's own, P&L from the row's price; no price -> "--", never 0. The P&L is
// the 庫存 page's net 未實現 under the position's closing_terms (AccountingCore.closing_terms).
const tw = { amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: "0.003", tax_rounding: "floor" };
const us = { amount_rounding: "cent", fee_rate: "0.0008", min_fee: "0", fee_rounding: "cent", sell_tax_rate: "0.0000206", tax_rounding: "cent" };
const holdings = [{ code: "2330", position_qty: 2000, avg_cost: 100, cost_amount: 200080, closing_terms: tw },
  { code: "2344", position_qty: 1000, avg_cost: 50, cost_amount: 50020, closing_terms: tw }];
const priced = renderedCells(rowCells({ code: "2330", name: "台積電", current: 110 }, ["name", "position_qty", "position_avg_cost", "position_pnl", "position_pnl_pct"],
  new Map(holdings.map((item) => [item.code, item]))));
assert.match(priced, /<td class="">2,000<\/td>/, "持股");
assert.match(priced, /<td class="">100\.00<\/td>/, "成本");
assert.match(priced, /<td class="price-up">19,172<\/td>/, "損益 = 220,000 - fee 88 - tax 660 - 200,080");
assert.match(priced, /<td class="price-up">9\.58%<\/td>/, "損益%: the size, the colour is the direction");
const unpriced = renderedCells(rowCells({ code: "2344", name: "華邦電" }, ["position_qty", "position_pnl", "position_pnl_pct"],
  new Map(holdings.map((item) => [item.code, item]))));
assert.equal(unpriced, '<td class="">1,000</td><td class="">--</td><td class="">--</td>', "no live price: 損益 is unavailable, not 0");
const loss = renderedCells(rowCells({ code: "2344", current: 45 }, ["position_pnl"], new Map(holdings.map((item) => [item.code, item]))));
assert.equal(loss, '<td class="price-down">-5,173</td>');
const lossPct = renderedCells(rowCells({ code: "2344", current: 45 }, ["position_pnl_pct"], new Map(holdings.map((item) => [item.code, item]))));
assert.equal(lossPct, '<td class="price-down">10.34%</td>', "a loss's 損益% has its minus sign, not only the colour");
const usd = renderedCells(rowCells({ code: "NOK", current: 10.33 }, ["position_pnl"],
  new Map([["NOK", { code: "NOK", position_qty: 4, avg_cost: 9.4275, cost_amount: 37.71, closing_terms: us }]])));
assert.equal(usd, '<td class="price-up">3.58</td>', "a US holding keeps cents (41.32 - fee 0.03 - 37.71), not a rounded 4");

// --- sorting by 損益 uses the same computation
const sortBody = { matches: () => false };
table.applyRealtimeQuoteSort({ sortKey: "position_pnl", direction: "desc" }, sortBody);
const rows = [{ code: "2344", current: 60 }, { code: "2330", current: 110 }].map((row) => withProductRead(row, "shioaji"));
const sorted = table.sortedRealtimeQuoteRows(rows, sortBody, 0, new Map(holdings.map((item) => [item.code, item])));
assert.deepEqual(sorted.map((row) => row.code), ["2330", "2344"], "19,172 before 9,776");

// --- the holding columns are not offered in the column settings (they belong to the 實際庫存 page)
const { REALTIME_QUOTE_COLUMNS, REALTIME_HOLDING_COLUMNS } = await import("../ui/renderer/js/core/column_schemas.js");
assert.ok(!REALTIME_QUOTE_COLUMNS.some((column) => column.id.startsWith("position_")));
assert.deepEqual(REALTIME_HOLDING_COLUMNS.map((column) => column.title), ["股數", "損益", "損益%", "成本/股", "成本"]);

// --- 成本 (total) cell: the ledger's cost_amount; whole NT dollars, cents for a US holding
const costs = new Map([["2330", { code: "2330", position_qty: 2000, avg_cost: 100, cost_amount: 200000 }],
  ["NOK", { code: "NOK", position_qty: 4, avg_cost: 9.42, cost_amount: 37.68 }]]);
assert.equal(renderedCells(rowCells({ code: "2330" }, ["position_cost_amount"], costs)), '<td class="">200,000</td>');
assert.equal(renderedCells(rowCells({ code: "NOK" }, ["position_cost_amount"], costs)), '<td class="">37.68</td>');

// --- the 實際庫存 page has its own column list: separate storage, its own defaults, its own options
const presentation = await import("../ui/renderer/js/features/market/quote_presentation.js");
const { HOLDINGS_COLUMN_PROFILE, PRODUCT_COLUMN_PROFILE } = presentation;
assert.deepEqual(presentation.getRealtimeQuoteColumnConfig(HOLDINGS_COLUMN_PROFILE),
  ["name", "code", "position_qty", "position_pnl", "position_pnl_pct", "prev_close", "current", "position_avg_cost", "position_cost_amount"]);
const holdingOptions = presentation.getRealtimeQuoteColumnOptions(HOLDINGS_COLUMN_PROFILE).map((item) => item.key);
assert.ok(holdingOptions.includes("chg_1m") && holdingOptions.includes("position_cost_amount"), "every ordinary column is offered too");
assert.ok(!presentation.getRealtimeQuoteColumnOptions(PRODUCT_COLUMN_PROFILE).some((item) => item.key.startsWith("position_")));
const ordinaryBefore = presentation.getRealtimeQuoteColumnConfig(PRODUCT_COLUMN_PROFILE);
const stored = new Map();
globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
globalThis.window.dispatchEvent ??= () => true;
globalThis.CustomEvent ??= class extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } };
presentation.setRealtimeQuoteColumnSettings({ order: ["position_pnl", "name"], visible: { position_pnl: true, name: true } }, { profile: HOLDINGS_COLUMN_PROFILE });
assert.deepEqual([...stored.keys()], ["actualHoldingsQuoteColumnsV1"], "saving the holdings list never writes the ordinary one");
assert.deepEqual(presentation.getRealtimeQuoteColumnConfig(HOLDINGS_COLUMN_PROFILE), ["position_pnl", "name"]);
assert.deepEqual(presentation.getRealtimeQuoteColumnConfig(PRODUCT_COLUMN_PROFILE), ordinaryBefore, "the ordinary pages keep their columns");

// --- SSE parsing across chunk boundaries; only positions.changed frames; heartbeats ignored
const first = holdingsModule.parsePositionsChangeEvents('event: positions.changed\ndata: {"revision": 0}\n\n: heartbeat\n\nevent: positions.cha');
assert.deepEqual(first.events, [{ revision: 0 }]);
const second = holdingsModule.parsePositionsChangeEvents(`${first.rest}nged\r\ndata: {"revision": 3, "count": 2}\r\n\r\n`);
assert.deepEqual(second.events, [{ revision: 3, count: 2 }]);
assert.equal(second.rest, "");

// --- the stream: revisions are handed on; when it ends it reconnects with a growing back-off (no polling timer)
const encoder = new TextEncoder();
function streamOf(chunks) {
  let index = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (index < chunks.length ? { value: encoder.encode(chunks[index++]), done: false } : { done: true }) }) } };
}
const revisions = [];
const waits = [];
const urls = [];
let calls = 0;
let stop = null;
await new Promise((resolve) => {
  stop = holdingsModule.startPositionsChangeStream({
    urlOf: (path) => `http://127.0.0.1:8001${path}`,
    fetchImpl: async (url) => {
      urls.push(url);
      calls += 1;
      if (calls === 1) return streamOf(['event: positions.changed\ndata: {"revision": 4}\n\n', 'event: positions.changed\ndata: {"revision": 5}\n\n']);
      if (calls === 2) return { ok: false, status: 503, body: null };
      return streamOf(['event: positions.changed\ndata: {"revision": 6}\n\n']);
    },
    onRevision: (revision) => { revisions.push(revision); if (revision === 6) resolve(); },
    wait: async (ms) => { waits.push(ms); },
  });
});
stop();
assert.deepEqual(revisions, [4, 5, 6]);
assert.equal(urls[0], "http://127.0.0.1:8001/api/actual-account/positions/events");
assert.deepEqual(waits.slice(0, 2), [1000, 2000], "back-off grows after a failed reconnect");

// --- the dead chain is gone, and both product lists pass the positions only on a holdings page
const holdingsSource = readFileSync(new URL("../ui/renderer/js/features/realtime/ledger_holdings.js", import.meta.url), "utf8");
assert.ok(!holdingsSource.includes("stock-monitor:actual-positions-changed"));
assert.ok(!holdingsSource.includes('setInterval('), "no polling");
const realtimeSource = realtimePageSource();
assert.match(realtimeSource, /setRealtimeQuoteHoldings\(!productListOverviewOnly && holdingPages\.has\(activeWatchPageId\) \? page\.items : null\)/);
const futuSource = readFutuComponentSources();
assert.match(futuSource, /holdings:this\.holdingPages\.get\(this\.activePageId\)\?\.items\?\?null/);
assert.match(futuSource, /holdings:current\.holdings/);
// Both lists' ⚙ names the column list of the page they show (product_list_tools.js).
assert.equal((futuSource.match(/mountProductListTools\(host,\{activePageId:\(\)=>this\.activePageId,actionsHost\}\)/g) || []).length, 2);

// --- 模擬庫存: the paper wallet's holdings pages sit beside 實際庫存 in both product lists, read from its own ledger
const { actualHoldings, paperHoldings, HOLDINGS_LEDGERS, holdingsLedgerOfPage } = holdingsModule;
assert.deepEqual(HOLDINGS_LEDGERS.map((ledger) => ledger.name), ["實際庫存", "模擬庫存"], "tab order: 實際庫存, then 模擬庫存");
assert.deepEqual(actualHoldings.pageIds, { tw: "system-actual-holdings-tw", us: "system-actual-holdings-us" }, "a saved 實際庫存 tab still opens");
assert.deepEqual(paperHoldings.pageIds, { tw: "system-paper-holdings-tw", us: "system-paper-holdings-us" });
assert.equal(holdingsLedgerOfPage("system-paper-holdings-us"), paperHoldings);
assert.equal(holdingsLedgerOfPage("overview"), null);
assert.equal(paperHoldings.pages().tw.name, "模擬庫存");
assert.match(holdingsSource, /apiPrefix: "\/api\/paper-wallet"/, "模擬庫存 reads the paper wallet, never the actual ledger");
assert.match(realtimeSource, /systemPages: \[\.\.\.holdingPages\.values\(\)\]/);
assert.match(futuSource, /systemPages:\[\.\.\.this\.holdingPages\.values\(\)\]/);

// --- the positions stream runs only while someone listens: the last listener leaving stops it, a new one reopens it
{
  const opened = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) => {
    opened.push({ url, signal });
    // A stream that stays open until it is aborted.
    return Promise.resolve({ ok: true, body: { getReader: () => ({
      read: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    }) } });
  };
  try {
    const first = paperHoldings.subscribe(() => {});
    const second = paperHoldings.subscribe(() => {});
    assert.equal(opened.length, 1, "one stream per ledger, however many listeners");
    assert.match(opened[0].url, /\/api\/paper-wallet\/positions\/events$/);
    first();
    assert.equal(opened[0].signal.aborted, false, "a listener remains: the stream keeps running");
    second();
    assert.equal(opened[0].signal.aborted, true, "the last listener left: the stream stops");
    second();
    const third = paperHoldings.subscribe(() => {});
    assert.equal(opened.length, 2, "a new listener reopens the stream");
    assert.equal(opened[1].signal.aborted, false);
    third();
    assert.equal(opened[1].signal.aborted, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
}
// --- a refresh that only moves 成本 (cost_amount, e.g. a fee recalculation) is a change the screens hear
{
  const savedFetch = globalThis.fetch;
  let costAmount = 200000;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/positions/events")) return new Promise(() => {});
    if (String(url).includes("/api/sources")) {
      return new Response(JSON.stringify({ source_settings: { enabled_sources: ["shioaji"], sources: {} } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, revision: 1, positions: [{ code: "2330", name: "台積電", market: "台股", qty: 2000, avg_cost: 100, cost_amount: costAmount }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const heard = [];
    const leave = actualHoldings.subscribe((pages) => heard.push(pages.tw.items[0]?.cost_amount));
    await actualHoldings.refresh({ force: true });
    costAmount = 200285;
    await actualHoldings.refresh({ force: true });
    assert.deepEqual(heard, [200000, 200285], "a cost_amount-only change is announced");
    leave();
  } finally {
    globalThis.fetch = savedFetch;
  }
}
console.log("w8 live holdings contract passed");
