import { renderPositions } from "../features/account/positions_view.js";
import { emptyStateRowHtml, loadStateRowHtml } from "../core/load_state_view.js";
import { renderMobileCards } from "../features/account/mobile_cards_view.js";
import { createPositionMarkTracker, withUnrealizedPnl } from "../features/account/live_position_marks.js";
import { accountSyncDeadlineMs } from "../features/account/account_sync_deadline.js";
import { subscribeRealtimeView, subscribeRealtimeSession } from "../market_data/realtime.js";
import { renderSummary, renderMarketSwitch, renderHome } from "../features/account/home_summary_view.js";
import { renderCapital } from "../features/account/capital_view.js";
import { isBuyAction } from "../features/account/trade_semantics.js";
import { closeTradeModal, isTradeModalOpen, loadTradeIntoEditor, mountTradeEditor, tradeInfoToFillRows } from "../features/account/trade_editor.js";
import { apiGet, apiPost } from "../core/api.js";
import { $, escapeHtml } from "../core/utility.js";
import { syncSegmented } from "../core/settings_ui.js";
import { userFacingMessage } from "../core/user_action.js";
import { applyColumnSchema } from "../core/column_title.js";
import {
  ACCOUNT_DAILY_COLUMNS,
  ACCOUNT_DIRECTION_REPORT_COLUMNS,
  ACCOUNT_HOLDINGS_COLUMNS,
  ACCOUNT_PAIR_COLUMNS,
  ACCOUNT_RANKING_COLUMNS,
  ACCOUNT_RAW_TRADES_COLUMNS,
  ACCOUNT_STOCK_STATS_COLUMNS,
} from "../core/column_schemas.js";

import { VIEW_META, account, installAccountPageHooks, actualAccountDirtyViews, actualAccountReplayState, actualAccountScrollController, changeAccountLedger, changeAccountMarket, persistAccountSort } from "../features/account/account_state.js";
import { accountApiPath, accountStorageKey, currentAnalytics, ledgerMarkets, formatMetricMoney, formatMoney, formatPercent, formatQty, formatRatio, formatSignedMoney, formatSignedPercent, formatTradePrice, isPaperWalletMode, profitClass, setMessage, updateActualAccountPageTitle } from "../features/account/account_format.js";
import { closePairReplay, installPairReplayOrigin } from "../features/account/pair_replay.js";
import { renderStockReplayHost, renderStockStats } from "../features/account/stock_stats_view.js";
import { renderDaytradeAnalysis } from "../features/account/daytrade_view.js";
import { isDaytradeReplayOrigin, renderDaytradeReplayHost } from "../features/account/daytrade_replay_host.js";
import { renderDailyStats, renderPairDetails } from "../features/account/daily_pairs_view.js";
import { createPaperOrderHistoryView } from "../features/account/paper_order_history_view.js";
import { marketTrades } from "../features/account/day_reads.js";
import { paperOrdersStore } from "../core/paper_orders_store.js";
import { paperHoldings } from "../features/realtime/ledger_holdings.js";
import { followLedgerChanges } from "../features/account/ledger_change_follower.js";
import { readPreference, writePreference } from "../core/preferences.js";

function loadAccountUiPreference() {
  account.market = readPreference(accountStorageKey("market"), { context: "account market" }) === "美股" && ledgerMarkets().includes("美股") ? "美股" : "台股";
  account.currentView = readPreference(accountStorageKey("view"), { context: "account view" }) || "home";
  if (!VIEW_META[account.currentView] || !viewAvailable(account.currentView)) account.currentView = "home";
}

// 手機卡片: both ledgers, one view. The actual account's is what the desktop publishes to the phone; the
// paper wallet's is shown on the desktop only and never published.
// 委託紀錄 is the paper wallet's only: the actual account has no 模擬下單 orders.
function viewAvailable(view) {
  if (view === "orders") return isPaperWalletMode();
  return true;
}

