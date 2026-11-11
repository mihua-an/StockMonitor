// The product list's selected row has one writer (BACKLOG D07-03): the quote table (realtime_quote_table.js) draws
// each row's class from the selected code it is handed. A selection -- a click on the list, a search, an event row,
// another component setting the symbol store -- only updates the symbol store; the page's selection listener then
// asks the table to patch the rows that lost and gained the selection. The click entry point never scans the rows.
// Driven through the real page over the fake live socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, rows: [], items: [], index: null, page: 1, total_pages: 1, total_rows: 0 }),
  { status: 200, headers: { "content-type": "application/json" } });
const page = await startRealtimePage({ tradingDate: "2026-10-27" });

// The mounted Shioaji list body: the presentation adapter publishes rows only while it exists.
const listBody = { dataset: {} };
const querySelector = globalThis.document.querySelector;
globalThis.document.querySelector = (selector) =>
  selector === '[data-role="product-list-body"][data-provider="shioaji"]' ? listBody : querySelector(selector);

const { appState } = await import("../ui/renderer/js/core/state.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
const { subscribeTaiwanProductListView } = await import("../ui/renderer/js/features/realtime/taiwan_product_list_store.js");
const { bindProductSelectionExtras } = await import("../ui/renderer/js/features/realtime/selection_controller.js");
appState.watchlistItems = [{ code: "2330" }, { code: "2317" }, { code: "2454" }];
page.showProducts(["2330", "2317", "2454"]);
bindProductSelectionExtras();
page.flush();

const published = [];
subscribeTaiwanProductListView((view) => published.push(view));
published.length = 0;

const selectAndPaint = (code) => { realtimeContext.symbolStore.setSelectedSymbol(code); page.flush(); page.flush(); };

selectAndPaint("2330");
assert.ok(published.length >= 1, "a selection asks the table to repaint");
let last = published.at(-1);
assert.equal(last.selectedCode, "2330", "the table is handed the new selection");
assert.ok(last.changedCodes?.has("2330"), "the newly selected row is patched");

published.length = 0;
selectAndPaint("2317");
last = published.at(-1);
assert.equal(last?.selectedCode, "2317");
assert.ok(last.changedCodes?.has("2330") && last.changedCodes?.has("2317"),
  "the row that lost the selection and the one that gained it are both patched");
assert.equal(published.length, 1, "one table patch per selection");

published.length = 0;
selectAndPaint("");
last = published.at(-1);
assert.equal(last?.selectedCode, "", "clearing the selection is drawn by the table too");
assert.ok(last.changedCodes?.has("2317"));

// The click entry point writes no row class: the table is the only writer.
const presentation = fs.readFileSync(new URL("../ui/renderer/js/features/realtime/realtime_presentation.js", import.meta.url), "utf8");
const start = presentation.indexOf("export async function selectRealtimeCodeImmediately");
const end = presentation.indexOf("\n}\n", start) > 0 ? presentation.indexOf("\n}\n", start) : presentation.indexOf("\r\n}\r\n", start);
const body = presentation.slice(start, end);
assert.ok(start >= 0 && body, "selection entry point must remain discoverable");
assert.doesNotMatch(body, /classList|querySelectorAll|product-list-selected-row/,
  "the click must not toggle row classes itself");
const writers = fs.readdirSync(new URL("../ui/renderer/js/", import.meta.url), { recursive: true })
  .filter((file) => file.endsWith(".js"))
  .filter((file) => fs.readFileSync(new URL(`../ui/renderer/js/${file.replaceAll("\\", "/")}`, import.meta.url), "utf8").includes("product-list-selected-row"))
  .map((file) => file.replaceAll("\\", "/"));
assert.deepEqual(writers, ["features/realtime/components/realtime_quote_table.js"],
  "only the quote table names the selected-row class");

console.log("product row selection owner contract passed (D07-03)");
