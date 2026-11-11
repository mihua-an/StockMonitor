import assert from "node:assert/strict";

// 個股走勢 with an overlay (使用者 11-02): the five price levels on the left are the stock's own -- picking 加權 or
// 期貨 as the overlay must not change them. The overlay is projected onto the stock's price axis and clipped to the
// plot; it never widens the scale. Drives the REAL renderTrendCanvas with a recording 2D context.

const recorder = new Proxy({}, {
  get(target, name) {
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

// The stock: 昨收 502, trading 498-510.
const bar = (minute, close, high, low) => ({ minute_timestamp: `2026-11-02T09:0${minute}:00+08:00`,
  time: `09:0${minute}`, price: close, close, high, low, volume: 5 });
const points = [bar(0, 503, 504, 501), bar(1, 507, 510, 503), bar(2, 500, 507, 498), bar(3, 499, 501, 498)];
// Two overlays already projected onto the stock's price axis: 加權 reaching far below the stock, 期貨 less so.
const overlay = (low) => [{ id: "overlay", color: "#8899aa", points: [{ minute: 0, price: 502 }, { minute: 1, price: low },
  { minute: 2, price: low + 1 }, { minute: 3, price: 495 }] }];

const levels = (options) => {
  frame = null;
  renderTrendCanvas(makeCanvas(), points, 502, 503, options);
  assert.ok(frame, "the chart reports the frame it drew");
  return frame.yLevels;
};

const alone = levels({});
const taiex = levels({ overlaySeries: overlay(485.65) });
const futures = levels({ overlaySeries: overlay(489) });
assert.deepEqual(taiex, alone, "the 加權 overlay must not move the price levels");
assert.deepEqual(futures, alone, "the 期貨 overlay must not move the price levels");
// The stock's own range is still inside the scale, centred on 昨收.
assert.equal(alone[2], 502, "昨收 is the centre level");
assert.ok(alone[0] >= 510 && alone[4] <= 498, `the stock's own high/low are inside: ${alone.join(" / ")}`);
console.log("renderer trend overlay scale contract passed");
