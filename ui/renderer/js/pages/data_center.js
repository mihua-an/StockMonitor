// 資料中心: the trading days (資料｜事件｜回放), the models, and 總覽 -- one page. The side nav's upper half is what does not
// belong to a day; its lower half is every day. The models' cards are pages/training.js's, 回放 is pages/history.js's,
// mounted in the page's stage while it is shown.
import { apiGetOk } from "../core/api.js";
import { runUiTask } from "../core/ui_task.js";
import { $ } from "../core/utility.js";
import { loadStateHtml, loadStateRowHtml } from "../core/load_state_view.js";
import { createExpandMotion } from "../core/expand_motion.js";
import { userFacingMessage } from "../core/user_action.js";
import { morphInto } from "../core/dom_morph.js";
import { markPageFrameItems, showPageFrameView } from "../core/page_frame.js";
import { syncSegmented } from "../core/settings_ui.js";
import { bytesText } from "../core/diagnostics_format.js";
import { int } from "../core/job_status_view.js";
import { normalizeHistoryEvents } from "../core/event_feed_format.js";
import { getTrendFooterHorizons } from "../core/trend_footer_horizons.js";
import { taipeiDateKey } from "../market_data/taipei_time.js";
import { startClosingCard, stopClosingCard } from "../features/data_center/closing_card.js";
import { completeText, dayStorage, dayTitle, dayUse, renderDayCategories, renderDayClosing, renderDayEvents, renderDayModels, renderDayNav, renderDayTiles,
  recentDays, renderDayUse, renderEventTiles, renderModelDays, renderRecentDays } from "../features/data_center/days_view.js";
import { onHistoryDateChange, setHistoryDateValue } from "../features/history/picked_date.js";
import { bindTrainingEvents, disposeTrainingPage, refreshTrainingStatus } from "./training.js";

const DAY_VIEWS = ["day-data", "day-events", "replay"];
const EVENTS_LIMIT = 20000;
const EVENT_ROWS = 200;        // the rows drawn at first, and added each time the list's end comes near
const EVENTS_AHEAD_PX = 600;

let view = "overview";
// The day shown, "" until the days are read. `pageTab`: which of 資料 / 事件 a day opens on from 總覽 and 模型; from a day's
// own tab (回放 included) another day opens on that tab.
let currentDay = "";
let pageTab = "day-data";
let dailySummaries = [];
let eventCounts = null;       // date -> { events, up, down, codes }, null until read
let modelDays = null;         // date -> { use, next, samples, models }, null until read
let marketHoliday = false;    // today has no trading session: it is not one of the days
const dailyDetailCache = new Map();
let dataCenterGeneration = 0;
let dayGeneration = 0;        // one per day drawn: an answer for an earlier one is dropped

const page = () => document.querySelector(".data-center-page");
const isDayView = (name) => DAY_VIEWS.includes(name);
const today = () => taipeiDateKey(Date.now());
const dayOf = (date) => dailySummaries.find((day) => day.date === date) || { date };

// ---- the frame ----

