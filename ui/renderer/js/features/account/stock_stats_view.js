// 帳務 個股數據: per-stock statistics, their expanded rows, inline trade details and replay host (split out of
// pages/account.js).
import { ACCOUNT_STOCK_DAYTRADE_COLUMNS, ACCOUNT_STOCK_NORMAL_TRADE_COLUMNS } from "../../core/column_schemas.js";
import { loadStateHtml } from "../../core/load_state_view.js";
import { renderColumnHeaderHtml } from "../../core/column_title.js";
import { applyStandardDataGrids, expandCellHtml, expandDetailRowHtml, recordExpandBody } from "../../core/data_grid.js";
import { createExpandMotion } from "../../core/expand_motion.js";
import { $, escapeHtml } from "../../core/utility.js";
import { currentAnalytics, dailyActionIcon, formatMetricMoney, formatMoney, formatPercent, formatQty, formatRatio, formatTradePrice, profitClass, updateActualAccountPageTitle } from "./account_format.js";
import { account, actualAccountExpandedStockStats, actualAccountOpenStockTradeDetails, actualAccountReplayState, actualAccountScrollController, actualAccountStockTradeModes } from "./account_state.js";
import { actualReplayRowSelector, bindPairReplayControls, closePairReplay, openPairReplay, pairReplayAvailable, replayPanelHtml } from "./pair_replay.js";
import { stockPairs } from "./day_reads.js";
import { compareAccountSortValue } from "./sort_utils.js";

export function stockStatMetric(label, value, options = {}) {
  const { kind = "money", profit = false } = options;
  let text = "-";
  if (kind === "percent") text = formatPercent(value);
  else if (kind === "ratio") text = formatRatio(value);
  else if (kind === "qty") text = formatQty(value);
  else if (kind === "count") text = `${Number(value || 0).toLocaleString("zh-TW")} 筆`;
  else if (kind === "price") text = formatTradePrice(value);
  else text = formatMetricMoney(value);
  const cls = profit ? profitClass(value) : "";
  return `<div class="account-stock-stat-metric"><span>${escapeHtml(label)}</span><b class="${cls}">${text}</b></div>`;
}

export function stockStatAveragePrice(amount, qty) {
  const amountValue = Number(amount);
  const qtyValue = Number(qty);
  if (!Number.isFinite(amountValue) || !Number.isFinite(qtyValue) || qtyValue <= 0) return null;
  return amountValue / qtyValue;
}

export function stockStatDaytradeQty(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty)) return null;
  // 台股當沖以「張」呈現；美股沒有張的概念，維持原始股數。
  return account.market === "台股" ? qty / 1000 : qty;
}

export function sortStockStatItems(items) {
  const key = account.stockSortKey || "total_profit";
  return [...items].sort((a, b) => compareAccountSortValue(a, b, key, account.stockSortDirection, "code"));
}

