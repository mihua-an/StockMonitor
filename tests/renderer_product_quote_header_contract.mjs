import assert from "node:assert/strict";
import { readRendererCss } from "./lib/renderer_css.mjs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";
import { orderbookSource } from "./lib/orderbook_sources.mjs";
import { trendSurfaceSource } from "./lib/trend_surface_sources.mjs";

const css = readRendererCss();
const trend = trendSurfaceSource();
const book = orderbookSource();
const futu = readFutuComponentSources();

for (const [name, source] of [["trend (incl. the Futu us-stock surface)", trend], ["orderbook", book]]) {
  assert.match(source, /productQuoteHeaderShell/, `${name} must use the shared product quote header shell`);
}
// The Futu 個股走勢 is the trend component's own "us-stock" surface, not a second header.
assert.match(futu, /new TrendChartComponent\(\{manual:true,variant:"us-stock"\}\)/, "Futu trend must mount the trend component's us-stock surface");
assert.doesNotMatch(futu, /productQuoteHeaderShell/, "Futu trend must not build a second product header");

const orderbookHeaderRule = css.match(/\.product-quote-header\.compact\s*\{[^}]*\}/g)?.at(-1) || "";
assert.match(orderbookHeaderRule, /position:\s*relative\b/, "orderbook price must be positioned against its own shared header");
assert.doesNotMatch(orderbookHeaderRule, /position:\s*static/, "orderbook must not anchor its quote box to the whole card");
// One flex row centres every part vertically; the price box is pushed to the row's end (not offset by top / right,
// which a box in the flow ignores).
assert.match(css, /\.product-quote-header,\s*\n\.product-quote-header\.compact\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/,
  "orderbook price must share the trend header's vertical center");
assert.match(css, /\.product-quote-header \.product-quote-price-box\s*\{[^}]*margin-left:\s*auto/, "the price box sits at the row's end");
assert.doesNotMatch(css, /\.product-quote-header\.compact \.product-quote-price-box\s*\{/, "no compact-only price box offsets");
// Every header (compact or not) centres its middle cell with the one rule.
assert.match(css, /\.product-quote-header \.product-quote-center\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*top:\s*50%/,
  "orderbook error message must be centered in the same header");

console.log("shared product quote header layout contract passed");
