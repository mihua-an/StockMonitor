import { $ } from "../../core/utility.js";
import { syncSegmented } from "../../core/settings_ui.js";

/**
 * Renders the account "Home" tab: the today/week/month/holding summary
 * cards, the top-of-page market switch buttons, and the overall
 * performance metrics (total/daytrade/normal/long/short profit, best/worst
 * stock and day). Also provides the shared metricCells() row-cell builder
 * used by the Home tab and (reused as-is) by the daytrade bucket tables.
 *
 * Reads no owned module-level state. Market/current-view flags and the
 * money/percent/ratio/profit-class formatters are page-owned and must be
 * passed in explicitly.
 */

function marketKey(market) {
  return market === "美股" ? "us" : "tw";
}

export function setSummaryValue(id, value, profit = false, { market, formatMoney, profitClass } = {}) {
  const el = $(id);
  if (!el) return;
  el.textContent = formatMoney(value, market);
  el.className = profit ? `settings-tile-value ${profitClass(value)}` : "settings-tile-value";
}

export function renderSummary(summary, { market, formatMoney, profitClass } = {}) {
  if (!summary) return;
  const key = marketKey(market);
  const opts = { market, formatMoney, profitClass };
  setSummaryValue("actualTodayValue", summary.today?.[key], true, opts);
  setSummaryValue("actualWeekValue", summary.week?.[key], true, opts);
  setSummaryValue("actualMonthValue", summary.month?.[key], true, opts);
  setSummaryValue("actualHoldingValue", summary.holding_cost?.[key], false, opts);
}

/** `markets`: the markets the ledger shown trades (a market it does not trade has no button). */
export function renderMarketSwitch({ market, currentView, markets = ["台股", "美股"] } = {}) {
  const daytradeOnlyTw = currentView === "daytrade";
  const seg = document.querySelector(".account-market-switch");
  seg?.querySelectorAll("[data-market]").forEach((button) => {
    const buttonMarket = button.dataset.market;
    button.hidden = !markets.includes(buttonMarket);
    const disabled = daytradeOnlyTw && buttonMarket === "美股";
    button.disabled = disabled;
    button.classList.toggle("is-active", buttonMarket === market);
  });
  syncSegmented(seg);
}

export function setTextWithProfit(id, text, value, { profitClass } = {}) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("price-up", "price-down", "price-flat");
  el.classList.add(profitClass(value));
}

export function renderHome(analytics, { formatSignedMoney, formatPercent, formatRatio, formatMetricMoney, profitClass } = {}) {
  const home = analytics?.home;
  const overall = home?.overall || {};
  const textOpts = { profitClass };
  setTextWithProfit("actualHomeTotalProfit", formatSignedMoney(overall.total_profit), overall.total_profit, textOpts);
  if ($("actualHomeTotalCount")) $("actualHomeTotalCount").textContent = `${overall.total_count || 0} 筆已實現`;
  if ($("actualHomeWinRate")) $("actualHomeWinRate").textContent = formatPercent(overall.win_rate);
  if ($("actualHomeWinLossCount")) $("actualHomeWinLossCount").textContent = `獲利 ${overall.win_count || 0} / 虧損 ${overall.loss_count || 0}`;
  if ($("actualHomeProfitLossRatio")) $("actualHomeProfitLossRatio").textContent = formatRatio(overall.profit_loss_ratio);
  if ($("actualHomeAvgWinLoss")) $("actualHomeAvgWinLoss").textContent = `均賺 ${formatMetricMoney(overall.avg_win)} / 均賠 ${formatMetricMoney(overall.avg_loss)}`;
  setTextWithProfit("actualHomeDayTradeProfit", formatSignedMoney(overall.daytrade_profit), overall.daytrade_profit, textOpts);
  if ($("actualHomeDayTradeCount")) $("actualHomeDayTradeCount").textContent = `${overall.daytrade_count || 0} 筆當沖`;
  setTextWithProfit("actualHomeNormalProfit", formatSignedMoney(overall.normal_profit), overall.normal_profit, textOpts);
  if ($("actualHomeNormalCount")) $("actualHomeNormalCount").textContent = `${overall.normal_count || 0} 筆一般`;
  setTextWithProfit("actualHomeLongProfit", formatSignedMoney(overall.long_profit), overall.long_profit, textOpts);
  setTextWithProfit("actualHomeShortProfit", formatSignedMoney(overall.short_profit), overall.short_profit, textOpts);
  if ($("actualHomeLongWinRate")) $("actualHomeLongWinRate").textContent = `勝率 ${formatPercent(overall.long_win_rate)}`;
  if ($("actualHomeShortWinRate")) $("actualHomeShortWinRate").textContent = `勝率 ${formatPercent(overall.short_win_rate)}`;

  // 績效亮點: one row each -- the stock or the day beside its name, the profit at the row's end.
  const highlight = (id, item, name) => {
    const nameEl = $(`${id}Name`);
    if (nameEl) nameEl.textContent = item ? name(item) : "";
    setTextWithProfit(id, item ? formatSignedMoney(item.total_profit) : "--", item?.total_profit, textOpts);
  };
  const stockName = (item) => `${item.code}${item.name ? ` ${item.name}` : ""}`;
  highlight("actualHomeBestStock", home?.best_stock, stockName);
  highlight("actualHomeWorstStock", home?.worst_stock, stockName);
  highlight("actualHomeBestDay", home?.best_day, (item) => item.date);
  highlight("actualHomeWorstDay", home?.worst_day, (item) => item.date);
}

export function metricCells(item, { profitClass, formatMetricMoney, formatPercent } = {}) {
  return `
    <td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td>
    <td>${formatPercent(item.win_rate)}</td>
    <td class="${profitClass(item.expectancy)}">${formatMetricMoney(item.expectancy)}</td>
    <td>${formatMetricMoney(item.avg_win)}</td>
    <td>${formatMetricMoney(item.avg_loss)}</td>
    <td class="${profitClass(item.long_profit)}">${formatMetricMoney(item.long_profit)}</td>
    <td class="${profitClass(item.short_profit)}">${formatMetricMoney(item.short_profit)}</td>
    <td>${item.win_count ?? 0}</td>
    <td>${item.loss_count ?? 0}</td>
    <td>${item.total_count ?? 0}</td>
  `;
}
