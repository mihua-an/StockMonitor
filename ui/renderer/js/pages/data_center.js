import { apiGetOk } from "../core/api.js";
import { runUiTask } from "../core/ui_task.js";
import { $, escapeHtml } from "../core/utility.js";
import { expandCellHtml, expandDetailRowHtml, recordExpandBody } from "../core/data_grid.js";
import { emptyStateRowHtml, loadStateHtml, loadStateRowHtml } from "../core/load_state_view.js";
import { createExpandMotion } from "../core/expand_motion.js";
import { userFacingMessage } from "../core/user_action.js";
import { resultView, combinedResultView } from "../features/data_center/closing_status.js";
import { bytesText } from "../core/diagnostics_format.js";
import { morphInto } from "../core/dom_morph.js";
import { syncSegmented } from "../core/settings_ui.js";
import { createJobLogToggle } from "../core/job_log_toggle.js";
import { int } from "../core/job_status_view.js";
import { closingPollMs, renderClosingBar, renderClosingHistory, renderClosingLog, renderClosingSteps, loggedClose } from "../features/data_center/closing_progress_view.js";
import { createClosingClock } from "../features/data_center/closing_clock.js";

let selectedMarket = "";
let dailySummaries = [];
const dailyDetailCache = new Map();
let dataCenterGeneration = 0;

// 每日資料總覽: a day is judged by whether it is 完整 (every stock's ticks reconcile with the exchange's cumulative
// volume -- only such a day is trained on in 模型中心, any other is test data only), how many records it holds, its
// industry indexes' records (產業筆數) and how much disk its raw data takes. The backend sums the records per market and
// for all markets ("ALL"); the market filter picks one.
const DAILY_COLUMNS = 8;
const CATEGORY_COLUMNS = 7;

// A date's categories in the backend's order (data_center_service CATEGORY_ORDER), and the market each belongs to for
// the market filter.
const CATEGORY = {
  taiex: { name: "加權指數", market: "IDX" },
  futures: { name: "期貨指數", market: "FUT" },
  industry: { name: "產業指數", market: "IDX" },
  tse: { name: "上市股票", market: "STK" },
  otc: { name: "上櫃股票", market: "STK" },
  other: { name: "其他", market: "" },
};
const SESSION_NAME = { DAY: "日盤", NIGHT: "夜盤" };

function dailyStorage(row = {}) {
  const usage = row?.storage?.[selectedMarket || "ALL"] || {};
  const rows = usage.rows || {};
  return { products: Number(usage.products || 0), tick: Number(rows.tick || 0), bidask: Number(rows.bidask || 0),
    quote: Number(rows.quote || 0), industry: Number(usage.industry_index_rows || 0), bytes: Number(usage.bytes || 0) };
}

// 完整 of a day: "--" when the day has no daily summary yet (not known, so not trained on either).
function completeCell(complete) {
  if (complete === true) return `<span class="settings-badge is-pass">完整</span>`;
  if (complete === false) return `<span class="settings-badge is-warn">不完整</span>`;
  return "--";
}

