import assert from "node:assert/strict";

// 個股走勢's 最高/最低 marks were the highest/lowest minute CLOSE, while the 最高/最低 row below the
// chart is the session's highest/lowest TRADE. Any minute that closed off its high therefore drew a
// lower "最高" on the chart than in the row. Minute bars carry their own high/low; the marks (and
// the price axis that must contain them) now use them. This drives the REAL renderTrendCanvas with
// a recording 2D context and reads which price labels it actually paints.

const texts = [];
const recorder = new Proxy({}, {
  get(target, name) {
    if (name === "fillText") return (text) => texts.push(String(text));
    if (name === "measureText") return (text) => ({ width: String(text).length * 6 });
    if (name === "createLinearGradient") return () => ({ addColorStop() {} });
    if (name in target) return target[name];
    return () => {};
  },
  set(target, name, value) { target[name] = value; return true; },
});
const makeCanvas = () => ({
  width: 800, height: 400, style: {}, dataset: {},
  getContext: () => recorder,
  getBoundingClientRect: () => ({ width: 400, height: 200, left: 0, top: 0 }),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  closest: () => null, parentElement: null,
});
globalThis.window = { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElement: () => makeCanvas() };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { renderTrendCanvas } = await import("../ui/renderer/js/core/trend/canvas_engine.js");

// Event-marker layout lives in its own module now; drawn through the REAL renderTrendCanvas, every marker
// that fits still gets its label painted.
const bar = (minute, close) => ({ minute_timestamp: `2026-09-28T09:${String(minute).padStart(2, "0")}:00+08:00`,
  time: `09:${String(minute).padStart(2, "0")}`, price: close, close, high: close + 0.2, low: close - 0.2, volume: 5 });
const points = Array.from({ length: 60 }, (_, i) => bar(i, 100 + Math.sin(i / 6) * 2));
const eventMarkers = [
  { time: "09:10", price: 101, label: "急拉A", priority: 2 },
  { time: "09:30", price: 99, label: "急殺B", priority: 1 },
  { time: "09:50", price: 100.5, label: "爆量C", priority: 0 },
];
renderTrendCanvas(makeCanvas(), points, 100, 100, { eventMarkers });
for (const label of ["急拉A", "急殺B", "爆量C"]) assert.ok(texts.includes(label), `${label} drawn`);
console.log("renderer trend event markers contract passed");
