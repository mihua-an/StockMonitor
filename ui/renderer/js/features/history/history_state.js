// 歷史回放 page state: the module-scope lets of pages/history.js as one object its split-out modules can read and
// write. Both objects are built by a factory that names every field, and sealed: a field the factory does not declare
// (a typo, a field added in one module only) throws where it is written instead of quietly becoming a new property.
import { apiGet } from "../../core/api.js";
import { createHistoryQueries } from "./queries.js";
import { createHistoryTrace } from "./trace.js";
import { createHistoryTradePagerState } from "./trade_pager.js";

export const historyPage = Object.seal({
  stockRowSnap: null,
  benchmarkOverlayControls: null,
  productRequestGeneration: 0,
  // One per mount of the page (bindHistoryEvents) and bumped again when it is left: the page's reads answer only the
  // visit that sent them.
  visit: 0,
  // The visit's date-list read and the day it opens (refreshHistoryPage); a replay opened from elsewhere waits for it.
  dateLoad: null,
  datePickerCleanup: null,
  unregisterProductQuoteSearch: null,
  engine: null,
  reloadOnApiOnline: null,
});

export const historyQueries = createHistoryQueries({ apiGet });

export const historyTraceObj = createHistoryTrace({ windowRef: globalThis.window, performanceRef: globalThis.performance });

/** Every field of the replay page's state, at its initial value. */
export function createHistoryState() {
  return {
    dates: [],
    // Why there is no history to list ("" when there is): no recorded dates, or the read failed. The date picker shows
    // it when no dates are listed and the stock list shows it instead of the day's stocks.
    historyUnavailable: "",
    stocks: [],
    selectedDate: "",
    selectedCode: "",
    // The stock whose replay data is loading (its row spins), "" when none.
    loadingCode: "",
    // Market Runtime's replay of the selected product and day: its last status (position, first / last print time,
    // playing, the recording's counts). The page's only source of what the cursor shows. null before one is open.
    replay: null,
    // Why the selected product has no replay ("" while one is open or opening): shown on every panel.
    replayUnavailable: "",
    // The time bar is held: Market Runtime's status does not move it under the pointer.
    dragging: false,
    speed: 1,
    playing: false,
    marketSession: null,
    marketDate: "",
    txfSession: null,
    txfDate: "",
    intradayEvents: [],
    daytradeMarkerRows: [],
    tradeDetails: createHistoryTradePagerState(),
    selectedEventKey: "",
    selectedDaytradeId: "",
    // 事件顯示分成「交易時段」與「整個盤中」兩層。
    // showAllEventMarkers=true 代表全部盤中事件；showTradeEventMarkers=true 則至少顯示持有區間事件。
    showTradeEventMarkers: true,
    showAllEventMarkers: true,
    replayAnchorTime: "",
    replayAnchorDate: "",
    replayAnchorCode: "",
    replayCurrentTime: "",
    activeTradeReview: null,
    noQuoteMode: false,
    noQuoteName: "",
    // The frame that publishes the newest replay time to the page (pages/history.js publishHistoryReplayTime).
    replayTimeFrame: null,
  };
}

export const historyState = Object.seal(createHistoryState());

// What a split-out module asks of the page itself: every callback is named here, and pages/history.js installs the
// whole set when it loads (installHistoryPageHooks). Until then a call throws with the hook's name, instead of
// "undefined is not a function" somewhere in a module; a hook the page leaves out fails the install itself.
const HISTORY_PAGE_HOOKS = ["invalidateReplayComponents", "rerenderHistoryCurrentChart", "updateHistoryTimeLabel",
  "updatePlayButton", "setHistoryChartLoading"];
export const historyHooks = Object.seal(Object.fromEntries(HISTORY_PAGE_HOOKS.map((name) => [name, () => {
  throw new Error(`history page hook ${name} is not installed (installHistoryPageHooks)`);
}])));

/** pages/history.js: the page's callbacks the split-out modules call back into (all of HISTORY_PAGE_HOOKS). */
export function installHistoryPageHooks(hooks) {
  const missing = HISTORY_PAGE_HOOKS.filter((name) => typeof hooks?.[name] !== "function");
  if (missing.length) throw new TypeError(`installHistoryPageHooks is missing ${missing.join(", ")}`);
  const unknown = Object.keys(hooks).filter((name) => !HISTORY_PAGE_HOOKS.includes(name));
  if (unknown.length) throw new TypeError(`installHistoryPageHooks got unknown hooks ${unknown.join(", ")}`);
  for (const name of HISTORY_PAGE_HOOKS) historyHooks[name] = hooks[name];
}