function drawChrome() {
  const root = page();
  if (!root) return;
  const isDay = isDayView(view);
  markPageFrameItems(root, (item) => (item.dataset.day ? isDay && item.dataset.day === currentDay : item.dataset.dcNav === view));
  showPageFrameView(root, "data-dc-view", view === "replay" ? null : view);
  $("dataCenterScroll").hidden = view === "replay";
  $("dataCenterReplay").hidden = view !== "replay";
  const head = root.querySelector(".page-frame-head");
  head.hidden = view === "replay";
  head.classList.toggle("has-tabs", isDay);
  const tabs = $("dataCenterDayTabs");
  tabs.hidden = !isDay;
  tabs.querySelectorAll("[data-day-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.dayTab === view));
  if (isDay) syncSegmented(tabs);
  root.querySelectorAll("[data-dc-action]").forEach((button) => { button.hidden = button.dataset.dcAction !== view; });
  $("modelCenterSubtitle").hidden = view !== "models";
  $("dataCenterTitle").textContent = view === "overview" ? "總覽" : view === "models" ? "模型" : dayTitle(currentDay || today());
  $("dataCenterSubtitle").textContent = isDay ? daySubtitle() : view === "overview" ? "每個交易日收盤後整理成歷史資料，模型用最近的交易日訓練，每一天都能回放" : "";
}

function daySubtitle() {
  const day = dayOf(currentDay);
  const usage = dayStorage(day);
  if (!usage.products) return currentDay === today() ? "今天 · 收盤整理後成為新的交易日" : "";
  const use = modelDays ? ` · ${dayUse(currentDay, modelDays[currentDay], today()).label}` : "";
  return `${completeText(day)}${use} · ${int(usage.products)} 檔 · ${bytesText(usage.bytes) ?? "--"}`;
}

// The page's days: the stored ones, and a trading day's today before it is one of them.
function listedDays() {
  const todayDate = today();
  const listed = marketHoliday || dailySummaries.some((day) => day.date === todayDate) ? dailySummaries : [{ date: todayDate, complete: null }, ...dailySummaries];
  return [...listed].sort((a, b) => b.date.localeCompare(a.date));
}

function show(next, day = currentDay) {
  const leaving = view;
  view = next;
  if (isDayView(next)) {
    currentDay = day || dailySummaries[0]?.date || today();
    if (next !== "replay") pageTab = next;
  }
  drawChrome();
  if (leaving === "replay" && next !== "replay") closeReplay();
  if (next === "replay") return openReplay(currentDay);
  if (leaving !== next) $("dataCenterScroll").scrollTop = 0;
  if (isDayView(next)) {
    page().querySelector(`[data-day="${CSS.escape(currentDay)}"]`)?.scrollIntoView({ block: "nearest" });
    void drawDay();
  }
  return Promise.resolve(true);
}

// ---- 總覽 and the day list ----

function renderDailyOverview(items = []) {
  dailySummaries = items;
  morphInto($("dataCenterDays"), renderDayNav(listedDays(), today()));
  morphInto($("dataCenterDailyRows"), renderRecentDays(items, { today: today(), counts: eventCounts, uses: modelDays }));
  drawChrome();
}

function renderDailyFailure(error) {
  const text = userFacingMessage(error, "資料中心讀取失敗，請稍後再試", { context: "DATA_CENTER_DATES" });
  morphInto($("dataCenterDailyRows"), loadStateRowHtml(7, "failed", text));
}

// The event counts and the models' days beside the dates: each is drawn when it arrives; a failed one leaves "--".
async function refreshDayNotes(generation) {
  const read = async (name, path, take) => {
    try {
      const answer = await apiGetOk(path);
      if (generation !== dataCenterGeneration) return;
      take(answer);
      renderDailyOverview(dailySummaries);
      morphInto($("dataCenterModelDays"), renderModelDays(modelDays));
      if (view === "day-data" || view === "day-events") void drawDay();
    } catch (error) {
      console.warn(`[data center: reading ${name}] failed`, error);
    }
  };
  await Promise.all([
    read("the event counts", `/api/monitor/event-counts?${new URLSearchParams({ dates: recentDays(dailySummaries).map((day) => day.date).join() })}`, (answer) => { eventCounts = answer.dates || {}; }),
    read("the models' days", "/api/training/days", (answer) => { modelDays = answer.days || {}; marketHoliday = answer.is_trading_day === false; }),
  ]);
}

// The page's DOM is rebuilt on every visit while the module (and its last summaries) stays loaded: entering draws what
// is known at once and always fetches the current list.
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
      renderDailyOverview(dates.items || []);
      await refreshDayNotes(generation);
    }
  } finally {
    if (generation === dataCenterGeneration && loading) loading.hidden = true;
  }
}

// ---- one day's 資料 and 事件 ----

// The events of the day drawn and how many of them have rows: a day can have thousands.
const eventList = { events: [], shown: 0, observer: null };

function drawEvents(more = 0) {
  eventList.shown = Math.min(eventList.events.length, Math.max(EVENT_ROWS, eventList.shown) + more);
  morphInto($("dataCenterEvents"), renderDayEvents(eventList.events.slice(0, eventList.shown), getTrendFooterHorizons()));
}

