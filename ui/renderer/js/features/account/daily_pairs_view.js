// 帳務 每日明細 / 配對明細: the per-day statistics with their trade fills, and the closed trade pairs by day (split
// out of pages/account.js).
import { expandCellHtml, expandDetailRowHtml, recordExpandBody } from "../../core/data_grid.js";
import { createExpandMotion } from "../../core/expand_motion.js";
import { emptyStateHtml, loadStateHtml } from "../../core/load_state_view.js";
import { $, escapeHtml } from "../../core/utility.js";
import { currentAnalytics, dailyActionIcon, formatMetricMoney, formatMoney, formatPercent, formatQty, formatRatio, formatTradePrice, profitClass } from "./account_format.js";
import { account, actualAccountExpandedDays, actualAccountExpandedPairDays, actualAccountReplayState, actualAccountScrollController } from "./account_state.js";
import { buildCumulativeRealizedByDate } from "./analytics.js";
import { actualReplayRowSelector, bindPairReplayControls, closePairReplay, openPairReplay, pairReplayAvailable, replayEntryRef, replayExitRef, replayPanelHtml, replayPeriodClockText } from "./pair_replay.js";
import { compareAccountSortValue } from "./sort_utils.js";
import { accountDay, readPair, readTrade } from "./day_reads.js";
import { loadTradeIntoEditor } from "./trade_editor.js";
import { isBuyAction, isShortDirection } from "./trade_semantics.js";
import { parseTradeInfo } from "./trade_info.js";

/** The fills the day table draws: the trade's own, else the valid tokens of its trade_info (the editor shows the rest). */
export function tradeFillItems(trade) {
  if (Array.isArray(trade?.fills) && trade.fills.length) return trade.fills;
  return parseTradeInfo(trade?.trade_info).fills
    .filter((fill) => !fill.errors.length)
    .map((fill) => ({ qty: fill.qty, price: fill.price, amount: fill.qty * fill.price }));
}

export function dailyTradeDetailsHtml(date) {
  const day = accountDay(account.market, date, () => renderDailyStats(currentAnalytics()));
  if (day.state !== "ready") return loadStateHtml(day.state, day.error);
  const trades = day.data.trades;

  if (!trades.length) return emptyStateHtml("這一天沒有交易資料");

  const tradeRows = trades.map((trade) => {
    const fills = tradeFillItems(trade);
    const normalizedFills = fills.length
      ? fills
      : [{ qty: Number(trade.qty) || 0, price: trade.avg_price, amount: Number(trade.gross_amount) || 0 }];

    // One line per fill: its shares, price and amount.
    const fillLines = normalizedFills.map((fill) => {
      const rawAmount = Number(fill.amount);
      const amount = Number.isFinite(rawAmount) ? rawAmount : (Number(fill.qty) || 0) * (Number(fill.price) || 0);
      return `<span>${formatQty(fill.qty)} 股 @ ${formatTradePrice(fill.price, trade.market)}<i>價金 ${formatMoney(amount, trade.market)}</i></span>`;
    }).join("");

    const actionText = `${trade.is_daytrade ? "當沖" : ""}${trade.action || ""}`;
    return `<div class="settings-item account-detail-row account-daily-raw-row" data-trade-id="${escapeHtml(trade.trade_id)}">`
      + `<span class="account-detail-time">${escapeHtml(trade.time || "--:--")}</span>`
      + `<span class="settings-item-main"><b>${escapeHtml(trade.name || trade.code)}</b><span class="settings-item-value">${escapeHtml(trade.code)}</span></span>`
      + `<span class="settings-badge ${isBuyAction(trade.action) ? "is-buy" : "is-sell"}">${escapeHtml(actionText)}</span>`
      + `<span class="account-detail-fills">${fillLines}</span>`
      + `<span class="account-detail-cost">手續費 ${formatMoney(trade.fee, trade.market)}・交易稅 ${formatMoney(trade.tax, trade.market)}</span>`
      + `<button class="settings-row-btn" type="button" data-daily-action="edit" aria-label="編輯交易">${dailyActionIcon("edit")}編輯</button></div>`;
  }).join("");

  return `<div class="account-detail-list"><div class="settings-group">${tradeRows}</div></div>`;
}

