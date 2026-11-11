// 手機卡片: the phone's Scriptable widgets, drawn on the desktop from the same package the desktop publishes to GAS
// (service/account/mobile_api.py::build_bundle, read through GET /api/actual-account/mobile-preview).
//
// The package holds every answer the phone can ask for; the two that depend on the day the phone asks
// (historyTrade, dayTradeEntryTime) are picked here the way integrations/gas_web_app/Mobile.gs picks them.
// Rates in the package are fractions (0.5 = 50%); amounts are numbers, "-" or "" when there is nothing.

import { morphInto } from "../../core/dom_morph.js";
import { syncSegmented } from "../../core/settings_ui.js";
import { escapeHtml } from "../../core/utility.js";

const WEEKDAY_LABELS = { 1: "週一", 2: "週二", 3: "週三", 4: "週四", 5: "週五" };
const RANK_KINDS = [["spot", "現股"], ["daytrade", "當沖"], ["us", "美股"]];
const REPORT_PERIODS = [["day", "日"], ["week", "週"], ["month", "月"]];

const state = { historyDate: "", entryTime: "first", rankSide: { spot: "profit", daytrade: "profit", us: "profit" }, period: "day" };

function blank(value) {
  return value === "" || value === null || value === undefined || value === "-";
}

function money(value) {
  if (blank(value)) return "-";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(value);
}

function rate(value, digits = 1) {
  if (blank(value)) return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : String(value);
}

function tone(value, profitClass) {
  return blank(value) ? "" : profitClass(value);
}

function cell(value, profitClass) {
  return `<td class="${tone(value, profitClass)}">${escapeHtml(money(value))}</td>`;
}

