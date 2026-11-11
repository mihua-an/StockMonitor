// 歷史回放 事件標記: the replayed day's intraday events and 當沖 entries as trend markers, cut at the replay time (split
// out of pages/history.js).
import { eventFeedKey } from "../../core/event_feed_format.js";
import { eventMarkerColor, eventMarkerLabel, eventMarkerPlacement, eventMarkerPriority } from "../../core/event_markers.js";
import { marketPalette } from "../../core/market_palette.js";
import { $ } from "../../core/utility.js";
import { historyState } from "./history_state.js";
import { activeHistoryTradeForCurrent, getHistoryReplayCutoffTime, historyReplayClockMinute, historyTradeEntryPrice, historyTradeInterval, normalizeHistoryClockText } from "./history_values.js";
import { historyTradePriceText } from "./presentation.js";

// The day's recorded tape ordered by its clock, built once per tape (and per code when asked): what the replay time
// shows is a prefix of it, found by a binary search. Each seek and each played second filtered the whole day's tape
// of every stock again, and handed the list and the chart a new array even when no event had crossed the time.
let tape = null;

function recordedTape() {
  const source = Array.isArray(historyState.intradayEvents) ? historyState.intradayEvents : [];
  if (tape?.source !== source) tape = { source, all: orderedByClock(source), byCode: new Map() };
  return tape;
}

function orderedByClock(events) {
  const timed = []; const timeless = [];
  for (const event of events) {
    const clock = normalizeHistoryClockText(event?.time);
    if (clock) timed.push({ clock, event }); else timeless.push(event);
  }
  timed.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : 0));
  return { timed, timeless, shown: null };
}

// The events of `ordered` at or before the replay time (an event with no time always), newest first; the same array
// while no event crosses the time.
function shownAtReplayTime(ordered) {
  const cutoff = getHistoryReplayCutoffTime();
  const { timed } = ordered;
  let count = timed.length;
  if (cutoff) {
    let low = 0; let high = timed.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (timed[mid].clock <= cutoff) low = mid + 1; else high = mid;
    }
    count = low;
  }
  if (ordered.shown?.count !== count) {
    const events = [];
    for (let index = count - 1; index >= 0; index -= 1) events.push(timed[index].event);
    ordered.shown = { count, events: events.concat(ordered.timeless) };
  }
  return ordered.shown.events;
}

/** The day's recorded events at or before the replay time, newest first (the same array until one crosses it). */
export function recordedEventsAtReplayTime() {
  return shownAtReplayTime(recordedTape().all);
}

function recordedEventsOfCodeAtReplayTime(code) {
  const current = recordedTape();
  let ordered = current.byCode.get(code);
  if (!ordered) {
    ordered = orderedByClock(current.source.filter((event) => String(event?.code || "") === code));
    current.byCode.set(code, ordered);
  }
  return shownAtReplayTime(ordered);
}

// Label / colour / placement / priority are shared with the live 個股走勢 (core/event_markers.js).
export const historyEventLabel = eventMarkerLabel;

export const historyEventColor = eventMarkerColor;

export const historyEventPlacement = eventMarkerPlacement;

export const historyEventPriority = eventMarkerPriority;

// The price an event or an entry is drawn at: the replay's minute trend at its minute ("HH:MM" -> close).
function minutePrices(points) {
  const prices = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const clock = normalizeHistoryClockText(point?.minute_timestamp || point?.timestamp || point?.time);
    const price = Number(point?.close ?? point?.price);
    if (clock && Number.isFinite(price) && price > 0) prices.set(clock.slice(0, 5), price);
  }
  return prices;
}

