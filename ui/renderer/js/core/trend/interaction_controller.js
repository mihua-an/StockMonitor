import { $, clamp, formatQuantity } from "../utility.js";
import { onElementResize } from "../element_size.js";
// One price text: a missing 均價 reads "--", not the 0.00 the local copy printed for null.
import { priceText } from "../auction_price.js";

const STATES = new WeakMap();

// Decimal volumes keep their significant decimals (a 0.0001-share minute is not "0").
function volumeText(value) {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? "--" : formatQuantity(n);
}

// The chart knows no page (F2): the surface that draws it names its series (`identityResolver`) and may name where
// the lookup card docks (`lookupDock`). Without one, a page can declare the dock in its markup -- the canvas carries
// data-trend-lookup-dock="<name>", the element to dock on data-trend-lookup-dock-target="<name>" (and
// data-trend-lookup-align="left|right") -- else the card sits beside the canvas.
function seriesIdentity(canvas, chart) {
  return (typeof chart?.identityResolver === "function" ? chart.identityResolver(canvas) : null) || { name: "走勢", code: "" };
}

function declaredDock(canvas) {
  const name = canvas?.dataset?.trendLookupDock;
  if (!name) return null;
  const element = document.querySelector(`[data-trend-lookup-dock-target="${CSS.escape(name)}"]`);
  return element ? { element, align: element.dataset.trendLookupAlign === "left" ? "left" : "right" } : null;
}

const CARD_WIDTH = 214;
const CARD_HEIGHT = 218;

function positionCard(canvas, state) {
  if (!canvas || !state?.card) return;
  const canvasRect = canvas.getBoundingClientRect();
  const targetInfo = state.chart?.lookupDock?.() || declaredDock(canvas);
  const target = targetInfo?.element || targetInfo;
  const rect = target?.getBoundingClientRect?.();
  let left;
  let top;
  if (rect && rect.width > 0 && rect.height > 0) {
    left = targetInfo?.align === "left" ? rect.left + 10 : rect.right - CARD_WIDTH - 10;
    top = rect.top + 10;
  } else if (window.innerWidth - canvasRect.right >= CARD_WIDTH + 16) {
    left = canvasRect.right + 8;
    top = canvasRect.top + 8;
  } else {
    left = canvasRect.left - CARD_WIDTH - 8;
    top = canvasRect.top + 8;
  }
  state.card.style.left = `${Math.round(clamp(left, 8, Math.max(8, window.innerWidth - CARD_WIDTH - 8)))}px`;
  state.card.style.top = `${Math.round(clamp(top, 8, Math.max(8, window.innerHeight - CARD_HEIGHT - 8)))}px`;
  state.cardPlaced = true;
}

// Where the canvas sits in its host and in the viewport. Read once and kept until something can move it (a press,
// a resize of the canvas or the window, a scroll): the crosshair is redrawn after every chart frame while it is shown,
// and reading these rects there forced a layout in the middle of the frame.
function geometryOf(canvas, state) {
  if (!state.geometry) {
    const hostRect = state.host?.getBoundingClientRect?.();
    const canvasRect = canvas.getBoundingClientRect();
    state.geometry = {
      ox: hostRect ? canvasRect.left - hostRect.left : 0,
      oy: hostRect ? canvasRect.top - hostRect.top : 0,
      left: canvasRect.left,
    };
  }
  return state.geometry;
}

function invalidateGeometry(state) {
  state.geometry = null;
  state.cardPlaced = false;
}

// The lookup card: built once, then only its texts and colour classes change.
const CARD_ROWS = [["time", "時間"], ["price", "價格"], ["change", "漲跌"], ["pct", "漲幅"], ["minuteVolume", "單量"], ["volume", "總量"], ["average", "均價"]];

