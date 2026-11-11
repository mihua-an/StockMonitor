import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The renderer reads each market's clock from the same table as Python and Rust A: config/market_timezones.json.
const table = JSON.parse(readFileSync(new URL("../config/market_timezones.json", import.meta.url), "utf8")).markets;
const { marketTimezone } = await import("../ui/renderer/js/core/market_read_adapters.js");
for (const [market, zone] of Object.entries(table)) {
  assert.equal(marketTimezone(market), zone, `${market}`);
  assert.equal(marketTimezone(market.toLowerCase()), zone, `${market} in lower case`);
}
const source = readFileSync(new URL("../ui/renderer/js/core/market_read_adapters.js", import.meta.url), "utf8");
const copy = source.match(/const MARKET_TIMEZONES = \{([^}]*)\}/)[1];
assert.deepEqual([...copy.matchAll(/([A-Z]+):/g)].map((m) => m[1]).sort(), Object.keys(table).sort(), "no market beyond the table");
assert.equal(marketTimezone("XX"), null, "an unknown market has no zone");
console.log("renderer market timezones contract passed");
