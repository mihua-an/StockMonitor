import { formatChartPrice, formatQuantity } from "../utility.js";
import { EQUITY_TIME_AXIS } from "./time_axis_policy.js";
import { DEFAULT_PRICE_SCALE_POLICY } from "./price_scale_policy.js";
import { DEFAULT_REPLAY_STYLE_POLICY } from "./replay_style_policy.js";
import { updateTrendLookupChartState } from "./interaction_controller.js";
import { CoordinateTransform } from "./coordinate_transform.js";
import { DEFAULT_GRID_POLICY } from "./grid_policy.js";
import { DEFAULT_TIME_LABEL_POLICY } from "./time_label_policy.js";
import { DEFAULT_REFERENCE_LINE_POLICY } from "./reference_line_policy.js";
import { marketPalette, themeColor } from "../market_palette.js";
import { drawEventMarkers } from "./event_marker_layout.js";
import { elementSize } from "../element_size.js";
import { normalizeProviderAverageSeries } from "./trend_indicator_engine.js";

const OPEN_SNAP_MINUTE = 1;

// A minute bar's own high/low bracket its close. The line is drawn through closes, but the day's
// 最高/最低 are trades INSIDE a minute: marking the highest close instead is why the chart's high
// mark disagreed with the 最高 in the row beneath it whenever a minute closed off its high.
function barHigh(point) {
  const high = Number(point?.high);
  return Number.isFinite(high) && high >= point.price ? high : point.price;
}
function barLow(point) {
  const low = Number(point?.low);
  return Number.isFinite(low) && low > 0 && low <= point.price ? low : point.price;
}

// The frame is drawn straight onto the visible canvas. A canvas shows what a task drew only when the task ends, so
// a synchronous redraw never shows a half-drawn or cleared frame; a full back buffer copied over on every frame cost
// one whole-canvas drawImage per tick. The backing store is resized (which clears it) only when the size changes,
// and the opaque base layer covers every pixel of each frame.
function prepareFrame(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = elementSize(canvas);
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height));
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height, pixelWidth, pixelHeight };
}

// The parts of a trend frame that only the size, the axes and the price scale decide -- the background with the plot
// frame, and the time / price grids with their labels -- are painted once into two layers per canvas and copied into
// each frame; a new point redraws only the volume, the lines and the markers. Two layers because the grid lies over
// the volume bars.
const TREND_STATIC_LAYERS = new WeakMap();

function staticLayer(canvas, name, surface, key, refs, paint) {
  let layers = TREND_STATIC_LAYERS.get(canvas);
  if (!layers) { layers = {}; TREND_STATIC_LAYERS.set(canvas, layers); }
  const current = layers[name];
  if (current && current.key === key && current.refs.length === refs.length && current.refs.every((ref, i) => ref === refs[i])) return current.canvas;
  const layer = current?.canvas || document.createElement("canvas");
  layer.width = surface.pixelWidth;
  layer.height = surface.pixelHeight;
  const ctx = layer.getContext("2d");
  ctx.setTransform(surface.pixelWidth / surface.width, 0, 0, surface.pixelHeight / surface.height, 0, 0);
  paint(ctx);
  layers[name] = { canvas: layer, key, refs };
  return layer;
}

// A layer is device pixels: copied 1:1, then the frame goes on drawing in CSS pixels.
function copyLayer(ctx, layer) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

// The plot is one rounded box: the price band on top (the line, its grid and the 昨收 line), the volume band under it,
// a separator between them. Only the left side has an axis (the price labels and the current-price tag); the time
// labels sit under the box.
const PRICE_BAND_SHARE = 0.72;
const BAND_GAP_SHARE = 0.05;
// The gap holds the lowest price label's lower half and the volume label's top: never less than a label's height.
const BAND_GAP_MIN = 13;
const AXIS_FONT = '11px "Microsoft JhengHei", sans-serif';

