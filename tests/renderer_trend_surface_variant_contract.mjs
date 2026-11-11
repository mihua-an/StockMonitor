import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every trend surface kind and what it does is declared once (trend_surface_variant.js); a name not in the table is
// refused where the surface is made, and the component branches on the declared capabilities.
const { trendSurfaceVariant, TREND_SURFACE_VARIANTS } = await import("../ui/renderer/js/core/components/trend_surface_variant.js");

// Every variant a caller passes today exists.
for (const name of ["auto", "market", "futures", "stock", "sector", "taiex", "us-stock"]) {
  assert.equal(trendSurfaceVariant(name).name, name);
}
assert.ok(trendSurfaceVariant("stock").benchmarks && trendSurfaceVariant("stock").searchable);
assert.ok(!trendSurfaceVariant("market").benchmarks && trendSurfaceVariant("market").liveControls);
assert.ok(!trendSurfaceVariant("futures").showsCode && trendSurfaceVariant("futures").controlsInHeader);
assert.ok(!trendSurfaceVariant("sector").showsCode && !trendSurfaceVariant("sector").liveControls);
assert.throws(() => trendSurfaceVariant("stocks"), /unknown variant "stocks"/);
assert.throws(() => trendSurfaceVariant("toString"), /unknown variant/);
assert.ok(Object.isFrozen(TREND_SURFACE_VARIANTS.stock));

const component = readFileSync(new URL("../ui/renderer/js/core/components/trend_chart_component.js", import.meta.url), "utf8");
assert.doesNotMatch(component, /variant === "(stock|futures|sector|market)"|\["market", "futures", "stock"\]/,
  "the component reads capabilities, not variant names");
console.log("renderer trend surface variant contract passed");
