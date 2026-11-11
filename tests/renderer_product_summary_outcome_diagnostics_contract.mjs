import assert from "node:assert/strict";
import fs from "node:fs";
import { realtimePageSource } from "./lib/realtime_sources.mjs";

// The product rows read their numbers from their Market Runtime views: one read, productSummaryOf,
// projecting the view store's state. No REST summary fetch, no page copy merged from the same snapshots, no durable
// "product cache" loaded at startup, no pre-open projection invented by the renderer.
// The page and its controllers (canonical_view_owner.js installs the reader).
const source = realtimePageSource();
const presentation = fs.readFileSync(new URL("../ui/renderer/js/features/realtime/realtime_presentation.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /\/api\/market\/product-summaries/);
assert.doesNotMatch(source + presentation, /productMarketSummaries|applyCanonicalStockSummary|loadDurableProductSummaryCache|projectProductSummariesToNewEquitySession/);
assert.match(source, /setProductSummaryReader\(\(code\) => selectRealtimeView\(stockCanonicalViewSpec\(code\)/);
assert.match(presentation, /productSummary: productSummaryOf\(instrument\)/, "a row reads the view of what it shows: its stock or futures month");
assert.match(source, /heldCanonicalViews/);
console.log("product summaries are read from the views (S2c-06)");