function plotGeometry(width, height, leftMargin) {
  const margin = { top: 4, right: 8, bottom: 18, left: leftMargin };
  const plotLeft = margin.left;
  const plotTop = margin.top;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const plotBottom = plotTop + plotHeight;
  const priceTop = plotTop + 6;
  const priceBottom = plotTop + plotHeight * PRICE_BAND_SHARE;
  const volumeTop = priceBottom + Math.max(BAND_GAP_MIN, plotHeight * BAND_GAP_SHARE);
  return { plotLeft, plotTop, plotWidth, plotHeight, plotRight: plotLeft + plotWidth, plotBottom,
    priceTop, priceBottom, priceHeight: priceBottom - priceTop, volumeTop, volumeBottom: plotBottom - 1 };
}

// The left axis is as wide as the longest label it shows (a five-digit index needs more than a stock).
const AXIS_LABEL_WIDTHS = new Map();
const AXIS_LABEL_WIDTHS_LIMIT = 4096;

function axisWidth(ctx, values) {
  ctx.save();
  ctx.font = AXIS_FONT;
  const widthOf = (value) => {
    const label = formatChartPrice(value);
    let width = AXIS_LABEL_WIDTHS.get(label);
    if (width === undefined) {
      width = ctx.measureText(label).width || 0;
      if (AXIS_LABEL_WIDTHS.size >= AXIS_LABEL_WIDTHS_LIMIT) AXIS_LABEL_WIDTHS.clear();
      AXIS_LABEL_WIDTHS.set(label, width);
    }
    return width;
  };
  const widest = Math.max(...values.map(widthOf), 24);
  ctx.restore();
  return Math.ceil(widest + 14);
}

// 每分鐘只取最後一筆價格。後端目前已經會先做 minute bucket，
// 這裡再做一次保險，避免舊 API / 快取仍送來 15 秒級資料。
function minutePoints(rawPoints, timeAxisPolicy, axisSpan) {
  const minutePointMap = new Map();
  const sourcePoints = Array.isArray(rawPoints) ? rawPoints : [];
  sourcePoints.forEach((p, index) => {
    const rawMinute = timeAxisPolicy.coordinateForPoint(p, index, sourcePoints.length);
    const price = Number(p?.price ?? p?.current ?? p?.close);
    if (!Number.isFinite(rawMinute) || !Number.isFinite(price) || price <= 0 || rawMinute < 0 || rawMinute > axisSpan) return;
    const minute = Math.min(axisSpan, Number(rawMinute));
    const cumulativeVolume = Number(p?.total_volume ?? p?.volume);
    const minuteVolume = Number(p?.minute_volume ?? p?.volume);
    minutePointMap.set(Math.round(minute * 1000) / 1000, {
      ...p,
      minute,
      price,
      time: p?.time ?? p?.exchange_time ?? p?.timestamp ?? p?.datetime,
      volume: Number.isFinite(cumulativeVolume) ? cumulativeVolume : null,
      minuteVolume: Number.isFinite(minuteVolume) ? Math.max(0, minuteVolume) : null,
    });
  });
  const points = [...minutePointMap.values()].sort((a, b) => a.minute - b.minute);
  fillMinuteVolumes(points);
  fillProviderAverages(points);
  if (points.length > 0 && Number.isFinite(points[0].minute) && points[0].minute >= 0
    && timeAxisPolicy.id === "equity-day" && points[0].minute <= OPEN_SNAP_MINUTE) {
    points[0].minute = 0;
  }
  return points;
}

// 舊 API 沒有 minute_volume 時，由每分鐘最後一筆累積量在前端補算。
function fillMinuteVolumes(points) {
  let previousTotalVolume = null;
  for (const point of points) {
    if (Number.isFinite(point.minuteVolume)) {
      if (Number.isFinite(point.volume)) previousTotalVolume = point.volume;
      continue;
    }
    if (!Number.isFinite(point.volume)) continue;
    if (previousTotalVolume == null) {
      point.minuteVolume = point.minute === 0 ? Math.max(0, point.volume) : null;
    } else if (point.volume >= previousTotalVolume) {
      point.minuteVolume = Math.max(0, point.volume - previousTotalVolume);
    } else {
      point.minuteVolume = Math.max(0, point.volume);
    }
    previousTotalVolume = point.volume;
  }
}

