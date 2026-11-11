import { apiGetOk, apiPost } from "../core/api.js";
import { morphInto } from "../core/dom_morph.js";
import { $, bindClick, escapeHtml } from "../core/utility.js";
import { formatSpan } from "../core/job_status_view.js";
import { loadStateHtml } from "../core/load_state_view.js";
import { syncSegmented } from "../core/settings_ui.js";
import { createExpandMotion } from "../core/expand_motion.js";
import { createJobLogToggle } from "../core/job_log_toggle.js";
import { renderSteps, renderBar, renderProgress, renderLog, renderSummary, renderToday, renderLiveCards, renderPairCards, renderImportanceHorizons, renderImportanceCards } from "./training/model_center_view.js";
import { userFacingMessage } from "../core/user_action.js";

// 模型中心: 訓練狀態, the 10 live models and both models of every prediction, from one request
// (/api/training/models, which carries today's status). Training is a job Health runs; this page reads its status,
// polls its progress while it runs, and asks for a manual run.
let latestPayload = null;     // the last /api/training/models answer: the models, the slots, today, the last success
let pollTimer = null;
let countdownTimer = null;
let countdownBase = null;     // { seconds, at }: the server's seconds_until_next_run and when it was received
let trainingGeneration = 0;
let importanceHorizon = null;  // the horizon 特徵權重 shows; null = the shortest
let liveDirection = "up";      // the side 上線模型 shows (上漲 / 下跌)
const openPairs = new Set();   // the 每個預測的兩種模型 rows open (slotKey)
let logToggle = null;
const pairMotion = createExpandMotion({
  find: (key) => document.querySelector(`[data-morph-key="pair-detail-${CSS.escape(key)}"]`),
  redraw: () => renderPairs(latestPayload),
});

// The training controller: the one owner of the job's state and of what shows it (the steps, the bar, the running
// figures, the log, the summary) and of the 重新訓練 button. Both /api/training/models and the runtime poll carry the
// job; every read takes a number when it is sent, and an answer from a read older than the one shown is dropped, so a
// late reply never moves the job back. The button is busy while a run command is being submitted or the job runs or
// waits; the reads and the command only change this state, and the button is drawn from it.
const trainingJob = { sent: 0, shown: 0, view: null, submitting: false };

function nextJobRead() {
  trainingJob.sent += 1;
  return trainingJob.sent;
}

// Takes the job part of an answer to read `read`; false when an answer to a newer read is already shown.
function acceptJob(read, answer) {
  if (read <= trainingJob.shown) return false;
  trainingJob.shown = read;
  trainingJob.view = { job: answer?.job ?? null, running: Boolean(answer?.running), pending_request: answer?.pending_request ?? null };
  return true;
}

function jobRunning() {
  return Boolean(trainingJob.view?.running || trainingJob.view?.pending_request);
}

function renderRunButton() {
  const button = $("manualTrainBtn");
  if (!button) return;
  const busy = trainingJob.submitting || jobRunning();
  const label = busy ? "訓練中..." : "重新訓練";
  if (button.disabled !== busy) button.disabled = busy;
  if (button.textContent !== label) button.textContent = label;
}

// What the job's cards draw: the models answer's dataset and last success with the controller's job.
function jobPayload() {
  return { ...(latestPayload || {}), ...(trainingJob.view || {}) };
}

// Status, steps and progress are redrawn on the 2 s runtime poll and the 1 s clock: morphed, so an unchanged card
// writes nothing and a changed one only its changed parts (the progress bar is the same element throughout).
function setHtml(id, html) {
  const el = $(id);
  if (el) morphInto(el, html);
}

function secondsLeft() {
  if (!countdownBase) return null;
  return Math.max(0, countdownBase.seconds - (Date.now() - countdownBase.at) / 1000);
}

// The bar and the running figures show only while a job runs.
function setShown(id, html) {
  const el = $(id);
  if (!el) return;
  if (el.hidden !== !html) el.hidden = !html;
  morphInto(el, html);
}

function renderJob() {
  const payload = jobPayload();
  setHtml("trainingSteps", renderSteps(payload));
  setShown("trainingBar", renderBar(payload));
  setShown("trainingProgress", renderProgress(payload));
  setHtml("trainingLog", renderLog(payload));
  const logNote = $("trainingLogNote");
  if (logNote) logNote.textContent = `${$("trainingLog")?.querySelectorAll(".job-log-row").length || 0} 行`;
  setHtml("trainingSummary", renderSummary(payload));
  renderRunButton();
  managePolling(jobRunning());
}

