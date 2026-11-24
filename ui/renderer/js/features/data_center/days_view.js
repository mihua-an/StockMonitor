// 資料中心's trading days, pure HTML: the day list beside the page, 最近的交易日, and one day's 資料 and 事件. A day's parts come
// from /api/data-center/dates and /date (what is stored), /api/training/days (its part in the models), and
// /api/monitor/event-counts and /events (Rust B's events). A value an answer does not have is "--", never 0.
import { escapeHtml, formatPercent } from "../../core/utility.js";
import { emptyStateRowHtml } from "../../core/load_state_view.js";
import { bytesText } from "../../core/diagnostics_format.js";
import { compactCount, int } from "../../core/job_status_view.js";
import { expandCellHtml } from "../../core/data_grid.js";
import { displayInstrumentName } from "../../core/instrument_names.js";
import { eventDisplayTime, eventFeedKey, eventInfoClass, renderEventInfoHtml } from "../../core/event_feed_format.js";
import { signedValueClass } from "../../core/market_color_policy.js";
import { closingStatusView, combinedResultView, resultView } from "./closing_status.js";

const RECENT_DAYS = 10;
const WEEKDAYS = "日一二三四五六";
const weekday = (date) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? "";
const monthDay = (date) => String(date).slice(5).replace("-", "/");
export const dayTitle = (date) => `${monthDay(date)}（週${weekday(date)}）`;
const badge = (text, tone = "") => `<span class="settings-badge${tone ? ` is-${tone}` : ""}">${escapeHtml(text)}</span>`;
const dash = (n) => (Number(n) > 0 ? int(n) : "--");

/** What is stored of a day, all markets together. */
export function dayStorage(day) {
  const usage = day?.storage?.ALL || {};
  const rows = usage.rows || {};
  return { products: Number(usage.products || 0), tick: Number(rows.tick || 0), bidask: Number(rows.bidask || 0), bytes: Number(usage.bytes || 0) };
}

/** 完整 of a day (台股日盤 only): "--" when it has no daily summary yet, not known. */
export function completeText(day) {
  return day?.complete === true ? "完整" : day?.complete === false ? "不完整" : "--";
}

function completeBadge(day) {
  const text = completeText(day);
  return text === "--" ? "--" : badge(text, day.complete ? "pass" : "warn");
}

/** The day list: every day, newest first, marked 今天, 完整 or 不完整. */
export function renderDayNav(days, today) {
  return days.map((day) => `<button class="settings-nav-item dc-day" type="button" data-day="${escapeHtml(day.date)}" data-morph-key="day-${escapeHtml(day.date)}">`
    + `<span>${monthDay(day.date)} ${weekday(day.date)}</span>${day.date === today ? badge("今天", "info") : day.complete == null ? "" : completeBadge(day)}</button>`).join("");
}

const USE = {
  train: { label: "訓練", tone: "pass", text: "訓練資料：最近一次訓練用了這天" },
  validation: { label: "驗證", tone: "info", text: "驗證資料：最近一次訓練用這天挑出上線的模型" },
  test: { label: "測試", tone: "warn", text: "測試資料：台股日盤不完整，只用於測試" },
};

/** A day's part in the models: { label, tone, text }. `info` is its /api/training/days entry (none: not used). */
export function dayUse(date, info, today) {
  if (USE[info?.use]) return USE[info.use];
  if (date === today) return { label: "今天", tone: "info", text: "收盤整理後成為新的交易日" };
  if (info?.next) return { label: "未使用", tone: "", text: "尚未用於訓練：下次訓練加入" };
  return { label: "未使用", tone: "", text: "不在最近的訓練範圍" };
}

/** The days 最近的交易日 lists: the newest stored ones. */
export const recentDays = (days) => days.filter((day) => dayStorage(day).products > 0).slice(0, RECENT_DAYS);

/** 最近的交易日. `counts` / `uses`: null until read (then "--"). */
export function renderRecentDays(days, { today, counts, uses }) {
  const stored = recentDays(days);
  if (!stored.length) return emptyStateRowHtml(7, "目前沒有日期統整資料");
  return stored.map((day) => {
    const usage = dayStorage(day);
    const use = uses ? dayUse(day.date, uses[day.date], today) : null;
    return `<tr class="record-expand-row" tabindex="0" role="button" data-open-day="${escapeHtml(day.date)}" data-morph-key="recent-${escapeHtml(day.date)}"><td><b>${dayTitle(day.date)}</b></td>`
      + `<td>${completeBadge(day)}</td><td>${int(usage.products)}</td><td>${int(usage.tick)}</td><td>${bytesText(usage.bytes) ?? "--"}</td>`
      + `<td>${counts ? int(counts[day.date]?.events ?? 0) : "--"}</td><td>${use ? badge(use.label, use.tone) : "--"}</td></tr>`;
  }).join("");
}

