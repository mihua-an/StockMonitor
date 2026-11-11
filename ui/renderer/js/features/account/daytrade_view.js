// 帳務 當沖分析's view: the summary, mini report, period / weekday / band tables, the matrix, rankings and the direction
// report, drawn from the ledger's slice of the chosen mode (`<ledger>/daytrade-analysis`); this module selects and
// formats, and opens a group's pairs by the ids the slice gives. Replay placement is daytrade_replay_host.js.
import { ACCOUNT_DAYTRADE_DETAIL_COLUMNS } from "../../core/column_schemas.js";
import { loadStateHtml } from "../../core/load_state_view.js";
import { createExpandMotion } from "../../core/expand_motion.js";
import { applyStandardDataGrids, expandDetailRowHtml, recordExpandBody } from "../../core/data_grid.js";
import { applyColumnSchema, defineColumnSchema, renderColumnHeaderHtml } from "../../core/column_title.js";
import { $, escapeHtml } from "../../core/utility.js";
import { syncSegmented } from "../../core/settings_ui.js";
import { dailyActionIcon, formatMetricMoney, formatPercent, formatRatio, formatSignedMoney, formatTradePrice, profitClass } from "./account_format.js";
import { account, actualAccountDaytradeMetricSort, actualAccountScrollController, persistAccountSort } from "./account_state.js";
import { daytradeFormatHoldMinutes } from "./analytics.js";
import { metricCells } from "./home_summary_view.js";
import { pairReplayAvailable } from "./pair_replay.js";
import { bindDaytradeReplayActions, renderDaytradeReplayHost } from "./daytrade_replay_host.js";
import { daytradeAnalysis } from "./day_reads.js";
import { sortDaytradeMetricItems as sortDaytradeMetricItemsPolicy } from "./reports.js";

export function metricCellsCompact(item) {
  return `
    <td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td>
    <td>${formatPercent(item.win_rate)}</td>
    <td class="${profitClass(item.expectancy)}">${formatMetricMoney(item.expectancy)}</td>
    <td>${formatMetricMoney(item.avg_win)}</td>
    <td>${formatMetricMoney(item.avg_loss)}</td>
    <td>${item.win_count ?? 0}</td>
    <td>${item.loss_count ?? 0}</td>
    <td>${item.total_count ?? 0}</td>
  `;
}

export function daytradeMetricSortState(kind) {
  if (kind !== "hold" && kind !== "entry") return { key: "bucket_index", direction: "asc" };
  return actualAccountDaytradeMetricSort[kind];
}

/** The pairs a group of the slice names (its pair_ids), in the slice's order. */
export function slicePairs(slice, ids) {
  const byId = new Map((Array.isArray(slice?.pairs) ? slice.pairs : []).map((pair) => [String(pair.id), pair]));
  return (Array.isArray(ids) ? ids : []).map((id) => byId.get(String(id))).filter(Boolean);
}

export function sortDaytradeMetricItems(items, kind) {
  const state = daytradeMetricSortState(kind);
  return sortDaytradeMetricItemsPolicy(items, state);
}

