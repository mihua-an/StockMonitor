import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";

// Renderer teardown contracts: what a page binds, its teardown ends.
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// The product tab rail's ResizeObserver, wheel/pointer listeners and rAF belong to one per-host binding that
// disposeProductPageTabs ends; both product lists call it from their teardown.
const productList = read("ui/renderer/js/features/realtime/product_list.js");
assert.match(productList, /export function disposeProductPageTabs\(host\) \{[\s\S]*?binding\.controller\.abort\(\);\s*binding\.observer\?\.disconnect\(\);\s*if \(binding\.frame\) cancelAnimationFrame\(binding\.frame\);/);
assert.doesNotMatch(productList, /productScrollRailBound|horizontalWheelBound/, "no dataset flag stands in for a binding");
for (const listener of productList.matchAll(/addEventListener\("(?:pointerdown|pointermove|pointerup|pointercancel|wheel)", [\s\S]*?\}(?:, \{[^}]*\})?\);/g)) {
  assert.match(listener[0], /signal/, `every rail listener is bound to the strip's signal: ${listener[0].slice(0, 60)}`);
}
assert.match(read("ui/renderer/js/pages/realtime.js"), /disposeProductPageTabs\(document\.querySelector\('\[data-role="product-list-pages"\]\[data-provider="shioaji"\]'\)/);
assert.match(readFutuComponentSources(), /disposeProductPageTabs\(this\.host\?\.querySelector\('\[data-role="product-list-pages"\]'\)\)/);

// The system page polls one request at a time (the next is scheduled after the previous answered), and an
// older sample never replaces a newer one.
const settings = read("ui/renderer/js/pages/settings_system.js");
assert.doesNotMatch(settings, /setInterval\(/, "no interval fires a refresh while one is still running");
assert.match(settings, /try \{ await fn\(\); \}[\s\S]*?const id = setTimeout\(/);
assert.match(settings, /Date\.parse\(payload\.snapshot\.sampled_at\) < Date\.parse\(snapshot\.sampled_at\)\) return;/);
console.log("renderer teardown contract passed");