function table(headers, rows, emptyText = "沒有資料", tableClass = "") {
  const head = headers.map((label) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = rows.length ? rows.join("") : `<tr><td class="mobile-card-empty" colspan="${headers.length}">${escapeHtml(emptyText)}</td></tr>`;
  return `<table class="mobile-card-table lined-rows ${tableClass}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function card(title, body, { tabs = "", wide = false, note = "" } = {}) {
  return `<section class="mobile-card${wide ? " mobile-card-wide" : ""}">
    <header class="mobile-card-header"><h4>${escapeHtml(title)}</h4>${tabs}</header>
    ${body}
    ${note ? `<div class="mobile-card-note">${escapeHtml(note)}</div>` : ""}
  </section>`;
}

function tabButtons(group, options, current) {
  return `<div class="settings-seg" role="group">${options.map(([value, label]) =>
    `<button type="button" class="settings-seg-btn${value === current ? " is-active" : ""}" data-mobile-tab="${escapeHtml(group)}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
  ).join("")}</div>`;
}

// ---- 交易總覽 / 庫存總覽

function summaryCard(summary, profitClass) {
  if (!summary) return card("交易總覽", '<div class="mobile-card-empty">沒有資料</div>');
  const rows = [
    ["庫存總成本", summary.holdingCost], ["現股已實現", summary.stockProfit], ["當沖已實現", summary.daytradingProfit],
    ["當沖日目標", summary.dayTarget], ["當沖週目標", summary.weekTarget], ["當沖月目標", summary.monthTarget],
  ];
  return card("交易總覽", `<dl class="mobile-card-list">${rows.map(([label, value]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${tone(value, profitClass)}">${escapeHtml(money(value))}</dd></div>`).join("")}</dl>`);
}

function holdingsCard(holdings) {
  const items = holdings?.activeHoldings || [];
  const rows = items.map((item) => `<tr><td>${escapeHtml(item.name || item.code)}<small>${escapeHtml(item.code)}</small></td>
    <td>${escapeHtml(money(item.shares))}</td><td>${escapeHtml(money(item.costPerShare))}</td><td>${escapeHtml(money(item.valH))}</td></tr>`);
  return card("庫存總覽", table(["股名", "股數", "成本", "總成本"], rows, "沒有庫存"),
    { note: "股價、未實現與報酬率由手機開啟時即時抓價；電腦上請看「庫存」頁。" });
}

// ---- 交易明細 (historyTrade, one per recent weekday)

function historyDates(entries) {
  return Object.keys(entries).filter((key) => key.startsWith("historyTrade:")).map((key) => key.slice("historyTrade:".length)).sort().reverse();
}

function dateLabel(text, index) {
  const parsed = new Date(`${text.replaceAll("/", "-")}T00:00:00`);
  const weekday = WEEKDAY_LABELS[((parsed.getDay() + 6) % 7) + 1] || "";
  const prefix = index === 0 ? "今日 " : index === 1 ? "昨日 " : "";
  return `${prefix}${text.slice(5)} ${weekday}`;
}

function historyCard(entries, profitClass) {
  const dates = historyDates(entries);
  if (!dates.includes(state.historyDate)) state.historyDate = dates[0] || "";
  const options = dates.map((text, index) => `<option value="${escapeHtml(text)}"${text === state.historyDate ? " selected" : ""}>${escapeHtml(dateLabel(text, index))}</option>`).join("");
  const picker = `<select class="search mobile-card-select" data-mobile-select="historyDate">${options}</select>`;
  const data = entries[`historyTrade:${state.historyDate}`];
  if (!data) return card("交易明細", '<div class="mobile-card-empty">沒有資料</div>', { tabs: picker, wide: true });

  const day = (data.dayTrade?.items || []).map((item) => `<tr><td>${escapeHtml(item.name || item.code)}<small>${escapeHtml(item.code)}</small></td>
    <td>${escapeHtml(item.direction || "")}</td><td>${escapeHtml(money(item.volume))}</td><td>${escapeHtml(money(item.buyPrice))}</td>
    <td>${escapeHtml(money(item.sellPrice))}</td><td>${escapeHtml(item.buyTime || "")}</td><td>${escapeHtml(item.sellTime || "")}</td>${cell(item.profit, profitClass)}</tr>`);
  const normal = (items) => items.map((item) => `<tr><td>${escapeHtml(item.name || item.code)}<small>${escapeHtml(item.code)}</small></td>
    <td>${escapeHtml(item.type)}</td><td>${escapeHtml(money(item.volume))}</td><td>${escapeHtml(money(item.buyPrice))}</td>
    <td>${escapeHtml(money(item.sellPrice))}</td><td>${escapeHtml(item.buyDate || "")}</td>${cell(item.type === "買進" ? item.settlement : item.profit, profitClass)}</tr>`);
  const section = (title, total, body) => `<div class="mobile-card-subtitle"><span>${escapeHtml(title)}</span><b class="${tone(total, profitClass)}">${escapeHtml(money(total))}</b></div>${body}`;
  const body = [
    `<div class="mobile-card-total">總計交割 <b class="${tone(data.totalSettlement, profitClass)}">${escapeHtml(money(data.totalSettlement))}</b></div>`,
    section("當沖", data.dayTrade?.profit, table(["股名", "多空", "股數", "買價", "賣價", "買時", "賣時", "收益"], day, "沒有當沖")),
    section("一般", data.normalTrade?.profit, table(["股名", "買賣", "股數", "買價", "賣價", "買日", "收益／交割"], normal(data.normalTrade?.items || []), "沒有一般交易")),
    section("美股", data.usTrade?.profit, table(["股名", "買賣", "股數", "買價", "賣價", "買日", "收益／交割"], normal(data.usTrade?.items || []), "沒有美股交易")),
  ].join("");
  return card("交易明細", body, { tabs: picker, wide: true, note: "買進列顯示的是交割金額（負數＝付出）。" });
}

// ---- 當沖分析

function rateRow(label, item, profitClass) {
  return `<tr><td>${escapeHtml(label)}</td>${cell(item.totalProfit, profitClass)}<td>${escapeHtml(rate(item.winRate))}</td>
    <td>${escapeHtml(rate(item.longWinRate))}</td><td>${escapeHtml(rate(item.shortWinRate))}</td>${cell(item.longProfit, profitClass)}${cell(item.shortProfit, profitClass)}</tr>`;
}

const RATE_HEADERS = ["當沖收益", "當沖勝率", "多單勝率", "空單勝率", "多單收益", "空單收益"];

function weekSummaryCard(data, profitClass) {
  const rows = (data?.items || []).map((item) => rateRow(`週${item.weekday}`, item, profitClass));
  const totals = data ? `<div class="mobile-card-total">整體當沖勝率 <b>${escapeHtml(rate(data.dayTradeWinRate))}</b>｜多單 <b>${escapeHtml(rate(data.dayTradeLongWinRate))}</b>｜空單 <b>${escapeHtml(rate(data.dayTradeShortWinRate))}</b></div>` : "";
  return card("當沖週結明細", totals + table(["星期", ...RATE_HEADERS], rows));
}

function priceSummaryCard(data, profitClass) {
  const rows = (data?.items || []).map((item) => rateRow(item.range, item, profitClass));
  return card("當沖價格勝率表", table(["價格區間", ...RATE_HEADERS], rows));
}

// Mobile.gs mobileTargetWeekdays_: the weekend and Monday look at Monday and Tuesday, Friday at Friday and Monday,
// any other day at itself and the next day.
function targetWeekdays(today) {
  const weekday = ((today.getDay() + 6) % 7) + 1;
  if (weekday >= 6 || weekday === 1) return [1, 2];
  if (weekday === 5) return [5, 1];
  return [weekday, weekday + 1];
}

function entryTimeCard(entries, today, profitClass) {
  const [first, second] = targetWeekdays(today);
  const options = [["first", WEEKDAY_LABELS[first]], ["second", WEEKDAY_LABELS[second]], ["week", "整週"]];
  const key = state.entryTime === "first" ? `dayTradeEntryTime:${first}` : state.entryTime === "second" ? `dayTradeEntryTime:${second}` : "dayTradeEntryTime:week";
  const data = entries[key];
  const rows = (data?.items || []).map((item) => rateRow(item.timeRange, item, profitClass));
  const totals = data ? `<div class="mobile-card-total">多單勝率 <b>${escapeHtml(rate(data.summary?.longWinRate))}</b>｜空單勝率 <b>${escapeHtml(rate(data.summary?.shortWinRate))}</b></div>` : "";
  return card(`${data?.weekdayLabel || ""} 當沖時間勝率`, totals + table(["進場時間", ...RATE_HEADERS], rows),
    { tabs: tabButtons("entryTime", options, state.entryTime) });
}

// ---- 排名 / 已實現報表

function rankCard(entries, kind, label, profitClass) {
  const side = state.rankSide[kind];
  const data = entries[`rank:${kind}:${side}`];
  const rows = (data?.data || []).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.name || item.code)}<small>${escapeHtml(item.code)}</small></td>
    ${cell(item.profit, profitClass)}<td class="${tone(item.rate, profitClass)}">${escapeHtml(rate(item.rate, 2))}</td></tr>`);
  return card(`${label}排名`, table(["#", "股名", "已實現", "報酬率"], rows, "沒有資料", "mobile-card-table-rank"),
    { tabs: tabButtons(`rank:${kind}`, [["profit", "賺錢"], ["loss", "賠錢"]], side) });
}

function reportCard(entries, profitClass) {
  const data = entries[`realizedReport:${state.period}`];
  const rows = (data?.items || []).map((item) => `<tr><td>${escapeHtml(item.date)}</td>${cell(item.spotRealized, profitClass)}${cell(item.dayTradeRealized, profitClass)}
    ${cell(item.stockRealized, profitClass)}${cell(item.spotAccumulated, profitClass)}${cell(item.dayTradeAccumulated, profitClass)}${cell(item.recentDayTradeAccumulated, profitClass)}</tr>`);
  const title = `${REPORT_PERIODS.find(([value]) => value === state.period)?.[1] || "日"}實現報表`;
  return card(title, table(["期間", "現股實現", "當沖實現", "股票實現", "現股累積", "當沖累積", "近期累積"], rows),
    { tabs: tabButtons("period", REPORT_PERIODS, state.period), wide: true });
}

function group(title, cards, gridClass = "") {
  return `<div class="mobile-card-group"><h3>${escapeHtml(title)}</h3><div class="mobile-card-grid ${gridClass}">${cards.join("")}</div></div>`;
}

/** The markup of every card from a mobile-preview payload, at the current choices. */
export function mobileCardsMarkup(payload, { profitClass, today = new Date() } = {}) {
  const entries = payload?.entries || {};
  return [
    group("總覽", [summaryCard(entries.summary, profitClass), holdingsCard(entries.holdings)]),
    group("交易明細", [historyCard(entries, profitClass)]),
    group("當沖分析", [weekSummaryCard(entries.dayTradeWeekSummary, profitClass), priceSummaryCard(entries.dayTradePriceSummary, profitClass), entryTimeCard(entries, today, profitClass)], "mobile-card-grid-roomy"),
    group("排名", RANK_KINDS.map(([kind, label]) => rankCard(entries, kind, label, profitClass))),
    group("已實現報表", [reportCard(entries, profitClass)]),
  ].join("");
}

/** One card's choice (a tab group or the date picker), read by the next `mobileCardsMarkup`. */
export function chooseMobileCardOption(name, value) {
  if (name.startsWith("rank:")) state.rankSide[name.slice(5)] = value;
  else state[name] = value;
}

/** Draws every card into `container`. A choice re-draws in place: the segmented controls stay, so their background slides. */
export function renderMobileCards(container, payload, options = {}) {
  if (!container) return;
  morphInto(container, mobileCardsMarkup(payload, options));
  container.querySelectorAll(".settings-seg").forEach(syncSegmented);
  const choose = (name, value) => {
    chooseMobileCardOption(name, value);
    renderMobileCards(container, payload, options);
  };
  container.onclick = (event) => {
    const tab = event.target.closest?.("[data-mobile-tab]");
    if (tab) choose(tab.dataset.mobileTab, tab.dataset.value);
  };
  container.onchange = (event) => {
    const select = event.target.closest?.("[data-mobile-select]");
    if (select) choose(select.dataset.mobileSelect, select.value);
  };
}