export function renderMetricTable(bodyId, headId, items, firstLabel, bucketKind, slice) {
  const body = $(bodyId);
  const head = $(headId);
  if (!body) return;
  const sourceRows = Array.isArray(items) ? items : [];
  const rows = sortDaytradeMetricItems(sourceRows, bucketKind);
  const directional = account.daytradeMode !== "overview";
  const table = head?.closest("table") || body.closest("table");
  table?.classList.toggle("account-direction-filter-table", directional);
  table?.classList.add("account-daytrade-metric-table");

  const columns = directional
    ? [
        ["bucket_index", firstLabel],
        ["total_profit", "總收益"],
        ["win_rate", "勝率"],
        ["expectancy", "期望值"],
        ["avg_win", "平均獲利"],
        ["avg_loss", "平均虧損"],
        ["win_count", "獲利次數"],
        ["loss_count", "虧損次數"],
        ["total_count", "總次數"],
      ]
    : [
        ["bucket_index", firstLabel],
        ["total_profit", "總收益"],
        ["win_rate", "勝率"],
        ["expectancy", "期望值"],
        ["avg_win", "平均獲利"],
        ["avg_loss", "平均虧損"],
        ["long_profit", "多單收益"],
        ["short_profit", "空單收益"],
        ["win_count", "獲利次數"],
        ["loss_count", "虧損次數"],
        ["total_count", "總次數"],
      ];
  const columnCount = columns.length;
  if (head && table) {
    const sortable = bucketKind === "hold" || bucketKind === "entry";
    const schema = defineColumnSchema(columns.map(([key, label]) => ({
      id: key,
      title: label,
      sortKey: key,
      divider: false,
      sortable,
      resizable: false,
    })), { id: `accountDaytradeMetric:${bucketKind || "summary"}:${directional ? "direction" : "overview"}` });
    const state = daytradeMetricSortState(bucketKind);
    applyColumnSchema(table, schema, {
      schemaId: schema.schemaId,
      sortState: sortable ? { columnId: state.key, direction: state.direction } : null,
      onSort: sortable ? ({ sortKey, direction }) => {
        const same = state.key === sortKey;
        state.key = sortKey;
        state.direction = same ? direction : (sortKey === "bucket_index" ? "asc" : "desc");
        const prefix = bucketKind === "hold" ? "actualAccountDaytradeHold" : "actualAccountDaytradeEntry";
        persistAccountSort(prefix, state.key, state.direction);
        renderDaytradeAnalysis();
      } : null,
    });
  }

  body.innerHTML = rows.map((item) => {
    const bucketIndex = item.bucket_index;
    const clickable = Boolean(bucketKind);
    const selected = clickable
      && account.daytradeBucketSelection.kind === bucketKind
      && Number(account.daytradeBucketSelection.index) === bucketIndex;
    const attrs = clickable
      ? ` data-daytrade-bucket-kind="${escapeHtml(bucketKind)}" data-daytrade-bucket-index="${bucketIndex}"`
      : "";
    const metricRow = `<tr class="${clickable ? "account-daytrade-bucket-row" : ""} ${selected ? "active" : ""}"${attrs}><td>${escapeHtml(item.label)}</td>${directional ? metricCellsCompact(item) : metricCells(item, { profitClass, formatMetricMoney, formatPercent })}</tr>`;
    const motionKey = `${bucketKind}:${bucketIndex}`;
    if (!(selected || (clickable && bucketMotion.closing(motionKey)))) return metricRow;

    const selectedBucket = { rows: slicePairs(slice, item.pair_ids) };
    const detailRow = expandDetailRowHtml({ colspan: columnCount, attrs: `data-daytrade-bucket-detail="${escapeHtml(motionKey)}"`,
      contentHtml: `
          <div class="account-daytrade-bucket-detail account-daytrade-bucket-detail-inline">
            <div class="table-wrap finance-table-wrap account-daytrade-bucket-detail-wrap">
              <table class="data-table finance-table account-daytrade-bucket-detail-table">
                ${renderColumnHeaderHtml(ACCOUNT_DAYTRADE_DETAIL_COLUMNS)}
                <tbody>${daytradeBucketDetailRowsHtml(selectedBucket.rows)}</tbody>
              </table>
            </div>
            <div class="account-daytrade-bucket-replay-host" data-daytrade-bucket-replay-host></div>
          </div>` });
    return metricRow + detailRow;
  }).join("");
  // The band's trades are a grid of their own; split now, so the motion measures the block at its final height.
  applyStandardDataGrids(body);
  if (bucketKind) bucketMotion.play();
}

