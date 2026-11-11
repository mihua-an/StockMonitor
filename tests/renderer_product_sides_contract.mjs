// One row per product (decisions.md 商品的現貨／期貨與月份): a stock's 現貨 and 期貨 months, 台指期／小台指 with only
// months. What a row shows -- the instrument every view, selection and detail panel reads -- is the product's chosen
// side and month (features/realtime/product_sides.js); a futures month is its own FUT view (market_data).
import assert from "node:assert/strict";

const store = new Map();
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { isFuturesMonthSymbol, parseFuturesMonthSymbol, shioajiMarketOf } = await import("../ui/renderer/js/market_data/futures_symbol.js");
const { stockCanonicalViewSpec } = await import("../ui/renderer/js/market_data/stock_view_spec.js");
const sides = await import("../ui/renderer/js/features/realtime/product_sides.js");
const { resolveInstrumentDisplayName } = await import("../ui/renderer/js/core/instrument_names.js");
const { futuresDisplayCode } = await import("../ui/renderer/js/market_data/futures_symbol.js");

// ---- a futures month is named <category><YYYYMM>; a stock, TXFR1 and a Futu code are not
assert.deepEqual(["CDF202611", "TXF202701", "MXF202612", "GR1202612"].map(isFuturesMonthSymbol), [true, true, true, true]);
assert.deepEqual(parseFuturesMonthSymbol("GR1202612"), { category: "GR1", month: "202612" }, "a category with a digit (京元電子)");
assert.deepEqual(["2330", "00878", "TXFR1", "US.AAPL", "00631L", "TXF"].map(isFuturesMonthSymbol), [false, false, false, false, false, false]);
assert.deepEqual(parseFuturesMonthSymbol("cdf202611"), { category: "CDF", month: "202611" });
assert.deepEqual([shioajiMarketOf("TXF202611"), shioajiMarketOf("TXFR1"), shioajiMarketOf("2330")], ["FUT", "FUT", "STK"]);

// ---- its view is the FUT view of the partition the caller names; a stock's stays the STK DAY view
const night = { trading_date: "2026-11-06", session: "NIGHT" };
assert.deepEqual(stockCanonicalViewSpec("TXF202611", "2026-11-07", night),
  { market: "FUT", code: "TXF202611", trading_date: "2026-11-06", session: "NIGHT",
    channels: ["summary", "trend", "trades", "orderbook", "tradeflow", "price_volume", "signals"] });
assert.equal(stockCanonicalViewSpec("CDF202611", "2026-11-07", null).trading_date, "", "no futures authority yet: never subscribed");
assert.deepEqual([stockCanonicalViewSpec("2330", "2026-11-07", night).market, stockCanonicalViewSpec("2330", "2026-11-07", night).session], ["STK", "DAY"]);

// ---- 台指期／小台指 are products: their bare code has no view, whichever path names it before the months are read
assert.equal(stockCanonicalViewSpec("TXF", "2026-11-07", night).trading_date, "", "no date: never subscribed");
assert.equal(stockCanonicalViewSpec("MXF", "2026-11-07", null).trading_date, "");
assert.equal(stockCanonicalViewSpec("2330", "2026-11-07", null).trading_date, "2026-11-07");
const { readFileSync: readSource } = await import("node:fs");
const listed = readSource(new URL("../service/market/reference/futures_contracts.py", import.meta.url), "utf8").match(/INDEX_FUTURES = \{([^}]*)\}/)[1];
for (const [, code] of listed.matchAll(/"([A-Z0-9]+)":/g)) assert.equal(stockCanonicalViewSpec(code, "2026-11-07", null).trading_date, "", `${code} is listed as an index future`);

// ---- no price is not a price of 0, so a row with no quote is not at its unknown 漲停
const { limitPriceClass, samePrice } = await import("../ui/renderer/js/core/components/orderbook_depth_table.js");
assert.equal(limitPriceClass(null, null, null), "");
assert.equal(samePrice(undefined, null), false);
assert.equal(limitPriceClass(100, 100, 90), "limit-up-price");

