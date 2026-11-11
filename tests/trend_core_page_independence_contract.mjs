// F2: the trend chart core (ui/renderer/js/core/trend) knows no page. A surface names its series through
// `identityResolver` and its card dock through `lookupDock` or the data-trend-lookup-* markup; the core never looks
// up a page's element ids or classes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "renderer", "js", "core", "trend");
const PAGE_NAMES = /realtime[A-Z-]|monitor[A-Z-]|history[A-Z-]|shioaji-|pageContainer|selectedQuote|dashboard-card|product-card|orderbook-card/;
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".js"))) {
  const code = fs.readFileSync(path.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const hit = code.match(PAGE_NAMES);
  assert.equal(hit, null, `core/trend/${name} names a page element: ${hit?.[0]}`);
}
console.log("trend core page independence contract passed");