// 查價視窗的均價與均價線同一份讀法（trend_indicator_engine.js normalizeProviderAverageSeries）。
function fillProviderAverages(points) {
  const averages = normalizeProviderAverageSeries(points);
  points.forEach((point, index) => { point.averagePrice = averages[index]; });
}

// 個股走勢上的 benchmark 疊圖由 features/realtime/live_view_models.js 在同一個
// 離屏 frame 內一起繪製。這樣 benchmark 不會因為後畫 canvas 被洗掉，
// 同時可把疊圖的 synthetic stock price 納入 Y 軸範圍，避免大盤漲跌幅
// 超過個股本身波動時整條線被 clip 在圖外。Provider 只回傳已投影到
// 個股價格軸的 minute/price，不會建立第二條 Y 軸。
function normalizeOverlaySeries(seriesList, axisSpan) {
  return (Array.isArray(seriesList) ? seriesList : [])
    .map((series) => ({
      ...series,
      points: (Array.isArray(series?.points) ? series.points : [])
        .map((point) => ({ minute: Number(point?.minute), price: Number(point?.price) }))
        .filter((point) => Number.isFinite(point.minute) && Number.isFinite(point.price)
          && point.minute >= 0 && point.minute <= axisSpan),
    }))
    .filter((series) => series.points.length >= 2);
}

// 歷史回放與即時報價共用同一個 drawRealtimeTrendChart 疊圖入口。
// 呼叫端可以直接透過 options.overlaySeries 傳入已投影到個股價格軸的序列；
// 另一個入口是呼叫端給的 overlayProvider（options.overlayProvider）。
function collectOverlaySeries(options, points, prevClose, validOpenPrice, axisSpan) {
  let overlaySeries = normalizeOverlaySeries(options?.overlaySeries, axisSpan);
  const overlayProvider = options?.overlayProvider;
  if (typeof overlayProvider === "function" && options?.useOverlayProvider !== false) {
    try {
      const provided = overlayProvider({
        points: points.map((point) => ({ ...point })),
        prevClose: Number.isFinite(Number(prevClose)) ? Number(prevClose) : null,
        openPrice: Number.isFinite(validOpenPrice) ? validOpenPrice : null,
      });
      overlaySeries = [...overlaySeries, ...normalizeOverlaySeries(provided, axisSpan)];
    } catch (error) {
      console.warn("[TREND OVERLAY] provider failed", error);
    }
  }
  return overlaySeries;
}

// The price scale: the chart's own prices (bars' own high/low, markers, the open) inside it, the reference at its
// center when there is one. An overlay (加權 / 期貨 projected onto the price axis) is drawn inside this scale and
// clipped to the plot: it never moves the axis, so the five price levels do not depend on which overlay is picked.
// Price charts stay in absolute-price space: a 0/null placeholder is not a valid reference and must never create a
// symmetric-around-zero market axis.
function resolvePriceScale({ prevClose, referenceLine, points, eventMarkers, validOpenPrice, options }) {
  const numericReference = Number(prevClose);
  let highPrice = Number.isFinite(numericReference) && numericReference > 0 ? numericReference : null;
  let lowPrice = highPrice;
  if (points.length > 0 || eventMarkers.length > 0 || Number.isFinite(validOpenPrice)) {
    const priceList = [
      ...points.map((p) => p.price),
      ...points.map(barHigh),
      ...points.map(barLow),
      ...eventMarkers.map((marker) => Number(marker.price)),
      ...(Number.isFinite(validOpenPrice) ? [validOpenPrice] : []),
    ];
    highPrice = Math.max(...priceList);
    lowPrice = Math.min(...priceList);
  }
  const visibleFallbackCenter = Number.isFinite(highPrice) && Number.isFinite(lowPrice)
    ? (Number(highPrice) + Number(lowPrice)) / 2
    : (Number.isFinite(Number(points.at(-1)?.price)) ? Number(points.at(-1).price) : null);
  const resolvedScale = (options?.priceScalePolicy || DEFAULT_PRICE_SCALE_POLICY).resolve({
    referencePrice: referenceLine.available ? referenceLine.value : null,
    fallbackCenter: visibleFallbackCenter,
    prices: [highPrice, lowPrice],
  });
  const center = resolvedScale.reference;
  const maxDiff = resolvedScale.maxDiff;
  return {
    center,
    top: resolvedScale.top,
    bottom: resolvedScale.bottom,
    yLevels: [resolvedScale.top, center + maxDiff / 2, center, center - maxDiff / 2, resolvedScale.bottom],
  };
}