// 委託紀錄: built on first show, reading its own range from app_api (not the dashboard); hidden, it stops listening.
let paperOrderHistory = null;
// One window resize listener for the page's sticky headers, bound the first time the page is set up.
let stickyResizeBound = false;
function paperOrderHistoryView() {
  const host = document.querySelector('[data-account-view-panel="orders"]');
  if (!host) return null;
  if (paperOrderHistory?.host !== host) {
    paperOrderHistory?.view.hide();
    paperOrderHistory = { host, view: createPaperOrderHistoryView({ host, get: apiGet, subscribeOrders: (fn) => paperOrdersStore.subscribe(fn) }) };
  }
  return paperOrderHistory.view;
}

async function loadMobileCards() {
  const generation = ++account.mobileCardsGeneration;
  const status = $("actualMobileCardsStatus");
  const container = $("actualMobileCards");
  if (status) status.textContent = "計算中…";
  try {
    const paper = isPaperWalletMode();
    const payload = await apiGet(paper ? "/api/paper-wallet/mobile-preview" : "/api/actual-account/mobile-preview");
    if (generation !== account.mobileCardsGeneration) return;
    if (!payload?.ok) throw new Error(payload?.error || "讀取失敗");
    renderMobileCards(container, payload, { profitClass });
    const at = (value) => (value ? new Date(value).toLocaleString("zh-TW", { hour12: false }) : "");
    if (status) {
      status.textContent = paper
        ? `依模擬帳本計算（${at(payload.generated_at)}），和實際帳務的手機卡片同一份算法｜只在電腦顯示，不上傳到手機`
        : `依目前帳本計算（${at(payload.generated_at)}），和上傳給手機的是同一份算法｜`
          + (payload.last_publish_at ? `手機資料上次上傳：${at(payload.last_publish_at)}` : "手機資料尚未上傳");
    }
  } catch (error) {
    const text = userFacingMessage(error, "手機卡片讀取失敗，請稍後再試", { context: "ACCOUNT_MOBILE_CARDS" });
    if (generation !== account.mobileCardsGeneration) return;
    if (status) status.textContent = text;
  }
}

function configureAccountMode(mode) {
  const nextMode = mode === "paper" ? "paper" : "actual";
  const changed = account.mode !== nextMode;
  if (changed) changeAccountLedger(nextMode);
  loadAccountUiPreference();
  if (!changed) return;
  closePairReplay();
  markActualAccountViewsDirty();
}

function markActualAccountViewsDirty() {
  Object.keys(VIEW_META).forEach((view) => actualAccountDirtyViews.add(view));
  account.idleWarmupToken += 1;
}

