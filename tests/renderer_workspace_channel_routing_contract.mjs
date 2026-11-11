import assert from "node:assert/strict";

// A workspace column redraws only the components whose view channels changed: a summary-only delta never redraws
// 成交明細 (unless the reference price moved), a book delta never redraws the trend, and a snapshot redraws all three.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.desktopAPI = {};
const { WorkspaceColumn } = await import("../ui/renderer/js/features/workspace/workspace_column_runtime.js");

function column(summary = { reference_price: 100 }) {
  const invalidated = [];
  const col = Object.create(WorkspaceColumn.prototype);
  Object.assign(col, {
    disposed: false, viewGeneration: 1, spec: {},
    gateway: { snapshot: () => ({ summary: col.currentSummary }) },
    context: { dataSource: { invalidate: (name) => invalidated.push(name) } },
    currentSummary: summary,
  });
  return { col, invalidated };
}

const delta = (...channels) => ({ type: "delta", changedChannels: channels });
const { col, invalidated } = column();

col.handleEvent({ type: "snapshot" }, 1);
assert.deepEqual(invalidated.sort(), ["orderbook", "tickDetails", "trendChart"], "a snapshot redraws every component");

invalidated.length = 0;
col.handleEvent(delta("orderbook"), 1);
assert.deepEqual(invalidated, ["orderbook"], "a book delta redraws the book only");

invalidated.length = 0;
col.handleEvent(delta("summary", "trend", "trades"), 1);
assert.deepEqual(invalidated.sort(), ["orderbook", "tickDetails", "trendChart"], "a trade frame redraws what it changed");

invalidated.length = 0;
col.handleEvent(delta("summary"), 1);
assert.deepEqual(invalidated.sort(), ["orderbook", "trendChart"], "a summary delta with the same reference price leaves 成交明細 alone");

invalidated.length = 0;
col.currentSummary = { reference_price: 101 };
col.handleEvent(delta("summary"), 1);
assert.ok(invalidated.includes("tickDetails"), "a moved reference price recolours 成交明細");

invalidated.length = 0;
col.handleEvent(delta("price_volume"), 1);
assert.deepEqual(invalidated, ["orderbook"], "價量 redraws the book: its 內外盤比 is B's out/in volumes");

invalidated.length = 0;
col.handleEvent(delta("signals"), 1);
assert.deepEqual(invalidated, [], "a channel no column component shows redraws nothing");

invalidated.length = 0;
col.handleEvent(delta("trades"), 2);
assert.deepEqual(invalidated, [], "an event of a replaced view generation is ignored");

console.log("renderer workspace channel routing contract passed");
