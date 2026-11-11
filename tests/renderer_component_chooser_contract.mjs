// Every 即時報價 component a pane can hold (registered for the inline host in live mode) is offered by the pane's
// 新增功能頁 chooser, and the chooser is derived from the definitions themselves (`chooser: { row, order }` in
// dashboard_components.js -> ComponentRegistry.chooserRows()): no second list to forget a component in (模擬帳務 was
// registered on 10-17 and could not be placed until 10-19). Components the chooser leaves out on purpose are named here
// with the reason.
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
const registry = read("dashboard_components.js");
const host = read("core/tabbed_component_host.js");

const NOT_OFFERED = new Map([
  ["trendChart", "internal: the shared chart the trend components embed"],
  ["workspaceOrderbook", "多商品工作區 only"],
  ["workspaceTrendChart", "多商品工作區 only"],
]);

const registered = [];
const offered = new Set();
for (const block of registry.split("componentRegistry.register(").slice(1)) {
  const body = block.slice(0, block.indexOf("create:"));
  const id = body.match(/id:\s*"([^"]+)"/)?.[1];
  const hosts = body.match(/supportedHosts:\s*\[([^\]]*)\]/)?.[1] || "";
  const modes = body.match(/supportedModes:\s*\[([^\]]*)\]/)?.[1] || "";
  if (id && hosts.includes('"inline"') && modes.includes('"live"')) registered.push(id);
  if (id && /chooser:\s*\{/.test(body)) offered.add(id);
}
// The three exchange trends are registered in one loop with their placement in its table.
for (const [, id] of registry.matchAll(/\["(marketTrend|futuresTrend|stockTrend)", "[^"]+", "[a-z]+", \{ row: \d+, order: \d+ \}\]/g)) {
  registered.push(id);
  offered.add(id);
}
assert.ok(registered.includes("paperLedger") && registered.includes("orderbook") && registered.includes("stockTrend"), `registry parse found ${registered}`);

const missing = registered.filter((id) => !offered.has(id) && !NOT_OFFERED.has(id));
assert.deepEqual(missing, [], `live inline components the chooser does not offer: ${missing.join(", ")}`);
for (const id of NOT_OFFERED.keys()) assert.ok(!offered.has(id), `${id} is listed as not offered but the chooser offers it`);
assert.match(host, /this\.registry\.chooserRows\(\)/, "the chooser is built from the registry");
assert.doesNotMatch(host, /CHOOSER_ROWS/, "no chooser list beside the definitions");

// chooserRows(): rows in order, each provider's column ordered, an unknown provider column refused.
const { ComponentRegistry } = await import("../ui/renderer/js/core/component_registry.js");
const reg = new ComponentRegistry();
const create = () => ({});
reg.register({ id: "b", chooser: { row: 1, order: 1 }, create });
reg.register({ id: "a", chooser: { row: 1, order: 0 }, create });
reg.register({ id: "f", provider: "futu", chooser: { row: 0 }, create });
reg.register({ id: "hidden", create });
assert.deepEqual(reg.chooserRows(), [{ shioaji: [], futu: ["f"] }, { shioaji: ["a", "b"], futu: [] }]);
assert.throws(() => reg.register({ id: "x", chooser: { row: -1 }, create }), /chooser needs whole-number row and order/);
reg.register({ id: "y", provider: "ib", chooser: { row: 2 }, create });
assert.throws(() => reg.chooserRows(), /provider ib, which has no chooser column/);
console.log(`component chooser offers every live pane component (${offered.size} offered, ${NOT_OFFERED.size} by design not)`);