// 交易資料: every trade of the market, read when the view shows (not carried in the dashboard).
function renderTrades() {
  const body = $("actualTradesBody");
  const count = $("actualAccountSubtitle");
  const read = marketTrades(account.market, () => renderTrades());
  if (read.state !== "ready") {
    if (count) count.textContent = "";
    if (body) body.innerHTML = loadStateRowHtml(10, read.state, read.error);
    return;
  }
  const filtered = read.data.items;
  if (count) count.textContent = `${filtered.length.toLocaleString("en-US")} 筆`;
  if (!body) return;
  if (!filtered.length) {
    body.innerHTML = emptyStateRowHtml(10, `尚無${account.market}交易資料`);
    return;
  }

  const rows = [];
  filtered.forEach((item) => {
    const fills = Array.isArray(item.fills) && item.fills.length
      ? item.fills
      : tradeInfoToFillRows(item.trade_info);
    const displayFills = fills.length ? fills : [{ qty: item.qty, price: item.avg_price }];
    const actionText = isBuyAction(item.action) ? "買" : (item.action === "賣出" ? "賣" : item.action);
    const actionClass = isBuyAction(item.action) ? "price-up" : "price-down";

    displayFills.forEach((fill, fillIndex) => {
      const isPrimary = fillIndex === 0;
      rows.push(`
        <tr class="account-trade-row ${isPrimary ? "actual-trade-primary-row" : "account-trade-fill-subrow"}" data-trade-id="${escapeHtml(item.trade_id)}">
          <td>${isPrimary ? escapeHtml(item.date) : ""}</td>
          <td>${isPrimary ? escapeHtml(item.time || "") : ""}</td>
          <td>${isPrimary ? escapeHtml(item.code) : ""}</td>
          <td>${isPrimary ? escapeHtml(item.name || "") : ""}</td>
          <td class="${isPrimary ? actionClass : ""}">${isPrimary ? escapeHtml(actionText) : ""}</td>
          <td class="account-trade-fill-qty-cell">${formatQty(fill?.qty)}</td>
          <td class="account-trade-fill-price-cell">${formatTradePrice(fill?.price, item.market)}</td>
          <td>${isPrimary ? formatTradePrice(item.avg_price, item.market) : ""}</td>
          <td>${isPrimary ? formatMoney(item.fee, item.market) : ""}</td>
          <td>${isPrimary ? formatMoney(item.tax, item.market) : ""}</td>
        </tr>
      `);
    });
  });

  body.innerHTML = rows.join("");

  // Keep one delegated click listener instead of attaching one
  // listener to every rendered fill row (the real account can easily exceed
  // 1,000 rows).  This materially reduces DOM/event overhead while moving the
  // pointer across the table.
  body._actualTradeById = new Map(
    filtered.map((item) => [String(item.trade_id), item])
  );
  if (body.dataset.tradeClickDelegated !== "1") {
    body.dataset.tradeClickDelegated = "1";
    body.addEventListener("click", (event) => {
      const row = event.target.closest?.("tr[data-trade-id]");
      if (!row || !body.contains(row)) return;
      const trade = body._actualTradeById?.get(String(row.dataset.tradeId));
      if (trade) loadTradeIntoEditor(trade);
    });
  }
}

// An error carries the market of the trade it names (the ledger joins it); one naming no trade is shown under both.
function renderErrors(items) {
  const box = $("actualAccountErrors");
  const count = $("actualErrorCountText");
  if (!box) return;
  const errors = (Array.isArray(items) ? items : []).filter((item) => !item.market || item.market === account.market);
  if (count) count.textContent = `${errors.length} 筆`;
  box.innerHTML = errors.length
    ? errors.map((item) => `<div class="settings-item"><span class="settings-item-main">${item.trade_id ? `<b>${escapeHtml(item.trade_id)}</b>` : ""}`
      + `<span class="account-error-text">${escapeHtml(item.message)}</span></span></div>`).join("")
    : `<div class="settings-empty"><span class="settings-empty-icon">✓</span>${escapeHtml(account.market)}目前沒有資料異常`
      + `<div class="account-title-note">格式錯誤或配對異常會列在這裡</div></div>`;
  const directoryItem = document.querySelector('.account-directory [data-account-view="errors"]');
  directoryItem?.classList.toggle("has-alert", errors.length > 0);
}

function renderReplayOrigin() {
  if (actualAccountReplayState.origin === "stockStats") {
    renderStockReplayHost();
  } else if (isDaytradeReplayOrigin(actualAccountReplayState.origin)) {
    renderDaytradeReplayHost();
  } else {
    renderPairDetails();
  }
}
installPairReplayOrigin(renderReplayOrigin);

// 庫存's current prices come over the WS while the holdings view is shown; the ledger rows stay FastAPI's.

function holdingsPositions() {
  const positions = account.dashboard?.positions || [];
  if (!account.positionMarks) {
    account.positionMarks = createPositionMarkTracker({
      subscribeView: subscribeRealtimeView,
      subscribeSession: subscribeRealtimeSession,
      onChange: () => {
        if (account.currentView !== "holdings") return;
        actualAccountDirtyViews.add("holdings");
        renderAccountViewContent("holdings", true);
      },
    });
  }
  account.positionMarks.sync(positions);
  return withUnrealizedPnl(positions, account.positionMarks.mark);
}

function releasePositionMarks() {
  account.positionMarks?.dispose();
  account.positionMarks = null;
}

