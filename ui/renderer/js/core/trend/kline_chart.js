import { marketPalette, themeColor, withAlpha } from "../market_palette.js";
import { priceText } from "../auction_price.js";   // the one price text
import { elementSize, holdElementSize } from "../element_size.js";
/**
 * Candlestick chart for 技術分析: scrollable (wheel, drag), zoomable (Ctrl + wheel), a crosshair
 * with price/time labels, SMA lines, a volume overlay underneath, 最高/最低 markers for the visible range and the
 * latest price as a dashed line. Pure drawing: the component hands it bars; nothing here aggregates them.
 *
 * bar: { key, label: "09:05", crosshairLabel?, dayStart?, dayLabel?, open, high, low, close, volume }. `key` names a
 * bar across updates; `label` is its text on the time axis and `crosshairLabel` under the crosshair. A `dayStart` bar
 * begins a new day of a chart of several days: the axis shows its `dayLabel` and a line separates the days.
 */

/** The chart's own colours: styles/tokens.css --kline-*. */
function baseColors() {
  return {
    background: themeColor("--kline-bg"), grid: themeColor("--kline-grid"), axisText: themeColor("--kline-axis-text"),
    flat: themeColor("--kline-flat"), crosshair: themeColor("--kline-crosshair"), crosshairLabel: themeColor("--kline-crosshair"),
    sma: [themeColor("--kline-sma-1"), themeColor("--kline-sma-2")],
  };
}

/** Up / down follow the user's 紅漲 / 綠漲 setting, read at draw time; the rest is the chart's own. */
function chartColors() {
  const { up, down } = marketPalette();
  return { ...baseColors(), up, down, high: up, low: down, volumeUp: withAlpha(up, 0.45), volumeDown: withAlpha(down, 0.45) };
}

export const KLINE_SMA_PERIODS = Object.freeze([5, 23]);
const PRICE_AXIS = 58;
const TIME_AXIS = 18;
const LEGEND = 30;
const VOLUME_SHARE = 0.2;
const MIN_BAR = 3;
const MAX_BAR = 40;

export function simpleMovingAverage(bars, period) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += Number(bars[i].close);
    if (i >= period) sum -= Number(bars[i - period].close);
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

function stepDigits(step) {
  return step >= 1 && Number.isInteger(step) ? 0 : step >= 0.1 ? (Number.isInteger(step * 10) ? 1 : 2) : 2;
}

