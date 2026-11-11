// 試撮 (盤前 / 緩漲緩跌 / 尾盤) shows in 現價's place marked "#" while Market Runtime says the instrument is in a call
// auction; a real print (status live) shows the trade price again.
import assert from "node:assert/strict";
import { auctionPrice, priceText } from "../ui/renderer/js/core/auction_price.js";
import { renderedCells } from "./lib/rendered_cells.mjs";

assert.equal(auctionPrice({ status: "simtrade", indicative_price: 2475, current: null }), 2475, "盤前試撮");
assert.equal(auctionPrice({ status: "simtrade", indicative_price: 54.7, current: 54.7 }), 54.7, "尾盤 / 緩漲緩跌 after the day traded");
assert.equal(auctionPrice({ status: "live", indicative_price: 54.7, current: 54.7 }), null, "a stale indicative after a real print is not shown");
// A futures 試撮 quote carries its price as indicative_price; Market Runtime never makes it 現價 (10-27: it had also
// put the auction's open / high / low into the night session's range).
assert.equal(auctionPrice({ status: "simulated", indicative_price: 23150, current: null }), 23150, "a futures pre-open quote");
assert.equal(auctionPrice({ status: "simulated", current: 23150 }), null, "current is never read as the indicative price");
assert.equal(auctionPrice({ status: "simtrade", indicative_price: null }), null);
assert.equal(priceText(2475, { indicative: true }), "#2475.00");
assert.equal(priceText(null, { indicative: true }), "--");

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { renderRealtimePriceCell } = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
assert.match(renderedCells(renderRealtimePriceCell(60, 54.7, 60.1, 49.25, { indicative: true })), />#60\.00</);
assert.match(renderedCells(renderRealtimePriceCell(60, 54.7, 60.1, 49.25)), />60\.00</);

// ONE 現價 / 漲跌 / 漲跌幅 for 個股走勢, 買賣報價 and 商品列: 2344 pre-open at #180.50 against 179.50 showed
// +1.00 (+0.56%) in 個股走勢, 0.00 (0.00%) in 買賣報價 (the broker's pre-open price_chg) and no 漲幅 in the list.
const { displayQuote } = await import("../ui/renderer/js/core/auction_price.js");
const { StockOrderBookAdapter } = await import("../ui/renderer/js/core/orderbook_adapters.js");
const { realtimeRowCells } = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
const { withProductRead } = await import("../ui/renderer/js/core/market_read_adapters.js");
// Market Runtime computes the change once from the shown (indicative) price; the broker's pre-open price_chg 0 is no
// field of its summary and is never read (D01-04).
const preOpen = { code: "2344", status: "simtrade", indicative_price: 180.5, current: null, prev_close: 179.5, reference_price: 179.5,
  change: 1, change_pct: 1 / 179.5 * 100, price_chg: 0, pct_chg: 0 };
const quote = displayQuote(preOpen);
assert.deepEqual({ current: quote.current, indicative: quote.indicative, reference: quote.reference }, { current: 180.5, indicative: true, reference: 179.5 });
assert.equal(quote.change, 1);
assert.equal(displayQuote({ ...preOpen, change: null, change_pct: null }).change, null, "no change of Market Runtime's: none derived");
const book = StockOrderBookAdapter.build({ code: "2344", signal: preOpen, book: { bid_prices: [180], bid_volumes: [3], ask_prices: [181], ask_volumes: [2] } });
assert.equal(book.lastPrice, 180.5, "買賣報價 現價 is the indicative price");
assert.equal(book.indicative, true);
assert.ok(Math.abs(book.priceChange - quote.change) < 1e-9, "買賣報價 漲跌 = 個股走勢 漲跌");
assert.ok(Math.abs(book.pctChange - quote.changePct) < 1e-9, "買賣報價 漲跌幅 = 個股走勢 漲跌幅");
const cells = renderedCells(realtimeRowCells(withProductRead(preOpen, "shioaji"), ["current", "day_change_pct"]));
assert.match(cells, />#180\.50</, "商品列 現價 is the indicative price");
assert.match(cells, /0\.56/, "商品列 漲幅 from the same pair");
const live = displayQuote({ status: "live", indicative_price: 181, current: 182, prev_close: 179.5, reference_price: 179.5 });
assert.equal(live.current, 182, "after a real print the trade price is 現價");
console.log("renderer auction price contract ok");