// 資金 cards (本金 / 待交割 / 交割後本金 / 今日已用額度) of one view, for the market shown.
function renderViewCapital(view) {
  const host = document.querySelector(`[data-account-view-panel="${view}"] [data-account-capital]`);
  renderCapital(host, account.dashboard?.capital, { market: account.market, formatMoney, profitClass, isPaper: isPaperWalletMode() });
}

function renderAccountViewContent(view, force = false) {
  if (!document.querySelector(".account-page")) return;
  if (!account.dashboard || !VIEW_META[view]) return;
  if (!force && !actualAccountDirtyViews.has(view)) return;

  const analytics = currentAnalytics();
  switch (view) {
    case "home":
      renderSummary(account.dashboard?.summary, { market: account.market, formatMoney, profitClass });
      renderViewCapital("home");
      renderHome(analytics, { formatSignedMoney, formatPercent, formatRatio, formatMetricMoney, profitClass });
      break;
    case "holdings":
      renderViewCapital("holdings");
      renderPositions(holdingsPositions(), {
        market: account.market,
        isPaper: isPaperWalletMode(),
        formatQty,
        formatMoney,
        formatSignedMoney,
        formatSignedPercent,
        profitClass,
      });
      break;
    case "stockStats":
      renderStockStats(analytics);
      break;
    case "daily":
      renderDailyStats(analytics);
      break;
    case "pairs":
      renderPairDetails();
      break;
    case "daytrade":
      if (account.currentView === "daytrade") renderDaytradeAnalysis();
      else return; // its pairs are read from the ledger: only when the view is open, never during idle warm-up
      break;
    case "mobile":
      if (account.currentView === "mobile") void loadMobileCards();
      else return; // computed on the backend: only when the view is open, never during idle warm-up
      break;
    case "trades":
      if (account.currentView === "trades") renderTrades();
      else return; // a market's every trade is read from the ledger: only when the view is open
      break;
    case "errors":
      renderErrors(account.dashboard?.errors || []);
      break;
    default:
      break;
  }
  actualAccountDirtyViews.delete(view);
}

function scheduleActualAccountIdleWarmup() {
  if (!account.dashboard) return;
  const token = ++account.idleWarmupToken;
  const queue = Object.keys(VIEW_META).filter((view) => view !== account.currentView);

  const runOne = (deadline) => {
    if (token !== account.idleWarmupToken || !account.dashboard) return;
    while (queue.length && (!deadline || deadline.timeRemaining() > 5)) {
      const view = queue.shift();
      if (view && actualAccountDirtyViews.has(view)) renderAccountViewContent(view);
    }
    if (!queue.length || token !== account.idleWarmupToken) return;
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(runOne);
    } else {
      setTimeout(() => runOne(null), 40);
    }
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(runOne);
  } else {
    setTimeout(() => runOne(null), 40);
  }
}

function renderMarketView() {
  if (!account.dashboard) return;
  renderMarketSwitch({ market: account.market, currentView: account.currentView, markets: ledgerMarkets() });
  renderAccountViewContent(account.currentView, true);
  scheduleActualAccountIdleWarmup();
}

// Pure decision: tell a genuine backend read failure (`{ok:false, error}`)
// apart from a legitimately empty ledger. Only reacts to an explicit
// `ok === false` -- a payload that never carries `ok` at all (or has it
// merely falsy/absent) is still treated as real data, since callers upstream
// already throw on a non-JSON/network failure before this ever runs.
export function resolveDashboardLoadOutcome(response) {
  if (response && typeof response === "object" && response.ok === false) {
    const detail = String(response.error || "").trim();
    return { accepted: false, message: detail ? `帳務資料讀取失敗：${detail}` : "帳務資料讀取失敗" };
  }
  return { accepted: true, message: "" };
}

function renderDashboardLoadError(message) {
  const banner = $("actualAccountLoadErrorBanner");
  if (!banner) return;
  banner.textContent = message;
  banner.hidden = false;
  // Deliberately do not touch account.dashboard/mark views dirty here:
  // the last successfully loaded dashboard (if any) stays on screen instead
  // of being clobbered by the error payload or an empty-looking re-render.
}