function followEventsEnd() {
  const scroll = $("dataCenterScroll"), end = $("dataCenterEventsEnd");
  // The end's place now: an entry may be from before the rows were drawn over it.
  const near = () => end.getBoundingClientRect().top <= scroll.getBoundingClientRect().bottom + EVENTS_AHEAD_PX;
  eventList.observer = new IntersectionObserver(() => {
    if (view === "day-events" && eventList.shown < eventList.events.length && near()) drawEvents(EVENT_ROWS);
  }, { root: scroll, rootMargin: `${EVENTS_AHEAD_PX}px` });
  eventList.observer.observe(end);
}

async function drawDay() {
  const date = currentDay, shown = view, generation = ++dayGeneration;
  const current = () => generation === dayGeneration && page();
  if (shown === "day-data") {
    morphInto($("dataCenterDayTiles"), renderDayTiles(dayOf(date)));
    morphInto($("dataCenterDayUse"), renderDayUse(date, modelDays, today()));
    const models = renderDayModels(modelDays?.[date]);
    $("dataCenterDayModels").hidden = !models;
    morphInto($("dataCenterDayModels"), models);
    if ($("dataCenterDayCategories").dataset.date === date) return;
    for (const id of ["dataCenterDayClosing", "dataCenterDayCategories"]) morphInto($(id), loadStateHtml("loading"));
    delete $("dataCenterDayCategories").dataset.date;
    try {
      const payload = dailyDetailCache.get(date) || await apiGetOk(`/api/data-center/date?${new URLSearchParams({ date })}`);
      dailyDetailCache.set(date, payload);
      if (!current()) return;
      morphInto($("dataCenterDayClosing"), renderDayClosing(payload.categories || []));
      drawCategories(payload.categories || []);
      $("dataCenterDayCategories").dataset.date = date;
    } catch (error) {
      const text = userFacingMessage(error, "資料讀取失敗，請稍後再試", { context: "DATA_CENTER_DETAIL" });
      if (!current()) return;
      for (const id of ["dataCenterDayClosing", "dataCenterDayCategories"]) morphInto($(id), loadStateHtml("failed", text));
    }
    return;
  }
  if ($("dataCenterEvents").dataset.date === date && date !== today()) return;
  if ($("dataCenterEvents").dataset.date !== date) {
    morphInto($("dataCenterEventTiles"), "");
    morphInto($("dataCenterEvents"), loadStateHtml("loading"));
  }
  try {
    const answer = await apiGetOk(`/api/monitor/events?${new URLSearchParams({ date, limit: String(EVENTS_LIMIT), view: "list" })}`);
    if (!current()) return;
    const events = normalizeHistoryEvents(answer.events);
    morphInto($("dataCenterEventTiles"), renderEventTiles(events));
    if ($("dataCenterEvents").dataset.date !== date) eventList.shown = 0;
    eventList.events = events;
    drawEvents();
    $("dataCenterEvents").dataset.date = date;
  } catch (error) {
    const text = userFacingMessage(error, "事件讀取失敗，請稍後再試", { context: "DATA_CENTER_EVENTS" });
    if (current()) morphInto($("dataCenterEvents"), loadStateHtml("failed", text));
  }
}

