import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { realtimeModuleSource, realtimePageSource } from "./lib/realtime_sources.mjs";
import { SelectionIntentStore } from "../ui/renderer/js/features/realtime/selection_intent_store.js";

// No built-in product: a new user with no saved selection sees a prompt in every detail panel, never someone's stock.
const fresh = new SelectionIntentStore({ panelState: {} });
assert.equal(fresh.detailCode, "", "no saved selection must leave the detail panels without a product");
assert.equal(fresh.selectedSymbol, "");
assert.equal(fresh.lastStockDetailCode, "");
assert.equal(fresh.trendCode, "TAIEX", "the main trend still opens on 加權指數");
fresh.restoreFromPanelState({});
assert.equal(fresh.detailCode, "", "a restore without a selection must not invent one");

const restored = new SelectionIntentStore({ panelState: { selectedSymbol: "2330" } });
assert.equal(restored.detailCode, "2330", "a saved selection is still restored");

// The page and its controllers (live_view_models.js holds the prompt, selection_controller.js the default).
const page = realtimePageSource();
const store = readFileSync(new URL("../ui/renderer/js/features/realtime/selection_intent_store.js", import.meta.url), "utf8");
for (const [name, source] of [["the 即時報價 page", page], ["selection_intent_store.js", store]]) {
  assert.doesNotMatch(source, /fallbackStock:\s*"\d/, `${name} must not hard-code a fallback product`);
}
// 五檔, 價量, 成交明細, 大單流向 and the stock trend all show the same prompt when nothing is selected.
const viewModels = realtimeModuleSource("live_view_models");
assert.match(viewModels, /const NO_SELECTION_TEXT = "請先在商品列表選擇商品";/);
assert.ok((viewModels.match(/NO_SELECTION_TEXT/g) || []).length >= 6, "every detail panel must use the shared no-selection prompt");

// Opening the product pages with nothing selected selects the active page's first product (user 10-13).
assert.match(page, /function selectFirstProductIfNone\(\) \{\r?\n  if \(selectedStockCode\(\)\) return;\r?\n  const first = instrumentOf\(String\(activePage\(\)\?\.codes\?\.\[0\]/, "the page's first product, as its row shows it (its stock or futures month)");
assert.match(page, /applyWatchPageToRealtime\(\);\r?\n  selectFirstProductIfNone\(\);/, "loading the product pages applies the default");

console.log("no default product contract passed");
