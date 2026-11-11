// 帳務: how money, prices, quantities, percentages and profit read in the market being shown (split out of
// pages/account.js).
import { $ } from "../../core/utility.js";
import { VIEW_META, account, accountReadViews } from "./account_state.js";

export function isPaperWalletMode() {
  return account.mode === "paper";
}

// The markets the ledger shown trades (service/account/capital.py CapitalScope): the paper ledger is 台股 only.
export function ledgerMarkets() {
  return isPaperWalletMode() ? ["台股"] : ["台股", "美股"];
}

export function accountStorageKey(kind) {
  if (kind === "market") return isPaperWalletMode() ? "paperWalletMarket" : "actualAccountMarket";
  if (kind === "view") return isPaperWalletMode() ? "paperWalletView" : "actualAccountView";
  return kind;
}

export function accountApiPath(path) {
  const suffix = String(path || "");
  return `${isPaperWalletMode() ? "/api/paper-wallet" : "/api/actual-account"}${suffix}`;
}

// The account page's progress / result / error line under its header. It never blocks the page (a failed background
// sync is not a modal alert): an error stays until it is closed or replaced, any other message (progress, result) clears
// itself after NOTICE_CLEAR_MS. An error is also recorded.
const NOTICE_CLEAR_MS = 8000;
let noticeTimer = 0;

export function setMessage(text, isError = false) {
  if (isError) console.error(isPaperWalletMode() ? "[PAPER WALLET]" : "[ACTUAL ACCOUNT]", text);
  const notice = typeof document === "undefined" ? null : document.getElementById("actualAccountNotice");
  if (!notice) return;
  clearTimeout(noticeTimer);
  const close = notice.querySelector("[data-account-notice-close]");
  if (close) close.onclick = () => { clearTimeout(noticeTimer); notice.hidden = true; };
  notice.querySelector("[data-account-notice-text]").textContent = String(text || "");
  notice.classList.toggle("account-notice-error", Boolean(isError));
  notice.hidden = !text;
  if (text && !isError) noticeTimer = setTimeout(() => { notice.hidden = true; }, NOTICE_CLEAR_MS);
}

export function formatMoney(value, market = account.market) {
  return accountReadViews.money(value, market);
}

export function formatTradePrice(value, market = account.market) {
  return accountReadViews.price(value, market);
}

export function formatSignedMoney(value, market = account.market) {
  return accountReadViews.signedMoney(value, market);
}

export function formatQty(value) {
  return accountReadViews.qty(value);
}

export function formatPercent(value, digits = 2) {
  return accountReadViews.percent(value, digits);
}

export function formatSignedPercent(value, digits = 2) {
  return accountReadViews.signedPercent(value, digits);
}

export function formatRatio(value) {
  return accountReadViews.ratio(value);
}

export function formatMetricMoney(value) {
  if (value === null || value === undefined || value === "") return "-";
  return accountReadViews.money(value, account.market);
}

export function profitClass(value) {
  return accountReadViews.profitClass(value);
}

export function currentAnalytics() {
  return account.dashboard?.analytics?.[account.market] || null;
}

export function dailyActionIcon(kind) {
  if (kind === "chart") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V6M4 18H20M7 14l4-4 3 3 5-6"></path></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4zM13.5 6.5l4 4"></path></svg>`;
}

export function updateActualAccountPageTitle(view = account.currentView, analytics = currentAnalytics()) {
  const titleEl = $("actualAccountViewTitle");
  if (!titleEl) return;
  const [baseTitle, subtitle = ""] = VIEW_META[view] || VIEW_META.home;
  if (isPaperWalletMode()) {
    const paperTitles = {
      home: "模擬帳務",
      holdings: "模擬庫存",
      stockStats: "個股數據",
      daily: "每日明細",
      pairs: "配對明細",
      daytrade: "當沖分析",
      orders: "委託紀錄",
      mobile: "手機卡片（只在電腦）",
      trades: "交易資料",
      errors: "資料檢查",
    };
    titleEl.textContent = paperTitles[view] || "模擬帳務";
  } else {
    titleEl.textContent = baseTitle;
  }
  // 交易資料's subtitle is its count (renderTrades writes it when the trades are read).
  const subtitleEl = $("actualAccountSubtitle");
  if (subtitleEl && view !== "trades") subtitleEl.textContent = subtitle;
}