// Every card's body before the page's first answer: the load-state placeholder, which the answer's content morphs
// over (training.html's cards are empty until then).
const CARD_BODIES = ["trainingLog", "trainingSummary", "trainingToday", "liveModelCards", "modelPairCards", "importanceCards"];

function renderLoadState(state, detail = "") {
  for (const id of CARD_BODIES) setHtml(id, loadStateHtml(state, detail));
}

function renderAll(payload, read) {
  latestPayload = payload;
  const today = payload?.today;
  countdownBase = Number.isFinite(Number(today?.seconds_until_next_run)) ? { seconds: Number(today.seconds_until_next_run), at: Date.now() } : null;
  acceptJob(read, payload);
  renderJob();
  setHtml("trainingToday", renderToday(today, secondsLeft()));
  renderLive(payload);
  renderPairs(payload);
  renderImportance(payload);
  const slots = payload?.slots || [];
  const subtitle = $("modelCenterSubtitle");
  if (subtitle) subtitle.textContent = slots.length ? `${slots.length} 個預測・${slots.filter((slot) => slot.model).length} 個上線` : "";
  const warning = $("trainingWarningBar");
  if (warning) warning.hidden = true;
}

function renderLive(payload) {
  setHtml("liveModelCards", renderLiveCards(payload?.slots || [], liveDirection));
  const seg = $("liveDirection");
  seg?.querySelectorAll("[data-direction]").forEach((button) => button.classList.toggle("is-active", button.dataset.direction === liveDirection));
  syncSegmented(seg);
}

function renderPairs(payload) {
  if (!payload) return;
  setHtml("modelPairCards", renderPairCards(payload.slots || [], { isOpen: (key) => openPairs.has(key) || pairMotion.closing(key) }));
  pairMotion.play();
}

function selectLiveDirection(event) {
  const button = event.target.closest?.("[data-direction]");
  if (!button || button.dataset.direction === liveDirection) return;
  liveDirection = button.dataset.direction === "down" ? "down" : "up";
  renderLive(latestPayload);
}

// A row of 每個預測的兩種模型 opens or closes its two models; a click while it moves is ignored.
function togglePair(event) {
  const row = event.target.closest?.("[data-pair-slot]");
  if (!row) return;
  const key = row.dataset.pairSlot;
  const open = !openPairs.has(key);
  if (!pairMotion.start(key, open)) return;
  if (open) openPairs.add(key);
  else openPairs.delete(key);
  renderPairs(latestPayload);
}

function renderImportance(payload) {
  setHtml("importanceHorizons", renderImportanceHorizons(payload?.slots || [], importanceHorizon));
  setHtml("importanceCards", renderImportanceCards(payload?.slots || [], importanceHorizon));
  syncSegmented($("importanceHorizons"));
}

function selectImportanceHorizon(event) {
  const button = event.target.closest?.("[data-horizon]");
  if (!button) return;
  importanceHorizon = Number(button.dataset.horizon);
  renderImportance(latestPayload);
}

async function loadConsole() {
  const generation = ++trainingGeneration;
  const read = nextJobRead();
  const payload = await apiGetOk("/api/training/models");
  if (generation !== trainingGeneration) return null;
  renderAll(payload, read);
  return payload;
}

export async function refreshTrainingStatus() {
  const request = loadConsole();
  const generation = trainingGeneration;
  try {
    return await request;
  } catch (error) {
    console.error("[MODEL CENTER] refresh failed", error);
    if (generation !== trainingGeneration) return null;
    const message = userFacingMessage(error, "模型中心載入失敗，請稍後再試", { context: "TRAINING_LOAD" });
    const warning = $("trainingWarningBar");
    if (warning) {
      warning.hidden = false;
      warning.innerHTML = `<div class="model-center-warning-row error">${escapeHtml(message)}</div>`;
    }
    // Cards still waiting for their first answer say it failed; a page already showing an answer keeps it.
    if (!latestPayload) renderLoadState("failed", message);
    throw error;
  }
}

