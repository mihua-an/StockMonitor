import assert from "node:assert/strict";

// renderPositions() (ui/renderer/js/features/account/positions_view.js)
// gained two dashboard-derived columns: unrealized_pnl / unrealized_pnl_pct
// (computed on the screen). The contract that matters most here:
// mark_price_available=false must render as "-", never as if the formatter
// had been handed a real 0 -- formatSignedMoney/formatSignedPercent's own
// null-handling is not trusted for this (signedMoney(null) actually treats
// null as a valid 0 via `Number(null) === 0`, a real footgun), so this test
// exercises the module's own explicit availability gate, not just the
// formatters in isolation.

globalThis.localStorage = { getItem: () => null, setItem() {} };

import { createDocument } from "./lib/mini_dom.mjs";

// The holdings body's rows are built and patched as elements (core/cell_patch.js); the test reads their markup.
const doc = createDocument();
function makeElement() { return doc.createElement("tbody"); }

let elements;
globalThis.document = {
  getElementById: (id) => elements.get(id) || null,
};

const { renderPositions } = await import("../ui/renderer/js/features/account/positions_view.js");

function formatSignedMoney(value) {
  const amount = Number(value);
  if (value === null || value === undefined || !Number.isFinite(amount)) return "--";
  return `${amount > 0 ? "+" : ""}${amount}`;
}
function formatSignedPercent(value) {
  const amount = Number(value);
  if (value === null || value === undefined || !Number.isFinite(amount)) return "-";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}%`;
}
function profitClass(value) {
  const amount = Number(value);
  return amount > 0 ? "price-up" : amount < 0 ? "price-down" : "price-flat";
}
function formatQty(value) { return String(value); }
function formatMoney(value) { return String(value); }

function setup() {
  elements = new Map([
    ["actualHoldingsBody", makeElement()],
    ["actualHoldingCountText", makeElement()],
    ["actualHoldingsTitle", makeElement()],
    ["actualHoldingNote", makeElement()],
  ]);
}

const baseOptions = { market: "台股", isPaper: false, formatQty, formatMoney, formatSignedMoney, formatSignedPercent, profitClass };

// 1. Available mark price with a positive return renders real values and the
//    positive CSS class, not "-".
{
  setup();
  renderPositions([
    { market: "台股", code: "2330", name: "台積電", qty: 1000, avg_cost: 500, cost_amount: 500000, mark_price_available: true, unrealized_pnl: 20000, unrealized_pnl_pct: 4 },
  ], baseOptions);
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.match(html, /\+20000/);
  assert.match(html, /\+4\.00%/);
  assert.match(html, /price-up/);
  assert.doesNotMatch(html, />-<\/td>/);
}

// 2. A negative return renders the negative class, still real values.
{
  setup();
  renderPositions([
    { market: "台股", code: "2330", name: "台積電", qty: 1000, avg_cost: 500, cost_amount: 500000, mark_price_available: true, unrealized_pnl: -20000, unrealized_pnl_pct: -4 },
  ], baseOptions);
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.match(html, /-20000/);
  assert.match(html, /price-down/);
}

// 3. mark_price_available=false must render "-" for BOTH pnl columns, never
//    call the formatters with the (null) values, and must not use a
//    positive/negative class -- only the neutral "flat" class.
{
  setup();
  renderPositions([
    { market: "台股", code: "2454", name: "聯發科", qty: 500, avg_cost: 800, cost_amount: 400000, mark_price_available: false, unrealized_pnl: null, unrealized_pnl_pct: null, mark_price_source: "UNAVAILABLE" },
  ], baseOptions);
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.doesNotMatch(html, /price-up/);
  assert.doesNotMatch(html, /price-down/);
  assert.match(html, /price-flat/);
  // Exactly two "-" cells for the pnl columns (not a stray formatter "--").
  const pnlCells = html.match(/<td class="price-flat">([^<]*)<\/td>/g) || [];
  assert.equal(pnlCells.length, 2);
  assert.ok(pnlCells.every((cell) => cell.includes(">-<")), `expected "-" cells, got: ${pnlCells}`);
}

// 4. US-market position (mark_price_source=UNSUPPORTED_MARKET) also renders
//    "-", same unavailable treatment as any other unavailable reason.
{
  setup();
  renderPositions([
    { market: "美股", code: "AAPL", name: "AAPL", qty: 10, avg_cost: 150, cost_amount: 1500, mark_price_available: false, unrealized_pnl: null, unrealized_pnl_pct: null, mark_price_source: "UNSUPPORTED_MARKET" },
  ], { ...baseOptions, market: "美股" });
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.match(html, /price-flat/);
  assert.doesNotMatch(html, /price-up/);
}

// 5. Zero-quantity/closed position (unrealized_pnl=0, a real computed zero)
//    must render as a real "0", distinct from the unavailable "-" case.
{
  setup();
  renderPositions([
    { market: "台股", code: "2330", name: "台積電", qty: 0, avg_cost: 0, cost_amount: 0, mark_price_available: true, unrealized_pnl: 0, unrealized_pnl_pct: null },
  ], baseOptions);
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.match(html, /price-flat/);
  // The money cell must show a real "0" (available=true path), not "-".
  const cells = html.match(/<td class="price-flat">([^<]*)<\/td>/g) || [];
  assert.equal(cells.length, 2);
  assert.ok(cells[0].includes(">0<"), `expected real 0 for a computed zero pnl, got: ${cells[0]}`);
}

// 6. Empty-state colspan matches the new 7-column layout.
{
  setup();
  renderPositions([], baseOptions);
  const html = elements.get("actualHoldingsBody").innerHTML;
  assert.match(html, /colspan="7"/);
}

console.log("account positions unrealized P&L render contract passed");
