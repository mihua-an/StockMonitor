// The 帳務 page's state, one object every account view module reads and writes (module-scope lets of
// pages/account.js could not be assigned by a split-out view module).
import { createAccountReadViewPresentation } from "./read_views.js";
import { createAccountScrollController } from "./scroll.js";

export const account = {
  initialized: false,
  generation: 0,
  // Whether this App run has done its one auto-sync on opening 實際帳務 (user 11-05: once per App run).
  autoSyncAttempted: false,
  dashboard: null,
  mode: "actual",
  market: "台股",
  currentView: "home",
  keyBound: false,
  daytradeMode: "overview",
  daytradeBucketSelection: { kind: "", index: null },
  daytradeWeekdaySelection: null,
  dailyAutoOpenPending: false,
  stockSortKey: localStorage.getItem("actualAccountStockSortKey") || "total_profit",
  stockSortDirection: localStorage.getItem("actualAccountStockSortDirection") || "desc",
  dailySortKey: localStorage.getItem("actualAccountDailySortKey") || "date",
  dailySortDirection: localStorage.getItem("actualAccountDailySortDirection") || "desc",
  pairSortKey: localStorage.getItem("actualAccountPairSortKey") || "date",
  pairSortDirection: localStorage.getItem("actualAccountPairSortDirection") || "desc",
  mobileCardsGeneration: 0,
  idleWarmupToken: 0,
  positionMarks: null,
};

export const actualAccountExpandedDays = new Set();

export const actualAccountExpandedPairDays = new Set();

export const actualAccountExpandedStockStats = new Set();

export const actualAccountOpenStockTradeDetails = new Set();

export const actualAccountStockTradeModes = new Map();

export const actualAccountDaytradeMetricSort = {
  hold: {
    key: localStorage.getItem("actualAccountDaytradeHoldSortKey") || "bucket_index",
    direction: localStorage.getItem("actualAccountDaytradeHoldSortDirection") || "asc",
  },
  entry: {
    key: localStorage.getItem("actualAccountDaytradeEntrySortKey") || "bucket_index",
    direction: localStorage.getItem("actualAccountDaytradeEntrySortDirection") || "asc",
  },
};

export const actualAccountReplayState = {
  pairId: null,
  pair: null,
  // The replay time ("HH:MM:SS"): the pair's entry when it opens, then Market Runtime's replay position.
  clock: "",
  playing: false,
  requestToken: 0,
  origin: "pairs",
  speed: 1,
  // Market Runtime's open of the pair's replay: "idle" | "loading" | "ready" | "error" (refused or failed; loadError
  // says why).
  loadState: "idle",
  loadError: "",
  // The day's 加權 and 產業指數 the 走勢資訊 overlays: {market, industry}, each {name, points, prevClose, note}; null
  // while they are read.
  indexes: null,
  // 技術分析: the K bar size, and the chart minute the mouse points at (null: off the chart).
  kbarMinutes: 5,
  kbarHover: null,
  // 大單流向's charts: "cumulative" (累計) or "minute" (分時).
  flowMode: "cumulative",
};

export const VIEW_META = {
  home: ["實際帳務"],
  holdings: ["實際庫存"],
  stockStats: ["個股數據", "點一列看那檔的細節"],
  daily: ["每日明細", "點一天看當天每筆交易"],
  pairs: ["配對明細", "點一天看當天的配對"],
  daytrade: ["當沖分析"],
  orders: ["委託紀錄"],
  mobile: ["手機卡片"],
  trades: ["交易資料"],
  errors: ["資料檢查"],
};

export const accountReadViews = createAccountReadViewPresentation();

export const actualAccountDirtyViews = new Set(Object.keys(VIEW_META));

export const actualAccountScrollController = createAccountScrollController();

export function persistAccountSort(prefix, key, direction) {
  localStorage.setItem(`${prefix}SortKey`, key);
  localStorage.setItem(`${prefix}SortDirection`, direction);
}

// What each change of the page's subject leaves behind, decided here once: the rows a view had opened belong to the
// market's trades, so a new market or ledger closes them all; the 當沖 selections (time bucket, weekday) belong to the
// market's day-trades too; a new ledger also forgets its dashboard and the 當沖 mode (not the auto-sync, which is
// once per App run). The
// caller then redraws (and closes a replay, which is the page's).
function clearOpenedRows() {
  actualAccountExpandedDays.clear();
  actualAccountExpandedPairDays.clear();
  actualAccountExpandedStockStats.clear();
  actualAccountOpenStockTradeDetails.clear();
  actualAccountStockTradeModes.clear();
}

export function changeAccountMarket(market) {
  account.market = market;
  account.daytradeBucketSelection = { kind: "", index: null };
  account.daytradeWeekdaySelection = null;
  clearOpenedRows();
}

export function changeAccountLedger(mode) {
  account.mode = mode;
  account.dashboard = null;
  account.daytradeMode = "overview";
  account.daytradeBucketSelection = { kind: "", index: null };
  account.daytradeWeekdaySelection = null;
  clearOpenedRows();
}

// What a split-out view asks of the page itself. pages/account.js installs it when it loads; until then a call fails
// loudly instead of reporting a saved trade whose account data never refreshes.
export const accountHooks = {
  refreshAfterChange: async () => { throw new Error("account page refresh is not installed (installAccountPageHooks)"); },
};

/** pages/account.js: how the page refreshes itself after a trade was added, changed or deleted. */
export function installAccountPageHooks({ refreshAfterChange }) {
  if (typeof refreshAfterChange !== "function") throw new TypeError("installAccountPageHooks needs refreshAfterChange");
  accountHooks.refreshAfterChange = refreshAfterChange;
}