// The highest minute volume of the drawn points (null when none), the volume band's scale and its axis label.
function maxMinuteVolumeOf(points) {
  let max = 0;
  for (const point of points) {
    const volume = Number(point.minuteVolume);
    if (Number.isFinite(volume) && volume > max) max = volume;
  }
  return max > 0 ? max : null;
}

// 每分鐘成交量柱：使用「本分鐘最後累積量 - 上一分鐘最後累積量」，畫在價格帶下面自己的量帶裡。
function drawVolumeBars(ctx, frame) {
  const { points, prevClose, plotLeft, plotWidth, plotRight, volumeTop, volumeBottom, axisSpan, xFromMinute, maxMinuteVolume } = frame;
  if (!maxMinuteVolume) return;
  const volumeAreaHeight = volumeBottom - volumeTop;
  const barWidth = Math.max(1, (plotWidth / axisSpan) * 0.82);
  const palette = marketPalette();
  const flatColor = themeColor("--chart-flat-band");
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.rect(plotLeft, volumeTop, plotWidth, volumeAreaHeight);
  ctx.clip();
  // fillStyle is set only when the colour changes (assigning it parses the colour string each time).
  let currentColor = null;
  points.forEach((point, index) => {
    const minuteVolume = Number(point.minuteVolume);
    if (!Number.isFinite(minuteVolume) || minuteVolume <= 0) return;
    const previousPrice = index > 0 ? points[index - 1].price : prevClose;
    // The one market red / green (設定 / styles/tokens.css :root), solid like every other bar.
    const barColor = point.price > previousPrice ? palette.up : point.price < previousPrice ? palette.down : flatColor;
    const barHeight = Math.max(1, (minuteVolume / maxMinuteVolume) * volumeAreaHeight);
    const barX = Math.max(plotLeft, Math.min(plotRight - barWidth, xFromMinute(point.minute) - barWidth / 2));
    if (barColor !== currentColor) { ctx.fillStyle = barColor; currentColor = barColor; }
    ctx.fillRect(barX, volumeBottom - barHeight, barWidth, barHeight);
  });
  ctx.restore();
}

// Grid geometry and text labels are separate policies. TXF can keep hourly
// structure while rendering sparse 2-hour labels during the long night session.
function drawTimeGrid(ctx, frame, options) {
  const { timeAxisPolicy, plotWidth, plotTop, plotBottom, xFromMinute } = frame;
  const asTicks = (ticks) => ticks.map((tick) => ({ minute: tick.coordinate, label: tick.label, kind: tick.kind }));
  const gridTicks = asTicks((options?.gridPolicy || DEFAULT_GRID_POLICY).ticks(timeAxisPolicy));
  const labelTicks = asTicks((options?.timeLabelPolicy || DEFAULT_TIME_LABEL_POLICY).ticks(timeAxisPolicy, { plotWidth }));
  ctx.strokeStyle = themeColor("--chart-grid");
  ctx.fillStyle = themeColor("--chart-label");
  ctx.font = '11px "Microsoft JhengHei", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tick of gridTicks) {
    const x = xFromMinute(tick.minute);
    ctx.strokeStyle = tick.kind === "session-break" ? themeColor("--chart-session-break-line") : themeColor("--chart-grid");
    ctx.setLineDash(tick.kind === "session-break" ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const tick of labelTicks) {
    if (!tick.label) continue;
    ctx.fillStyle = tick.kind === "session-break" ? themeColor("--chart-session-break-label") : themeColor("--chart-label");
    ctx.fillText(tick.label, xFromMinute(tick.minute), plotBottom + 4);
  }
}

