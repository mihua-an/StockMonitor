// 資料中心's 收盤整理 card: one poll of /api/data-center/closing while the page shows.
import { apiGetOk } from "../../core/api.js";
import { $ } from "../../core/utility.js";
import { morphInto } from "../../core/dom_morph.js";
import { createJobLogToggle } from "../../core/job_log_toggle.js";
import { closingPollMs, loggedClose, renderClosingBar, renderClosingLast, renderClosingLog, renderClosingSteps } from "./closing_progress_view.js";
import { createClosingClock } from "./closing_clock.js";

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
  setClosing("dataCenterClosingLast", renderClosingLast(payload));
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

export function stopClosingCard() {
  closingGeneration += 1;
  if (closingTimer) window.clearTimeout(closingTimer);
  closingTimer = null;
  closingClock?.dispose();
  closingClock = null;
  closingLive = null;
  closingLog?.dispose();
  closingLog = null;
}

export function startClosingCard() {
  stopClosingCard();
  closingLog = createJobLogToggle($("dataCenterClosingLogToggle"), $("dataCenterClosingLogPane"));
  // Only the figures move with the clock; the rest changes with an answer.
  closingClock = createClosingClock($("dataCenterClosingNext"));
  void refreshClosing(closingGeneration);
}
