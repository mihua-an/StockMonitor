// The futures contract table is written with the Shioaji security master; at 15:00 of an expiry day it drops the
// expired month. Each product's futures months (GET /api/subscriptions) are read again when the catalog changes, so
// the 期貨 picker and the near month move on with the night instead of keeping the expired month until a restart.
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

await startRealtimePage({ tradingDate: "2026-11-18" });

const catalogListeners = [];
window.desktopAPI = {
  ...(window.desktopAPI || {}),
  onProductCatalogChanged: (listener) => { catalogListeners.push(listener); return () => {}; },
  onWatchPagesChanged: () => () => {},
};

const months = { now: ["202611", "202612"] };
const subscriptionReads = [];

globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes("/api/subscriptions")) {
    subscriptionReads.push(path);
    const body = { ok: true, rows: [], index_futures: {},
      pages: [], prefs: {}, items: [],
      products: [{ code: "TXF", index_futures: { months_listed: months.now, months: [] } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  // not an error: every other read this page makes is outside this contract and answered empty, never sent out
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

const controller = await import("../ui/renderer/js/features/realtime/selection_controller.js");
controller.bindWatchPageSources();
assert.equal(catalogListeners.length, 1, "the page follows catalog revisions");

const before = subscriptionReads.length;
months.now = ["202612", "202701"];
catalogListeners[0]({ revision: 42 });
for (let tick = 0; tick < 200 && subscriptionReads.length === before; tick += 1) await Promise.resolve();
assert.equal(subscriptionReads.length, before + 1, "a catalog revision reads each product's sides and months again");

console.log("renderer_product_sides_follow_catalog_contract: ok");
process.exit(0);