export function stockStatExpandedContent(item) {
  const normalBuyAvgPrice = stockStatAveragePrice(item.normal_buy_amount, item.normal_buy_qty);
  const normalSellAvgPrice = stockStatAveragePrice(item.normal_sell_amount, item.normal_sell_qty);
  const daytradeBuyAvgPrice = stockStatAveragePrice(item.daytrade_buy_amount, item.daytrade_buy_qty);
  const daytradeSellAvgPrice = stockStatAveragePrice(item.daytrade_sell_amount, item.daytrade_sell_qty);
  const daytradeBuyQtyLabel = account.market === "台股" ? "總買張數" : "總買股數";
  const daytradeSellQtyLabel = account.market === "台股" ? "總賣張數" : "總賣股數";

  return `
    <div class="account-stock-stat-detail-grid">
      <section class="account-stock-stat-group">
        <div class="account-stock-stat-group-heading">
          <h4>整體績效</h4>
          <span>${Number(item.total_count || 0).toLocaleString("zh-TW")} 筆</span>
        </div>
        <div class="account-stock-stat-metrics">
          ${stockStatMetric("平均交易收益", item.avg_trade_profit, { profit: true })}
          ${stockStatMetric("報酬率", item.return_rate, { kind: "percent" })}
          ${stockStatMetric("整體勝率", item.win_rate, { kind: "percent" })}
          ${stockStatMetric("盈虧比", item.profit_loss_ratio, { kind: "ratio" })}
          ${stockStatMetric("獲利次數", item.win_count, { kind: "count" })}
          ${stockStatMetric("虧損次數", item.loss_count, { kind: "count" })}
        </div>
      </section>

      <section class="account-stock-stat-group">
        <div class="account-stock-stat-group-heading"><h4>現股</h4></div>
        <div class="account-stock-stat-metrics">
          ${stockStatMetric("淨損益", item.normal_profit, { profit: true })}
          ${stockStatMetric("報酬率", item.normal_return_rate, { kind: "percent" })}
          ${stockStatMetric("交易稅", item.normal_tax)}
          ${stockStatMetric("手續費", item.normal_fee)}

          ${stockStatMetric("庫存成本", item.holding_cost)}
          ${stockStatMetric("庫存成本 / 股", item.holding_avg_cost, { kind: "price" })}
          ${stockStatMetric("買進均價", normalBuyAvgPrice, { kind: "price" })}
          ${stockStatMetric("賣出均價", normalSellAvgPrice, { kind: "price" })}

          ${stockStatMetric("總買股數", item.normal_buy_qty, { kind: "qty" })}
          ${stockStatMetric("總賣股數", item.normal_sell_qty, { kind: "qty" })}
          ${stockStatMetric("總買進", item.normal_buy_amount)}
          ${stockStatMetric("總賣出", item.normal_sell_amount)}
        </div>
      </section>

      <section class="account-stock-stat-group account-stock-daytrade-group">
        <div class="account-stock-stat-group-heading">
          <h4>當沖</h4>
          <span>${Number(item.daytrade_count || 0).toLocaleString("zh-TW")} 筆</span>
        </div>
        <div class="account-stock-stat-metrics">
          ${stockStatMetric("淨損益", item.daytrade_profit, { profit: true })}
          ${stockStatMetric("報酬率", item.daytrade_return_rate, { kind: "percent" })}
          ${stockStatMetric("交易稅", item.daytrade_tax)}
          ${stockStatMetric("手續費", item.daytrade_fee)}

          ${stockStatMetric("平均收益", item.avg_daytrade_profit, { profit: true })}
          ${stockStatMetric("當沖勝率", item.daytrade_win_rate, { kind: "percent" })}
          ${stockStatMetric("買進均價", daytradeBuyAvgPrice, { kind: "price" })}
          ${stockStatMetric("賣出均價", daytradeSellAvgPrice, { kind: "price" })}

          ${stockStatMetric(daytradeBuyQtyLabel, stockStatDaytradeQty(item.daytrade_buy_qty), { kind: "qty" })}
          ${stockStatMetric(daytradeSellQtyLabel, stockStatDaytradeQty(item.daytrade_sell_qty), { kind: "qty" })}
          ${stockStatMetric("總買進", item.daytrade_buy_amount)}
          ${stockStatMetric("總賣出", item.daytrade_sell_amount)}
        </div>
      </section>

      <section class="account-stock-stat-group account-stock-direction-group">
        <div class="account-stock-direction-grid account-stock-direction-grid-split">
          <div class="account-stock-direction-side">
            <div class="account-stock-direction-side-heading">多單 <b>${Number(item.long_count || 0).toLocaleString("zh-TW")} 筆</b></div>
            <div class="account-stock-direction-row">
              ${stockStatMetric("多單收益", item.long_profit, { profit: true })}
              ${stockStatMetric("多單勝率", item.long_win_rate, { kind: "percent" })}
            </div>
            <div class="account-stock-direction-row">
              ${stockStatMetric("平均多單收益", item.avg_long_profit, { profit: true })}
              ${stockStatMetric("多單報酬率", item.long_return_rate, { kind: "percent" })}
            </div>
          </div>
          <div class="account-stock-direction-side">
            <div class="account-stock-direction-side-heading">空單 <b>${Number(item.short_count || 0).toLocaleString("zh-TW")} 筆</b></div>
            <div class="account-stock-direction-row">
              ${stockStatMetric("空單收益", item.short_profit, { profit: true })}
              ${stockStatMetric("空單勝率", item.short_win_rate, { kind: "percent" })}
            </div>
            <div class="account-stock-direction-row">
              ${stockStatMetric("平均空單收益", item.avg_short_profit, { profit: true })}
              ${stockStatMetric("空單報酬率", item.short_return_rate, { kind: "percent" })}
            </div>
          </div>
        </div>
      </section>
    </div>`;
}

// The expanded stock's pairs, read when it opens (the dashboard carries no pair list); null until they are read.
function expandedStockPairs(code) {
  const read = stockPairs(account.market, code, () => renderStockStats(currentAnalytics()));
  return read.state === "ready" ? read.data.items : null;
}

