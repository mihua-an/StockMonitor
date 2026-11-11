import assert from "node:assert/strict";
import fs from "node:fs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

const monitor = fs.readFileSync(new URL("../ui/renderer/js/features/realtime/realtime_presentation.js", import.meta.url), "utf8");
const realtime = fs.readFileSync(new URL("../ui/renderer/js/pages/realtime.js", import.meta.url), "utf8");
const tabbedHost = fs.readFileSync(new URL("../ui/renderer/js/core/tabbed_component_host.js", import.meta.url), "utf8");

const selectStart = monitor.indexOf("export async function selectRealtimeCodeImmediately");
const selectEnd = monitor.indexOf("function realtimeMergedRow", selectStart);
const selectBody = selectStart >= 0 && selectEnd > selectStart ? monitor.slice(selectStart, selectEnd) : "";
assert.ok(selectBody, "selection entry point must remain discoverable");
assert.equal((selectBody.match(/symbolStore\.setSelectedSymbol\(/g) || []).length, 1,
  "the direct symbol-store fallback must exist exactly once");
assert.match(selectBody, /services\?\.selection\?\.select/,
  "the product list must use the page selection authority before notifying components");
assert.doesNotMatch(selectBody, /renderRealtimeOrderbook\(|invalidateSelectedRealtimeTrend\(|scheduleRealtimeTrendInvalidate\(/,
  "the click entry point must not repeat component-owned rendering");

// The page's selection listener (selection_controller.js bindProductSelectionExtras), on the real page: one symbol
// event commits the selection once, and redraws nothing the mounted components already refresh from symbolStore.
{
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, rows: [], page: 1, total_pages: 1, total_rows: 0 }),
    { status: 200, headers: { "content-type": "application/json" } });
  const page = await startRealtimePage({ tradingDate: "2026-10-27" });
  const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
  const { bindProductSelectionExtras } = await import("../ui/renderer/js/features/realtime/selection_controller.js");
  bindProductSelectionExtras();
  let commits = 0;
  const setSelected = page.pageState.marketPanelUiState.setSelectedSymbol.bind(page.pageState.marketPanelUiState);
  page.pageState.marketPanelUiState.setSelectedSymbol = (...args) => { commits += 1; return setSelected(...args); };
  const invalidated = [];
  const invalidate = realtimeContext.dataSource.invalidate.bind(realtimeContext.dataSource);
  realtimeContext.dataSource.invalidate = (id, request) => { invalidated.push(`${id}:${request?.symbol || ""}`); return invalidate(id, request); };
  realtimeContext.symbolStore.setSelectedSymbol("2330");
  page.flush();
  assert.equal(commits, 1, "the selection intent must be committed once per symbol event");
  assert.deepEqual(invalidated.filter((entry) => /^(tickDetails|orderbook|tradeFlow|stockTrend):2330$/.test(entry)), [],
    "mounted components already refresh from symbolStore; page coordination must not rebuild them again");
}
assert.match(realtime, /services\.selection\s*=\s*\{[\s\S]*?publishSelectedSymbol\(/,
  "the dashboard context must expose the commit-before-fanout selection owner");

const selectTabStart = tabbedHost.indexOf("select(componentId, { persist = true, notify = true } = {})");
const selectTabEnd = tabbedHost.indexOf("switchComponent(componentId)", selectTabStart);
const selectTabBody = selectTabStart >= 0 && selectTabEnd > selectTabStart ? tabbedHost.slice(selectTabStart, selectTabEnd) : "";
assert.match(selectTabBody, /if \(!changed\) return false;/,
  "asserting an already-active dashboard tab must not rebuild its tab strip");

console.log("Selection uses one symbol fan-out and no duplicate component invalidation");
