import { componentUpdated } from "../market_render_trace.js";
import { renderTrendCanvas } from "./canvas_engine.js";
import { destroyTrendLookup } from "./interaction_controller.js";
import { EventMarkerLayer, OverlayLayerManager } from "./layers.js";
import { RenderScheduler } from "./render_scheduler.js";
import { resolveTrendAdapter } from "./adapters.js";
import { elementSize } from "../element_size.js";
import { themeColor } from "../market_palette.js";

// The empty-chart message fits the chart: the font steps down from 18 px to 11 px, and a message still wider than the
// plot is broken into two lines (a narrow pane would cut it off at both edges).
export function drawEmptyOverlay(ctx, text, width, height) {
  const room = Math.max(40, width - 24);
  let size = 18;
  const font = (px) => `700 ${px}px system-ui,sans-serif`;
  ctx.save();
  ctx.fillStyle = themeColor("--chart-axis-label-bg");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = font(size);
  while (size > 11 && ctx.measureText(text).width > room) ctx.font = font(--size);
  let lines = [text];
  if (ctx.measureText(text).width > room && text.length > 1) {
    const half = Math.ceil(text.length / 2);
    lines = [text.slice(0, half), text.slice(half)];
  }
  const step = size * 1.35;
  lines.forEach((line, index) => ctx.fillText(line, width / 2, height / 2 + (index - (lines.length - 1) / 2) * step));
  ctx.restore();
  return { size, lines };
}

// One chart on one canvas. The view model it was last given is the only copy of the series: every render adapts that
// model, so there is no second series store to fall out of step with it.
export class TrendChartManager {
  constructor({ canvas = null, adapter = null, adapterType = "equity", overlayProvider = null } = {}) {
    this.canvas = canvas;
    this.adapter = adapter || resolveTrendAdapter(adapterType);
    this.adapterType = adapterType;
    this.overlayProvider = overlayProvider;
    this.overlays = new OverlayLayerManager();
    this.events = new EventMarkerLayer();
    this.lastModel = null;
    this.destroyed = false;
    this.scheduler = new RenderScheduler((model) => this._render(model));
    if (canvas) this.mount(canvas);
  }

  mount(canvas = this.canvas) {
    this.canvas = canvas;
    if (this.canvas) this.canvas.dataset.trendManager = "1";
    return this;
  }

  setContext({ adapter = null, adapterType = null, overlayProvider = undefined } = {}) {
    if (adapter) this.adapter = adapter;
    if (adapterType && adapterType !== this.adapterType) {
      this.adapterType = adapterType;
      this.adapter = resolveTrendAdapter(adapterType);
    }
    if (overlayProvider !== undefined) this.overlayProvider = overlayProvider;
    return this;
  }

  addOverlay(id, series) {
    this.overlays.addOverlay(id, series);
    this.requestRender();
    return this;
  }

  removeOverlay(id) {
    this.overlays.removeOverlay(id);
    this.requestRender();
    return this;
  }

  updateOverlay(id, patch) {
    this.overlays.updateOverlay(id, patch);
    this.requestRender();
    return this;
  }

  clearOverlay() {
    this.overlays.clearOverlay();
    this.requestRender();
    return this;
  }

  setOverlayVisibility(id, visible) {
    this.overlays.setOverlayVisibility(id, visible);
    this.requestRender();
    return this;
  }

  update(vm = {}) {
    if (this.destroyed) return;
    this.lastModel = vm || {};
    this.scheduler.request(this.lastModel);
  }

  // The current model without a repaint: its series is already on screen, but later overlay repaints must use it.
  adoptModel(vm = {}) {
    if (this.destroyed) return;
    this.lastModel = vm || {};
  }

  updateEvents(markers = []) {
    this.lastModel = { ...(this.lastModel || {}), options: { ...(this.lastModel?.options || {}), eventMarkers: markers } };
    this.requestRender();
    return this;
  }

  setReplayCursor(cursor) {
    this.lastModel = { ...(this.lastModel || {}), options: { ...(this.lastModel?.options || {}), replayCursor: cursor } };
    this.requestRender();
    return this;
  }

  renderNow(vm = this.lastModel || {}) {
    if (this.destroyed) return;
    this.lastModel = vm || {};
    this.scheduler.flush(this.lastModel);
  }

  requestRender() {
    if (this.lastModel) this.scheduler.request(this.lastModel);
  }

  resize() {
    this.requestRender();
  }

  _render(vm) {
    if (!this.canvas || this.canRender?.(vm) === false) return;
    const adapted = this.adapter.adapt(vm || {});
    const overlaySeries = [...(adapted.options?.overlaySeries || []), ...this.overlays.series()];
    const eventMarkers = this.events.normalize(adapted.options?.eventMarkers || []);
    const options = { ...adapted.options, overlaySeries, eventMarkers, overlayProvider: this.overlayProvider };
    const points = Array.isArray(adapted.points) ? adapted.points.filter(Boolean) : [];
    renderTrendCanvas(this.canvas, points, adapted.prevClose, adapted.openPrice, options);
    if (adapted.emptyOverlayText && !points.length) this._drawEmptyOverlay(String(adapted.emptyOverlayText));
    componentUpdated("trend", vm, this.canvas);
  }

  _drawEmptyOverlay(text) {
    const ctx = this.canvas.getContext?.("2d");
    const rect = elementSize(this.canvas);
    if (ctx && rect?.width > 0 && rect?.height > 0) drawEmptyOverlay(ctx, text, rect.width, rect.height);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scheduler.destroy();
    if (this.canvas) {
      destroyTrendLookup(this.canvas);
      delete this.canvas.dataset.trendManager;
    }
    this.overlays.clearOverlay();
    this.canvas = null;
    this.lastModel = null;
  }
}