export function stockInlineTradeDetailContent(item) {
  let mode = actualAccountStockTradeModes.get(item.code);
  if (!mode) {
    // 點個股後交易明細要直接有內容：有現股就先顯示現股；只有當沖的股票則
    // 直接開當沖，不再先看到一張空的「零股」表還要多切一次。
    mode = Number(item.normal_count) > 0 ? "normal" : "daytrade";
    actualAccountStockTradeModes.set(item.code, mode);
  }
  const read = stockPairs(account.market, item.code, () => renderStockStats(currentAnalytics()));
  if (read.state !== "ready") {
    return `<section class="account-stock-inline-trades">${loadStateHtml(read.state, read.error)}</section>`;
  }
  // Newest first, as the ledger answers.
  const rows = read.data.items
    .filter((detail) => mode === "daytrade" ? detail.trade_type === "當沖" : detail.trade_type !== "當沖");

  const tableRows = rows.length ? rows.map((detail) => {
    const entry = detail.trade_type === "當沖" ? detail.entry_ref : detail.buy_ref;
    const exit = detail.trade_type === "當沖" ? detail.exit_ref : detail.sell_ref;
    const hold = detail.trade_type === "當沖" ? `${detail.hold_period ?? 0} 分` : `${detail.hold_period ?? 0} 天`;
    const canReplay = mode === "daytrade" && pairReplayAvailable(detail);
    const activeReplay = actualAccountReplayState.origin === "stockStats" && actualAccountReplayState.pairId === String(detail.id);

    if (mode === "normal") {
      return `<tr>
        <td>${escapeHtml(detail.realized_date)}</td>
        <td>${formatQty(detail.qty)}</td>
        <td>${escapeHtml(entry || "-")}</td>
        <td>${escapeHtml(exit || "-")}</td>
        <td>${escapeHtml(hold)}</td>
        <td>${formatMoney(detail.buy_price, detail.market || account.market)}</td>
        <td>${formatMoney(detail.sell_price, detail.market || account.market)}</td>
        <td class="${profitClass(detail.profit)}">${formatMetricMoney(detail.profit)}</td>
        <td>${formatPercent(detail.roi)}</td>
        <td>${formatMoney(detail.fee, detail.market || account.market)}</td>
        <td>${formatMoney(detail.tax, detail.market || account.market)}</td>
      </tr>`;
    }

    return `<tr data-stock-replay-id="${escapeHtml(detail.id)}" class="${canReplay ? "account-stock-inline-replayable " : ""}${activeReplay ? "account-stock-inline-active-replay" : ""}">
      <td>${escapeHtml(detail.realized_date)}</td>
      <td>${escapeHtml(detail.direction || "-")}</td>
      <td>${formatQty(detail.qty)}</td>
      <td>${escapeHtml(entry || "-")}</td>
      <td>${escapeHtml(exit || "-")}</td>
      <td>${escapeHtml(hold)}</td>
      <td>${formatMoney(detail.buy_price, detail.market || account.market)}</td>
      <td>${formatMoney(detail.sell_price, detail.market || account.market)}</td>
      <td class="${profitClass(detail.profit)}">${formatMetricMoney(detail.profit)}</td>
      <td>${formatPercent(detail.roi)}</td>
      <td>${formatMoney(detail.fee, detail.market || account.market)}</td>
      <td>${formatMoney(detail.tax, detail.market || account.market)}</td>
      <td class="account-stock-inline-action-cell"><button class="account-row-icon-btn ${activeReplay ? "active" : ""}" type="button" data-stock-pair-action="replay" aria-label="在帳務頁展開歷史回放" ${canReplay ? "" : "disabled"}>${dailyActionIcon("chart")}</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="${mode === "daytrade" ? 13 : 11}" class="empty">目前沒有${mode === "daytrade" ? "當沖" : "零股 / 一般"}交易明細</td></tr>`;

  const tableHead = renderColumnHeaderHtml(
    mode === "daytrade" ? ACCOUNT_STOCK_DAYTRADE_COLUMNS : ACCOUNT_STOCK_NORMAL_TRADE_COLUMNS,
  );

  return `
    <section class="account-stock-inline-trades">
      <div class="account-stock-inline-trades-header">
        <div class="account-stock-inline-trades-title">${escapeHtml(item.code)}${item.name ? ` ${escapeHtml(item.name)}` : ""} 交易明細</div>
        <div class="account-stock-inline-mode-switch" role="group" aria-label="交易明細類型">
          <button type="button" class="account-stock-inline-mode-btn ${mode === "normal" ? "active" : ""}" data-stock-trade-mode="normal" data-stock-trade-code="${escapeHtml(item.code)}">零股</button>
          <button type="button" class="account-stock-inline-mode-btn ${mode === "daytrade" ? "active" : ""}" data-stock-trade-mode="daytrade" data-stock-trade-code="${escapeHtml(item.code)}">當沖</button>
        </div>
      </div>
      <div class="table-wrap finance-table-wrap account-stock-inline-table-wrap">
        <table class="data-table finance-table account-stock-inline-table ${mode === "normal" ? "account-stock-inline-normal-table" : "account-stock-inline-daytrade-table"}">
          ${tableHead}
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>`;
}

function stockStatRowHtml(item) {
  const detailOpen = actualAccountExpandedStockStats.has(item.code) || stockMotion.closing(item.code);
  const expandedContent = detailOpen
    ? `${stockStatExpandedContent(item)}${stockInlineTradeDetailContent(item)}`
    : "";
  return `
    <tr class="record-expand-row ${detailOpen ? "expanded" : ""}" data-stock-stat-code="${escapeHtml(item.code)}">
      ${expandCellHtml(escapeHtml(item.code))}
      <td class="account-stock-name-cell">${escapeHtml(item.name || "")}</td>
      <td>${formatQty(item.holding_qty)}</td>
      <td>${formatMetricMoney(item.holding_cost)}</td>
      <td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td>
      <td class="${profitClass(item.daytrade_profit)}">${formatMetricMoney(item.daytrade_profit)}</td>
      <td>${formatPercent(item.daytrade_win_rate)}</td>
      <td class="${profitClass(item.long_profit)}">${formatMetricMoney(item.long_profit)}</td>
      <td class="${profitClass(item.short_profit)}">${formatMetricMoney(item.short_profit)}</td>
      <td>${formatRatio(item.daytrade_profit_loss_ratio)}</td>
      <td>${formatRatio(item.long_profit_loss_ratio)}</td>
      <td>${formatRatio(item.short_profit_loss_ratio)}</td>
    </tr>
    ${expandDetailRowHtml({ colspan: 12, open: detailOpen, className: "account-stock-stat-expanded-row",
      attrs: `data-stock-stat-detail="${escapeHtml(item.code)}"`,
      contentHtml: `<div class="account-stock-stat-expanded-stack">${expandedContent}</div>` })}`;
}

// 個股數據一次只展開一檔。Clicking the open one closes it (and its replay).
function toggleStockStat(analytics, row) {
  const code = row.dataset.stockStatCode || "";
  if (!code || stockMotion.busy(code)) return;
  const others = [...actualAccountExpandedStockStats].filter((open) => open !== code);
  if (others.some((open) => stockMotion.busy(open))) return;
  stockMotion.start(code, !actualAccountExpandedStockStats.has(code));
  others.forEach((open) => stockMotion.start(open, false));
  if (actualAccountExpandedStockStats.has(code)) {
    actualAccountExpandedStockStats.delete(code);
    actualAccountOpenStockTradeDetails.delete(code);
    if (actualAccountReplayState.origin === "stockStats" && actualAccountReplayState.pair?.code === code) {
      closePairReplay();
      actualAccountReplayState.origin = "stockStats";
    }
    renderStockStats(analytics);
  } else {
    // 個股數據一次只展開一檔。
    actualAccountExpandedStockStats.clear();
    actualAccountOpenStockTradeDetails.clear();
    if (actualAccountReplayState.origin === "stockStats") closePairReplay();
    actualAccountExpandedStockStats.add(code);
    actualAccountOpenStockTradeDetails.add(code);
    renderStockStats(analytics);
  }
}

// A stock's detail opens and closes with the shared expand motion; opening one closes the one that was open.
const stockMotion = createExpandMotion({
  find: (code) => recordExpandBody(document.querySelector(`tr[data-stock-stat-detail="${CSS.escape(code)}"]`)),
  redraw: () => renderStockStats(currentAnalytics()),
  reveal: actualAccountScrollController.revealFrom((code) => document.querySelector(`tr[data-stock-stat-code="${CSS.escape(code)}"]`)),
});

// Open a stock's trade pair replay from its row or its button.
// A row click opens only a replayable pair; the button is disabled for the others.
function stockOfDetail(element) {
  return String(element.closest("[data-stock-stat-detail]")?.dataset.stockStatDetail || "");
}

function openStockPairReplay(code, id, { requireAvailable = false } = {}) {
  const detail = (expandedStockPairs(code) || []).find((item) => String(item.id) === id);
  if (!detail || (requireAvailable && !pairReplayAvailable(detail))) return;
  const opened = openPairReplay(detail, "stockStats");
  if (opened) actualAccountScrollController.openReplay(actualReplayRowSelector(detail.id, "stockStats"));
}

function bindStockStatRows(body, analytics) {
  body.querySelectorAll("tr[data-stock-stat-code]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      toggleStockStat(analytics, row);
    });
  });
  body.querySelectorAll("button[data-stock-trade-mode]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const code = button.dataset.stockTradeCode || "";
      const mode = button.dataset.stockTradeMode || "normal";
      if (!code || !["normal", "daytrade"].includes(mode)) return;
      if (mode !== "daytrade" && actualAccountReplayState.origin === "stockStats" && actualAccountReplayState.pair?.code === code) {
        closePairReplay();
        actualAccountReplayState.origin = "stockStats";
      }
      actualAccountStockTradeModes.set(code, mode);
      actualAccountOpenStockTradeDetails.add(code);
      renderStockStats(analytics);
    });
  });

  body.querySelectorAll("button[data-stock-pair-action='replay']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      openStockPairReplay(stockOfDetail(button), String(button.closest("[data-stock-replay-id]")?.dataset.stockReplayId || ""));
    });
  });
  body.querySelectorAll("tr[data-stock-replay-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openStockPairReplay(stockOfDetail(row), String(row.dataset.stockReplayId || ""), { requireAvailable: true });
    });
  });
}