export class KLineChart {
  // smaPeriods: the moving averages drawn (null: KLINE_SMA_PERIODS).
  constructor(canvas, { onHover = null, onOffsetChange = null, smaPeriods = null } = {}) {
    this.canvas = canvas;
    this.smaPeriods = smaPeriods ?? KLINE_SMA_PERIODS;
    this.onHover = onHover;
    this.onOffsetChange = onOffsetChange;
    this.bars = [];
    this.sma = [];
    this.barWidth = 9;
    this.offset = 0;              // bars hidden to the right of the view (0 = newest at the right edge)
    this.hover = null;            // { index, y }
    this.drag = null;
    this.frame = 0;
    // Its size is read on every draw: the shared observer keeps it current while this chart exists.
    this.listeners = [holdElementSize(canvas)];
    const on = (target, type, handler, options) => { target.addEventListener(type, handler, options); this.listeners.push(() => target.removeEventListener(type, handler, options)); };
    on(canvas, "wheel", (event) => this.#onWheel(event), { passive: false });
    on(canvas, "mousemove", (event) => this.#onMove(event));
    on(canvas, "mouseleave", () => { this.drag = null; this.#setHover(null); });
    on(canvas, "mousedown", (event) => { this.drag = { x: event.clientX, offset: this.offset }; });
    on(globalThis, "mouseup", () => { this.drag = null; });
  }

  // Older bars put in front (a history page) leave the view where it is: `offset` counts from the newest bar. Only
  // bars added at the newest end move a scrolled-back view.
  setBars(bars = []) {
    const atLatest = this.offset === 0;
    const firstKey = this.bars[0]?.key;
    const found = firstKey != null && bars[0]?.key !== firstKey ? bars.findIndex((bar) => bar.key === firstKey) : 0;
    const prepended = Math.max(0, found);
    const grew = bars.length - this.bars.length - prepended;
    // Another series (a new timeframe or product) has no bar under the pointer yet.
    if (found < 0) this.hover = null;
    if (this.hover) this.hover.index += prepended;
    this.bars = bars;
    this.sma = this.smaPeriods.map((period) => simpleMovingAverage(bars, period));
    // A new bar keeps a scrolled-back view where it was; the newest view keeps following.
    if (!atLatest && grew > 0) this.offset += grew;
    this.#clampOffset();
    this.schedule();
  }

  /** Whether the chart is on screen and has a size (a hidden tab has none). */
  hasSize() { return elementSize(this.canvas).width > 0; }

  /** How many bars fit the view. */
  viewCapacity() { return this.#geometry().count; }

  /** Bars held to the left of the view; negative when the view has room no bar fills. */
  barsLeftOfView() {
    const { end, count } = this.#geometry();
    return end - count + 1;
  }

  jumpToLatest() { this.offset = 0; this.onOffsetChange?.(this.offset); this.schedule(); }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.listeners.splice(0).forEach((off) => off());
  }

  // The canvas size comes from the shared observer: a draw follows every bar update and every hover.
  #geometry() {
    const rect = elementSize(this.canvas);
    const width = Math.max(120, Math.floor(rect.width));
    const height = Math.max(120, Math.floor(rect.height));
    const plot = { left: 0, top: LEGEND, right: width - PRICE_AXIS, bottom: height - TIME_AXIS };
    const count = Math.max(1, Math.floor((plot.right - plot.left) / this.barWidth));
    const end = this.bars.length - 1 - this.offset;
    const start = Math.max(0, end - count + 1);
    return { width, height, plot, count, start, end };
  }

  #clampOffset() {
    const maxOffset = Math.max(0, this.bars.length - 1);
    this.offset = Math.min(Math.max(0, Math.round(this.offset)), maxOffset);
  }

  // `rect`: the canvas's viewport rect, read once by the event handler that asks.
  #indexAt(clientX, rect) {
    const { plot, end } = this.#geometry();
    const x = clientX - rect.left;
    if (x < plot.left || x > plot.right) return null;
    const fromRight = Math.floor((plot.right - x) / this.barWidth);
    const index = end - fromRight;
    return index >= 0 && index < this.bars.length ? index : null;
  }

  #onWheel(event) {
    if (!this.bars.length) return;
    event.preventDefault();
    if (event.ctrlKey) {
      // Zoom around the bar under the pointer: it stays under the pointer.
      const rect = this.canvas.getBoundingClientRect();
      const anchor = this.#indexAt(event.clientX, rect);
      const fromRightPx = this.#geometry().plot.right - (event.clientX - rect.left);
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.barWidth = Math.min(MAX_BAR, Math.max(MIN_BAR, this.barWidth * factor));
      if (anchor != null) {
        const slots = Math.floor(fromRightPx / this.barWidth);
        this.offset = this.bars.length - 1 - anchor - slots;
      }
    } else {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const step = Math.max(1, Math.round(Math.abs(delta) / 40)) * Math.max(1, Math.round(12 / this.barWidth));
      // Wheel down / right = earlier bars (the view moves left in time).
      this.offset += delta > 0 ? step : -step;
    }
    this.#clampOffset();
    this.onOffsetChange?.(this.offset, { user: true });
    this.#onMove(event);
    this.schedule();
  }

