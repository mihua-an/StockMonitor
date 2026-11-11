import assert from "node:assert/strict";

// The trend lookup (crosshair) registers its canvas and window listeners with one signal and releases them all on
// destroy: a canvas parked and mounted again (trend_surface_state.js) carries one set of handlers, not one per mount.
function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler, options = {}) {
      const entry = { handler };
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(entry);
      options?.signal?.addEventListener("abort", () => listeners.get(type).delete(entry), { once: true });
    },
    removeEventListener(type, handler) {
      for (const entry of [...(listeners.get(type) || [])]) if (entry.handler === handler) listeners.get(type).delete(entry);
    },
    count(type) { return listeners.get(type)?.size || 0; },
  };
}
const element = () => ({ className: "", dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  set innerHTML(_v) { this.children = [0, 1, 2, 3, 4].map(() => element()); }, children: [], remove() {}, appendChild() {} });
const page = { querySelectorAll: () => [], appendChild() {} };
globalThis.window = target();
globalThis.document = { createElement: element, querySelector: () => null, body: page };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const canvas = Object.assign(target(), {
  id: "c", dataset: {}, parentElement: { classList: { add() {} }, appendChild() {} }, closest: () => page,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
});

const { updateTrendLookupChartState, destroyTrendLookup } = await import("../ui/renderer/js/core/trend/interaction_controller.js");
for (let mount = 0; mount < 3; mount += 1) {
  updateTrendLookupChartState(canvas, { points: [] });
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "dblclick"]) {
    assert.equal(canvas.count(type), 1, `mount ${mount + 1}: one ${type} handler`);
  }
  assert.equal(window.count("resize"), 1);
  assert.equal(window.count("scroll"), 1);
  destroyTrendLookup(canvas);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "dblclick"]) assert.equal(canvas.count(type), 0, `destroy releases ${type}`);
  assert.equal(window.count("resize") + window.count("scroll"), 0, "destroy releases the window listeners");
}
console.log("renderer trend lookup listeners contract passed");