// 所有共用走勢圖的水平格線採同一規格。
// 昨收永遠位在價格軸正中央，同時就是 0% 基準；中線不跳過，
// 而是和上、下水平格線使用完全相同的實線樣式。
// 先前額外繪製的「開盤價虛線 + 右側 O 標記」會讓使用者誤以為
// 中央基準是開盤價，因此已移除；openPrice 仍可用於資料範圍與其他計算，
// 但不再形成第二條視覺基準線。
// 五位數指數的標籤直接從 canvas 左緣開始，不再保留固定大 margin。
// The price band's lines: faint lines at the quarter levels, the 昨收 (the center level) dashed, and the separator
// between the price and the volume band. With no reference the center is only a scale midpoint: a faint line.
function drawPriceGrid(ctx, frame) {
  const { yLevels, plotLeft, plotRight, yFromPrice, referenceLine, priceBottom, volumeTop } = frame;
  ctx.lineWidth = 1;
  ctx.strokeStyle = themeColor("--chart-grid");
  for (const value of [yLevels[1], yLevels[3]]) {
    const y = Math.round(yFromPrice(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }
  const separator = Math.round((priceBottom + volumeTop) / 2) + 0.5;
  ctx.strokeStyle = themeColor("--chart-separator");
  ctx.beginPath();
  ctx.moveTo(plotLeft, separator);
  ctx.lineTo(plotRight, separator);
  ctx.stroke();
  const center = Math.round(yFromPrice(yLevels[2])) + 0.5;
  ctx.strokeStyle = themeColor(referenceLine.available ? "--chart-reference-line" : "--chart-grid");
  ctx.setLineDash(referenceLine.available ? [3, 4] : []);
  ctx.beginPath();
  ctx.moveTo(plotLeft, center);
  ctx.lineTo(plotRight, center);
  ctx.stroke();
  ctx.setLineDash([]);
}

// The tone of a price against 昨收 (flat without a reference), in the chart's colours.
function priceToneColor(price, frame) {
  const palette = marketPalette();
  if (!frame.referenceLine.available) return themeColor("--chart-label");
  if (price > frame.prevClose) return palette.up;
  if (price < frame.prevClose) return palette.down;
  return themeColor("--chart-axis-flat");
}

// The left axis: the five levels in their tone against 昨收 and the highest minute volume at the top of the volume
// band. No current-price tag (user 11-07): 現價 is in the header.
function drawPriceAxis(ctx, frame) {
  const { yLevels, plotLeft, yFromPrice, volumeTop, maxMinuteVolume } = frame;
  const right = plotLeft - 4;
  ctx.save();
  ctx.font = AXIS_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const value of yLevels) {
    ctx.fillStyle = priceToneColor(value, frame);
    ctx.fillText(formatChartPrice(value), right, yFromPrice(value));
  }
  if (maxMinuteVolume) {
    ctx.fillStyle = themeColor("--chart-label");
    ctx.textBaseline = "top";
    ctx.fillText(formatQuantity(maxMinuteVolume), right, volumeTop);
  }
  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

// benchmark 疊圖先畫，再畫個股主線，讓個股永遠在最上層。
// benchmark 的 price 已由 realtime.js 依「各自開盤價漲跌幅」投影到個股價格軸。
function drawOverlaySeries(ctx, frame, overlaySeries) {
  if (overlaySeries.length === 0) return;
  const { plotLeft, plotTop, plotWidth, plotHeight, xFromMinute, yFromPrice, crossesMissingInterval } = frame;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();
  for (const series of overlaySeries) {
    ctx.beginPath();
    series.points.forEach((point, index) => {
      const x = xFromMinute(point.minute);
      const y = yFromPrice(point.price);
      if (index === 0 || crossesMissingInterval(series.points[index - 1], point)) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = String(series.strokeStyle || themeColor("--chart-series"));
    ctx.lineWidth = Number.isFinite(Number(series.lineWidth)) ? Number(series.lineWidth) : 1.8;
    ctx.globalAlpha = Number.isFinite(Number(series.alpha)) ? Number(series.alpha) : 0.92;
    ctx.stroke();
  }
  ctx.restore();
}

function strokeSegment(ctx, x1, y1, x2, y2, color, lineWidth = 1.35) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// 走勢線：每一段依「昨收線」分色，而不是用最後一筆決定整條線。
// 高於昨收 = 紅色；低於或等於昨收 = 綠色。穿越昨收時在交叉點切色。
// A replay trade interval colors by its own style policy; without a reference the line is one neutral color.
function drawPriceLine(ctx, frame, options, replay) {
  const { points, prevClose, referenceLine, xFromMinute, yFromPrice, crossesMissingInterval } = frame;
  const { up: upColor, down: downColor } = marketPalette();  // the user's 紅漲 / 綠漲 setting
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (crossesMissingInterval(previous, current)) continue;
    const x1 = xFromMinute(previous.minute);
    const y1 = yFromPrice(previous.price);
    const x2 = xFromMinute(current.minute);
    const y2 = yFromPrice(current.price);
    if (replay.active) {
      const style = (options?.replayStylePolicy || DEFAULT_REPLAY_STYLE_POLICY).resolve({
        previous, current, tradeInterval: replay.interval, options,
      });
      let segmentColor = style.color;
      if (!segmentColor) {
        const midpoint = (Number(previous.price) + Number(current.price)) / 2;
        segmentColor = midpoint > prevClose ? upColor : midpoint < prevClose ? downColor : replay.flatColor;
      }
      strokeSegment(ctx, x1, y1, x2, y2, segmentColor, Number(style.width) || 1.35);
      continue;
    }
    if (!referenceLine.available) {
      strokeSegment(ctx, x1, y1, x2, y2, options?.unreferencedLineColor || themeColor("--chart-unreferenced-line"));
      continue;
    }
    const crossesPrevClose = (previous.price - prevClose) * (current.price - prevClose) < 0;
    if (crossesPrevClose && current.price !== previous.price) {
      const ratio = (prevClose - previous.price) / (current.price - previous.price);
      const crossX = xFromMinute(previous.minute + (current.minute - previous.minute) * ratio);
      const crossY = yFromPrice(prevClose);
      strokeSegment(ctx, x1, y1, crossX, crossY, previous.price > prevClose ? upColor : downColor);
      strokeSegment(ctx, crossX, crossY, x2, y2, current.price > prevClose ? upColor : downColor);
    } else {
      // 如果其中一端剛好落在昨收，使用線段中點判斷真正位於哪一側。
      const midpoint = (previous.price + current.price) / 2;
      strokeSegment(ctx, x1, y1, x2, y2, midpoint > prevClose ? upColor : downColor);
    }
  }
}

// 回放可以直接指定「整個交易區間」的顏色規則（options.tradeInterval + replayStylePolicy）。
function replayMode(options) {
  const interval = options?.tradeInterval || null;
  return {
    interval,
    active: Number.isFinite(Number(interval?.startMinute)) && Number.isFinite(Number(interval?.endMinute)),
    flatColor: options?.tradeFlatColor || themeColor("--chart-trade-flat"),
  };
}

export function renderTrendCanvas(canvas, rawPoints, prevClose, openPrice = null, options = {}) {
  const surface = prepareFrame(canvas);
  if (!surface) return;
  const { ctx, width, height } = surface;

  let referenceLine = (options?.referenceLinePolicy || DEFAULT_REFERENCE_LINE_POLICY).resolve(prevClose, { referenceAvailable: options?.referenceAvailable !== false, referenceType: options?.referenceType, referenceSource: options?.referenceSource });

  const timeAxisPolicy = options?.timeAxisPolicy || EQUITY_TIME_AXIS;
  const axisSpan = Math.max(1, Number(timeAxisPolicy?.span) || 270);
  const points = minutePoints(rawPoints, timeAxisPolicy, axisSpan);
  const maxConnectGapMinutes = Number(options?.maxConnectGapMinutes);
  const crossesMissingInterval = (previous, current) => Number.isFinite(maxConnectGapMinutes)
    && maxConnectGapMinutes > 0
    && Number(current?.minute) - Number(previous?.minute) > maxConnectGapMinutes;
  const eventMarkers = Array.isArray(options?.eventMarkers)
    ? options.eventMarkers.filter((marker) => Number.isFinite(Number(marker?.price)))
    : [];
  // Number(null) is 0. Treating a missing open as a real zero added 0 to the
  // TAIEX price range and flattened the entire index line against the top edge.
  const rawOpenPrice = Number(openPrice);
  const validOpenPrice = Number.isFinite(rawOpenPrice) && rawOpenPrice > 0 ? rawOpenPrice : null;
  const overlaySeries = collectOverlaySeries(options, points, prevClose, validOpenPrice, axisSpan);
  const scale = resolvePriceScale({ prevClose, referenceLine, points, eventMarkers, validOpenPrice, options });
  // Keep reference-line semantics separate from fallback scale geometry. Missing
  // authoritative reference means no 0% line/color segmentation, but the axis
  // still uses a legal absolute-price center.
  if (!referenceLine.available) referenceLine = { ...referenceLine, value: null };

  // The axis is as wide as its widest label (the scale's ends; the current-price tag is one of the prices between them).
  const geometry = plotGeometry(width, height, axisWidth(ctx, [scale.top, scale.bottom]));
  const { plotLeft, plotTop, plotWidth, plotHeight, priceTop, priceHeight } = geometry;

  // The card's colour and the plot's rounded box (a cached layer: size and axis width only).
  copyLayer(ctx, staticLayer(canvas, "base", surface, `${surface.pixelWidth}x${surface.pixelHeight}|${plotLeft}`, [], (layer) => {
    layer.fillStyle = themeColor("--chart-surface");
    layer.fillRect(0, 0, width, height);
    layer.fillStyle = themeColor("--chart-plot-bg");
    roundedRect(layer, plotLeft, plotTop, plotWidth, plotHeight, 6);
    layer.fill();
  }));

  const coordinateTransform = new CoordinateTransform({ plotLeft, plotTop: priceTop, plotWidth, plotHeight: priceHeight, domainSpan: axisSpan, yTop: scale.top, yBottom: scale.bottom });
  const xFromMinute = (minute) => coordinateTransform.xFromCoordinate(minute);
  const yFromPrice = (price) => coordinateTransform.yFromPrice(price);
  const frame = { ...geometry, points, prevClose: scale.center, referenceLine, yLevels: scale.yLevels, axisSpan, timeAxisPolicy,
    xFromMinute, yFromPrice, crossesMissingInterval, maxMinuteVolume: maxMinuteVolumeOf(points) };

  drawVolumeBars(ctx, frame);
  // The grid lines (a cached layer over the volume): size, time axis, price scale, whether 昨收 is known.
  const gridKey = [surface.pixelWidth, surface.pixelHeight, plotLeft, axisSpan, scale.top, scale.bottom,
    scale.yLevels.join(","), referenceLine.available].join("|");
  copyLayer(ctx, staticLayer(canvas, "grid", surface, gridKey,
    [timeAxisPolicy, options?.gridPolicy || DEFAULT_GRID_POLICY, options?.timeLabelPolicy || DEFAULT_TIME_LABEL_POLICY], (layer) => {
      drawTimeGrid(layer, frame, options);
      drawPriceGrid(layer, frame);
    }));
  drawPriceAxis(ctx, frame);
  drawOverlaySeries(ctx, frame, overlaySeries);
  if (points.length > 0) drawPriceLine(ctx, frame, options, replayMode(options));
  drawEventMarkers(ctx, { axisSpan, barHigh, barLow, eventMarkers, plotBottom: geometry.priceBottom, plotHeight: priceHeight, plotLeft,
    plotRight: geometry.plotRight, plotTop: priceTop, plotWidth, points, timeAxisPolicy, xFromMinute, yFromPrice });

  const frameMeta = {
    points,
    prevClose: scale.center,
    openPrice: Number.isFinite(validOpenPrice) ? validOpenPrice : null,
    plotLeft,
    plotTop,
    plotRight: geometry.plotRight,
    plotBottom: geometry.plotBottom,
    plotWidth,
    plotHeight,
    xFromMinute,
    yFromPrice,
    yLevels: scale.yLevels,
    timeAxisPolicy,
    identityResolver: options?.identityResolver,
    lookupDock: options?.lookupDock,
  };
  updateTrendLookupChartState(canvas, frameMeta);
  canvas.dispatchEvent(new CustomEvent("trend-frame-drawn", { detail: frameMeta }));
}
