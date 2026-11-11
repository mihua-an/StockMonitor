// The trend surface's header cells each have ONE writer -- BEHAVIOURAL, on the real component and its real shell.
//
//   * 上漲/下跌/漲停/跌停/平盤 of a Shioaji trend: the breadth store's subscription. A data frame writes none of them,
//     whatever breadth it carries; only 產業指數 (its own index's counts) writes them from its view model.
//   * the N分上漲／N分下跌 cells: the frame's header commit (update()). A horizon change in settings writes nothing
//     itself; it asks the data source for a new frame.
//   * the 盤中事件 switch's active / aria-pressed: the marker store's subscription. A click only changes the store,
//     and a data frame never touches the switch.
//
// Each was written by two or three paths before (a store/settings subscription, the click handler, and every frame
// again), so these checks count writes on the real nodes rather than read the final text.
import assert from "node:assert/strict";
import { createDocument } from "./lib/mini_dom.mjs";
import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";

const doc = createDocument();
globalThis.document = {
  createElement: (tag) => doc.createElement(tag),
  createDocumentFragment: () => doc.createDocumentFragment(),
  getElementById: (id) => doc.getElementById(id),
  querySelector: (selector) => doc.querySelector(selector),
};
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
};
// The window the marker and horizon stores announce on. Announcements are queued, so a test can tell what a click
// wrote by itself from what the store's announcement wrote.
const queued = [];
const target = new EventTarget();
globalThis.window = {
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, devicePixelRatio: 1,
  addEventListener: (...args) => target.addEventListener(...args),
  removeEventListener: (...args) => target.removeEventListener(...args),
  dispatchEvent: (event) => { queued.push(event); return true; },
};
const deliver = () => { while (queued.length) target.dispatchEvent(queued.shift()); };

const { TrendChartComponent } = await import("../ui/renderer/js/core/components/trend_chart_component.js");
const { setMarketBreadthReader, notifyMarketBreadthChanged } = await import("../ui/renderer/js/core/market_breadth_store.js");
const { setTrendFooterHorizons } = await import("../ui/renderer/js/core/trend_footer_horizons.js");
const { stockTrendEventMarkersVisible } = await import("../ui/renderer/js/core/event_markers.js");

// Every write to a node: its text, its class list, its attributes.
function countWrites(node) {
  const counter = { count: 0 };
  const proto = Object.getPrototypeOf(node);
  const textDescriptor = Object.getOwnPropertyDescriptor(proto, "textContent")
    || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), "textContent");
  Object.defineProperty(node, "textContent", {
    get() { return textDescriptor.get.call(this); },
    set(value) { counter.count += 1; textDescriptor.set.call(this, value); },
    configurable: true,
  });
  const setAttribute = node.setAttribute.bind(node);
  node.setAttribute = (name, value) => { counter.count += 1; setAttribute(name, value); };
  const toggle = node.classList.toggle.bind(node.classList);
  node.classList.toggle = (...args) => { counter.count += 1; return toggle(...args); };
  return counter;
}

const invalidations = [];
const liveContext = () => ({
  mode: "live",
  services: {},
  dataSource: { subscribe: () => () => {}, invalidate: (key) => { invalidations.push(key); } },
  symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
  currentTimestamp: { subscribe: () => () => {} },
});
const role = (host, name) => host.querySelector(`[data-role="${name}"]`);
const BREADTH_ROLES = ["breadth-up", "breadth-down", "breadth-limit-up", "breadth-limit-down", "breadth-flat"];
const stockVm = (extra = {}) => withMarketRead({
  points: [], displayName: "台積電", displayCode: "2330", symbol: "2330", currentPrice: 1105, prevClose: 1090,
  stockInfo: { open: 1092, high: 1110, low: 1088, prevClose: 1090 },
  metrics: { limitUp: 1199, limitDown: 981, change: 15, changePct: 1.38, amplitude: 2.02, up3m: 0.58, down3m: 0.42, up5m: 0.55, down5m: 0.45 },
  ...extra,
});

