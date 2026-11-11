// 歷史回放 日期: the date select and its calendar picker (split out of pages/history.js).
import { $, escapeHtml } from "../../core/utility.js";
import { morphInto } from "../../core/dom_morph.js";
import { historyPage, historyState } from "./history_state.js";

// The date picker owns its three parts -- the <select> the page reads the chosen date from, the button's label and the
// calendar list -- and draws them from historyState alone: the listed dates (historyState.dates) with the chosen one,
// or, when there are none, the one line that says why (historyState.historyUnavailable). The page changes that state
// and calls this; it never writes the picker's DOM.
export function syncHistoryDatePicker() {
  const select = $("historyDateSelect");
  const label = $("historyDateLabel");
  const list = $("historyDateList");
  if (!select || !label || !list) return;
  const dates = historyState.dates.map((value) => String(value || ""));
  if (!dates.length) {
    const reason = historyState.historyUnavailable || "尚無歷史資料";
    morphInto(select, `<option value="" selected>${escapeHtml(reason)}</option>`);
    label.textContent = reason;
    morphInto(list, "");
    return;
  }
  const chosen = String(select.value || "");
  const current = dates.includes(chosen) ? chosen
    : dates.includes(String(historyState.selectedDate || "")) ? String(historyState.selectedDate) : dates[0];
  morphInto(select, dates.map((value) => (
    `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(value)}</option>`
  )).join(""));
  label.textContent = current;
  morphInto(list, dates.map((value) => {
    const active = value === current;
    return `<button type="button" class="event-feed-date-option${active ? " active" : ""}" role="option" data-morph-key="${escapeHtml(value)}" data-history-date="${escapeHtml(value)}" aria-selected="${active ? "true" : "false"}">${escapeHtml(value)}</button>`;
  }).join(""));
}

export function setHistoryDateValue(value) {
  const select = $("historyDateSelect");
  if (!select) return false;
  select.value = String(value || "");
  syncHistoryDatePicker();
  return true;
}

export function bindHistoryDatePicker() {
  const picker = $("historyDatePicker");
  const button = $("historyDateButton");
  const menu = $("historyDateMenu");
  const list = $("historyDateList");
  const select = $("historyDateSelect");
  if (!picker || !button || !menu || !list || !select || picker.dataset.bound === "1") return;
  // Page DOM can be recreated after Replay <-> Realtime navigation. Remove the
  // previous document-level handlers before binding the replacement picker so
  // every mount owns exactly one outside-click/Escape listener pair.
  historyPage.datePickerCleanup?.();
  picker.dataset.bound = "1";
  const setOpen = (open) => {
    const visible = Boolean(open);
    menu.hidden = !visible;
    button.setAttribute("aria-expanded", visible ? "true" : "false");
    picker.classList.toggle("open", visible);
    if (visible) syncHistoryDatePicker();
  };
  const onButtonClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(menu.hidden);
  };
  const onListClick = (event) => {
    const option = event.target?.closest?.("button[data-history-date]");
    if (!option || !list.contains(option)) return;
    const next = String(option.dataset.historyDate || "");
    setOpen(false);
    if (!next || next === String(select.value || "")) return;
    setHistoryDateValue(next);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const onDocumentPointerDown = (event) => {
    if (!picker.contains(event.target)) setOpen(false);
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  };

  button.addEventListener("click", onButtonClick);
  list.addEventListener("click", onListClick);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  historyPage.datePickerCleanup = () => {
    button.removeEventListener("click", onButtonClick);
    list.removeEventListener("click", onListClick);
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    picker.classList.remove("open");
    delete picker.dataset.bound;
    historyPage.datePickerCleanup = null;
  };
  syncHistoryDatePicker();
}

/** Lists `dateText` among the picker's dates (a jump to a day the date list has not caught up with); the caller picks it. */
export function ensureHistoryDateOption(dateText) {
  const normalized = String(dateText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  if (!historyState.dates.includes(normalized)) {
    historyState.dates = [...historyState.dates, normalized].sort((a, b) => String(b).localeCompare(String(a)));
  }
  syncHistoryDatePicker();
  return true;
}
