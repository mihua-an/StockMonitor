import assert from "node:assert/strict";

// The trend chart writes no 最高/最低 labels over the line (使用者 11-01: 圖上不疊最高最低標籤); the 最高/最低 are in the
// row beneath the chart. The price axis must still contain the session's highest / lowest TRADE -- a minute bar's own
// high/low, not its close -- or the line could leave the chart. This drives the REAL renderTrendCanvas with a recording
// 2D context: every price it paints is on the left axis (left of the plot), and the scale it reports brackets the
// session's real high and low.

const painted = [];
const recorder = new Proxy({}, {
  get(target, name) {
    if (name === "fillText") return (text, x) => painted.push({ text: String(text), x });
    if (name === "measureText") return (text) => ({ width: String(text).length * 6 });
    if (name === "createLinearGradient") return () => ({ addColorStop() {} });
    if (name in target) return target[name];
    return () => {};
  },
  set(target, name, value) { target[name] = value; return true; },
});
let frame = null;
const makeCanvas = () => ({
  width: 800, height: 400, style: {}, dataset: {},
  getContext: () => recorder,
  getBoundingClientRect: () => ({ width: 400, height: 200, left: 0, top: 0 }),
  addEventListener() {}, removeEventListener() {},
  dispatchEvent(event) { if (event.type === "trend-frame-drawn") frame = event.detail; },
  closest: () => null, parentElement: null,
});
globalThis.window = { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElement: () => makeCanvas() };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { renderTrendCanvas } = await import("../ui/renderer/js/core/trend/canvas_engine.js");

// 09:00-09:04. The session's real high is 102.75, inside 09:02, whose bar closed at 101.80; the real
// low is 99.10, inside 09:03, which closed at 99.60. The highest CLOSE is 101.95 (09:04).
const bar = (minute, close, high, low) => ({ minute_timestamp: `2026-09-28T09:0${minute}:00+08:00`,
  time: `09:0${minute}`, price: close, close, high, low, volume: 5 });
const points = [bar(0, 100.5, 100.8, 100.2), bar(1, 101.2, 101.4, 100.4), bar(2, 101.8, 102.75, 101.1),
  bar(3, 99.6, 101.7, 99.1), bar(4, 101.95, 102.0, 99.7)];
renderTrendCanvas(makeCanvas(), points, 100, 100.5, {});

assert.ok(frame, "the chart reports the frame it drew");
assert.ok(frame.yLevels[0] >= 102.75, `the scale's top must contain the session high 102.75; top ${frame.yLevels[0]}`);
assert.ok(frame.yLevels[4] <= 99.1, `the scale's bottom must contain the session low 99.10; bottom ${frame.yLevels[4]}`);
const prices = painted.filter((item) => /^\d+\.\d+$/.test(item.text));
assert.ok(prices.length > 0, "the left axis is painted");
for (const item of prices) {
  assert.ok(item.x < frame.plotLeft, `${item.text} is painted at x=${item.x}, inside the plot (left edge ${frame.plotLeft}): no labels over the line`);
}
// No current-price tag on the axis (使用者 11-07): 現價 is in the header, so the last close 101.95 is not painted.
assert.ok(!prices.some((item) => item.text === "101.95"), "the current price (the last close) is not tagged on the axis");
console.log("renderer trend extrema marks contract passed");