function buildCard(card) {
  const title = document.createElement("div");
  title.className = "trend-lookup-card-title";
  const bullet = document.createElement("span");
  bullet.className = "trend-lookup-bullet";
  const name = document.createElement("b");
  const code = document.createElement("span");
  title.append(bullet, name, code);
  card.replaceChildren(title);
  const values = {};
  for (const [key, label] of CARD_ROWS) {
    const row = document.createElement("div");
    row.className = "trend-lookup-row";
    const text = document.createElement("span");
    text.textContent = label;
    const value = document.createElement("b");
    row.append(text, value);
    card.appendChild(row);
    values[key] = value;
  }
  return { name, code, values };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

function setVisible(state, visible, pinned = false, showCard = true) {
  state?.layer?.classList.toggle("active", visible);
  state?.layer?.classList.toggle("pinned", visible && pinned);
  state?.card?.classList.toggle("active", visible && showCard);
  state?.card?.classList.toggle("pinned", visible && showCard && pinned);
}

function nearest(points, target) {
  let best = null;
  let distance = Infinity;
  for (const point of points || []) {
    const x = Number(point?.minute);
    if (!Number.isFinite(x)) continue;
    const next = Math.abs(x - target);
    if (next < distance) {
      best = point;
      distance = next;
    }
  }
  return best;
}

function formatTime(point, chart) {
  const raw = String(point?.time || point?.exchange_time || point?.timestamp || point?.datetime || "");
  const match = raw.match(/(?:^|T|\s)(\d{2}:\d{2})/);
  if (match) return match[1];
  return chart?.timeAxisPolicy?.formatCoordinate?.(point?.minute) || "--:--";
}

// The point's change against the chart's reference (none when the reference is not available).
function changeOf(point, chart) {
  const price = Number(point.price);
  const reference = chart.referenceAvailable === false ? Number.NaN : Number(chart.prevClose);
  const change = Number.isFinite(price) && Number.isFinite(reference) ? price - reference : null;
  const pct = change !== null && reference > 0 ? change / reference * 100 : null;
  return { price, change, pct };
}

function placeCrosshair(canvas, state, chart, point) {
  const x = chart.xFromMinute(point.minute);
  const y = chart.yFromPrice(point.price);
  const { ox, oy } = geometryOf(canvas, state);
  const lx = ox + x;
  const ly = oy + y;
  Object.assign(state.vline.style, { left: `${lx}px`, top: `${oy + chart.plotTop}px`, height: `${chart.plotHeight}px` });
  Object.assign(state.hline.style, { left: `${ox + chart.plotLeft}px`, top: `${ly}px`, width: `${chart.plotWidth}px` });
  Object.assign(state.dot.style, { left: `${lx}px`, top: `${ly}px` });
  state.xLabel.textContent = formatTime(point, chart);
  Object.assign(state.xLabel.style, { left: `${lx}px`, top: `${oy + chart.plotBottom}px` });
  state.yLabel.textContent = priceText(Number(point.price));
  Object.assign(state.yLabel.style, { left: `${ox + chart.plotLeft}px`, top: `${ly}px` });
}

function fillCard(canvas, state, chart, point) {
  const identity = seriesIdentity(canvas, chart);
  const { price, change, pct } = changeOf(point, chart);
  const move = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const moveClass = `trend-lookup-${move}`;
  const view = state.cardView || (state.cardView = buildCard(state.card));
  setText(view.name, identity?.name || "走勢");
  setText(view.code, identity?.code || "");
  view.code.hidden = !identity?.code;
  setText(view.values.time, formatTime(point, chart));
  setText(view.values.price, priceText(price));
  setClass(view.values.price, moveClass);
  setText(view.values.change, change === null ? "--" : priceText(Math.abs(change)));
  setClass(view.values.change, moveClass);
  setText(view.values.pct, pct === null ? "--" : `${Math.abs(pct).toFixed(2)}%`);
  setClass(view.values.pct, moveClass);
  setText(view.values.minuteVolume, volumeText(point.minuteVolume));
  setText(view.values.volume, volumeText(point.volume));
  setText(view.values.average, priceText(point.averagePrice));
}

function renderPoint(canvas, point, keepPinned = false, showCard = true) {
  const state = STATES.get(canvas);
  const chart = state?.chart;
  if (!state || !chart || !point) return;
  state.selectedMinute = Number(point.minute);
  placeCrosshair(canvas, state, chart, point);
  fillCard(canvas, state, chart, point);
  if (showCard && !state.cardPlaced) positionCard(canvas, state);
  setVisible(state, true, Boolean(keepPinned || state.pinned), showCard);
}

function renderPointer(canvas, clientX, keepPinned = false) {
  const state = STATES.get(canvas);
  const chart = state?.chart;
  if (!chart?.points?.length) return;
  const local = clamp(clientX - geometryOf(canvas, state).left, chart.plotLeft, chart.plotRight);
  const target = chart.coordinateTransform?.coordinateFromX?.(local)
    ?? (((local - chart.plotLeft) / chart.plotWidth) * (chart.timeAxisPolicy?.span || 270));
  renderPoint(canvas, nearest(chart.points, target), keepPinned, true);
}

function resetSelection(state) {
  state.pinned = false;
  state.pressed = false;
  state.crosshairOnly = false;
  state.selectedMinute = null;
  setVisible(state, false, false);
}

const LAYER_HTML = '<div class="trend-lookup-vline"></div><div class="trend-lookup-hline"></div><div class="trend-lookup-dot"></div>'
  + '<div class="trend-lookup-axis-label trend-lookup-x-label"></div><div class="trend-lookup-axis-label trend-lookup-y-label"></div>';

function bindPointer(canvas, state, on) {
  const hide = () => {
    state.pressed = false;
    if (!state.pinned) setVisible(state, false, false);
  };
  on(canvas, "pointerdown", (event) => {
    if (event.button !== 0 || state.pinned) return;
    invalidateGeometry(state);
    state.crosshairOnly = false;
    state.pressed = true;
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* not an error: the pointer is already released */ }
    renderPointer(canvas, event.clientX, false);
  });
  on(canvas, "pointermove", (event) => {
    if (state.pressed && !state.pinned) renderPointer(canvas, event.clientX, false);
  });
  on(canvas, "pointerup", (event) => {
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* not an error: the pointer is already released */ }
    hide();
  });
  on(canvas, "pointercancel", hide);
  on(canvas, "dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.pinned) {
      resetSelection(state);
      return;
    }
    invalidateGeometry(state);
    state.pinned = true;
    state.pressed = false;
    state.crosshairOnly = false;
    renderPointer(canvas, event.clientX, true);
  });
}