  #onMove(event) {
    if (this.drag) {
      const shifted = this.drag.offset + Math.round((event.clientX - this.drag.x) / this.barWidth);
      if (shifted !== this.offset) {
        this.offset = shifted;
        this.#clampOffset();
        this.onOffsetChange?.(this.offset, { user: true });
      }
    }
    const rect = this.canvas.getBoundingClientRect();
    const index = this.#indexAt(event.clientX, rect);
    this.#setHover(index == null ? null : { index, y: event.clientY - rect.top });
  }

  #setHover(hover) {
    this.hover = hover;
    this.onHover?.(hover ? this.bars[hover.index] : null, hover ? hover.index : null);
    this.schedule();
  }

  /** The bar the header's OHLCV reads: the hovered one, else the newest. */
  focusBar() { return this.hover ? this.bars[this.hover.index] : this.bars.at(-1) || null; }

  draw() {
    const { width, height, plot, start, end } = this.#geometry();
    const ratio = globalThis.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const COLORS = chartColors();
    if (!this.bars.length || end < 0) {
      this.staticKey = "";
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, width, height);
      ctx.font = "11px system-ui, 'Microsoft JhengHei', sans-serif";
      ctx.fillStyle = COLORS.axisText;
      ctx.textAlign = "center";
      ctx.fillText("尚無 K 棒資料", width / 2, height / 2);
      return;
    }
    const view = this.#priceView(plot, start, end, COLORS);
    // The background, the grid and the time axis change only with the size, the visible range and the price scale:
    // they are painted once into a layer and copied, and a new print redraws only the bars and lines over it.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.#staticLayer(view, width, height, ratio), 0, 0);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = "11px system-ui, 'Microsoft JhengHei', sans-serif";
    this.#drawPriceLabels(ctx, view);
    this.#drawVolume(ctx, view);
    this.#drawCandles(ctx, view);
    this.#drawSma(ctx, view);
    this.#drawExtremes(ctx, view);
    this.#drawCrosshair(ctx, view);
    // No legend text and no SMA / VOL readout in the top-left corner: the lines and the
    // volume overlay stay, and the focused bar's O/H/L/C/V is in the toolbar above the chart.
  }

  // The visible range's price scale (the SMA lines inside it) and its coordinate functions.
  #priceView(plot, start, end, COLORS) {
    const visible = this.bars.slice(start, end + 1);
    const volumeTop = plot.bottom - (plot.bottom - plot.top) * VOLUME_SHARE;
    const priceBottom = volumeTop - 6;
    let hi = Math.max(...visible.map((bar) => bar.high));
    let lo = Math.min(...visible.map((bar) => bar.low));
    for (const line of this.sma) for (let i = start; i <= end; i += 1) if (line[i] != null) { hi = Math.max(hi, line[i]); lo = Math.min(lo, line[i]); }
    const pad = Math.max((hi - lo) * 0.08, hi * 0.0005, 0.01);
    hi += pad; lo -= pad;
    const y = (price) => plot.top + (hi - price) / (hi - lo) * (priceBottom - plot.top);
    const xOf = (index) => plot.right - (end - index + 0.5) * this.barWidth;
    // Half a pixel between candles (user 11-09), or one physical pixel where a screen has no half; edges snapped to
    // physical pixels so every gap is the same.
    const ratio = globalThis.devicePixelRatio || 1;
    const snap = (value) => Math.round(value * ratio) / ratio;
    const gap = Math.max(0.5, 1 / ratio);
    const slot = (i) => {
      const left = snap(xOf(i) - this.barWidth / 2);
      return [left, Math.max(1 / ratio, snap(xOf(i) + this.barWidth / 2) - left - gap)];
    };
    // The middle of a candle's own body: its wick and the crosshair both stand here.
    const center = (i) => {
      const [left, width] = slot(i);
      return (Math.floor((left + width / 2) * ratio) + 0.5) / ratio;
    };
    return { plot, start, end, visible, volumeTop, priceBottom, hi, lo, y, xOf, slot, center, COLORS,
      digits: hi >= 1000 ? 0 : hi >= 100 ? 1 : 2 };
  }

  // The layer under the data: background, price grid lines on round steps, the axis line and the time axis. Rebuilt
  // only when what it shows changes (size, pixel ratio, visible bars, price scale, bar width, palette).
  #staticLayer(view, width, height, ratio) {
    const { start, end, hi, lo, COLORS } = view;
    const key = JSON.stringify([width, height, ratio, start, end, this.barWidth, hi, lo, this.bars[start]?.key ?? this.bars[start]?.label, this.bars[end]?.key ?? this.bars[end]?.label,
      COLORS.background, COLORS.grid, COLORS.axisText]);
    if (this.staticCanvas && this.staticKey === key) return this.staticCanvas;
    const layer = this.staticCanvas || this.canvas.ownerDocument.createElement("canvas");
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);
    ctx.font = "11px system-ui, 'Microsoft JhengHei', sans-serif";
    this.#drawPriceGrid(ctx, view);
    this.#drawTimeAxis(ctx, view);
    this.staticCanvas = layer;
    this.staticKey = key;
    return layer;
  }

  #priceSteps({ priceBottom, hi, lo, y }) {
    const step = niceStep((hi - lo) / 5);
    const out = [];
    for (let price = Math.ceil(lo / step) * step; price <= hi; price += step) {
      const gy = Math.round(y(price)) + 0.5;
      if (gy <= priceBottom) out.push({ price, gy, digits: stepDigits(step) });
    }
    return out;
  }

  // Grid lines and the price axis line on round steps (the static layer).
  #drawPriceGrid(ctx, view) {
    const { plot, COLORS } = view;
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    for (const { gy } of this.#priceSteps(view)) { ctx.beginPath(); ctx.moveTo(plot.left, gy); ctx.lineTo(plot.right, gy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(plot.right + 0.5, plot.top); ctx.lineTo(plot.right + 0.5, plot.bottom); ctx.stroke();
  }

  // The grid's price labels, drawn with the data.
  #drawPriceLabels(ctx, view) {
    const { plot, COLORS } = view;
    ctx.fillStyle = COLORS.axisText; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const { price, gy, digits } of this.#priceSteps(view)) ctx.fillText(priceText(price, { digits }), plot.right + 6, gy);
  }

  // Time axis: a label every ~70 px, and a day's first bar marked with its date (the other labels keep clear of it).
  #drawTimeAxis(ctx, { plot, start, end, xOf, COLORS }) {
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const every = Math.max(1, Math.round(70 / this.barWidth));
    const dayStarts = [];
    for (let i = start; i <= end; i += 1) if (this.bars[i].dayStart) dayStarts.push(i);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = COLORS.axisText;
    for (const i of dayStarts) {
      const gx = Math.round(xOf(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx, plot.top); ctx.lineTo(gx, plot.bottom); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.axisText;
    for (const i of dayStarts) ctx.fillText(this.bars[i].dayLabel, Math.round(xOf(i)) + 0.5, plot.bottom + 3);
    for (let i = start; i <= end; i += 1) {
      if ((i - start) % every !== 0 || dayStarts.some((day) => Math.abs(day - i) * this.barWidth < 44)) continue;
      const gx = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(gx, plot.top); ctx.lineTo(gx, plot.bottom); ctx.stroke();
      ctx.fillText(this.bars[i].label, gx, plot.bottom + 3);
    }
  }

  // Volume underneath.
  #drawVolume(ctx, { plot, start, end, visible, volumeTop, slot, COLORS }) {
    const maxVolume = Math.max(1, ...visible.map((bar) => Number(bar.volume) || 0));
    for (let i = start; i <= end; i += 1) {
      const bar = this.bars[i];
      const h = (Number(bar.volume) || 0) / maxVolume * (plot.bottom - volumeTop);
      ctx.fillStyle = bar.close >= bar.open ? COLORS.volumeUp : COLORS.volumeDown;
      const [left, width] = slot(i);
      ctx.fillRect(left, plot.bottom - h, width, h);
    }
  }

  #drawCandles(ctx, { start, end, y, slot, center, COLORS }) {
    for (let i = start; i <= end; i += 1) {
      const bar = this.bars[i];
      const color = bar.close > bar.open ? COLORS.up : bar.close < bar.open ? COLORS.down : COLORS.flat;
      const [left, width] = slot(i);
      const cx = center(i);
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(cx, y(bar.high)); ctx.lineTo(cx, y(bar.low)); ctx.stroke();
      const top = Math.min(y(bar.open), y(bar.close));
      ctx.fillRect(left, top, width, Math.max(1, Math.abs(y(bar.open) - y(bar.close))));
    }
  }

  #drawSma(ctx, { start, end, y, xOf, COLORS }) {
    this.sma.forEach((line, k) => {
      ctx.strokeStyle = COLORS.sma[k % COLORS.sma.length]; ctx.lineWidth = 1.2; ctx.beginPath();
      let started = false;
      for (let i = start; i <= end; i += 1) {
        if (line[i] == null) continue;
        if (started) ctx.lineTo(xOf(i), y(line[i])); else { ctx.moveTo(xOf(i), y(line[i])); started = true; }
      }
      ctx.stroke();
    });
    ctx.lineWidth = 1;
  }

  // 最高 / 最低 of the visible range.
  #drawExtremes(ctx, { plot, start, visible, y, xOf, digits, COLORS }) {
    const highIndex = start + visible.reduce((best, bar, i) => (bar.high > visible[best].high ? i : best), 0);
    const lowIndex = start + visible.reduce((best, bar, i) => (bar.low < visible[best].low ? i : best), 0);
    const marker = (index, price, label, color, below) => {
      const mx = xOf(index), my = y(price) + (below ? 10 : -10);
      const text = `${label}: ${priceText(price, { digits: Math.max(digits, 2) })}`;
      ctx.font = "12px system-ui, 'Microsoft JhengHei', sans-serif";
      const w = ctx.measureText(text).width;
      const toLeft = mx + w + 8 > plot.right;
      ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.textAlign = toLeft ? "right" : "left";
      ctx.fillText(text, toLeft ? mx - 6 : mx + 6, my);
      ctx.font = "11px system-ui, 'Microsoft JhengHei', sans-serif";
    };
    marker(highIndex, this.bars[highIndex].high, "最高", COLORS.high, false);
    marker(lowIndex, this.bars[lowIndex].low, "最低", COLORS.low, true);
  }

  // A price tag on the axis (the crosshair's price).
  #axisLabel(ctx, { plot, priceBottom, y, digits }, price, background, color = themeColor("--kline-bg")) {
    const ly = y(price);
    if (ly < plot.top || ly > priceBottom) return;
    ctx.fillStyle = background; ctx.fillRect(plot.right + 1, ly - 8, PRICE_AXIS - 2, 16);
    ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(priceText(price, { digits: Math.max(digits, 2) }), plot.right + 5, ly);
  }

  #drawCrosshair(ctx, view) {
    const { plot, start, end, priceBottom, hi, lo, center, COLORS } = view;
    if (!this.hover || this.hover.index < start || this.hover.index > end) return;
    const cx = center(this.hover.index);
    const cy = Math.min(Math.max(this.hover.y, plot.top), priceBottom);
    ctx.strokeStyle = COLORS.crosshair;
    ctx.beginPath(); ctx.moveTo(cx, plot.top); ctx.lineTo(cx, plot.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(plot.left, Math.round(cy) + 0.5); ctx.lineTo(plot.right, Math.round(cy) + 0.5); ctx.stroke();
    this.#axisLabel(ctx, view, hi - (cy - plot.top) / (priceBottom - plot.top) * (hi - lo), COLORS.crosshairLabel);
    const label = this.bars[this.hover.index].crosshairLabel ?? this.bars[this.hover.index].label;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = COLORS.crosshairLabel; ctx.fillRect(cx - w / 2, plot.bottom + 1, w, TIME_AXIS - 2);
    ctx.fillStyle = themeColor("--kline-bg"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(label, cx, plot.bottom + 3);
  }
}
