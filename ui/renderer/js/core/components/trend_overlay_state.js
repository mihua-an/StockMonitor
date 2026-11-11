// The benchmark overlays' per-surface choice (kept per viewer), the series an overlay draws (均價), and the
// controller that applies both to one surface's chart.

import { BENCHMARK_OVERLAYS, DEFAULT_BENCHMARK_OVERLAY_STATE, bindBenchmarkOverlayControls, normalizeBenchmarkOverlayState, syncBenchmarkOverlayControls } from "../benchmark_overlay_controls.js";
import { themeColor } from "../market_palette.js";
import { numberOrNull } from "../numbers.js";
import { trendIndicatorEngine } from "../trend/trend_indicator_engine.js";

export const DEFAULT_OVERLAY_STATE = DEFAULT_BENCHMARK_OVERLAY_STATE;

function storageOrNull() {
  try { return globalThis.localStorage || null; } catch (error) { console.warn("[trend chart: opening localStorage] failed", error); return null; }
}

export function loadOverlayState(key, defaults = {}) {
  let raw = {};
  try { raw = JSON.parse(storageOrNull()?.getItem?.(key) || "null"); } catch (error) { console.warn("[trend chart: reading the overlay state] failed", error); raw = null; }
  // Benchmark comparison is a radio-style choice: the stored state names exactly one of the two. Anything else
  // (both, neither, the two-checkbox state) is refused and the defaults apply.
  if (raw != null) {
    if (typeof raw.taiex === "boolean" && typeof raw.futures === "boolean" && raw.taiex !== raw.futures) {
      return { taiex: raw.taiex, futures: raw.futures };
    }
    console.warn(`[trend chart] overlay state ${key} refused: not exactly one benchmark`, raw);
  }
  return normalizeBenchmarkOverlayState({ ...DEFAULT_OVERLAY_STATE, ...defaults });
}

export function persistOverlayState(key, state) {
  try { storageOrNull()?.setItem?.(key, JSON.stringify(state)); } catch (error) { console.warn("[trend chart: saving the overlay state] failed", error); }
}

export function timeAxisPolicy(manager, vm) {
  try { return manager?.adapter?.adapt?.(vm || {})?.options?.timeAxisPolicy || null; }
  catch (error) { console.warn("[trend chart: reading the time axis policy] failed", error); return null; }
}

function coordinateForPoint(policy, point, index, length) {
  const coordinate = policy?.coordinateForPoint?.(point, index, length);
  return Number.isFinite(coordinate) ? coordinate : numberOrNull(point?.minute);
}

export function averagePriceOverlay(points = [], policy = null) {
  const source = Array.isArray(points) ? points : [];
  const mapped = trendIndicatorEngine.averagePrice(
    source, (point, index, length) => coordinateForPoint(policy, point, index, length)
  );
  return mapped.length >= 2 ? {
    id: "AVERAGE_PRICE", label: "均價", points: mapped,
    strokeStyle: themeColor("--chart-average-price"), lineWidth: 1.5, alpha: 0.92, semantic: "AVERAGE_PRICE",
  } : null;
}

// One surface's overlays: 均價 always, and the 加權 / 期貨 benchmark its toolbar (or its host's switch) chose. The
// choice is kept per surface and viewer; the series come from the context's trendOverlays service and are drawn by the
// surface's chart manager.
export class TrendOverlayController {
  constructor(surface) {
    this.surface = surface;
    this.state = { ...DEFAULT_OVERLAY_STATE };
    this.storageKey = "";
    this.toolbarControls = null;
  }

  // The remembered choice of the surface's slot and variant (or the context's default when none is stored).
  load(storageKey, defaults = {}) {
    this.storageKey = storageKey;
    this.state = loadOverlayState(storageKey, defaults);
  }

  releaseToolbar() {
    this.toolbarControls?.destroy?.();
    this.toolbarControls = null;
  }