function ensure(canvas) {
  if (!canvas) return null;
  let state = STATES.get(canvas);
  if (state) return state;
  const host = canvas.parentElement;
  if (!host) return null;
  host.classList.add("trend-lookup-host");
  const layer = document.createElement("div");
  layer.className = "trend-lookup-layer";
  layer.innerHTML = LAYER_HTML;
  host.appendChild(layer);
  const owner = String(canvas.id || "trend-canvas");
  const page = canvas.closest("[data-trend-lookup-host]") || document.querySelector("[data-trend-lookup-host]") || document.body;
  page.querySelectorAll(".trend-lookup-card").forEach((item) => {
    if (item.dataset.trendLookupOwner === owner) item.remove();
  });
  const card = document.createElement("div");
  card.className = "trend-lookup-card";
  card.dataset.trendLookupOwner = owner;
  page.appendChild(card);
  state = {
    host, layer, card,
    vline: layer.children[0], hline: layer.children[1], dot: layer.children[2], xLabel: layer.children[3], yLabel: layer.children[4],
    chart: null, pressed: false, pinned: false, crosshairOnly: false, selectedMinute: null, seriesKey: "",
  };
  // Every listener this lookup adds (window and canvas) is registered with one signal: destroyTrendLookup aborts it,
  // so a canvas that is parked and mounted again carries one set of handlers, never one per mount.
  state.listeners = new AbortController();
  const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: state.listeners.signal });
  state.reposition = () => {
    invalidateGeometry(state);
    if (state.pinned || state.pressed || state.crosshairOnly) positionCard(canvas, state);
  };
  on(window, "resize", state.reposition);
  on(window, "scroll", state.reposition, { capture: true });
  state.stopResize = onElementResize(canvas, state.reposition);
  bindPointer(canvas, state, on);
  STATES.set(canvas, state);
  return state;
}

export function updateTrendLookupChartState(canvas, chart) {
  const state = ensure(canvas);
  if (!state) return;
  const identity = seriesIdentity(canvas, chart);
  const key = `${identity?.code || ""}:${identity?.name || ""}`;
  // Another series: whatever was pinned on the previous one is let go.
  if (state.seriesKey && state.seriesKey !== key) resetSelection(state);
  state.seriesKey = key;
  state.chart = chart;
  if (!chart?.points?.length) {
    setVisible(state, false, false);
    return;
  }
  if ((state.pinned || state.pressed || state.crosshairOnly) && Number.isFinite(state.selectedMinute)) {
    renderPoint(canvas, nearest(chart.points, state.selectedMinute), state.pinned, !state.crosshairOnly);
  }
}

export function destroyTrendLookup(canvas) {
  const target = typeof canvas === "string" ? $(canvas) : canvas;
  const state = target ? STATES.get(target) : null;
  if (!state) return;
  setVisible(state, false, false);
  state.card?.remove();
  state.layer?.remove();
  state.listeners.abort();
  state.stopResize?.();
  STATES.delete(target);
}

// A point chosen from outside the chart (a product row's time): `pinned` keeps the card until the user lets it go;
// otherwise only the crosshair is shown.
function showAtTime(canvas, timeText, pinned) {
  const target = typeof canvas === "string" ? $(canvas) : canvas;
  const state = ensure(target);
  const chart = state?.chart;
  const coordinate = chart?.timeAxisPolicy?.coordinateForTime?.(timeText);
  if (!state || !chart || !Number.isFinite(coordinate) || !chart.points?.length) return false;
  const point = nearest(chart.points, coordinate);
  invalidateGeometry(state);
  state.pinned = pinned;
  state.pressed = false;
  state.crosshairOnly = !pinned;
  renderPoint(target, point, pinned, pinned);
  return true;
}

export function pinTrendLookupAtTime(canvas, timeText) {
  return showAtTime(canvas, timeText, true);
}

export function showTrendCrosshairAtTime(canvas, timeText) {
  return showAtTime(canvas, timeText, false);
}