setMarketBreadthReader(() => ({ trading_date: "2026-11-03", up_count: 411, down_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
notifyMarketBreadthChanged();

const host = doc.createElement("div");
host.setAttribute("data-component-slot", "analysisPrimary");
doc.body.appendChild(host);
const surface = new TrendChartComponent({ dataKey: "stockTrend", variant: "stock" });
surface.mount({ host, context: liveContext(), hydrate: false, slotId: "analysisPrimary" });
assert.deepEqual(BREADTH_ROLES.map((name) => role(host, name).textContent), ["411", "391", "7", "3", "72"],
  "the breadth store fills the row at mount");

// --- D07-05: the exchange breadth row has one writer, the breadth store ---------------------------------------------
{
  const counters = BREADTH_ROLES.map((name) => countWrites(role(host, name)));
  // A frame carrying different counts (an old producer, a stale snapshot) never reaches the row.
  for (let frame = 0; frame < 3; frame += 1) {
    surface.update(stockVm({ breadth: { trading_date: "2026-11-03", up_count: frame, down_count: frame, limit_up_count: frame, limit_down_count: frame, flat_count: frame } }));
  }
  assert.deepEqual(counters.map((c) => c.count), [0, 0, 0, 0, 0], "a data frame writes no exchange breadth cell");
  assert.deepEqual(BREADTH_ROLES.map((name) => role(host, name).textContent), ["411", "391", "7", "3", "72"]);
  setMarketBreadthReader(() => ({ trading_date: "2026-11-03", up_count: 412, down_count: 390, limit_up_count: 8, limit_down_count: 4, flat_count: 71 }));
  notifyMarketBreadthChanged();
  assert.deepEqual(counters.map((c) => c.count), [1, 1, 1, 1, 1], "a store change writes each cell exactly once");
  assert.deepEqual(BREADTH_ROLES.map((name) => role(host, name).textContent), ["412", "390", "8", "4", "71"]);
}

// --- D07-06: the prediction cells are written by the frame's header commit alone -------------------------------------
{
  const cells = host.querySelectorAll('[data-role="prediction-cell"]');
  const labels = cells.map((cell) => cell.querySelector('[data-role="prediction-label"]'));
  const values = cells.map((cell) => cell.querySelector("b"));
  const labelCounters = labels.map(countWrites);
  const valueCounters = values.map(countWrites);
  const before = invalidations.length;
  setTrendFooterHorizons([10, 15]);
  deliver();
  assert.deepEqual([...labelCounters, ...valueCounters].map((c) => c.count), Array(8).fill(0),
    "a horizon change writes no prediction cell itself");
  assert.deepEqual(invalidations.slice(before), ["stockTrend"], "it asks the data source for one new frame");
  surface.update(stockVm({ metrics: { ...stockVm().metrics, up10m: 0.6, down10m: 0.4, up15m: 0.7, down15m: 0.3 } }));
  assert.deepEqual(labels.map((label) => label.textContent), ["10", "10", "15", "15"]);
  assert.deepEqual(values.map((value) => value.textContent), ["60.0%", "40.0%", "70.0%", "30.0%"]);
  assert.deepEqual(labelCounters.map((c) => c.count), [1, 1, 1, 1], "the frame writes each label once");
  surface.update(stockVm({ metrics: { ...stockVm().metrics, up10m: 0.6, down10m: 0.4, up15m: 0.7, down15m: 0.3 } }));
  assert.deepEqual(labelCounters.map((c) => c.count), [1, 1, 1, 1], "an unchanged frame writes nothing");
}

// --- D07-07: the 盤中事件 switch is written by the marker store's subscription alone ---------------------------------
{
  const button = surface._controlRole("event-marker-toggle");
  assert.ok(button, "個股走勢 has its 盤中事件 switch");
  const shown = () => [button.classList.contains("active"), button.getAttribute("aria-pressed")];
  const initially = stockTrendEventMarkersVisible();
  assert.deepEqual(shown(), [initially, String(initially)]);
  const writes = countWrites(button);
  // The click changes the store; the button follows only when the store announces the change.
  const clickTarget = button.querySelector(".trend-event-marker-toggle-track") || button;
  for (const [type, handler] of host.listeners) if (type === "click") handler({ target: clickTarget });
  assert.equal(stockTrendEventMarkersVisible(), !initially, "the click changed the store");
  assert.deepEqual(shown(), [initially, String(initially)], "the click itself wrote nothing to the button");
  assert.equal(writes.count, 0);
  deliver();
  assert.deepEqual(shown(), [!initially, String(!initially)], "the store's announcement repainted the button");
  const afterStore = writes.count;
  // Frames never write the switch: one showing something else (as if a store announcement were still on its way)
  // stays as it is through any number of frames.
  button.setAttribute("aria-pressed", String(initially));
  const beforeFrames = writes.count;
  surface.update(stockVm());
  surface.update(stockVm());
  assert.equal(writes.count, beforeFrames, "a data frame does not touch the 盤中事件 switch");
  assert.ok(afterStore > 0);
}

surface.destroy();
console.log("trend header single writer contract passed (breadth store, horizon redraw, 盤中事件 store)");