// A band's and a weekday's trades open and close with the shared expand motion; opening one closes the one that was
// open. A band's key is "<kind>:<index>".
const bucketMotion = createExpandMotion({
  find: (key) => recordExpandBody(document.querySelector(`tr[data-daytrade-bucket-detail="${CSS.escape(key)}"]`)),
  redraw: () => renderDaytradeAnalysis(),
  reveal: actualAccountScrollController.revealFrom((key) => {
    const [kind, index] = key.split(":");
    return document.querySelector(`[data-daytrade-bucket-kind="${CSS.escape(kind)}"][data-daytrade-bucket-index="${CSS.escape(index)}"]`);
  }),
});
const weekdayMotion = createExpandMotion({
  find: (weekday) => recordExpandBody(document.querySelector(`tr[data-daytrade-weekday-detail="${CSS.escape(weekday)}"]`)),
  redraw: () => renderDaytradeAnalysis(),
  reveal: actualAccountScrollController.revealFrom((weekday) => document.querySelector(`[data-daytrade-weekday="${CSS.escape(weekday)}"]`)),
});

/** Start the motions of switching an only-one-open selection from `previous` to `next` (either may be null); false
 * while one of them is still moving. */
function startSwitch(motion, previous, next) {
  const keys = [previous, next].filter((key) => key !== null);
  if (keys.some((key) => motion.busy(key))) return false;
  if (previous !== null) motion.start(previous, false);
  if (next !== null && next !== previous) motion.start(next, true);
  return true;
}

export function renderAnalysisSummary(targetId, metric, label = "當沖") {
  const box = $(targetId);
  if (!box) return;
  const tile = (name, value, valueClass = "") => `<div class="settings-tile"><div class="settings-tile-label">${name}</div>`
    + `<div class="settings-tile-value is-mid ${valueClass}">${value}</div></div>`;
  box.innerHTML = tile(`${escapeHtml(label)}總收益`, formatSignedMoney(metric?.total_profit), profitClass(metric?.total_profit))
    + tile("勝率", formatPercent(metric?.win_rate))
    + tile("盈虧比", formatRatio(metric?.profit_loss_ratio))
    + tile("平均獲利", formatMetricMoney(metric?.avg_win), profitClass(metric?.avg_win))
    + tile("平均虧損", formatMetricMoney(metric?.avg_loss), profitClass(metric?.avg_loss));
}

export function rankingRows(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows.length
    ? rows.map((item) => {
        const canReplay = pairReplayAvailable(item);
        return `<tr data-daytrade-replay-id="${escapeHtml(String(item.id ?? ""))}" class="${canReplay ? "account-daytrade-detail-replayable" : ""}"><td>${escapeHtml(item.realized_date)}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.direction || "-")}</td><td>${escapeHtml(item.entry_ref || "")}</td><td>${escapeHtml(item.exit_ref || "")}</td><td>${item.hold_period ?? "-"}</td><td class="${profitClass(item.profit)}">${formatMetricMoney(item.profit)}</td><td>${formatPercent(item.roi)}</td><td><button class="account-row-icon-btn" type="button" data-daytrade-replay-action aria-label="在排名下方展開歷史回放"${canReplay ? "" : " disabled"}>${dailyActionIcon("chart")}</button></td></tr>`;
      }).join("")
    : `<tr><td colspan="9" class="empty">尚無資料</td></tr>`;
}

