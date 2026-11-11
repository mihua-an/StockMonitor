// 歷史回放: the replayed day's value helpers -- names, clock text and the trade under review (split out of pages/history.js).
import { buildTradeInterval } from "../../core/trend/adapters.js";
import { $ } from "../../core/utility.js";
import { historyState } from "./history_state.js";
import { parseExchangeClock } from "../../market_data/taipei_time.js";

/** The replay time ("HH:MM:SS", Market Runtime's replay position), "" before a replay is open. */
export function getHistoryReplayCutoffTime() {
  return normalizeHistoryClockText(historyState.replayCurrentTime);
}

export function isStockReplayProduct(item = {}) {
  const code = String(item?.code || "").trim().toUpperCase();
  return Boolean(code) && !["TAIEX", "TXF", "TXFR1"].includes(code);
}

export function getHistoryStockName(code) {
  const normalized = String(code || "");
  return String(
    historyState.stocks.find((item) => String(item?.code || "") === normalized)?.name || ""
  );
}

export function historyReplayClockMinute(value) {
  const text = normalizeHistoryClockText(value);
  if (!text) return null;
  const [hour, minute, second] = text.split(":").map(Number);
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return ((hour - 9) * 60) + minute + second / 60;
}

export function historyTradeInterval(pair = historyState.activeTradeReview) {
  if (!pair) return null;
  return buildTradeInterval({ entryTime: pair.entry_ref, exitTime: pair.exit_ref });
}

export function historyTradeEntryPrice(pair = historyState.activeTradeReview) {
  if (!pair) return null;
  const isShort = String(pair.direction || "") === "空";
  const value = Number(isShort ? pair.sell_price : pair.buy_price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setActiveHistoryTradeReview(pair) {
  historyState.activeTradeReview = pair ? { ...pair } : null;
  historyState.selectedDaytradeId = pair ? String(pair?.id ?? "") : "";
}

export function activeHistoryTradeForCurrent() {
  const pair = historyState.activeTradeReview;
  if (!pair) return null;
  const date = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
  const code = String(historyState.selectedCode || "");
  if (String(pair.realized_date || "").slice(0, 10) !== date) return null;
  if (String(pair.code || "") !== code) return null;
  return pair;
}

export function historyTradeReplayStatus(pair = activeHistoryTradeForCurrent()) {
  return tradeReplayStatus(pair, getHistoryReplayCutoffTime());
}

/** Where the replay time `clock` ("HH:MM:SS") is against `pair`'s holding: inside it, before its entry or after its
 * exit (歷史回放's trade review and 帳務's 配對回放 alike). */
export function tradeReplayStatus(pair, clock) {
  if (!pair) return { inside: false, before: false, after: false, currentMinute: null };
  const interval = historyTradeInterval(pair);
  const currentMinute = historyReplayClockMinute(clock);
  if (!interval || !Number.isFinite(currentMinute)) {
    return { inside: false, before: false, after: false, currentMinute };
  }
  const lower = Math.min(interval.startMinute, interval.endMinute);
  const upper = Math.max(interval.startMinute, interval.endMinute);
  return {
    inside: currentMinute >= lower && currentMinute <= upper,
    before: currentMinute < lower,
    after: currentMinute > upper,
    currentMinute,
    lower,
    upper,
  };
}

export function formatChangeNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  return Math.abs(numberValue) < 0.0000001 ? "0.00" : numberValue.toFixed(2);
}

/** An exchange clock or timestamp -> "HH:MM:SS" (parseExchangeClock), "" when it is not a valid clock. */
export function normalizeHistoryClockText(value) {
  const clock = parseExchangeClock(value);
  if (!clock) return "";
  return [clock.hour, clock.minute, clock.second].map((n) => String(n).padStart(2, "0")).join(":");
}

export function historyPointClock(point) {
  return normalizeHistoryClockText(point?.time || point?.exchange_time || point?.datetime);
}

export function historySeriesUntil(rawPoints, timeText) {
  const target = normalizeHistoryClockText(timeText || historyState.replayCurrentTime);
  const rows = Array.isArray(rawPoints) ? rawPoints : [];
  if (!target) return rows;
  return rows.filter((point) => {
    const clock = historyPointClock(point);
    return clock && clock <= target;
  });
}

// The selected date at the moment a reply lands. Each of the date's loaders (stock session, TAIEX, TXF,
// events) awaits on its own; a reply for a date the user has already left must not be written into the
// shared historyState, or date B shows A's market/futures/events.
export function historyDateStillSelected(date) {
  const selected = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
  return selected === String(date || "").slice(0, 10);
}