const tile = (label, value, tone = "") => `<div class="settings-tile"><div class="settings-tile-label">${label}</div><div class="settings-tile-value${tone ? ` ${tone}` : ""}">${value}</div></div>`;

export function renderDayTiles(day) {
  const usage = dayStorage(day);
  const stored = usage.products > 0;
  return tile("商品數", stored ? int(usage.products) : "--") + tile("成交筆數", stored ? compactCount(usage.tick) : "--")
    + tile("五檔筆數", stored ? compactCount(usage.bidask) : "--") + tile("資料大小", stored ? bytesText(usage.bytes) ?? "--" : "--");
}

// A date's categories in the backend's order (data_center_service CATEGORY_ORDER).
const CATEGORY = { taiex: "加權指數", futures: "期貨指數", industry: "產業指數", tse: "上市股票", otc: "上櫃股票", other: "其他" };
const SESSION_NAME = { DAY: "日盤", NIGHT: "夜盤" };
const rowsOf = (item) => Object.values(item.rows || {}).reduce((sum, n) => sum + Number(n || 0), 0);
const localMinute = (seconds) => {
  const at = new Date(Number(seconds) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return Number(seconds) > 0 ? `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` : "--";
};

/** A date's closes (what each was materialized into): 台股日盤, 指數, 期貨日盤, 期貨夜盤. */
export function renderDayClosing(categories) {
  const of = (...ids) => categories.filter((item) => ids.includes(item.id));
  const sessions = of("futures")[0]?.sessions || [];
  const closes = [["台股日盤", of("tse", "otc")], ["指數", of("taiex", "industry")],
    ["期貨日盤", sessions.filter((s) => s.id === "DAY")], ["期貨夜盤", sessions.filter((s) => s.id === "NIGHT")]].filter(([, items]) => items.length);
  const body = closes.map(([name, items]) => {
    const ledger = items[0].materialization;
    const result = combinedResultView(items);
    const done = ledger?.state === "succeeded";
    return `<tr><td>${name}</td><td>${escapeHtml(closingStatusView(ledger).text)}</td>`
      + `<td>${int(items.reduce((sum, item) => sum + Number(item.products || 0), 0))} 檔 · ${compactCount(items.reduce((sum, item) => sum + rowsOf(item), 0))} 筆</td>`
      + `<td>${result.tone ? badge(result.text, result.tone) : escapeHtml(result.text)}</td><td>${done ? localMinute(ledger.updated_at) : "--"}</td></tr>`;
  }).join("") || emptyStateRowHtml(5, "這天還沒有收盤整理");
  return `<table class="data-table dc-category-table"><thead><tr><th>物化</th><th>狀態</th><th>歷史資料</th><th>完整性</th><th>完成時間</th></tr></thead><tbody>${body}</tbody></table>`;
}

const closingCell = ({ text, tone }) => `<td>${tone ? badge(text, tone) : escapeHtml(text)}</td>`;
const countCells = (item) => `<td>${dash(item.products)}</td><td>${dash(item.rows?.tick)}</td><td>${dash(item.rows?.bidask)}</td>
  <td>${dash(item.rows?.quote)}</td><td>${bytesText(item.bytes) ?? "--"}</td>`;

// One category row; 期貨指數 opens to its 日盤 / 夜盤 rows.
function categoryRowsHtml(item) {
  const name = escapeHtml(CATEGORY[item.id] || item.id);
  const sessions = Array.isArray(item.sessions) ? item.sessions : [];
  if (!sessions.length) {
    return `<tr class="dc-category-row"><td><span class="record-expand-label"><b>${name}</b></span></td>${countCells(item)}${closingCell(resultView(item))}</tr>`;
  }
  return `<tr class="dc-category-row record-expand-row" data-dc-category="${escapeHtml(item.id)}" tabindex="0" role="button" aria-expanded="false">
      ${expandCellHtml(`<b>${name}</b>`)}${countCells(item)}${closingCell(combinedResultView(sessions))}</tr>
    ${sessions.map((session) => `<tr class="dc-session-row" data-row-detail data-dc-session-of="${escapeHtml(item.id)}" hidden>
      <td><span class="record-expand-label"><span class="dc-session-name">${escapeHtml(SESSION_NAME[session.id] || session.id)}</span></span></td>
      ${countCells(session)}${closingCell(resultView(session))}</tr>`).join("")}`;
}

export function renderDayCategories(categories) {
  const rows = categories.length ? categories.map(categoryRowsHtml).join("") : emptyStateRowHtml(7, "這天沒有資料");
  return `<div data-grid-variant="page"><table class="data-table dc-category-table">
      <thead><tr><th><span class="record-expand-label">類別</span></th><th>商品數</th><th>成交筆數</th><th>五檔筆數</th><th>報價筆數</th><th>資料大小</th><th>物化結果</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

const item = (label, text) => `<div class="settings-item"><span class="settings-item-main"><b>${label}</b><span class="settings-item-value">${escapeHtml(text)}</span></span></div>`;

/** A day's part in the models. `uses` null: not read yet. */
export function renderDayUse(date, uses, today) {
  if (!uses) return item("用途", "--");
  const info = uses[date];
  return item("用途", dayUse(date, info, today).text) + item("樣本", Number(info?.samples) > 0 ? `${int(info.samples)} 筆` : "--");
}

const slotName = (key) => {
  const match = /^(\d+)m_(up|down)$/.exec(String(key || ""));
  return match ? `${match[1]} 分${match[2] === "up" ? "上漲" : "下跌"}` : String(key || "");
};

/** How each live model did on the day: how often it called (probability at least a half) and how often it was right.
 * "" when none has a record of this day. */
export function renderDayModels(info) {
  const models = (info?.models || []).filter((model) => Number(model.samples) > 0)
    .sort((a, b) => (Number.parseInt(a.key, 10) - Number.parseInt(b.key, 10)) || (String(a.key).endsWith("_up") ? -1 : 1));
  if (!models.length) return "";
  const rate = (part, whole) => (Number(whole) > 0 ? formatPercent(Number(part) / Number(whole)) : "--");
  return `<table class="data-table dc-category-table"><thead><tr><th>上線模型</th><th>樣本</th><th>實際發生</th><th>模型預測會發生</th><th>命中率</th></tr></thead><tbody>${models.map((model) => (
    `<tr><td>${escapeHtml(slotName(model.key))}</td><td>${int(model.samples)}</td><td>${rate(model.positives, model.samples)}</td><td>${int(model.called)}</td><td>${rate(model.hits, model.called)}</td></tr>`)).join("")}</tbody></table>`;
}

/** 用到的交易日 of the latest run, and the days the next one adds. */
export function renderModelDays(uses) {
  if (!uses) return item("訓練", "--");
  const dates = Object.keys(uses).sort();
  const of = (part) => dates.filter((date) => uses[date].use === part);
  const range = (list) => (list.length > 1 ? `${monthDay(list[0])} – ${monthDay(list.at(-1))}` : list.length ? monthDay(list[0]) : "--");
  const samples = (list) => list.reduce((sum, date) => sum + Number(uses[date].samples || 0), 0);
  const row = (label, note, list) => `<div class="settings-item"><span class="settings-item-main"><b>${label}</b><span class="settings-item-value">${escapeHtml(note)}</span></span>`
    + `<span class="dc-item-number">${range(list)}${samples(list) ? ` · ${compactCount(samples(list))} 筆` : ""}</span></div>`;
  const train = of("train"), validation = of("validation"), test = of("test");
  const next = dates.filter((date) => !uses[date].use && uses[date].next);
  return row("訓練", `${train.length} 個完整交易日`, train) + row("驗證", `${validation.length} 個交易日`, validation)
    + row("測試", `${test.length} 個不完整日`, test) + row("尚未使用", next.length ? `下次訓練加入 ${next.length} 天` : "沒有", next);
}

export function renderEventTiles(events) {
  const count = (direction) => events.filter((event) => event.direction === direction).length;
  return tile("事件", int(events.length)) + tile("上漲事件", int(count("up")), signedValueClass(1)) + tile("下跌事件", int(count("down")), signedValueClass(-1))
    + tile("有事件的商品", int(new Set(events.map((event) => event.code)).size));
}

/** A day's events, newest first; `horizons`: the two the trend's footer shows. */
export function renderDayEvents(events, horizons) {
  const columns = horizons.flatMap((minutes) => [[`${minutes}m_up`, `${minutes} 分上漲`], [`${minutes}m_down`, `${minutes} 分下跌`]]);
  const head = ["時間", "股號", "股名", "事件", ...columns.map(([, name]) => name), ""];
  const body = events.length ? events.map((event) => {
    const time = eventDisplayTime(event);
    return `<tr data-morph-key="${escapeHtml(eventFeedKey(event))}"><td>${escapeHtml(time)}</td><td>${escapeHtml(event.code)}</td>`
      + `<td>${escapeHtml(displayInstrumentName("shioaji", event.code, event.name))}</td><td class="${eventInfoClass(event)}">${renderEventInfoHtml(event)}</td>`
      + columns.map(([key]) => `<td class="${key.endsWith("_up") ? "prediction-up" : "prediction-down"}">${formatPercent(event.model_predictions?.[key]?.probability)}</td>`).join("")
      + `<td><button class="settings-row-btn" type="button" data-replay-code="${escapeHtml(event.code)}" data-replay-time="${escapeHtml(time)}" aria-label="從 ${escapeHtml(time)} 回放 ${escapeHtml(event.code)}">`
      + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V6M4 18H20M7 14l4-4 3 3 5-6"></path></svg>回放</button></td></tr>`;
  }).join("") : emptyStateRowHtml(head.length, "這天沒有事件");
  return `<table class="data-table dc-category-table dc-events-table"><thead><tr>${head.map((name) => `<th>${name}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