// ---- the products of the subscriptions view
sides.setProductSidesView({ instruments: [
  { source: "shioaji", market: "STK", code: "2330", name: "台積電", trade: true, orderbook: true,
    futures: { on: true, trade: false, orderbook: true, months: [], category: "CDF", months_listed: ["202611", "202612"] } },
  { source: "shioaji", market: "STK", code: "2454", trade: false, orderbook: false,
    futures: { on: true, trade: true, orderbook: false, months: [], category: "DVF", months_listed: ["202611", "202612"] } },
  { source: "shioaji", market: "STK", code: "2317", trade: true, orderbook: true,
    futures: { on: false, trade: true, orderbook: true, months: [], category: "DHF", months_listed: ["202611"] } },
  { source: "shioaji", market: "FUT", code: "TXF", name: "台指期", trade: true, orderbook: true,
    index_futures: { months: ["202612"], months_listed: ["202611", "202612", "202701"] } },
  { source: "shioaji", market: "STK", code: "00878", trade: true, orderbook: true },
  { source: "futu", market: "US", code: "US.AAPL", trade: true, orderbook: false },
] });

// The side a product opens on: the one subscribed with 明細 first (the trend is drawn from it), then 五檔.
assert.deepEqual(["2330", "2454", "2317", "TXF", "00878"].map(sides.instrumentOf), ["2330", "DVF202611", "2317", "TXF202611", "00878"]);
assert.equal(sides.productSides("TXF").spot, null, "an index future has no spot side");
assert.equal(sides.productSides("00878").fut, null, "no 個股期貨: no futures side");
assert.deepEqual(sides.productMonths("TXF"), ["202611", "202612", "202701"]);

// A futures month is headed by its product's name and shows its category as its code.
assert.deepEqual([resolveInstrumentDisplayName("shioaji", "CDF202612"), resolveInstrumentDisplayName("shioaji", "TXF202701")], ["台積電期", "台指期"]);
assert.deepEqual([futuresDisplayCode("CDF202612"), futuresDisplayCode("2330")], ["CDF", "2330"]);

// A futures month belongs to its product; anything else is its own product.
assert.deepEqual(["CDF202612", "TXF202701", "2330", "9999"].map(sides.productOfInstrument), ["2330", "TXF", "2330", "9999"]);

// The user's choice: kept per product and across restarts, and every listener hears which product changed.
const heard = [];
const stop = sides.subscribeProductSides((code) => heard.push(code));
sides.setProductChoice("2330", "fut", 1);
sides.setProductChoice("2454", "spot");
assert.deepEqual([sides.instrumentOf("2330"), sides.instrumentOf("2454")], ["CDF202612", "2454"]);
assert.deepEqual(heard, ["2330", "2454"]);
assert.deepEqual(JSON.parse(store.get("realtimeProductSides")), { 2330: { side: "fut", month: 1 }, 2454: { side: "spot", month: 0 } });
stop();
// A choice a product cannot show falls back: 00878 has no futures, a month index past the list is its last month.
sides.setProductChoice("00878", "fut", 0);
sides.setProductChoice("TXF", "fut", 9);
assert.deepEqual([sides.instrumentOf("00878"), sides.instrumentOf("TXF")], ["00878", "TXF202701"]);

// On 現 the picker carries a 「期」 hint after its options: shown closed, hidden once it opens (expand-picker.css),
// picking the month last looked at.
const { expandPickerHtml } = await import("../ui/renderer/js/core/components/expand_picker.js");
const spotPicker = expandPickerHtml({ options: [["spot", "現"], ["m0", "11月"], ["m1", "12月"]], current: "spot", hint: ["m1", "期"] });
assert.match(spotPicker, /<button type="button" class="is-active" data-pick="spot"[^>]*>現<\/button>.*12月<\/button><button type="button" class="is-hint" data-pick="m1" aria-pressed="false">期<\/button><\/span>$/);
assert.doesNotMatch(expandPickerHtml({ options: [["spot", "現"], ["m0", "11月"]], current: "m0" }), /is-hint/, "no hint: none drawn");
const { readFileSync } = await import("node:fs");
const pickerCss = readFileSync(new URL("../ui/renderer/styles/components/expand-picker.css", import.meta.url), "utf8");
assert.match(pickerCss, /\.expand-picker button\.is-hint \{[^}]*max-width: 64px;[^}]*opacity: 1;/, "the hint shows while closed");
assert.match(pickerCss, /\.expand-picker:hover button\.is-hint \{[^}]*max-width: 0;[^}]*opacity: 0;/, "the hint gives way to the months when open");

console.log("renderer product sides contract passed");
