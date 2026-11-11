import { marketPalette, themeColor } from "./market_palette.js";
import { readPreference, writePreference } from "./preferences.js";
// Intraday-event markers on a trend chart: one vocabulary for 歷史回放 and the live 個股走勢. Everything a marker
// shows comes from Rust B's record (events.rs EventRecord): its label as written, its rule's `direction` (colour and
// side) and `priority` (which of a minute's events is marked); nothing is read out of the label text.

export function eventMarkerLabel(event) {
  return String(event?.info || "").trim() || "事件";
}

// An up move is red-up and drawn below the line, a down move green and above it; a rule without a direction is flat.
export function eventMarkerColor(event) {
  if (event?.direction === "down") return marketPalette().down;
  if (event?.direction === "up") return marketPalette().up;
  return themeColor("--chart-marker");
}

export function eventMarkerPlacement(event) {
  return event?.direction === "down" ? "above" : event?.direction === "up" ? "below" : "auto";
}

export function eventMarkerPriority(event) {
  return event?.priority;
}

// Live 個股走勢: one marker per minute for the selected code (the most important event of that minute), placed on
// that minute's trend price. `points` are the chart's own trend points ({minute, price} or {time, price}).
export function clockMinute(value) {
  const match = /(?:^|[ T])(\d{1,2}):(\d{2})/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function liveEventMarkers(events, { code, points = [], minuteOf = clockMinute, keyOf = (e) => e?.event_id } = {}) {
  const wanted = String(code || "").trim().toUpperCase();
  if (!wanted || !Array.isArray(events) || !events.length) return [];
  const priceByMinute = new Map();
  for (const point of points) {
    const minute = minuteOf(point?.minute_timestamp || point?.datetime || point?.timestamp || point?.time);
    const price = Number(point?.price ?? point?.close);
    if (Number.isFinite(minute) && Number.isFinite(price)) priceByMinute.set(minute, price);
  }
  const byMinute = new Map();
  for (const event of events) {
    if (String(event?.code || "").trim().toUpperCase() !== wanted || event?.revoked) continue;
    const time = String(event?.time || "").slice(0, 8);
    const minute = minuteOf(time);
    const price = priceByMinute.get(minute);
    if (!Number.isFinite(minute) || !Number.isFinite(price)) continue;
    const candidate = { time, price, label: eventMarkerLabel(event), color: eventMarkerColor(event), placement: eventMarkerPlacement(event),
      priority: eventMarkerPriority(event), key: keyOf(event), sourceIndex: minute, selected: false,
      // Leader line and label only: no dot on the live line (user request).
      dot: false };
    const current = byMinute.get(minute);
    if (!current || candidate.priority > current.priority) byMinute.set(minute, candidate);
  }
  return [...byMinute.values()].sort((a, b) => a.sourceIndex - b.sourceIndex);
}

// 個股走勢「盤中事件」toggle (bottom-right of the chart). Per-viewer display preference, like the 歷史回放 toggles;
// every open window follows through the storage event.
const MARKERS_KEY = "stockmonitor.stockTrendEventMarkers.v1";
const MARKERS_CHANGED = "stock-trend-event-markers-changed";
export function stockTrendEventMarkersVisible() {
  return readPreference(MARKERS_KEY, { context: "stock trend event markers" }) !== "0";
}
/** Store the toggle and announce it; `{ ok: false }` (logged, nothing announced) when it cannot be kept. */
export function setStockTrendEventMarkersVisible(visible) {
  const result = writePreference(MARKERS_KEY, visible ? "1" : "0", { context: "stock trend event markers" });
  if (result.ok) globalThis.window?.dispatchEvent?.(new CustomEvent(MARKERS_CHANGED, { detail: { visible: Boolean(visible) } }));
  return result;
}
export function subscribeStockTrendEventMarkers(callback) {
  const win = globalThis.window;
  if (!win?.addEventListener) return () => {};
  const local = () => callback(stockTrendEventMarkersVisible());
  const other = (event) => { if (event.key === MARKERS_KEY) callback(stockTrendEventMarkersVisible()); };
  win.addEventListener(MARKERS_CHANGED, local);
  win.addEventListener("storage", other);
  return () => { win.removeEventListener(MARKERS_CHANGED, local); win.removeEventListener("storage", other); };
}
