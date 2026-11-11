import assert from "node:assert/strict";
import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";

// 個股走勢's 加權/期貨 overlay froze (the grey line stopped near 10:30 / 11:00 while the stock line
// and the TAIEX series kept going) because an overlay-only repaint was refused by the component's
// own display gate:
//   update(vm) accepts vm at displaySequence N through the gate, but when vm's trend signature is
//   unchanged it returned early WITHOUT handing vm to the manager, so manager.lastModel stayed at an
//   older sequence M < N. Every later overlay change (addOverlay -> requestRender(lastModel)) was
//   then rejected as STALE_COMPONENT_SEQUENCE, i.e. the overlay could only move when the STOCK line
//   itself changed -- and never again once the stock went quiet.
// This drives the REAL TrendChartComponent.update() and the REAL TrendChartManager and gate.

const frames = [];
globalThis.window = globalThis.window || {};
window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
window.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { TrendChartComponent } = await import("../ui/renderer/js/core/components/trend_chart_component.js");
const { PresentationRevisionGate } = await import("../ui/renderer/js/core/display_frame_gate.js");
const { trendSurfaceVariant } = await import("../ui/renderer/js/core/components/trend_surface_variant.js");
const { TrendHeaderPresenter } = await import("../ui/renderer/js/core/components/trend_header_presenter.js");
const { TrendOverlayController } = await import("../ui/renderer/js/core/components/trend_overlay_state.js");
const { TrendCanvasController } = await import("../ui/renderer/js/core/components/trend_canvas_frames.js");

const canvas = { dataset: {}, getBoundingClientRect: () => ({ width: 400, height: 200 }), getContext: () => null,
  addEventListener() {}, removeEventListener() {}, closest: () => null };
const component = Object.create(TrendChartComponent.prototype);
Object.assign(component, {
  host: null, canvas, lastVm: null, cleanup: [],
  context: { mode: "live", services: { trendOverlays: {
    build: () => ({ points: overlayPoints.map((minute) => ({ minute, price: 100 })), strokeStyle: "#6f86a4" }),
  } } },
  variant: "stock", variantSpec: trendSurfaceVariant("stock"), header: new TrendHeaderPresenter(), dataKey: "stockTrend", showControls: true, manual: false,
  displayFrameGate: new PresentationRevisionGate(),
});
component.overlays = new TrendOverlayController(component);
component.chart = new TrendCanvasController();
component.chart.attach(canvas);
component.overlays.state = { taiex: true, futures: false };
// Paint accounting: count which models the manager actually renders.
const painted = [];
const flush = () => { while (frames.length) frames.shift()(); };

let overlayPoints = [0, 1, 2];
const points = Array.from({ length: 30 }, (_, minute) => ({ minute, time: `09:${String(minute).padStart(2, "0")}`, price: 100 + minute / 10 }));
const vm = (displaySequence) => ({ symbol: "2481", displaySymbol: "2481", displayEpoch: "0:2481:1", displaySequence,
  points, prevClose: 100, openPrice: 100, options: { adapterType: "equity" } });

component.update(withMarketRead(vm(10)));
component.manager._render = (model) => painted.push(model.displaySequence);   // observe paints only
flush();
assert.deepEqual(painted, [10]);

// A later frame whose trend is unchanged (an order-book or summary tick): signature is equal.
component.update(withMarketRead(vm(20)));
flush();

// Now only the TAIEX series moves: the stock chart must repaint its overlay.
painted.length = 0;
overlayPoints = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
component.overlays.sync();
const rendered = [];
component.manager._render = function (model) {
  if (this.canRender?.(model) === false) return;
  rendered.push(model.displaySequence);
};
flush();
assert.deepEqual(rendered, [20],
  "an overlay-only change must repaint; the manager was holding a model the gate had already superseded");
assert.equal(component.displayFrameGate.lastRejectReason, "", "the gate must not reject the overlay repaint");
assert.equal(component.manager.overlays.series().find((s) => s.id === "TAIEX_BENCHMARK").points.length, 10);
console.log("renderer trend overlay repaint contract passed");