export function renderStockStats(analytics) {
  const body = $("actualStockStatsBody");
  const count = $("actualStockStatsCount");
  const sourceItems = Array.isArray(analytics?.stock_stats) ? analytics.stock_stats : [];
  const items = sortStockStatItems(sourceItems);
  if (count) count.textContent = `${items.length} 檔`;
  if (account.currentView === "stockStats") updateActualAccountPageTitle("stockStats", analytics);
  if (!body) return;
  if (!items.length) {
    // A ledger built by another version is not shown patched -- it is said to need a rebuild.
    const ledgerState = account.dashboard?.analytics?.ledger_state;
    const pending = ledgerState && ledgerState.state !== "CURRENT";
    body.innerHTML = `<tr><td colspan="12" class="empty">${pending ? `個股數據暫不可用：${escapeHtml(ledgerState.reason || "帳務需要重新計算")}` : "尚無個股數據"}</td></tr>`;
    return;
  }

  body.innerHTML = items.map((item) => stockStatRowHtml(item)).join("");
  // A stock's trade tables are grids of their own; split now, so the motion measures the block at its final height.
  applyStandardDataGrids(body);
  stockMotion.play();
  actualAccountScrollController.syncStickyMetrics();
  bindStockStatRows(body, analytics);
  if (actualAccountReplayState.origin === "stockStats" && actualAccountReplayState.pair) {
    renderStockReplayHost();
  }
}