export function buildHistoryEventMarkers(points) {
  if ((!historyState.showTradeEventMarkers && !historyState.showAllEventMarkers) || !historyState.selectedCode) return [];
  const trade = activeHistoryTradeForCurrent();
  const tradeInterval = historyTradeInterval(trade);
  const tradeOnly = historyState.showTradeEventMarkers && !historyState.showAllEventMarkers;
  const events = recordedEventsOfCodeAtReplayTime(String(historyState.selectedCode))
    .filter((event) => {
      if (!tradeOnly) return true;
      if (!tradeInterval) return false;
      const minute = historyReplayClockMinute(event?.time);
      return Number.isFinite(minute) && minute >= tradeInterval.startMinute && minute <= tradeInterval.endMinute;
    });
  if (!events.length) return [];

  const prices = minutePrices(points);
  const byMinute = new Map();

  events.forEach((event) => {
    const eventTime = String(event?.time || "").slice(0, 8);
    const minuteKey = eventTime.slice(0, 5);
    const price = prices.get(minuteKey);
    if (!Number.isFinite(price)) return;
    const key = eventFeedKey(event);
    const candidate = {
      time: eventTime,
      price,
      label: historyEventLabel(event),
      color: historyEventColor(event),
      selected: key === historyState.selectedEventKey,
      placement: historyEventPlacement(event),
      key,
      priority: historyEventPriority(event),
      sourceIndex: historyReplayClockMinute(eventTime),
    };

    // 同一分鐘可能同時有好幾個事件（例如 1分急拉 與 3分急拉）。
    // 走勢圖只保留 B 規則 priority 最高的一個；如果使用者剛好點了某一列事件，則選中的
    // 事件優先顯示，讓視覺回饋與表格選取一致。
    const current = byMinute.get(minuteKey);
    if (!current
      || (candidate.selected && !current.selected)
      || (candidate.selected === current.selected && candidate.priority > current.priority)) {
      byMinute.set(minuteKey, candidate);
    }
  });

  return [...byMinute.values()]
    .sort((a, b) => Number(a.sourceIndex) - Number(b.sourceIndex))
    .map((marker) => ({ ...marker }));
}

// 個股歷史走勢永遠保留「自己的進場點」。
// 這些不是盤中監控事件，因此不受「交易時段事件 / 盤中交易事件」Toggle 影響。
// 同一天同一檔若有多筆當沖，回放時間走到哪裡，就顯示截至該時間已經發生的所有進場。
export function buildHistoryTradeEntryMarkers() {
  if (!historyState.selectedCode) return [];

  const selectedDate = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
  const selectedCode = String(historyState.selectedCode || "");
  const cutoff = getHistoryReplayCutoffTime();
  const cutoffMinute = historyReplayClockMinute(cutoff);
  if (!selectedDate || !selectedCode) return [];

  const activeId = String(historyState.selectedDaytradeId || "");
  const uniqueEntries = new Map();
  (Array.isArray(historyState.daytradeMarkerRows) ? historyState.daytradeMarkerRows : [])
    .filter((item) => String(item?.realized_date || "").slice(0, 10) === selectedDate)
    .filter((item) => String(item?.code || "") === selectedCode)
    .filter((item) => {
      const entryMinute = historyReplayClockMinute(item?.entry_ref);
      return !Number.isFinite(cutoffMinute) || !Number.isFinite(entryMinute) || entryMinute <= cutoffMinute + 1e-9;
    })
    .forEach((item) => {
      const direction = String(item?.direction || "").trim();
      const entryTime = normalizeHistoryClockText(item?.entry_ref);
      const entryPrice = historyTradeEntryPrice(item);
      if (!entryTime || !Number.isFinite(entryPrice)) return;

      // 同一筆原始進場若後續被拆成多筆 FIFO 配對，realized_matches 可能出現
      // 相同進場時間/價格的多列。走勢圖只畫一個真正的「進場事件」。
      const dedupeKey = `${direction}|${entryTime}|${entryPrice.toFixed(6)}`;
      const existing = uniqueEntries.get(dedupeKey);
      const selected = String(item?.id ?? "") === activeId;
      if (!existing || (selected && !existing.selected)) {
        uniqueEntries.set(dedupeKey, { item, direction, entryTime, entryPrice, selected });
      }
    });

  return [...uniqueEntries.values()]
    .sort((a, b) => String(a.entryTime).localeCompare(String(b.entryTime)))
    .map(({ item, direction, entryTime, entryPrice, selected }, index) => tradeEntryMarker({
      id: item?.id ?? index, direction, time: entryTime, price: entryPrice, selected, index }));
}

/** A trade's entry on the replay trend: 多 below the line in the up colour, 空 above it in the down colour, ahead of
 * every intraday event (歷史回放's trades of the day and 帳務's 配對回放). */
export function tradeEntryMarker({ id, direction, time, price, selected = false, index = 0 }) {
  const isShort = direction === "空";
  return {
    time,
    price,
    label: `${isShort ? "空" : "多"}:${historyTradePriceText(price)}`,
    color: isShort ? marketPalette().down : marketPalette().up,
    selected,
    // 進場點是覆盤核心資訊，優先級高於一般盤中事件。
    priority: 1000 + index,
    placement: isShort ? "above" : "below",
    sourceIndex: historyReplayClockMinute(time),
    tradeEntry: true,
    key: `trade-entry|${String(id)}`,
  };
}