export function renderDaytradeMiniReport(item, modeLabel) {
  const box = $("actualDaytradeMiniReport");
  if (!box) return;
  const metrics = [
    ["期望值", formatMetricMoney(item.expectancy), item.expectancy],
    ["盈虧比", formatRatio(item.payoff_ratio)],
    ["平均交易時間", daytradeFormatHoldMinutes(item.avg_hold)],
    ["平均交易成本", formatMetricMoney(item.avg_cost)],

    ["損益平衡勝率", formatPercent(item.breakeven_rate)],
    ["勝率差距", formatPercent(item.win_rate_gap), item.win_rate_gap],
    ["打平盈虧比", formatRatio(item.required_payoff_ratio)],
    ["盈虧比差距", formatRatio(item.payoff_gap), item.payoff_gap],

    ["平均獲利金額", formatMetricMoney(item.avg_win), item.avg_win],
    ["最大獲利金額", formatMetricMoney(item.biggest_win_amount), item.biggest_win_amount],
    ["平均虧損金額", formatMetricMoney(item.avg_loss), item.avg_loss],
    ["最大虧損金額", formatMetricMoney(item.biggest_loss_amount), item.biggest_loss_amount],

    ["平均獲利時間", daytradeFormatHoldMinutes(item.avg_win_hold)],
    ["最大獲利時間", daytradeFormatHoldMinutes(item.biggest_win_hold)],
    ["平均虧損時間", daytradeFormatHoldMinutes(item.avg_loss_hold)],
    ["最大虧損時間", daytradeFormatHoldMinutes(item.biggest_loss_hold)],

    ["交易次數", `${item.total_count || 0}`],
    ["目前勝率", formatPercent(item.win_rate)],
    ["獲利次數", `${item.win_count || 0}`],
    ["虧損次數", `${item.loss_count || 0}`],
  ];
  // Two columns of one figure per row, in the order above: the first half on the left.
  const itemHtml = ([label, value, profit]) => `<div class="settings-item"><span class="settings-item-main"><b>${escapeHtml(label)}</b></span>`
    + `<span class="account-item-number ${profit === undefined ? "" : profitClass(profit)}">${escapeHtml(String(value ?? "-"))}</span></div>`;
  const half = Math.ceil(metrics.length / 2);
  box.innerHTML = [metrics.slice(0, half), metrics.slice(half)]
    .map((column) => `<div class="settings-group">${column.map(itemHtml).join("")}</div>`).join("");
  box.setAttribute("aria-label", `${modeLabel}數據小報表`);
}