  // 疊圖 (加權 / 期貨) of a 個股走勢 surface with controls; 歷史回放's toolbar is bound by its page.
  bindToolbar() {
    this.releaseToolbar();
    const toolbar = this.surface.showToolbar ? this.surface._controlRole("trend-overlay-toolbar") : null;
    if (!toolbar) return;
    this.toolbarControls = bindBenchmarkOverlayControls(toolbar, {
      initialState: this.state,
      onSelect: (key) => this.select(key, true),
    });
  }

  async select(kind, visible) {
    const key = String(kind || "");
    if (!BENCHMARK_OVERLAYS.includes(key)) return false;
    // Same interaction contract as 日盤／夜盤／全日: exactly one selection.
    // Clicking the active option keeps it selected instead of turning both off.
    if (!visible && this.state[key]) return true;
    for (const candidate of BENCHMARK_OVERLAYS) this.state[candidate] = candidate === key;
    persistOverlayState(this.storageKey, this.state);
    syncBenchmarkOverlayControls(this.surface._controlRole("trend-overlay-toolbar"), this.state);
    // Apply the selection immediately; hydration may wait for a snapshot.
    this.sync();
    if (this.state[key]) {
      try { await this.surface.context?.services?.trendOverlays?.ensure?.(key); }
      catch (error) { console.warn(`[TrendChartComponent] ${key} overlay load failed`, error); }
    }
    this.sync();
    return true;
  }

  // The benchmark a view model names (follow): set only when it changes, so every frame does not reload it. It has a
  // real "off" and is never persisted: the view model is the authority, on every frame.
  follow(mode) {
    const normalized = mode === "taiex" || mode === "futures" ? mode : "off";
    const current = this.state.taiex ? "taiex" : this.state.futures ? "futures" : "off";
    if (normalized !== current) this.setBenchmark(normalized);
  }

  setBenchmark(mode) {
    const normalized = mode === "taiex" || mode === "futures" ? mode : "off";
    this.state = { taiex: normalized === "taiex", futures: normalized === "futures" };
    const toolbar = this.surface._controlRole("trend-overlay-toolbar");
    if (toolbar) {
      const taiexButton = toolbar.querySelector('[data-role="trend-overlay-taiex"]');
      const futuresButton = toolbar.querySelector('[data-role="trend-overlay-futures"]');
      taiexButton?.classList.toggle("active", normalized === "taiex");
      taiexButton?.setAttribute("aria-pressed", String(normalized === "taiex"));
      futuresButton?.classList.toggle("active", normalized === "futures");
      futuresButton?.setAttribute("aria-pressed", String(normalized === "futures"));
    }
    this.sync();
    if (normalized !== "off") {
      Promise.resolve(this.surface.context?.services?.trendOverlays?.ensure?.(normalized))
        .catch((error) => console.warn(`[TrendChartComponent] ${normalized} overlay load failed`, error))
        .finally(() => this.sync());
    }
    return normalized;
  }

  _apply(id, series, visible) {
    if (!this.surface.manager) return;
    if (visible && series) this.surface.manager.addOverlay(id, { ...series, id, visible: true });
    else this.surface.manager.removeOverlay(id);
  }

  sync() {
    if (!this.surface.manager || !this.surface.lastVm) return;
    const points = Array.isArray(this.surface.lastVm.points) ? this.surface.lastVm.points : [];
    const policy = timeAxisPolicy(this.surface.manager, this.surface.lastVm);
    this._apply("AVERAGE_PRICE", averagePriceOverlay(points, policy), true);
    for (const kind of BENCHMARK_OVERLAYS) {
      const id = kind === "taiex" ? "TAIEX_BENCHMARK" : "TXF_BENCHMARK";
      const enabled = this.surface.variantSpec.benchmarks && Boolean(this.state[kind]);
      const series = enabled ? this.surface.context?.services?.trendOverlays?.build?.({
        kind, variant: this.surface.variant,
        frame: { points, openPrice: this.surface.lastVm.openPrice, prevClose: this.surface.lastVm.prevClose },
        timeAxisPolicy: policy,
      }) : null;
      this._apply(id, series, enabled);
    }
  }
}
