// D01-04＋D02-09＋D03-03: 漲跌 / 漲跌幅 had at least five calculators (Market Runtime, Rust B, the stock summary join,
// the order-book adapters, displayQuote, the stock trend and the Futu trend header), and the book compared its own
// result with Market Runtime's and kept its own. Market Runtime's summary `change` / `change_pct` is now the one value:
// every surface shows it as sent, and a pair of prices that implies another number never replaces it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };

const { displayQuote } = await import("../ui/renderer/js/core/auction_price.js");
const { StockOrderBookAdapter, FuturesOrderBookAdapter, FutuOrderBookAdapter } = await import("../ui/renderer/js/core/orderbook_adapters.js");
const { quoteChange } = await import("../ui/renderer/js/core/components/orderbook_header.js");
const { mergeStockMarketSummary } = await import("../ui/renderer/js/market_data/stock_market_summary.js");
const { viewStateToMoomooProductFields } = await import("../ui/renderer/js/features/realtime/moomoo_view_adapter.js");
const { trendMetrics } = await import("../ui/renderer/js/core/trend_metrics.js");

// A summary whose prices would imply +2.00 / +2.00%, while Market Runtime says +1.50 / +1.5% (its comparison price is
// the contract reference, not the 昨收 a panel would pick): the panels must show Market Runtime's.
const summary = { code: "2330", current: 102, prev_close: 100, reference_price: 100.5, change: 1.5, change_pct: 1.5, status: "live" };

const shown = displayQuote(summary);
assert.deepEqual([shown.change, shown.changePct], [1.5, 1.5], "displayQuote reads Market Runtime's change");

// A stale live signal carrying its own price_chg / pct_chg (the broker's hundredths) is not the row's 漲跌.
const merged = mergeStockMarketSummary({ productSummary: summary, liveSignal: { price_chg: 0, pct_chg: 0, change: 9, change_pct: 9 } });
assert.deepEqual([merged.change, merged.change_pct], [1.5, 1.5], "the product row's 漲跌 is the summary's");
assert.ok(!("price_chg" in merged) && !("pct_chg" in merged), "no second change field travels with the row");
assert.equal(mergeStockMarketSummary({ productSummary: { current: 102, prev_close: 100 } }).change ?? null, null, "none derived from prices");

const book = StockOrderBookAdapter.build({ code: "2330", signal: { ...summary, price_chg: 2, pct_chg: 2 },
  book: { bid_prices: [101.5], bid_volumes: [1], ask_prices: [102], ask_volumes: [1] } });
assert.deepEqual([book.priceChange, book.pctChange], [1.5, 1.5], "買賣報價 shows Market Runtime's, never its own subtraction");
assert.deepEqual([quoteChange(book).diff, quoteChange(book).pct], [1.5, 1.5], "the header formats what the view model carries");
assert.deepEqual([quoteChange({ lastPrice: 102, prevClose: 100 }).diff, quoteChange({ lastPrice: 102, prevClose: 100 }).pct], [null, null],
  "a view model without 漲跌 shows none: the header derives nothing");

const futures = FuturesOrderBookAdapter.build({ tick: { current: 23150, reference_price: 23000, change: 150, change_pct: 0.652 },
  book: { bid_prices: [23149], bid_volumes: [1] } });
assert.deepEqual([futures.priceChange, futures.pctChange], [150, 0.652]);

const futuFields = viewStateToMoomooProductFields({ summary: { current: 10.5, prev_close: 10, change: 0.4, change_pct: 4 } });
assert.deepEqual([futuFields.change, futuFields.change_pct], [0.4, 4], "a Futu row carries Market Runtime's 漲跌");
const futuBook = FutuOrderBookAdapter.build({ code: "US.NOK", quote: { current: 10.5, prev: 10, change: 0.4, changePct: 4 } });
assert.deepEqual([futuBook.priceChange, futuBook.pctChange], [0.4, 4]);

assert.deepEqual([trendMetrics({ change: 1.5, changePct: 1.5, reference: 100 }).change, trendMetrics({ reference: 100 }).change], [1.5, null]);

// No surface subtracts a reference from a price for 漲跌 any more, the closed 期貨走勢 tab included (its partition's
// summary is that session's close).
const read = (path) => readFileSync(new URL(`../ui/renderer/js/${path}`, import.meta.url), "utf8");
for (const path of ["core/auction_price.js", "core/orderbook_adapters.js", "core/components/orderbook_header.js",
  "core/components/trend_header_presenter.js", "core/trend_metrics.js", "market_data/stock_market_summary.js",
  "features/realtime/components/futu/futu_product.js", "features/realtime/components/futu/trend_component.js",
  "features/realtime/live_view_models.js"]) {
  assert.doesNotMatch(read(path), /(current|now|price|close)\s*-\s*(prev|reference|ref)\b|current\s*\/\s*prev\s*-\s*1/, `${path} derives no 漲跌`);
}
// The header colour is the sign of that one change as shown: 買賣報價 drew it from the broker's chg_type or from the
// price against the reference, so a view model without A's change still showed red / green.
const { quoteMoveClass } = await import("../ui/renderer/js/core/components/product_quote_header.js");
assert.deepEqual([quoteMoveClass(1.5), quoteMoveClass(-1), quoteMoveClass(-1e-12), quoteMoveClass(null)],
  ["price-up", "price-down", "price-flat", "price-flat"]);
for (const path of ["core/components/orderbook_component.js", "core/components/trend_header_presenter.js"]) {
  const source = read(path);
  assert.match(source, /quoteMoveClass\(/, `${path} colours the header by quoteMoveClass`);
  assert.doesNotMatch(source, /priceMoveClass|changeType/, `${path} derives no header colour from prices or chg_type`);
}
assert.doesNotMatch(read("core/orderbook_adapters.js"), /chg_type|changeType/, "no broker change type travels with a book");
const futuTrend = read("features/realtime/components/futu/trend_component.js");
assert.doesNotMatch(futuTrend, /data-role="trend-(name|code|price|change)"/, "D07-04: the Futu wrapper writes no trend header node");

console.log("renderer change single owner contract passed");