function renderDailyOverview(items = []) {
  const body = $("dataCenterDailyRows");
  if (!body) return;
  const rows = items.filter((row) => dailyStorage(row).products > 0);
  if (!rows.length) {
    body.innerHTML = emptyStateRowHtml(DAILY_COLUMNS, "目前沒有日期統整資料");
    return;
  }
  body.innerHTML = rows.map((row) => {
    const usage = dailyStorage(row);
    return `<tr class="dc-daily-row record-expand-row" data-dc-date="${escapeHtml(row.date)}" tabindex="0" role="button" aria-expanded="false">
      ${expandCellHtml(`<b>${escapeHtml(row.date)}</b>`)}<td>${completeCell(row.complete)}</td>
      <td>${int(usage.products)}</td><td>${int(usage.tick)}</td><td>${int(usage.bidask)}</td><td>${int(usage.quote)}</td>
      <td>${int(usage.industry)}</td><td>${bytesText(usage.bytes) ?? "--"}</td>
    </tr>${expandDetailRowHtml({ colspan: DAILY_COLUMNS, open: false, className: "dc-date-detail-row",
      attrs: `data-dc-date-detail="${escapeHtml(row.date)}"`, contentHtml: `<div class="dc-date-detail-content"></div>` })}`;
  }).join("");

  const mainRow = (date) => [...body.querySelectorAll(".dc-daily-row")].find((row) => row.dataset.dcDate === date);
  const detailRow = (date) => [...body.querySelectorAll(".dc-date-detail-row")].find((row) => row.dataset.dcDateDetail === date);
  // A day's detail opens and closes with the shared expand motion; a closed one is hidden once its motion ends.
  const dateMotion = createExpandMotion({
    find: (date) => recordExpandBody(detailRow(date)),
    redraw: () => body.querySelectorAll(".dc-date-detail-row").forEach((detail) => {
      detail.hidden = !mainRow(detail.dataset.dcDateDetail)?.classList.contains("expanded");
    }),
    reveal: (date, node) => ({ first: mainRow(date), last: node.closest("tr") || node }),
  });

  const toggleDate = async (date) => {
    const generation = dataCenterGeneration;
    const main = mainRow(date);
    const detail = detailRow(date);
    if (!main || !detail) return;
    const opening = !main.classList.contains("expanded");
    if (!dateMotion.start(date, opening)) return;
    if (opening) detail.hidden = false;
    main.classList.toggle("expanded", opening);
    main.setAttribute("aria-expanded", String(opening));
    dateMotion.play();
    if (!opening) return;
    const content = detail.querySelector(".dc-date-detail-content");
    if (!content || content.dataset.loaded === "1") return;
    content.innerHTML = loadStateHtml("loading");
    let payload = dailyDetailCache.get(date);
    try {
      if (!payload) {
        payload = await apiGetOk(`/api/data-center/date?${new URLSearchParams({ date }).toString()}`);
        if (generation !== dataCenterGeneration || !content.isConnected) return;
        dailyDetailCache.set(date, payload);
      }
      renderDateDetail(content, payload);
      content.dataset.loaded = "1";
    } catch (error) {
      const text = userFacingMessage(error, "資料讀取失敗，請稍後再試", { context: "DATA_CENTER_DETAIL" });
      if (generation !== dataCenterGeneration || !content.isConnected) return;
      content.innerHTML = loadStateHtml("failed", text);
    }
  };

  body.querySelectorAll(".dc-daily-row").forEach((row) => {
    row.addEventListener("click", () => void toggleDate(row.dataset.dcDate || ""));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); void toggleDate(row.dataset.dcDate || "");
    });
  });
}

function renderDailyFailure(error) {
  const body = $("dataCenterDailyRows");
  if (!body) return;
  const text = userFacingMessage(error, "資料中心讀取失敗，請稍後再試", { context: "DATA_CENTER_DATES" });
  body.innerHTML = loadStateRowHtml(DAILY_COLUMNS, "failed", text);
}

const dash = (n) => (Number(n) > 0 ? int(n) : "--");
const closingCell = ({ text, tone }) => `<td>${tone ? `<span class="settings-badge is-${tone}">${escapeHtml(text)}</span>` : escapeHtml(text)}</td>`;
const countCells = (item) => `<td>${dash(item.products)}</td><td>${dash(item.rows?.tick)}</td><td>${dash(item.rows?.bidask)}</td>
  <td>${dash(item.rows?.quote)}</td><td>${bytesText(item.bytes) ?? "--"}</td>`;