function hideDashboardLoadError() {
  const banner = $("actualAccountLoadErrorBanner");
  if (!banner) return;
  banner.hidden = true;
  banner.textContent = "";
}

function renderDashboard(data) {
  account.dashboard = data;
  markActualAccountViewsDirty();
  hideDashboardLoadError();
  renderMarketView();
}

function selectMarket(market) {
  if (!ledgerMarkets().includes(market)) return;
  if (account.currentView === "daytrade" && market === "美股") return;
  closePairReplay();
  changeAccountMarket(market);
  writePreference(accountStorageKey("market"), market, { context: "account market" });
  markActualAccountViewsDirty();
  renderMarketView();
}

function showAccountView(view) {
  if (view === "stockDetail") view = "stockStats";
  if (!VIEW_META[view] || !viewAvailable(view)) view = "home";

  // Every time the user enters Daily Detail, open the newest
  // trading date on the next render (also works while dashboard data is loading).
  if (view === "daily") account.dailyAutoOpenPending = true;
  if (view !== "pairs" && account.currentView === "pairs") {
    closePairReplay();
  }
  if (view !== "stockStats" && account.currentView === "stockStats" && actualAccountReplayState.origin === "stockStats") {
    closePairReplay();
  }
  const marketChangedForDaytrade = view === "daytrade" && account.market === "美股";
  if (marketChangedForDaytrade) {
    changeAccountMarket("台股");
    writePreference(accountStorageKey("market"), account.market, { context: "account market" });
  }
  account.currentView = view;
  writePreference(accountStorageKey("view"), view, { context: "account view" });
  if (view === "orders") paperOrderHistoryView()?.show();
  else paperOrderHistory?.view.hide();
  document.querySelectorAll(".account-directory [data-account-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.accountView === view));
  document.querySelectorAll(".account-view[data-account-view-panel]").forEach((panel) => {
    const active = panel.dataset.accountViewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  updateActualAccountPageTitle(view, currentAnalytics());
  // The phone's cards cover both markets at once.
  const marketSwitch = document.querySelector(".account-market-switch");
  marketSwitch?.classList.toggle("is-invisible", view === "mobile");
  if (marketChangedForDaytrade) markActualAccountViewsDirty();
  renderMarketSwitch({ market: account.market, currentView: account.currentView, markets: ledgerMarkets() });
  requestAnimationFrame(actualAccountScrollController.syncStickyMetrics);
  if (account.dashboard) {
    // Daily 保留「每次進入自動展開最新交易日」；其他頁面只有
    // 資料真的變更時才重建 DOM，避免每次切頁都重畫大型表格。
    renderAccountViewContent(view, view === "daily" || marketChangedForDaytrade);
    scheduleActualAccountIdleWarmup();
  }
  const scroll = $("actualAccountContentScroll");
  if (scroll) {
    // Avoid heavyweight CSS :has() selectors on the large account
    // DOM.  A simple state class tells CSS whether the active page is one of
    // the full-height table workspaces, reducing hover style recalculation.
    scroll.classList.toggle("account-table-workspace-active", ["stockStats", "daily", "pairs", "trades"].includes(view));
    scroll.scrollTop = 0;
  }

  // The main tabular views own their row scrollbar
  // (Title stays outside the visible scrollbar lane, like 查詢商品).
  // Reset that local row viewport as well when the user enters a view.
  const activePanel = document.querySelector(`.account-view.active[data-account-view-panel="${view}"]`);
  const localTableScroll = activePanel?.querySelector?.(
    ".account-stock-stats-table-wrap, .account-daily-table-wrap, .account-pair-table-wrap, .account-trades-wrap"
  );
  if (localTableScroll) {
    const rowScroll = localTableScroll.querySelector?.(".standard-data-grid-body-scroll") || localTableScroll;
    rowScroll.scrollTop = 0;
    rowScroll.scrollLeft = 0;
  }
}

async function syncAccount() {
  const generation = account.generation;
  setMessage("正在從 Google Sheet 同步…");
  const result = await apiPost("/api/actual-account/sync", { timeoutMs: await accountSyncDeadlineMs(await loadConfig()) });
  if (generation !== account.generation) return;
  if (!result?.ok) throw new Error(result?.error || "同步失敗");
  setMessage(`同步完成：${result.remote_rows ?? result.imported ?? 0} 筆 Raw Transaction`);
  await refreshAccountPage(account.mode, false);
}

async function loadConfig() {
  if (isPaperWalletMode()) {
    return { gas_url: "", auto_sync_on_page_open: false, local_only: true };
  }
  return apiGet("/api/actual-account/config");
}

// Actual Account / Paper Wallet are canonical Title consumers.
// The Title engine owns sort intent/presentation; this controller still owns
// business sorting and persistence.
function accountHeaderTables(selector) {
  return [...document.querySelectorAll(selector)].filter((table) => !table.matches(".standard-data-grid-body-table"));
}

function setupAccountColumnTitles() {
  const applyAll = (selector, columns, options = {}) => {
    for (const table of accountHeaderTables(selector)) {
      applyColumnSchema(table, columns, {
        schemaId: columns.schemaId,
        colgroup: options.colgroup !== false,
        sortState: options.sortState?.(),
        onSort: options.onSort,
      });
      if (typeof options.after === "function") options.after(table);
    }
  };

  // A sortable table's header: the account fields holding its sort, the name they are saved under, how it redraws. A
  // column clicked for the first time starts in `firstDirection(sortKey)`.
  const sortableTable = (keyField, directionField, storagePrefix, redraw, firstDirection = () => "desc") => ({
    sortState: () => ({ columnId: account[keyField], direction: account[directionField] }),
    onSort: ({ sortKey, direction }) => {
      const same = account[keyField] === sortKey;
      account[keyField] = sortKey;
      account[directionField] = same ? direction : firstDirection(sortKey);
      persistAccountSort(storagePrefix, account[keyField], account[directionField]);
      setupAccountColumnTitles();
      redraw();
    },
  });

  applyAll(".account-holdings-table", ACCOUNT_HOLDINGS_COLUMNS);
  applyAll(".account-stock-stats-table", ACCOUNT_STOCK_STATS_COLUMNS, sortableTable("stockSortKey", "stockSortDirection", "actualAccountStock",
    () => renderStockStats(currentAnalytics()), (sortKey) => (["code", "name"].includes(sortKey) ? "asc" : "desc")));
  applyAll(".account-daily-table", ACCOUNT_DAILY_COLUMNS, sortableTable("dailySortKey", "dailySortDirection", "actualAccountDaily",
    () => renderDailyStats(currentAnalytics())));
  applyAll(".account-ranking-table", ACCOUNT_RANKING_COLUMNS);
  applyAll(".account-daytrade-report-table", ACCOUNT_DIRECTION_REPORT_COLUMNS, {
    after: (table) => {
      const roi = table.querySelector('thead th[data-column-id="roi"]');
      if (roi) roi.id = "actualDirectionReportCount";
    },
  });
  applyAll(".account-trades-table", ACCOUNT_RAW_TRADES_COLUMNS);
  applyAll(".account-pair-table", ACCOUNT_PAIR_COLUMNS, sortableTable("pairSortKey", "pairSortDirection", "actualAccountPair", () => renderPairDetails()));
}

function bindDirectory() {
  document.querySelectorAll(".account-directory [data-account-view]").forEach((button) => {
    button.hidden = !viewAvailable(button.dataset.accountView);
    button.addEventListener("click", () => showAccountView(button.dataset.accountView));
  });
  $("actualMobileCardsRefreshBtn")?.addEventListener("click", () => void loadMobileCards());
}

function bindModalKeyboard() {
  if (account.keyBound) return;
  account.keyBound = true;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isTradeModalOpen()) closeTradeModal();
  });
}