// One run command at a time, and none while the job runs or waits. Once the command is answered the status is read
// again; if that read fails the button shows the last confirmed state (an unanswered command is not a running job).
export async function runManualTraining() {
  if (trainingJob.submitting || jobRunning()) return;
  trainingJob.submitting = true;
  renderRunButton();
  try {
    // Leaves a request; Health starts the training job (a process of its own, not inside FastAPI).
    const result = await apiPost("/api/training/run");
    if (!result?.ok) throw new Error(result?.error || "訓練失敗");
  } catch (error) {
    console.error("[MODEL CENTER] training failed", error);
  }
  try {
    await refreshTrainingStatus();
  } catch { /* not an error: refreshTrainingStatus() already reported the failure */ }
  trainingJob.submitting = false;
  renderRunButton();
}

// One runtime poll in flight at a time, and a reply from before the polling was restarted or stopped is dropped:
// a 1.2 s interval over a 20 s request timeout piled requests up on a busy backend and their late replies moved
// 訓練中 / progress backwards.
let runtimePollInFlight = false;
let runtimePollGeneration = 0;

export async function refreshTrainingRuntimeOnly() {
  if (runtimePollInFlight) return;
  runtimePollInFlight = true;
  const generation = runtimePollGeneration;
  const read = nextJobRead();
  try {
    const runtime = await apiGetOk("/api/training/runtime", { timeoutMs: 5000 });
    if (generation !== runtimePollGeneration || !acceptJob(read, runtime)) return;
    renderJob();
    // The job ended: the models answer brings what it trained.
    if (!jobRunning()) await refreshTrainingStatus();
  } catch (error) {
    console.warn("[MODEL CENTER] runtime poll failed", error);
  } finally {
    runtimePollInFlight = false;
  }
}

function managePolling(running) {
  if (running && !pollTimer) {
    runtimePollGeneration += 1;
    pollTimer = window.setInterval(() => refreshTrainingRuntimeOnly(), 2000);
    return;
  }
  if (!running && pollTimer) {
    runtimePollGeneration += 1;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

// The countdown and the elapsed time tick every second from the last answer; the next start itself is the server's.
// Only the countdown's own text is rewritten: the rest of the card changes with an answer, not with the clock. The
// running figures and the log are drawn from the controller's job at the new time, so only their time texts change
// (morphed) and the clock can never show a job the controller has replaced.
function tickClock() {
  if (!latestPayload) return;
  const countdown = $("trainingToday")?.querySelector(".mc-countdown");
  const left = secondsLeft();
  if (countdown && left !== null) {
    const text = formatSpan(left);
    if (countdown.textContent !== text) countdown.textContent = text;
  }
  if (trainingJob.view?.running) {
    const payload = jobPayload();
    setHtml("trainingProgress", renderProgress(payload));
    setHtml("trainingLog", renderLog(payload));     // the running step's elapsed time
  }
  if (countdownBase && secondsLeft() === 0) {
    countdownBase = null;     // once per answer: the refresh brings the next one
    refreshTrainingStatus().catch((error) => console.warn("[training: refreshing the status] failed", error));
  }
}

export function bindTrainingEvents() {
  trainingGeneration += 1;
  // A fresh page (its HTML was just inserted) has no answer yet, whatever an earlier visit had.
  latestPayload = null;
  countdownBase = null;
  // Nor a job: an answer to a read sent before this visit is older than any it sends. A run command still being
  // submitted stays: it keeps the button busy until it is answered.
  trainingJob.view = null;
  trainingJob.shown = trainingJob.sent;
  renderLoadState("loading");
  renderRunButton();
  bindClick("refreshTrainingBtn", () => refreshTrainingStatus().catch((error) => console.warn("[training: refreshing the status] failed", error)));
  bindClick("manualTrainBtn", runManualTraining);
  bindClick("importanceHorizons", selectImportanceHorizon);
  bindClick("liveDirection", selectLiveDirection);
  bindClick("modelPairCards", togglePair);
  logToggle?.dispose();
  logToggle = createJobLogToggle($("trainingLogToggle"), $("trainingLogPane"));
  if (!countdownTimer) countdownTimer = window.setInterval(tickClock, 1000);
}

export function disposeTrainingPage() {
  trainingGeneration += 1;
  logToggle?.dispose();
  logToggle = null;
  runtimePollGeneration += 1;
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}
