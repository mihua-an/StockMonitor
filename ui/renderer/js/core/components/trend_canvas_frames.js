// What each trend canvas last drew (a frame record per canvas, read by diagnostics and the startup check), the
// signature that tells whether a new view model draws anything different, and the controller that draws it.

import { numberOrNull } from "../numbers.js";
import { TrendChartManager } from "../trend/index.js";
import { projectTrendForDisplay } from "../trend/trend_projection.js";
import { elementSize } from "../element_size.js";

// What each trend canvas last drew (points, size, reference, how often its futures reference moved, how often its
// series was replaced rather than extended), for the startup acceptance. Kept in memory: written as data-*
// attributes after every frame it mutated the canvas's attributes at the frame rate.
export const trendFrames = new WeakMap();

export function frameRecordOf(canvas) {
  let record = trendFrames.get(canvas);
  if (!record) {
    record = { drawnAt: null, pointCount: 0, width: 0, height: 0, reference: null, futuresReference: null, referenceChanges: 0, topologyCommits: 0 };
    trendFrames.set(canvas, record);
  }
  return record;
}
/** The last frame a trend canvas drew (null before its first frame). */
export function trendFrameRecord(canvas) { return canvas ? trendFrames.get(canvas) || null : null; }

export function findCanvas(host) { return host?.querySelector?.('[data-role="trend-canvas"]') || host?.querySelector?.("canvas") || null; }

export function pointKey(point = {}) {
  return String(point?.timestamp || point?.datetime || point?.minute_timestamp || point?.time || "");
}

// What the chart was last drawn from, apart from its points: session, identities, reference, open. The points are
// compared separately by identity (sameDisplaySeries): the view's series is immutable, so an unchanged series is the
// same points -- this was a string of every point's fields built on each update.
export function trendRenderSignature(vm = {}, points = []) {
  const source = Array.isArray(points) ? points : [];
  return [
    vm?.session || vm?.options?.session || "",
    vm?.tradingDate || vm?.trading_date || vm?.options?.tradingDate || "",
    vm?.contractCode || vm?.contract_code || "",
    source.length,
    numberOrNull(vm?.prevClose), numberOrNull(vm?.openPrice),
    vm?.displayEpoch, vm?.selectionGeneration, vm?.sessionGeneration, vm?.code,
  ].join("");
}

export function sameDisplaySeries(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

// Draws one surface's line chart: the chart manager for its canvas, the series projected to the canvas width, and a
// redraw only when the drawn series changed (the frame record counts a series that started over). The surface's
// overlays are drawn on top by its overlay controller after each draw.
export class TrendCanvasController {
  constructor() {
    this.canvas = null;
    this.manager = null;
    this.signature = "";
    this.points = null;
  }

  attach(canvas) {
    this.canvas = canvas;
  }

  draw(vm, { previousPoints = [], adapterType = "equity", overlayProvider = null, accept, identityResolver, ownOverlays = false } = {}) {
    if (!this.manager) this.manager = new TrendChartManager({ canvas: this.canvas, adapterType, overlayProvider });
    else this.manager.setContext({ adapterType, overlayProvider });
    this.manager.canRender = accept;
    const pixelWidth = elementSize(this.canvas).width || 0;
    const displayPoints = projectTrendForDisplay(vm?.points || [], { pixelWidth });
    const projectedVm = { ...vm, points: displayPoints };
    const managedVm = ownOverlays
      ? { ...projectedVm, options: { ...(vm.options || {}), identityResolver, overlaySeries: [], useOverlayProvider: false } }
      : { ...projectedVm, options: { ...(vm.options || {}), identityResolver } };
    const signature = trendRenderSignature(managedVm, displayPoints);
    if (signature === this.signature && sameDisplaySeries(displayPoints, this.points)) {
      // Nothing to redraw for the series, but the gate above has just accepted THIS frame, so the
      // manager must hold it too. Keeping the older model made every overlay-only repaint (the
      // 加權/期貨 line moving while the stock is quiet) fail the gate as STALE_COMPONENT_SEQUENCE,
      // which froze the 個股走勢 benchmark overlay wherever the stock line last changed.
      this.manager.adoptModel(managedVm);
      return;
    }
    if (displayPoints.length) {
      const previousFirst = pointKey(previousPoints[0] || {});
      const nextFirst = pointKey((Array.isArray(vm?.points) ? vm.points : [])[0] || {});
      const incremental = previousPoints.length > 0
        && previousFirst && previousFirst === nextFirst
        && (Array.isArray(vm?.points) ? vm.points.length : 0) >= previousPoints.length;
      if (!incremental) frameRecordOf(this.canvas).topologyCommits += 1;
    }
    this.signature = signature;
    this.points = displayPoints;
    this.manager.update(managedVm);
  }

  resize() {
    this.manager?.resize();
  }

  recordFrameDrawn(detail) {
    if (!this.canvas) return;
    const record = frameRecordOf(this.canvas);
    const reference = Number(detail.prevClose);
    const view = String(this.canvas.dataset.trendView || "");
    const framePoints = Array.isArray(detail.points) ? detail.points.length : 0;
    if (view === "futures" && framePoints > 0 && Number.isFinite(reference) && reference > 0) {
      if (record.futuresReference != null && Math.abs(record.futuresReference - reference) > 0.001) record.referenceChanges += 1;
      record.futuresReference = reference;
    }
    const rect = elementSize(this.canvas);
    record.drawnAt = performance.now();
    record.pointCount = framePoints;
    record.width = Math.round(rect.width);
    record.height = Math.round(rect.height);
    record.reference = Number.isFinite(reference) ? reference : null;
  }

  // Another view in the same canvas: a new manager, and what the old view drew is wiped.
  reset() {
    this.manager?.destroy();
    this.manager = null;
    this.signature = "";
    this.points = null;
    const canvas = this.canvas;
    if (canvas?.getContext) canvas.getContext("2d")?.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
  }

  destroy() {
    this.manager?.destroy();
    this.manager = null;
    this.canvas = null;
    this.signature = "";
    this.points = null;
  }
}