// A day's and a pair day's details open and close with the shared expand motion.
const dailyMotion = createExpandMotion({
  find: (date) => recordExpandBody(document.querySelector(`tr[data-daily-detail="${CSS.escape(date)}"]`)),
  redraw: () => renderDailyStats(currentAnalytics()),
  reveal: actualAccountScrollController.revealFrom((date) => document.querySelector(`tr[data-daily-date="${CSS.escape(date)}"]`)),
});
const pairDayMotion = createExpandMotion({
  find: (date) => recordExpandBody(document.querySelector(`tr[data-pair-detail="${CSS.escape(date)}"]`)),
  redraw: () => renderPairDetails(),
  reveal: actualAccountScrollController.revealFrom((date) => document.querySelector(`tr[data-pair-date="${CSS.escape(date)}"]`)),
});

export function renderDailyStats(analytics) {
  const body = $("actualDailyBody");
  const sourceItems = Array.isArray(analytics?.daily_stats) ? analytics.daily_stats : [];
  const cumulativeByDate = buildCumulativeRealizedByDate(sourceItems);
  const items = sourceItems.map((item) => {
    const cumulative = cumulativeByDate.get(String(item?.date || "")) || { normal_profit: 0, daytrade_profit: 0 };
    return { ...item, cumulative_normal_profit: cumulative.normal_profit, cumulative_daytrade_profit: cumulative.daytrade_profit };
  }).sort((a, b) => compareAccountSortValue(a, b, account.dailySortKey, account.dailySortDirection));
  if (!body) return;

  if (account.dailyAutoOpenPending && items.length) {
    const newestDate = items
      .map((item) => String(item?.date || ""))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))[0] || "";
    actualAccountExpandedDays.clear();
    if (newestDate) actualAccountExpandedDays.add(newestDate);
    account.dailyAutoOpenPending = false;
  }

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="11" class="empty">尚無每日明細</td></tr>`;
    return;
  }

  body.innerHTML = items.map((item) => {
    const expanded = actualAccountExpandedDays.has(item.date) || dailyMotion.closing(item.date);
    const cumulative = { normal_profit: item.cumulative_normal_profit, daytrade_profit: item.cumulative_daytrade_profit };
    return `
      <tr class="account-daily-summary-row record-expand-row ${expanded ? "expanded" : ""}" data-daily-date="${escapeHtml(item.date)}">
        ${expandCellHtml(escapeHtml(item.date))}
        <td class="${profitClass(item.settlement)}">${formatMetricMoney(item.settlement)}</td>
        <td class="${profitClass(item.today_realized)}">${formatMetricMoney(item.today_realized)}</td>
        <td class="${profitClass(item.normal_profit)}">${formatMetricMoney(item.normal_profit)}</td>
        <td class="${profitClass(item.daytrade_profit)}">${formatMetricMoney(item.daytrade_profit)}</td>
        <td>${formatRatio(item.daytrade_profit_loss_ratio)}</td>
        <td class="${profitClass(item.normal_trade_diff)}">${formatMetricMoney(item.normal_trade_diff)}</td>
        <td class="${profitClass(item.long_profit)}">${formatMetricMoney(item.long_profit)}</td>
        <td class="${profitClass(item.short_profit)}">${formatMetricMoney(item.short_profit)}</td>
        <td class="${profitClass(cumulative.normal_profit)}">${formatMetricMoney(cumulative.normal_profit)}</td>
        <td class="${profitClass(cumulative.daytrade_profit)}">${formatMetricMoney(cumulative.daytrade_profit)}</td>
      </tr>
      ${expanded ? expandDetailRowHtml({ colspan: 11, className: "account-daily-detail-row", attrs: `data-daily-detail="${escapeHtml(item.date)}"`, contentHtml: dailyTradeDetailsHtml(item.date) }) : ""}
    `;
  }).join("");
  dailyMotion.play();

  body.querySelectorAll(".account-daily-summary-row[data-daily-date]").forEach((row) => {
    row.addEventListener("click", () => {
      const date = row.dataset.dailyDate || "";
      const opening = !actualAccountExpandedDays.has(date);
      if (!date || !dailyMotion.start(date, opening)) return;
      if (opening) actualAccountExpandedDays.add(date);
      else actualAccountExpandedDays.delete(date);
      renderDailyStats(currentAnalytics());
    });
  });

  body.querySelectorAll(".account-daily-raw-row[data-trade-id] [data-daily-action='edit']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = button.closest("[data-trade-id]");
      const id = String(row?.dataset.tradeId || "");
      const trade = readTrade(id);
      if (trade) loadTradeIntoEditor(trade);
    });
  });
}

export function pairPeriodText(pair) {
  // A 當沖 pair's entry and exit clocks to the minute (its day is the row above it); any other pair's dates as the
  // source wrote them.
  if (pair?.trade_type === "當沖") return replayPeriodClockText(pair);
  return `${String(replayEntryRef(pair) || "--")} → ${String(replayExitRef(pair) || "--")}`;
}

export function pairTradeTypeText(pair) {
  if (pair?.trade_type !== "當沖") return { text: "一般", className: "normal" };
  if (isShortDirection(pair?.direction)) return { text: "空單", className: "short" };
  return { text: "多單", className: "long" };
}

export function pairRowsHtml(date) {
  const day = accountDay(account.market, date, () => renderPairDetails());
  if (day.state !== "ready") return loadStateHtml(day.state, day.error);
  const pairs = day.data.pairs;
  if (!pairs.length) return emptyStateHtml("這一天沒有已實現配對");

  return `<div class="account-detail-list"><div class="settings-group">${pairs.map((pair) => {
    const pairId = String(pair.id);
    const canReplay = pairReplayAvailable(pair);
    const activeReplay = actualAccountReplayState.origin === "pairs" && actualAccountReplayState.pairId === pairId;
    // Only a day trade has a direction (多 / 空); an overnight (一般) pair is a buy then a sell.
    const isShort = pair?.trade_type === "當沖" && isShortDirection(pair?.direction);
    // 報酬率 is the ledger's (AccountReadService._pair_row); null when nothing was put in, shown as no rate.
    const type = pairTradeTypeText(pair);
    const profitText = `${formatMetricMoney(pair.profit)}${pair.roi === null ? "" : ` (${formatPercent(pair.roi)})`}`;
    const directionalPriceText = isShort
      ? `賣: ${formatTradePrice(pair.sell_price, pair.market)} → 買: ${formatTradePrice(pair.buy_price, pair.market)}`
      : pair?.trade_type === "當沖"
        ? `買: ${formatTradePrice(pair.buy_price, pair.market)} → 賣: ${formatTradePrice(pair.sell_price, pair.market)}`
        : `${formatTradePrice(pair.buy_price, pair.market)} → ${formatTradePrice(pair.sell_price, pair.market)}`;

    return `<div class="settings-item account-detail-row account-daily-pair-row${canReplay ? " is-clickable" : ""}${activeReplay ? " is-selected" : ""}" data-pair-id="${escapeHtml(pair.id)}">`
      + `<span class="settings-item-main"><b>${escapeHtml(pair.name || pair.code)}</b><span class="settings-item-value">${escapeHtml(pair.code)}・${escapeHtml(pairPeriodText(pair))}</span></span>`
      + `<span class="settings-badge">${escapeHtml(type.text)}</span>`
      + `<span class="account-detail-num">${formatQty(pair.qty)} 股</span>`
      + `<span class="account-detail-num is-wide">${escapeHtml(directionalPriceText)}</span>`
      + `<span class="account-detail-num is-wide"><b class="${profitClass(pair.profit)}">${profitText}</b></span>`
      + `<span class="account-detail-cost">手續費 ${formatMoney(pair.fee, pair.market)}・稅 ${formatMoney(pair.tax, pair.market)}</span>`
      + `<button class="settings-row-btn${activeReplay ? " is-open" : ""}" type="button" data-pair-action="replay" aria-label="在帳務頁展開歷史回放"${canReplay ? "" : " disabled"}>${dailyActionIcon("chart")}走勢</button></div>`
      + (activeReplay ? replayPanelHtml(pair) : "");
  }).join("")}</div></div>`;
}

// 配對明細's days (analytics pair_days: one row per realized date, computed by the ledger): each day's summary and the
// running totals, in the chosen sort order. A day's pairs are read when it is opened.
const NO_PAIR_DAY = Object.freeze({ total_profit: 0, daytrade_profit: 0, normal_profit: 0, long_profit: 0, short_profit: 0, total_count: 0 });

function pairDays(pairDayStats) {
  const statsByDate = new Map(pairDayStats.map((stat) => [String(stat.date || ""), stat]));
  const cumulativeByDate = buildCumulativeRealizedByDate([...statsByDate.values()]);
  const dates = [...statsByDate.values()].map((stat) => {
    const cumulative = cumulativeByDate.get(stat.date) || { normal_profit: 0, daytrade_profit: 0 };
    return { ...stat, cumulative_normal_profit: cumulative.normal_profit, cumulative_daytrade_profit: cumulative.daytrade_profit };
  }).sort((a, b) => compareAccountSortValue(a, b, account.pairSortKey, account.pairSortDirection)).map((row) => row.date);
  return { dates, statsByDate, cumulativeByDate };
}

function pairDayRowHtml(date, { statsByDate, cumulativeByDate }) {
  const stat = statsByDate.get(date) || NO_PAIR_DAY;
  const cumulative = cumulativeByDate.get(date) || { normal_profit: 0, daytrade_profit: 0 };
  const expanded = actualAccountExpandedPairDays.has(date) || pairDayMotion.closing(date);
  return `
      <tr class="account-pair-summary-row record-expand-row ${expanded ? "expanded" : ""}" data-pair-date="${escapeHtml(date)}">
        ${expandCellHtml(escapeHtml(date))}
        <td class="${profitClass(stat.total_profit)}">${formatMetricMoney(stat.total_profit)}</td>
        <td class="${profitClass(stat.daytrade_profit)}">${formatMetricMoney(stat.daytrade_profit)}</td>
        <td class="${profitClass(stat.normal_profit)}">${formatMetricMoney(stat.normal_profit)}</td>
        <td class="${profitClass(stat.long_profit)}">${formatMetricMoney(stat.long_profit)}</td>
        <td class="${profitClass(stat.short_profit)}">${formatMetricMoney(stat.short_profit)}</td>
        <td class="${profitClass(cumulative.normal_profit)}">${formatMetricMoney(cumulative.normal_profit)}</td>
        <td class="${profitClass(cumulative.daytrade_profit)}">${formatMetricMoney(cumulative.daytrade_profit)}</td>
      </tr>
      ${expanded ? expandDetailRowHtml({ colspan: 8, className: "account-pair-detail-row", attrs: `data-pair-detail="${escapeHtml(date)}"`, contentHtml: pairRowsHtml(date) }) : ""}
    `;
}

// Opening or closing one day; closing it closes a replay of one of its pairs.
function togglePairDay(date) {
  const opening = !actualAccountExpandedPairDays.has(date);
  if (!date || !pairDayMotion.start(date, opening)) return;
  if (!opening) {
    actualAccountExpandedPairDays.delete(date);
    if (actualAccountReplayState.pair?.realized_date === date) closePairReplay();
  } else actualAccountExpandedPairDays.add(date);
  renderPairDetails();
}

// A row click opens only a replayable pair; the button is disabled for the others.
function openRealizedPairReplay(id, { requireAvailable = false } = {}) {
  const pair = readPair(id);
  if (!pair || (requireAvailable && !pairReplayAvailable(pair))) return;
  const opened = openPairReplay(pair, "pairs");
  if (opened) actualAccountScrollController.openReplay(actualReplayRowSelector(pair.id, "pairs"));
}

function bindPairRows(body) {
  body.querySelectorAll(".account-pair-summary-row[data-pair-date]").forEach((row) => {
    row.addEventListener("click", () => togglePairDay(row.dataset.pairDate || ""));
  });
  body.querySelectorAll(".account-daily-pair-row[data-pair-id] [data-pair-action='replay']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      openRealizedPairReplay(button.closest("[data-pair-id]")?.dataset.pairId);
    });
  });
  body.querySelectorAll(".account-daily-pair-row[data-pair-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openRealizedPairReplay(row.dataset.pairId || "", { requireAvailable: true });
    });
  });
}

export function renderPairDetails() {
  const body = $("actualPairBody");
  if (!body) return;
  const pairDayStats = Array.isArray(currentAnalytics()?.pair_days) ? currentAnalytics().pair_days : [];
  if (!pairDayStats.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">尚無配對明細</td></tr>`;
    return;
  }
  const days = pairDays(pairDayStats);
  body.innerHTML = days.dates.map((date) => pairDayRowHtml(date, days)).join("");
  pairDayMotion.play();
  bindPairRows(body);
  bindPairReplayControls();
}