export function daytradePeriodTableHtml(items, firstLabel) {
  const directional = account.daytradeMode !== "overview";
  const rows = Array.isArray(items) ? items : [];
  const labels = directional
    ? [firstLabel, "總收益", "勝率", "期望值", "平均獲利", "平均虧損", "總次數"]
    : [firstLabel, "當沖實現", "多單實現", "空單實現", "當沖勝率", "多單勝率", "空單勝率", "總次數"];
  const schema = defineColumnSchema(labels.map((title, index) => ({
    id: index === 0 ? "period" : `metric_${index}`,
    title,
    divider: false,
    sortable: false,
    resizable: false,
  })), { id: `accountDaytradePeriod:${directional ? "direction" : "overview"}` });
  const header = renderColumnHeaderHtml(schema);
  if (directional) {
    return `
      <table class="data-table finance-table account-daytrade-period-table">
        ${header}
        <tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td><td>${formatPercent(item.win_rate)}</td><td class="${profitClass(item.expectancy)}">${formatMetricMoney(item.expectancy)}</td><td>${formatMetricMoney(item.avg_win)}</td><td>${formatMetricMoney(item.avg_loss)}</td><td>${item.total_count || 0}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">尚無資料</td></tr>`}</tbody>
      </table>`;
  }

  return `
    <table class="data-table finance-table account-daytrade-period-table account-daytrade-period-overview-table">
      ${header}
      <tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td><td class="${profitClass(item.long_profit)}">${formatMetricMoney(item.long_profit)}</td><td class="${profitClass(item.short_profit)}">${formatMetricMoney(item.short_profit)}</td><td>${formatPercent(item.win_rate)}</td><td>${formatPercent(item.long_win_rate)}</td><td>${formatPercent(item.short_win_rate)}</td><td>${item.total_count || 0}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">尚無資料</td></tr>`}</tbody>
    </table>`;
}

export function renderDaytradePeriodReports(periods) {
  const weekBox = $("actualDaytradeWeekPeriod");
  const monthBox = $("actualDaytradeMonthPeriod");
  if (weekBox) weekBox.innerHTML = daytradePeriodTableHtml(periods?.week, "交易週次");
  if (monthBox) monthBox.innerHTML = daytradePeriodTableHtml(periods?.month, "交易月份");
}

export function weekdayMetricRowCells(item) {
  if (account.daytradeMode !== "overview") {
    const directionLabel = account.daytradeMode === "long" ? "多單" : "空單";
    return `
      <td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td>
      <td>${formatPercent(item.win_rate)}</td>
      <td class="${profitClass(item.expectancy)}">${formatMetricMoney(item.expectancy)}</td>
      <td>${formatRatio(item.profit_loss_ratio)}</td>
      <td>${formatPercent(item.win_rate)}</td>
      <td>${formatPercent(item.return_rate)}</td>
      <td>${item.win_count || 0}</td>
      <td>${item.loss_count || 0}</td>
      <td>${item.total_count || 0}</td>`;
  }

  return `
    <td class="${profitClass(item.total_profit)}">${formatMetricMoney(item.total_profit)}</td>
    <td>${formatPercent(item.win_rate)}</td>
    <td class="${profitClass(item.expectancy)}">${formatMetricMoney(item.expectancy)}</td>
    <td>${formatRatio(item.profit_loss_ratio)}</td>
    <td class="${profitClass(item.long_profit)}">${formatMetricMoney(item.long_profit)}</td>
    <td>${formatPercent(item.long_win_rate)}</td>
    <td class="${profitClass(item.short_profit)}">${formatMetricMoney(item.short_profit)}</td>
    <td>${formatPercent(item.short_win_rate)}</td>
    <td>${item.total_count || 0}</td>`;
}

export function renderDaytradeWeekdayReport(slice) {
  const head = $("actualDaytradeWeekdayHead");
  const body = $("actualDaytradeWeekdayBody");
  if (!head || !body) return;

  const directional = account.daytradeMode !== "overview";
  const directionLabel = account.daytradeMode === "long" ? "多單" : "空單";
  const weekdayLabels = directional
    ? ["星期", "淨損益", "勝率", "期望值", "盈虧比", `${directionLabel}勝率`, `${directionLabel}報酬率`, "獲利次數", "虧損次數", "總次數"]
    : ["星期", "淨損益", "勝率", "期望值", "盈虧比", "多單", "多單勝率", "空單", "空單勝率", "總次數"];
  const weekdaySchema = defineColumnSchema(weekdayLabels.map((title, index) => ({
    id: `weekday_${index}`, title, divider: false, sortable: false, resizable: false,
  })), { id: `accountDaytradeWeekday:${directional ? "direction" : "overview"}` });
  applyColumnSchema(head.closest("table"), weekdaySchema, { schemaId: weekdaySchema.schemaId });
  const colCount = 10;
  const items = Array.isArray(slice?.weekdays) ? slice.weekdays : [];

  body.innerHTML = items.map((item) => {
    const selected = account.daytradeWeekdaySelection !== null && Number(account.daytradeWeekdaySelection) === Number(item.weekday);
    const mainRow = `<tr class="account-daytrade-weekday-row ${selected ? "active" : ""}" data-daytrade-weekday="${item.weekday}"><td>${escapeHtml(item.label)}</td>${weekdayMetricRowCells(item)}</tr>`;
    if (!selected && !weekdayMotion.closing(String(item.weekday))) return mainRow;
    return mainRow + expandDetailRowHtml({ colspan: colCount, attrs: `data-daytrade-weekday-detail="${item.weekday}"`,
      contentHtml: `
          <div class="account-daytrade-weekday-detail">
            <div class="table-wrap finance-table-wrap account-daytrade-weekday-detail-wrap">
              <table class="data-table finance-table account-daytrade-bucket-detail-table">
                ${renderColumnHeaderHtml(ACCOUNT_DAYTRADE_DETAIL_COLUMNS)}
                <tbody>${daytradeBucketDetailRowsHtml(slicePairs(slice, item.pair_ids))}</tbody>
              </table>
            </div>
          </div>` });
  }).join("");
  applyStandardDataGrids(body);
  weekdayMotion.play();
}

export function bindDaytradeWeekdayActions() {
  document.querySelectorAll("[data-daytrade-weekday]").forEach((row) => {
    row.addEventListener("click", () => {
      const weekday = Number(row.dataset.daytradeWeekday);
      const previous = account.daytradeWeekdaySelection === null ? null : Number(account.daytradeWeekdaySelection);
      const next = previous === weekday ? null : weekday;
      if (!startSwitch(weekdayMotion, previous === null ? null : String(previous), next === null ? null : String(next))) return;
      account.daytradeWeekdaySelection = next;
      renderDaytradeAnalysis();
    });
  });
}

export function daytradeBucketDetailRowsHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return `<tr><td colspan="12" class="empty">這個區間沒有交易</td></tr>`;
  }
  return list.map((item) => {
    const canReplay = pairReplayAvailable(item);
    return `<tr data-daytrade-replay-id="${escapeHtml(String(item.id ?? ""))}" class="${canReplay ? "account-daytrade-detail-replayable" : ""}">
      <td>${escapeHtml(item.realized_date)}</td>
      <td>${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name || "")}</td>
      <td>${escapeHtml(item.direction || "-")}</td>
      <td>${escapeHtml(item.entry_ref || "")}</td>
      <td>${escapeHtml(item.exit_ref || "")}</td>
      <td>${item.hold_period ?? "-"}</td>
      <td class="${profitClass(item.profit)}">${formatMetricMoney(item.profit)}</td>
      <td>${formatPercent(item.roi)}</td>
      <td>${formatTradePrice(item.buy_price, item.market)}</td>
      <td>${formatTradePrice(item.sell_price, item.market)}</td>
      <td><button class="account-row-icon-btn" type="button" data-daytrade-replay-action aria-label="展開這筆交易的走勢圖"${canReplay ? "" : " disabled"}>${dailyActionIcon("chart")}</button></td>
    </tr>`;
  }).join("");
}

export function bindDaytradeBucketActions() {
  document.querySelectorAll("[data-daytrade-bucket-kind][data-daytrade-bucket-index]").forEach((row) => {
    row.addEventListener("click", () => {
      const kind = String(row.dataset.daytradeBucketKind || "");
      const index = Number(row.dataset.daytradeBucketIndex);
      const current = account.daytradeBucketSelection;
      const previous = current.kind && current.index !== null ? `${current.kind}:${Number(current.index)}` : null;
      const same = previous === `${kind}:${index}`;
      if (!startSwitch(bucketMotion, previous, same ? null : `${kind}:${index}`)) return;
      account.daytradeBucketSelection = same
        ? { kind: "", index: null }
        : { kind, index };
      renderDaytradeAnalysis();
    });
  });
}

export function renderDirectionReport(slice) {
  const card = $("actualDirectionReportCard");
  const title = $("actualDirectionReportTitle");
  const count = $("actualDirectionReportCount");
  const body = $("actualDirectionReportBody");
  if (!card || !body) return;

  card.hidden = false;
  const rows = Array.isArray(slice?.pairs) ? slice.pairs : [];
  const label = account.daytradeMode === "long"
    ? "多單交易明細"
    : account.daytradeMode === "short"
      ? "空單交易明細"
      : "當沖交易明細";
  if (title) title.textContent = label;
  if (count) count.textContent = "收益%";

  body.innerHTML = rows.length ? rows.map((item) => {
    const canReplay = pairReplayAvailable(item);
    return `<tr data-daytrade-replay-id="${escapeHtml(String(item.id ?? ""))}" class="${canReplay ? "account-daytrade-report-replayable" : ""}">
      <td>${escapeHtml(item.realized_date)}</td>
      <td>${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name || "")}</td>
      <td>${escapeHtml(item.entry_ref || "")}</td>
      <td>${escapeHtml(item.exit_ref || "")}</td>
      <td>${item.hold_period ?? "-"}</td>
      <td>${escapeHtml(item.direction || "-")}</td>
      <td>${formatTradePrice(item.buy_price, item.market)}</td>
      <td>${formatTradePrice(item.sell_price, item.market)}</td>
      <td class="${profitClass(item.profit)}">${formatMetricMoney(item.profit)}</td>
      <td>${formatPercent(item.roi)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="11" class="empty">尚無${label.replace("交易明細", "")}資料</td></tr>`;
}

// Until the market's 當沖分析 is read, every section says so instead of showing the last market's or mode's figures.
function renderDaytradeReadState(read) {
  const placeholder = loadStateHtml(read.state, read.error);
  ["actualDayTradeSummary", "actualDaytradeMiniReport", "actualDaytradeWeekPeriod", "actualDaytradeMonthPeriod"].forEach((id) => {
    const box = $(id);
    if (box) box.innerHTML = id === "actualDayTradeSummary" ? placeholder : "";
  });
  ["actualDaytradeWeekdayBody", "actualHoldTimeBody", "actualEntryTimeBody", "actualMatrixBody", "actualTopLossBody", "actualTopWinBody", "actualDirectionReportBody"].forEach((id) => {
    const body = $(id);
    if (body) body.innerHTML = "";
  });
}

export function renderDaytradeAnalysis() {
  const read = daytradeAnalysis(account.market, account.daytradeMode, () => renderDaytradeAnalysis());
  if (read.state !== "ready") {
    renderDaytradeReadState(read);
    return;
  }
  const slice = read.data;
  const modeLabel = slice.label;

  document.querySelectorAll(".account-daytrade-tabs [data-daytrade-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.daytradeMode === account.daytradeMode);
  });
  syncSegmented(document.querySelector(".account-daytrade-tabs"));

  renderAnalysisSummary("actualDayTradeSummary", slice.summary, modeLabel);
  renderDaytradeMiniReport(slice.mini_report, modeLabel);
  renderDaytradePeriodReports(slice.periods);
  renderDaytradeWeekdayReport(slice);
  renderMetricTable("actualHoldTimeBody", "actualHoldTimeHead", slice.hold_time || [], "持有時間", "hold", slice);
  renderMetricTable("actualEntryTimeBody", "actualEntryTimeHead", slice.entry_time || [], "進場時間", "entry", slice);

  const head = $("actualMatrixHead");
  const body = $("actualMatrixBody");
  const matrix = slice.matrix || {};
  if (head) {
    const matrixSchema = defineColumnSchema(["收益", ...(matrix.columns || [])].map((title, index) => ({
      id: index === 0 ? "yield" : `bucket_${index}`,
      title,
      divider: false,
      sortable: false,
      resizable: false,
    })), { id: "accountDaytradeMatrix" });
    applyColumnSchema(head.closest("table"), matrixSchema, { schemaId: matrixSchema.schemaId });
  }
  if (body) body.innerHTML = (matrix.rows || []).map((row) => `<tr><th>${escapeHtml(row.label)}</th>${(row.values || []).map((value, index) => `<td class="${value === null ? "" : profitClass(value)}">${value === null ? "-" : formatMetricMoney(value)}</td>`).join("")}</tr>`).join("");

  if ($("actualTopLossBody")) $("actualTopLossBody").innerHTML = rankingRows(slicePairs(slice, slice.top_losses));
  if ($("actualTopWinBody")) $("actualTopWinBody").innerHTML = rankingRows(slicePairs(slice, slice.top_wins));
  renderDirectionReport(slice);
  renderDaytradeReplayHost();
  bindDaytradeReplayActions(slice);
  bindDaytradeBucketActions();
  bindDaytradeWeekdayActions();
  actualAccountScrollController.syncStickyMetrics();
}