// A category's session rows open and close with the shared expand motion, one motion per row (key: the row's place among
// the session rows); a closed one is hidden once its motion ends.
function drawCategories(categories) {
  const content = $("dataCenterDayCategories");
  morphInto(content, "");
  morphInto(content, renderDayCategories(categories));
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

// ---- 回放: pages/history.js in the stage, while it is shown ----

let replay = null;            // { module, loaded } while 回放 is mounted
let replayGeneration = 0;
let stopFollowingDate = () => {};

async function openReplay(day) {
  if (replay) {
    replay.module.selectHistoryDate(day);
    return true;
  }
  const generation = ++replayGeneration;
  const [module, response] = await Promise.all([import("./history.js"), fetch(new URL("../../pages/history.html", import.meta.url))]);
  if (!response.ok) throw new Error(`pages/history.html: ${response.status}`);
  const html = await response.text();
  if (generation !== replayGeneration || view !== "replay" || !page()) return false;
  $("dataCenterReplay").innerHTML = html;
  setHistoryDateValue(currentDay);
  module.bindHistoryEvents();
  // A date picked inside 回放 (歷史事件, 交易明細) is the page's day too.
  stopFollowingDate = onHistoryDateChange((date) => { currentDay = date; drawChrome(); });
  replay = { module, loaded: module.refreshHistoryPage() };
  await replay.loaded;
  return true;
}

function closeReplay() {
  replayGeneration += 1;
  stopFollowingDate();
  stopFollowingDate = () => {};
  replay?.module.disposeHistoryPage();
  replay = null;
  const stage = $("dataCenterReplay");
  if (stage) stage.replaceChildren();
}

/** Shows 回放 at one product's moment: { date, code, name, time, autoplay }. */
export async function openDataCenterReplay(detail = {}) {
  await show("replay", String(detail.date || "").slice(0, 10) || currentDay);
  return replay ? replay.module.openHistoryReplay(detail) : false;
}

export function resizeDataCenterPage() {
  replay?.module.resizeHistoryDashboard();
}

// ---- mount ----

function bindClicks(root) {
  const showing = (name, work) => void runUiTask(name, work, { fallback: "畫面切換失敗，請稍後再試",
    show: (text) => { const line = $("dataCenterSubtitle"); if (line) line.textContent = text; } });
  root.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-dc-nav]");
    if (nav) { if (nav.dataset.dcNav !== view) showing("DATA_CENTER_VIEW", () => show(nav.dataset.dcNav)); return; }
    const day = event.target.closest("[data-day], [data-open-day]");
    if (day) { showing("DATA_CENTER_DAY", () => show(isDayView(view) ? view : pageTab, day.dataset.day || day.dataset.openDay)); return; }
    const tab = event.target.closest("[data-day-tab]");
    if (tab) { if (tab.dataset.dayTab !== view) showing("DATA_CENTER_TAB", () => show(tab.dataset.dayTab)); return; }
    const jump = event.target.closest("[data-replay-code]");
    if (jump) showing("DATA_CENTER_REPLAY", () => openDataCenterReplay({ date: currentDay, code: jump.dataset.replayCode, time: jump.dataset.replayTime }));
  });
  root.addEventListener("keydown", (event) => {
    const row = event.target.closest("[data-open-day]");
    if (!row || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    row.click();
  });
}

export function initDataCenterPage() {
  dataCenterGeneration += 1;
  reloadOnEnter = true;
  // 回放 is opened by asking for it: a visit does not start a replay by itself.
  if (view === "replay") view = "overview";
  bindClicks(page());
  followEventsEnd();
  startClosingCard();
  bindTrainingEvents();
  morphInto($("dataCenterModelDays"), renderModelDays(modelDays));
  morphInto($("dataCenterDays"), renderDayNav(listedDays(), today()));
  void show(view, currentDay);
  $("dataCenterRefreshBtn")?.addEventListener("click", () => {
    dailyDetailCache.clear();
    const generation = dataCenterGeneration + 1;
    void runUiTask("DATA_CENTER_REFRESH", () => Promise.all([refreshDataCenter({ reloadDates: true }), refreshTrainingStatus()]), {
      fallback: "資料中心讀取失敗，請稍後再試",
      show: (text) => { const state = $("dataCenterSubtitle"); if (state) state.textContent = text; },
      isCurrent: () => dataCenterGeneration === generation,
    });
  });
}

/** The page's first reads: the days, and the models. */
export async function loadDataCenterPage() {
  await Promise.all([refreshDataCenter(), refreshTrainingStatus()]);
}

export function disposeDataCenterPage() {
  dataCenterGeneration += 1;
  dayGeneration += 1;
  stopClosingCard();
  disposeTrainingPage();
  eventList.observer?.disconnect();
  Object.assign(eventList, { events: [], shown: 0, observer: null });
  closeReplay();
  dailyDetailCache.clear();
}