export function renderStockReplayHost() {
  document.querySelectorAll("[data-stock-inline-replay-row]").forEach((row) => row.remove());

  document.querySelectorAll("[data-stock-replay-id]").forEach((row) => {
    const active = actualAccountReplayState.origin === "stockStats"
      && String(row.dataset.stockReplayId || "") === String(actualAccountReplayState.pairId || "");
    row.classList.toggle("account-stock-inline-active-replay", active);
    row.querySelector("[data-stock-pair-action='replay']")?.classList.toggle("active", active);
  });

  const activePair = actualAccountReplayState.origin === "stockStats" && actualAccountReplayState.pair
    ? actualAccountReplayState.pair
    : null;
  if (activePair) {
    const targetRow = document.querySelector(`[data-stock-replay-id="${CSS.escape(String(actualAccountReplayState.pairId || ""))}"]`);
    if (targetRow) {
      const replayRow = document.createElement("tr");
      replayRow.className = "account-stock-inline-replay-row";
      replayRow.dataset.stockInlineReplayRow = String(actualAccountReplayState.pairId || "");
      const cell = document.createElement("td");
      cell.colSpan = Math.max(1, targetRow.children.length);
      cell.innerHTML = replayPanelHtml(activePair);
      replayRow.appendChild(cell);
      targetRow.insertAdjacentElement("afterend", replayRow);
    }
  }

  bindPairReplayControls();
}