function initAccountPage(mode = "actual") {
  configureAccountMode(mode);
  setupAccountColumnTitles();
  account.initialized = true;
  mountTradeEditor();
  renderMarketSwitch({ market: account.market, currentView: account.currentView, markets: ledgerMarkets() });
  bindDirectory();
  bindModalKeyboard();
  showAccountView(account.currentView);

  if (account.dashboard) {
    markActualAccountViewsDirty();
    renderMarketView();
  }

  document.querySelectorAll(".account-market-switch [data-market]").forEach((button) => button.addEventListener("click", () => selectMarket(button.dataset.market)));
  document.querySelectorAll(".account-daytrade-tabs [data-daytrade-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const modeName = button.dataset.daytradeMode;
      if (!["overview", "long", "short"].includes(modeName)) return;
      account.daytradeMode = modeName;
      account.daytradeBucketSelection = { kind: "", index: null };
      renderDaytradeAnalysis();
    });
  });
  if (!stickyResizeBound) {
    stickyResizeBound = true;
    window.addEventListener("resize", () => requestAnimationFrame(actualAccountScrollController.syncStickyMetrics));
  }
  requestAnimationFrame(actualAccountScrollController.syncStickyMetrics);
}

async function refreshAccountPage(mode = "actual", allowAutoSync = true) {
  const generation = ++account.generation;
  configureAccountMode(mode);
  if (!account.initialized) return;
  const [config, dashboard] = await Promise.all([
    loadConfig(),
    apiGet(accountApiPath("/dashboard")),
  ]);
  const outcome = resolveDashboardLoadOutcome(dashboard);
  if (generation !== account.generation) return;
  if (outcome.accepted) {
    renderDashboard(dashboard);
  } else {
    renderDashboardLoadError(outcome.message);
  }
  showAccountView(account.currentView);
  // Once per App run (user 11-05): the first time 實際帳務 opens after the App starts. Entering 帳務 again, or
  // switching ledgers, does not sync again; 立即同步 is the way to sync later.
  if (!isPaperWalletMode() && allowAutoSync && config?.auto_sync_on_page_open && config?.gas_url && !account.autoSyncAttempted) {
    account.autoSyncAttempted = true;
    // The sync runs beside the page, not as part of showing it: entering 帳務 is a navigation, and navigations run one
    // at a time (navigation_coordinator.js), so awaiting a Google Sheet sync here (21-82 s on 10-28) held every other
    // page the user clicked until it ended (user 10-28). The page is shown already; the sync's result re-renders it.
    void syncAccount().catch((error) => {
      console.warn("[ACTUAL ACCOUNT] auto sync failed:", error?.message || error);
      if (generation !== account.generation) return;
      // syncAccount() already shows a message on success; a failed background
      // auto-sync must be just as visible, not silent -- the user would
      // otherwise only notice via stale data with no error shown anywhere.
      // setMessage puts it on the page's notice line; it never blocks the page.
      setMessage(userFacingMessage(error, "自動同步失敗，請稍後手動重試", { context: "ACCOUNT_AUTO_SYNC" }), true);
    });
  }
}
installAccountPageHooks({ refreshAfterChange: () => refreshAccountPage(account.mode, false) });

