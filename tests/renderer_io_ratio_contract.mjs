// 內外盤比: one shared bar (order book, 價量). Shares of the four segments sum to 100; nothing to show is 50 / 50.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ioRatioMarkup, patchIoRatio } from "../ui/renderer/js/core/components/io_ratio.js";
import { orderbookSource } from "./lib/orderbook_sources.mjs";

const node = () => ({ textContent: "", title: "", style: { width: "" } });
const nodes = { outside: node(), inside: node(), track: node(), outsideBar: node(), neutralBar: node(), unknownBar: node(), insideBar: node() };
patchIoRatio(nodes, { outside: 30, inside: 10 });
assert.equal(nodes.outside.textContent, "75.00%");
assert.equal(nodes.inside.textContent, "25.00%");
assert.equal(nodes.outsideBar.style.width, "75%");
assert.equal(nodes.neutralBar.style.width, "0%");
assert.equal(nodes.track.title, "", "no hover text (user 10-20)");
patchIoRatio(nodes, { outside: 1, inside: 1, neutral: 1, unknown: 1 });
assert.equal(nodes.unknownBar.style.width, "25%");
assert.equal(nodes.track.title, "");
patchIoRatio(nodes, null);
assert.equal(nodes.outside.textContent, "50.00%");
assert.equal(nodes.track.title, "");

assert.match(ioRatioMarkup({ label: "大單" }), /class="io-ratio io-ratio-labeled" data-role="io-ratio"><span class="io-ratio-label">大單<\/span>/);
// Both hosts build the bar from this one markup.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
assert.match(orderbookSource(), /ioRatioMarkup\(\{ className: "orderbook-io-ratio" \}\)/);
assert.match(read("ui/renderer/js/core/components/price_flow_component.js"), /ioRatioMarkup\(\{ label: "大單" \}\)\}\$\{ioRatioMarkup\(\{ label: "小單" \}\)/);
assert.doesNotMatch(read("ui/renderer/js/core/components/price_flow_component.js"), /集合競價撮合/, "auction volume is not shown in 價量");

// The order book's bar is Rust B's per-print 內外盤 (價量's out/in volumes), never the broker's cumulative
// bid_side_total_vol / ask_side_total_vol (user 11-01), for stocks and futures alike.
const { StockOrderBookAdapter, FuturesOrderBookAdapter } = await import("../ui/renderer/js/core/orderbook_adapters.js");
const { normalizeDaemonPriceVolume } = await import("../ui/renderer/js/market_data/realtime_market_math.js");
const ladder = { bid_prices: [115.5], bid_volumes: [10], ask_prices: [116], ask_volumes: [5] };
const broker = { bid_side_total_vol: 9000, ask_side_total_vol: 1000 };
const aggregate = normalizeDaemonPriceVolume({ out_volume: 3000, in_volume: 7000 });
const book = StockOrderBookAdapter.build({ code: "2303", book: ladder, signal: broker, aggregate });
assert.deepEqual([book.outsideTradeVolume, book.insideTradeVolume, book.outsideRatioPct], [3000, 7000, 30],
  "外盤 / 內盤 are B's out_volume / in_volume, not the broker's totals");
const futures = FuturesOrderBookAdapter.build({ tick: broker, book: ladder, aggregate });
assert.deepEqual([futures.outsideTradeVolume, futures.insideTradeVolume, futures.outsideRatioPct], [3000, 7000, 30]);
const noLadder = StockOrderBookAdapter.build({ code: "2303", book: ladder, signal: broker });
assert.deepEqual([noLadder.outsideTradeVolume, noLadder.insideTradeVolume, noLadder.outsideRatioPct], [null, null, 50],
  "before B's 價量 arrives there is no ratio, not the broker's");
// A 工作區 column reads its own view's 價量 and redraws the book when it changes.
const column = read("ui/renderer/js/features/workspace/workspace_column_runtime.js");
assert.match(column, /aggregate: normalizeDaemonPriceVolume\(state\?\.price_volume/);
assert.match(column, /changed\.has\("price_volume"\)\) redraw\.add\("orderbook"\)/);

// 外盤 (buyer-initiated) in the rising colour, 內盤 in the falling one, as the order book's 逐價內外盤 bars (使用者 10-30).
const css = read("ui/renderer/styles/components/io-ratio.css");
assert.match(css, /\.io-ratio-out \{\s*background: var\(--price-up-color\);/);
assert.match(css, /\.io-ratio-in \{\s*background: var\(--price-down-color\);/);
assert.match(css, /\.io-ratio-outside \{\s*color: var\(--price-up-color\);/);
assert.match(css, /\.io-ratio-inside \{[^}]*color: var\(--price-down-color\);/);
assert.match(read("ui/renderer/styles/components/orderbook.css"), /\.pv-imbalance \.pv-out \{\s*background: var\(--price-up-color\);/,
  "the same colours as the 逐價內外盤 bars");

console.log("renderer io ratio contract passed");
