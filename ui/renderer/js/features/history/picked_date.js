// The date 歷史回放 shows: the one picked on the page's day list, in 歷史事件 or 交易明細. Its listeners (the day list) follow
// every change, whoever made it.
import { historyState } from "./history_state.js";

const listeners = new Set();

/** The picked date; before one is picked, the date last shown. */
export function pickedHistoryDate() {
  return String(historyState.pickedDate || historyState.selectedDate || "").slice(0, 10);
}

export function setHistoryDateValue(value) {
  const next = String(value || "").slice(0, 10);
  if (next === historyState.pickedDate) return;
  historyState.pickedDate = next;
  for (const listener of [...listeners]) listener(next);
}

export function onHistoryDateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lists `dateText` among the page's dates (a jump to a day the date list has not caught up with); the caller picks it. */
export function ensureHistoryDateOption(dateText) {
  const normalized = String(dateText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  if (!historyState.dates.includes(normalized)) {
    historyState.dates = [...historyState.dates, normalized].sort((a, b) => String(b).localeCompare(String(a)));
  }
  return true;
}