// 帳務 shows one ledger at a time; the tabs switch it and the choice is remembered.
const ACCOUNT_MODE_KEY = "accountLedgerMode";

function storedAccountMode() {
  return readPreference(ACCOUNT_MODE_KEY, { context: "account ledger" }) === "paper" ? "paper" : "actual";
}

// What changes with the ledger besides its data: the page's mode attribute (the paper colour band), the tabs, the
// views it has (手機卡片 is the actual ledger's) and the dock's 新增交易 (actual only).
function applyAccountModeChrome() {
  syncPaperLedgerFollow();
  const paper = isPaperWalletMode();
  const page = document.querySelector(".account-page");
  if (page) page.dataset.accountMode = account.mode;
  // A paper trade comes only from 即時報價's 下單: the dock's 新增交易 (the real Google Form) is not offered meanwhile.
  document.body.dataset.dockTradeEntry = account.mode === "paper" ? "hidden" : "shown";
  const modeSeg = document.querySelector(".account-mode-seg");
  modeSeg?.querySelectorAll("[data-account-mode-tab]").forEach((tab) => {
    const active = tab.dataset.accountModeTab === account.mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  modeSeg?.classList.toggle("is-paper", paper);
  syncSegmented(modeSeg);
  document.querySelectorAll(".account-directory [data-account-view]").forEach((button) => {
    button.hidden = !viewAvailable(button.dataset.accountView);
  });
}

// The paper ledger is written by the desk's fills, which this page does not make: while it is shown, the push that
// tells 即時報價's 模擬庫存 re-reads the dashboard. Only the holdings on screen are patched (row by row, cell_patch); the
// other views are drawn from the new dashboard when they are next shown.
let stopPaperLedgerFollow = () => {};
let followingPaperLedger = false;

function syncPaperLedgerFollow() {
  if (isPaperWalletMode() === followingPaperLedger) return;
  stopPaperLedgerFollow();
  stopPaperLedgerFollow = () => {};
  followingPaperLedger = isPaperWalletMode();
  if (!followingPaperLedger) return;
  stopPaperLedgerFollow = followLedgerChanges({
    subscribe: (listener) => paperHoldings.subscribe(listener),
    read: async () => ({ generation: account.generation, dashboard: await apiGet(accountApiPath("/dashboard")) }),
    apply: ({ generation, dashboard }) => {
      // A newer read of the page (a ledger or market switch) owns what is shown.
      if (generation !== account.generation || !isPaperWalletMode()) return;
      const outcome = resolveDashboardLoadOutcome(dashboard);
      if (!outcome.accepted) throw new Error(outcome.message);
      account.dashboard = dashboard;
      markActualAccountViewsDirty();
      if (account.currentView === "holdings") renderAccountViewContent("holdings", true);
    },
  });
}

function bindAccountModeTabs() {
  document.querySelectorAll(".account-mode-seg [data-account-mode-tab]").forEach((tab) => tab.addEventListener("click", () => {
    const mode = tab.dataset.accountModeTab === "paper" ? "paper" : "actual";
    if (mode === account.mode) return;
    writePreference(ACCOUNT_MODE_KEY, mode, { context: "account ledger" });
    configureAccountMode(mode);
    mountTradeEditor();
    applyAccountModeChrome();
    renderMarketSwitch({ market: account.market, currentView: account.currentView, markets: ledgerMarkets() });
    showAccountView(account.currentView);
    void refreshAccountPage(mode, mode === "actual")
      .catch((error) => setMessage(userFacingMessage(error, "帳務讀取失敗，請稍後再試", { context: "ACCOUNT_MODE_SWITCH" }), true));
  }));
}

export function initAccountLedgerPage() {
  account.generation += 1;
  initAccountPage(storedAccountMode());
  applyAccountModeChrome();
  bindAccountModeTabs();
}

/** `onlyMode`: refresh only while that ledger is shown (the trade window writes the actual one). */
export async function refreshAccountLedgerPage(allowAutoSync = true, onlyMode = "") {
  if (onlyMode && onlyMode !== account.mode) return;
  return refreshAccountPage(account.mode, allowAutoSync && account.mode === "actual");
}

export function disposeAccountPage() {
  account.generation += 1;
  delete document.body.dataset.dockTradeEntry;
  account.initialized = false;
  stopPaperLedgerFollow();
  stopPaperLedgerFollow = () => {};
  followingPaperLedger = false;
  releasePositionMarks();
  closePairReplay();
  actualAccountScrollController.cancel?.();
  // Leaving 帳務 from 委託紀錄 ends that view's paper-orders subscription (its host's listeners go with the host).
  paperOrderHistory?.view.hide();
  paperOrderHistory = null;
}