// One category row; 期貨指數 opens to its 日盤 / 夜盤 rows.
function categoryRowsHtml(item) {
  const name = CATEGORY[item.id]?.name || item.id;
  const sessions = Array.isArray(item.sessions) ? item.sessions : [];
  if (!sessions.length) {
    return `<tr class="dc-category-row"><td><span class="record-expand-label"><b>${escapeHtml(name)}</b></span></td>
      ${countCells(item)}${closingCell(resultView(item))}</tr>`;
  }
  return `<tr class="dc-category-row record-expand-row" data-dc-category="${escapeHtml(item.id)}" tabindex="0" role="button" aria-expanded="false">
      ${expandCellHtml(`<b>${escapeHtml(name)}</b>`)}${countCells(item)}${closingCell(combinedResultView(sessions))}</tr>
    ${sessions.map((session) => `<tr class="dc-session-row" data-row-detail data-dc-session-of="${escapeHtml(item.id)}" hidden>
      <td><span class="record-expand-label"><span class="dc-session-name">${escapeHtml(SESSION_NAME[session.id] || session.id)}</span></span></td>
      ${countCells(session)}${closingCell(resultView(session))}</tr>`).join("")}`;
}

function renderDateDetail(content, payload = {}) {
  const categories = (payload.categories || [])
    .filter((item) => !selectedMarket || CATEGORY[item.id]?.market === selectedMarket);
  const rows = categories.length ? categories.map(categoryRowsHtml).join("")
    : emptyStateRowHtml(CATEGORY_COLUMNS, "這天沒有資料");
  content.innerHTML = `<div data-grid-variant="page"><table class="data-table dc-category-table">
      <thead><tr><th><span class="record-expand-label">類別</span></th><th>商品數</th><th>成交筆數</th><th>五檔筆數</th><th>報價筆數</th><th>資料大小</th><th>物化結果</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  // A category's session rows open and close with the shared expand motion, one motion per row (key: the row's
  // place among the session rows); a closed one is hidden once its motion ends.
  const sessionRows = () => [...content.querySelectorAll(".dc-session-row")];
  const categoryOpen = (sub) => content.querySelector(`.dc-category-row[data-dc-category="${CSS.escape(sub.dataset.dcSessionOf || "")}"]`)
    ?.classList.contains("expanded");
  const sessionMotion = createExpandMotion({
    find: (key) => sessionRows()[Number(key)] || null,
    redraw: () => sessionRows().forEach((sub) => { sub.hidden = !categoryOpen(sub); }),
  });
  content.querySelectorAll(".dc-category-row.record-expand-row").forEach((row) => {
    const toggle = () => {
      const opening = !row.classList.contains("expanded");
      const keys = sessionRows().map((sub, index) => (sub.dataset.dcSessionOf === row.dataset.dcCategory ? String(index) : null))
        .filter((key) => key !== null);
      if (keys.some((key) => sessionMotion.busy(key))) return;
      keys.forEach((key) => sessionMotion.start(key, opening));
      row.classList.toggle("expanded", opening);
      row.setAttribute("aria-expanded", String(opening));
      if (opening) keys.forEach((key) => { sessionRows()[Number(key)].hidden = false; });
      sessionMotion.play();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); toggle();
    });
  });
}

// The page's DOM is rebuilt on every visit while the module (and its last summaries) stays loaded: the cached
// list was neither drawn nor reloaded, so the table stayed empty until 重新整理. Entering the page
// draws what is known at once and always fetches the current list.
let reloadOnEnter = true;

export async function refreshDataCenter({ reloadDates = false } = {}) {
  const generation = ++dataCenterGeneration;
  const loading = $("dataCenterLoading");
  if (loading) loading.hidden = false;
  const entering = reloadOnEnter;
  reloadOnEnter = false;
  try {
    if (entering && dailySummaries.length) renderDailyOverview(dailySummaries);
    if (reloadDates || entering || !dailySummaries.length) {
      let dates;
      try {
        dates = await apiGetOk("/api/data-center/dates");
      } catch (error) {
        // The table says why it is empty (never a 載入中 that never ends); a list already shown stays. The caller's
        // task shows and records the failure.
        if (generation === dataCenterGeneration && !dailySummaries.length) renderDailyFailure(error);
        throw error;
      }
      if (generation !== dataCenterGeneration) return;
      dailySummaries = dates.items || [];
      renderDailyOverview(dailySummaries);
    }
  } finally {
    if (generation === dataCenterGeneration && loading) loading.hidden = true;
  }
}

// 收盤整理: asked again every 2 s while the close moves, every 30 s while it waits for the clock; one request in flight,
// and an answer from before the page was left is dropped. Morphed: an unchanged card writes nothing.
let closingTimer = null;
let closingInFlight = null;   // the generation whose request is out
let closingGeneration = 0;
let closingClock = null;   // the figures' renderer (closing_clock.js): the poll only replaces its input
let closingLog = null;     // 執行紀錄's row and the log under it
let closingLive = null;    // whether the log shows a close still being materialized (it is open then)

function setClosing(id, html, { hideEmpty = false } = {}) {
  const el = $(id);
  if (!el) return;
  if (hideEmpty && el.hidden !== !html) el.hidden = !html;
  morphInto(el, html);
}

function renderClosing(payload, now = Date.now()) {
  setClosing("dataCenterClosingSteps", renderClosingSteps(payload, now));
  setClosing("dataCenterClosingBar", renderClosingBar(payload), { hideEmpty: true });
  setClosing("dataCenterClosingLog", renderClosingLog(payload, now));
  closingClock?.setInput(payload);
  setClosing("dataCenterClosingHistory", renderClosingHistory(payload));
  // 執行紀錄 opens by itself while it is about a close still being materialized and closes when that close is done
  // (user 11-01); between those changes it stays as the user left it.
  const live = loggedClose(payload) === payload && payload?.stage !== "done";
  const note = $("dataCenterClosingLogNote");
  if (note) note.textContent = live ? "這一次・進行中" : "上一次";
  if (live !== closingLive) {
    closingLive = live;
    closingLog?.setOpen(live);
  }
}

async function refreshClosing(generation) {
  if (closingInFlight === generation || generation !== closingGeneration) return;
  closingInFlight = generation;
  let next = 30000;
  try {
    const payload = await apiGetOk("/api/data-center/closing", { timeoutMs: 10000 });
    if (generation !== closingGeneration) return;
    renderClosing(payload);
    next = closingPollMs(payload);
  } catch (error) {
    console.warn("[data center: reading 收盤整理] failed", error);
  } finally {
    if (closingInFlight === generation) closingInFlight = null;
    if (generation === closingGeneration) closingTimer = window.setTimeout(() => refreshClosing(generation), next);
  }
}

function stopClosing() {
  closingGeneration += 1;
  if (closingTimer) window.clearTimeout(closingTimer);
  closingTimer = null;
  closingClock?.dispose();
  closingClock = null;
  closingLive = null;
  closingLog?.dispose();
  closingLog = null;
}

export function initDataCenterPage() {
  dataCenterGeneration += 1;
  reloadOnEnter = true;
  stopClosing();
  closingLog = createJobLogToggle($("dataCenterClosingLogToggle"), $("dataCenterClosingLogPane"));
  // Only the figures move with the clock; the rest changes with an answer.
  closingClock = createClosingClock($("dataCenterClosingNext"));
  void refreshClosing(closingGeneration);
  const marketSeg = $("dataCenterMarket");
  const refreshBtn = $("dataCenterRefreshBtn");
  const showMarket = () => {
    marketSeg?.querySelectorAll("[data-market]").forEach((button) => button.classList.toggle("is-active", button.dataset.market === selectedMarket));
    syncSegmented(marketSeg);
  };
  showMarket();
  marketSeg?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-market]");
    if (!button || button.dataset.market === selectedMarket) return;
    selectedMarket = button.dataset.market;
    showMarket();
    renderDailyOverview(dailySummaries);
  });
  refreshBtn?.addEventListener("click", () => {
    dailyDetailCache.clear();
    const generation = dataCenterGeneration + 1;
    void runUiTask("DATA_CENTER_REFRESH", () => refreshDataCenter({ reloadDates: true }), {
      fallback: "資料中心讀取失敗，請稍後再試",
      show: (text) => { const state = $("dataCenterDailyCacheState"); if (state) state.textContent = text; },
      isCurrent: () => dataCenterGeneration === generation,
    });
  });
}

export function disposeDataCenterPage() {
  dataCenterGeneration += 1;
  stopClosing();
  dailyDetailCache.clear();
}
