// 模型中心 view: 訓練狀態, the 10 live models, and both models of every prediction.
// Pure HTML from the /api/training/models payload (api/training_application.py: models() with today()).
import { escapeHtml } from "../../core/utility.js";
import { numberOrNull } from "../../core/numbers.js";
import { bytesText } from "../../core/diagnostics_format.js";
import { formatSpan, compactCount, clockTime, int, stepCard, progressBar, figure, runningFigures, logRow, logGroup, logList, logEmpty,
  phasePip, phaseRemaining } from "../../core/job_status_view.js";

const DIRECTION = { up: "上漲", down: "下跌" };
const KIND = { logistic: "Logistic", lightgbm: "LightGBM" };
const PHASE = {
  LEDGER_DAMAGED: "訓練紀錄檔損毀，自動訓練停止（見錯誤紀錄）",
  HOLIDAY: "今天休市",
  BEFORE_OPEN: "尚未開盤",
  IN_SESSION: "盤中收集資料中，收盤資料封存完成後自動訓練",
  WAITING_SEAL: "已收盤，等待資料封存，完成後自動訓練",
  WAITING_TRAINING: "資料已封存，即將開始訓練",
  RETRY_WAIT: "上次訓練失敗，等待重試",
  TRAINING: "訓練中",
  TRAINED: "今天已完成訓練",
};

// Every value of the /api/training payload reaches HTML escaped: model metadata is data, never markup.
export const kindName = (kind) => escapeHtml(KIND[kind] || String(kind || "--"));
// A missing figure is "--", never 0 (numberOrNull: null / "" are missing).
const f3 = (v) => (numberOrNull(v) === null ? "--" : numberOrNull(v).toFixed(3));
const f4 = (v) => (numberOrNull(v) === null ? "--" : numberOrNull(v).toFixed(4));
// AUC in one colour with a bar from 0.5 (a coin toss) to 1.0 (user 11-01: not red / green / orange).
const aucBar = (auc) => {
  const v = numberOrNull(auc);
  const width = v === null ? 0 : Math.max(0, Math.min(100, (v - 0.5) * 200));
  return `<div class="mc-auc-bar"><i style="width:${width.toFixed(1)}%"></i></div>`;
};
/** A slot's key in the page's open set (每個預測的兩種模型). */
export const slotKey = (slot) => `${slot.direction}-${slot.horizon_minutes}`;

function localDateTime(iso, { year = true } = {}) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${year ? `${d.getFullYear()}/` : ""}${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const slotName = (slot) => escapeHtml(`${slot.horizon_minutes} 分${DIRECTION[slot.direction] || ""}`);

/** Which of the four steps a job is on: 檢查 → 計算特徵與標籤 (per date) → 訓練模型 (per slot) → 上線. */
export function jobStep(job, running) {
  const step = String(job?.step || "");
  if (!running) return job?.state === "SUCCEEDED" ? 4 : -1;
  if (step === "publish") return 3;
  if (/^(split|train|promote)\b/.test(step)) return 2;
  if (/^(features|dataset)\b/.test(step)) return 1;
  return 0;
}

function slotLabel(code) {
  const m = /^(\d+)m_(up|down)$/.exec(String(code || ""));
  return m ? `${m[1]} 分${DIRECTION[m[2]]}` : String(code || "");
}

const shortDate = (date) => String(date || "").slice(5).replace("-", "/");

// A run of trading dates as "10/20–10/22" (one date alone as itself).
const dateRange = (dates) => (dates.length > 1 ? `${shortDate(dates[0])}–${shortDate(dates.at(-1))}` : shortDate(dates[0]));

/** One 執行紀錄 line: the data the job (online_training/job.py `log`) worked on at that step, and what it became.
 * `window` is the job's trading dates (the split names which of them train, validate and test). */
export function logStepText(entry, window = []) {
  const [kind, arg, model] = String(entry?.step || "").split(" ");
  const detail = entry?.detail || {};
  const dates = Array.isArray(window) ? window : [];
  switch (kind) {
    case "starting": return "--";
    case "checking": return dates.length ? `交易日曆、收盤封存紀錄 → 範圍 ${dateRange(dates)}` : "交易日曆、收盤封存紀錄";
    case "features":
      if (detail.skipped) return `${shortDate(arg)} 沒有原始行情與特徵檔`;
      if (detail.reused === true) return `${shortDate(arg)} 已整理的特徵檔`;
      if (detail.reused === false) return `${shortDate(arg)} 原始行情 → 特徵檔`;
      return `${shortDate(arg)} 特徵檔`;
    case "dataset": return dates.length ? `${dateRange(dates)} 特徵檔 → 資料集` : "各日特徵檔 → 資料集";
    case "split":
      if (detail.kind === "by_date" && dates.length >= 3) {
        return `資料集 → 訓練 ${dateRange(dates.slice(0, -2))}、驗證 ${shortDate(dates.at(-2))}、測試 ${shortDate(dates.at(-1))}`;
      }
      if (detail.kind) return "資料集 → 依時間 訓練 70%、驗證 15%、測試 15%";
      return "資料集 → 訓練、驗證、測試";
    case "train": return model ? `${slotLabel(arg)} 訓練集 → ${KIND[model] || model} 模型` : `${slotLabel(arg)} 標籤`;
    case "promote": return "各時段勝出的模型 → 一起上線";
    case "publish": return "訓練報告、過期資料";
    default: return String(entry?.step || "--");
  }
}

// The job's end; only a failure's own error is shown after it (the other reasons restate the state).
const END = {
  SUCCEEDED: ["done", "✓", "完成"],
  FAILED: ["error", "✕", "失敗"],
  INTERRUPTED: ["warn", "!", "中斷"],
  NOT_READY: ["warn", "!", "資料未就緒"],
};

const STEP_NAMES = ["檢查", "計算特徵與標籤", "訓練模型", "上線"];

// A date's phases in order (online_training/dataset.py _DatePhases): B's export, then the shard read into the dataset.
const EXPORT_PHASES = ["verify", "replay", "labels", "write", "load"];

/** The pip-style lines under a date being computed: its phases (done ✓, current ▸), then the current phase's bar,
 * percent, done/total, rate, time spent and time left. A shard already stored has only `load`. */
export function exportProgress(detail) {
  const progress = detail?.export;
  const phase = EXPORT_PHASES.includes(progress?.phase) ? progress.phase : null;
  if (!phase) return "";
  const figures = progress.phases?.[phase] || {};
  return phasePip(detail.reused === true ? ["load"] : EXPORT_PHASES, phase, figures, phaseRemaining(figures));
}

/** What a computed date became, once done: the events replayed → the samples written. */
function exportCount(detail) {
  const phases = detail?.export?.phases || {};
  if (!phases.replay || !phases.write) return "";
  return ` <span class="job-log-count">${compactCount(phases.replay.total)} → ${compactCount(phases.write.total)}</span>`;
}

/** Which of the four step cards a `log` step belongs to (the same split as jobStep). */
export function logStepCard(step) {
  const kind = String(step || "").split(" ")[0];
  if (kind === "publish") return 3;
  if (["split", "train", "promote"].includes(kind)) return 2;
  if (["features", "dataset"].includes(kind)) return 1;
  return 0;
}

/** 執行紀錄: every step of the current (or last) job under the step card it belongs to, oldest first (the newest
 * at the bottom), with how long each took. */
export function renderLog(payload, now = Date.now()) {
  const job = payload?.job || {};
  const log = Array.isArray(job.log) ? job.log : [];
  if (!log.length) return logEmpty("還沒有執行紀錄");
  const running = Boolean(payload?.running);
  // The dates the dataset holds: the job's window less any date skipped for having no data.
  const skipped = new Set(log.filter((e) => e.detail?.skipped).map((e) => String(e.step).split(" ")[1]));
  const dates = (Array.isArray(job.window) ? job.window : []).filter((d) => !skipped.has(d));
  // An open step of a job no longer running stopped at its last update, not now.
  const openEnd = running ? null : job.updated_at;
  const span = (from, to) => {
    const end = to || openEnd;
    const a = new Date(from).getTime(), b = end ? new Date(end).getTime() : now;
    return Number.isFinite(a) && Number.isFinite(b) ? formatSpan((b - a) / 1000) : "";
  };
  const row = (key, ...rest) => logRow(escapeHtml(key), ...rest);
  const groups = STEP_NAMES.map(() => ({ rows: [], from: null, to: null, open: false }));
  const mode = job.mode === "auto" ? "自動" : job.mode === "manual" ? "手動" : "";
  groups[0].rows.push(row("start", "done", "✓", clockTime(job.started_at), escapeHtml(`開始${mode ? `（${mode}）` : ""}`), ""));
  log.forEach((entry, index) => {
    const open = !entry.ended_at;
    const state = open ? (running ? "now" : "warn") : "done";
    const icon = state === "now" ? "●" : state === "warn" ? "!" : "✓";
    const group = groups[logStepCard(entry.step)];
    // A date being computed shows its phases below the line; once done, the line keeps only what it became.
    const features = String(entry.step).startsWith("features ");
    const text = escapeHtml(logStepText(entry, dates)) + (features && state === "done" ? exportCount(entry.detail) : "");
    group.rows.push(row(`${index}:${entry.step}`, state, icon, clockTime(entry.started_at), text,
      span(entry.started_at, entry.ended_at), features && state === "now" ? exportProgress(entry.detail) : ""));
    group.from ??= entry.started_at;
    group.to = entry.ended_at;
    group.open ||= open;
  });
  const succeeded = job.state === "SUCCEEDED";
  // A step the job has not reached is not listed (user 10-28): only the groups with lines so far.
  const html = groups.flatMap((group, index) => {
    if (!group.rows.length) return [];
    const state = !group.rows.length || (index === 0 && group.rows.length === 1) ? (succeeded ? "done" : "todo")
      : group.open ? (running ? "now" : "warn") : "done";
    const took = group.from ? span(group.from, group.to) : "";
    return [logGroup(index, STEP_NAMES[index], state, took, group.rows)];
  });
  const end = END[job.state];
  if (!running && end) {
    const why = job.state === "FAILED" ? job.error : "";
    html.push(row(`end:${job.state}`, end[0], end[1], clockTime(job.finished_at || job.updated_at),
      escapeHtml(why ? `${end[2]}：${why}` : end[2]), ""));
  }
  return logList(html);
}

export function renderSteps(payload) {
  const job = payload?.job || {};
  const running = Boolean(payload?.running);
  const at = jobStep(job, running);
  // Each card's own bar: a finished step full, the running one at the job's current/total within it.
  const inner = Number(job.total) > 0 ? Math.min(1, Number(job.current || 0) / Number(job.total)) : 0;
  // The step bar shows only the step names (user 11-02): what each step did is in 執行紀錄 and the figures below.
  return STEP_NAMES.map((title, index) => {
    const state = !running ? (at === 4 ? "done" : "todo") : index < at ? "done" : index === at ? "now" : "todo";
    const pct = state === "done" ? 100 : state === "now" ? Math.round(inner * 100) : 0;
    return stepCard(index, title, "", state, pct);
  }).join("");
}

function progressPercent(job) {
  const at = jobStep(job, true);
  // The four steps weigh 5% / 35% / 55% / 5%; within a step the job's own current/total.
  const share = [[0, 5], [5, 35], [40, 55], [95, 5]][Math.max(0, at)] || [0, 5];
  const inner = Number(job.total) > 0 ? Math.min(1, Number(job.current || 0) / Number(job.total)) : 0;
  return Math.round(share[0] + share[1] * inner);
}

/** The progress bar under the four steps, while a job runs. */
export function renderBar(payload) {
  if (!payload?.running) return "";
  return progressBar(progressPercent(payload.job || {}));
}

/** 進度 / 已花時間 / 預估剩餘 / 開始, while a job runs. */
export function renderProgress(payload, now = Date.now()) {
  if (!payload?.running) return "";
  const job = payload.job || {};
  const started = job.started_at ? new Date(job.started_at).getTime() : null;
  return runningFigures(progressPercent(job), started ? (now - started) / 1000 : null);
}

export function renderSummary(payload) {
  const done = payload?.last_success || {};
  const job = payload?.job || {};
  const finished = job.state === "SUCCEEDED" ? job.finished_at : done.finished_at;
  const startedAt = job.state === "SUCCEEDED" ? job.started_at : null;
  const took = startedAt && finished ? (new Date(finished) - new Date(startedAt)) / 1000 : null;
  const dataset = payload?.dataset || {};
  const failedText = { FAILED: "失敗", INTERRUPTED: "中斷（訓練程序已結束，未完成）" }[job.state];
  const failed = failedText ? figure("上次結果", failedText, "error") : "";
  return failed + figure("訓練資料", `${int(dataset.samples)} 筆 · ${int(dataset.codes)} 檔 · ${(dataset.trading_dates || []).length} 個交易日`)
    + figure("完成時間", `${localDateTime(finished)}${took ? `（耗時 ${formatSpan(took)}）` : ""}`);
}

/** 今天的狀態; `secondsLeft` is the countdown the page keeps ticking from seconds_until_next_run. */
export function renderToday(today, secondsLeft) {
  if (!today) return "";
  const date = new Date(`${today.trading_date}T00:00:00`);
  const weekday = "日一二三四五六"[date.getDay()];
  const window = today.window || {};
  const own = today.today_data;
  // Only 完整 days are trained on; the incomplete days among them are test data only (資料中心's 完整).
  const testOnly = (window.test_only_dates || []).length;
  const data = `訓練用最近 ${(window.trained_dates || []).length} 個完整交易日${testOnly ? `＋測試 ${testOnly} 個不完整日` : ""}`
    + ` · ${compactCount(window.events)} 筆 · ${bytesText(window.bytes) ?? "--"}`
    + (own ? `（今天 ${compactCount(own.events)} 筆 · ${int(own.instruments)} 檔 · ${bytesText(own.bytes) ?? "--"}）` : "");
  const next = today.next_run_at
    ? figure("距離重試", formatSpan(secondsLeft ?? today.seconds_until_next_run), "mc-countdown")
    : "";
  return figure(`今天 ${escapeHtml(String(today.trading_date || "").slice(5).replace("-", "/"))}（週${weekday ?? ""}）`, escapeHtml(PHASE[today.phase] || today.phase))
    + figure("目前資料", data) + next;
}

// Why a slot has no live model (registry.py status `champion_state`): none yet is not a damaged record.
const LIVE_STATE = {
  NONE: "無模型",
  // The run's winner did not beat the constant baseline and the slot had no model to keep (trainer.py).
  BELOW_BASELINE: "無模型 · 沒贏過常數基準",
  MODEL_UNUSABLE: "模型無法使用",
  CHAMPIONS_DAMAGED: "上線紀錄損毀",
  CHAMPIONS_IO_ERROR: "上線紀錄讀取失敗",
};

// Why a live model stayed: the latest run's winner did not go live (registry.py status `kept`).
const KEPT = { BELOW_BASELINE: "這次訓練勝出的模型沒贏過常數基準，沿用上一個模型" };

/** 上線模型: one number tile per slot of `direction` (all slots when none is given), shortest horizon first. */
export function renderLiveCards(slots, direction = null) {
  const card = (slot) => {
    const state = slot.champion_state || (slot.model ? "OK" : "NONE");
    const kept = slot.kept
      ? " · <span>沿用上一個</span>" : "";
    const kind = state === "OK"
      ? `<div class="settings-badge mc-live-kind">${kindName(slot.kind)}${kept}</div>`
      : `<div class="settings-badge mc-live-kind${state === "NONE" || state === "BELOW_BASELINE" ? "" : " mc-weak"}">${escapeHtml(LIVE_STATE[state] || state)}</div>`;
    const auc = numberOrNull(slot.validation_auc);
    return `<div class="settings-tile" data-morph-key="live-${escapeHtml(slotKey(slot))}">
      <div class="settings-tile-label">${slotName(slot)}</div>
      <div class="settings-tile-value mc-live-auc${auc === null ? " is-none" : ""}">${f3(slot.validation_auc)}</div>
      ${aucBar(slot.validation_auc)}${kind}
    </div>`;
  };
  return sortedSlots(slots, direction).map(card).join("");
}

// Why a slot's latest run shows no candidates (training_application.py `_slot_candidates`).
const RUN_STATE = { RUN_MISSING: "訓練紀錄不存在", RUN_DAMAGED: "訓練紀錄損毀", RUN_IO_ERROR: "訓練紀錄讀取失敗" };

export function rejectedText(rejected) {
  if (!rejected) return "";
  const rows = Number(rejected.rows), over = Number(rejected.rows_over);
  const ratio = Number.isFinite(Number(rejected.ratio_over)) ? `（${(Number(rejected.ratio_over) * 100).toFixed(3)}%）` : "";
  const tolerance = Number(rejected.tolerance);
  const tolText = Number.isFinite(tolerance) && tolerance > 0 && tolerance < 1e-3 ? tolerance.toExponential().replace(/\.0+e/, "e") : String(rejected.tolerance);
  return `匯出誤差超過 ${tolText}：${Number.isFinite(over) ? over : "?"} / ${Number.isFinite(rows) ? rows : "?"} 列${ratio}`;
}

/** 每個預測的兩種模型: 上漲 and 下跌 side by side, one row per prediction with the winner's AUC and LogLoss; the row
 * opens to both models and the constant baseline. `isOpen(key)` says which rows are open (or still closing): their
 * detail is drawn shown, the others' drawn hidden (expand_motion.js plays the change). */
export function renderPairCards(slots, { isOpen = () => false } = {}) {
  const card = (slot) => {
    const valid = slot.candidates.filter((c) => !c.rejected);
    const bestAuc = Math.max(...valid.map((c) => Number(c.validation_auc) || 0));
    const bestLoss = Math.min(...valid.map((c) => (Number.isFinite(Number(c.validation_log_loss)) ? Number(c.validation_log_loss) : Infinity)));
    const rows = slot.candidates.map((c) => c.rejected
      ? `<div class="mc-pair-row rejected"><span class="mc-pair-kind">${kindName(c.kind)}</span><span class="mc-pair-note">匯出檢查未通過</span></div>`
      : `<div class="mc-pair-row${c.winner ? " win" : ""}"><span class="mc-pair-kind">${kindName(c.kind)}${c.winner ? " ★" : ""}</span>
          <span class="${Number(c.validation_auc) === bestAuc ? "mc-best" : ""}">${f3(c.validation_auc)}</span>
          <span class="${Number(c.validation_log_loss) === bestLoss ? "mc-best" : ""}">${f4(c.validation_log_loss)}</span></div>`).join("")
      // The constant a winner must beat to go live (the training positive ratio for every row): no AUC of its own.
      + (slot.candidates.length && slot.baseline_log_loss != null
        ? `<div class="mc-pair-row baseline"><span class="mc-pair-kind">常數基準</span><span>--</span><span>${f4(slot.baseline_log_loss)}</span></div>`
        : "");
    const error = slot.candidates_error;
    const empty = error
      ? `<div class="mc-pair-note mc-weak">${escapeHtml(RUN_STATE[error.kind] || error.kind)}</div>`
      : '<div class="mc-pair-note">尚未訓練</div>';
    const key = slotKey(slot);
    const open = isOpen(key);
    const winner = slot.candidates.find((c) => c.winner && !c.rejected);
    const summary = winner
      ? `<span class="settings-item-value">${kindName(winner.kind)} 勝出</span></span><span class="mc-pair-figure">AUC <b>${f3(winner.validation_auc)}</b></span>`
        + `<span class="mc-pair-figure">LogLoss <b>${f4(winner.validation_log_loss)}</b></span>`
      : "</span>";
    return `<button type="button" class="settings-item is-clickable mc-pair" data-pair-slot="${escapeHtml(key)}" aria-expanded="${open}">`
      + `<span class="record-expand-chevron" aria-hidden="true">›</span><span class="settings-item-main"><b>${slotName(slot)}</b>${summary}</button>`
      + `<div class="mc-pair-detail" data-morph-key="pair-detail-${escapeHtml(key)}"${open ? "" : " hidden"}><div class="mc-pair-list">`
      + `<div class="mc-pair-row head"><span></span><span>AUC</span><span>LogLoss</span></div>${rows || empty}</div></div>`;
  };
  return ["up", "down"].map((direction) => {
    const items = sortedSlots(slots, direction);
    return items.length ? `<div><div class="settings-group-title"><span>${DIRECTION[direction]}</span></div>`
      + `<div class="settings-group">${items.map(card).join("")}</div></div>` : "";
  }).join("");
}

function sortedSlots(slots, direction) {
  return (slots || []).filter((slot) => !direction || slot.direction === direction)
    .sort((a, b) => (a.direction === b.direction ? a.horizon_minutes - b.horizon_minutes : a.direction === "up" ? -1 : 1));
}

const IMPORTANCE_METHOD = { standardized_coefficient: "標準化係數", gain: "gain 佔比" };

/** The horizons 特徵權重 can show (those with a slot), and the one shown: `selected` when there is one, else the first. */
export function importanceHorizons(slots, selected) {
  const minutes = [...new Set((slots || []).map((slot) => Number(slot.horizon_minutes)).filter(Number.isFinite))].sort((a, b) => a - b);
  return { minutes, shown: minutes.includes(Number(selected)) ? Number(selected) : (minutes[0] ?? null) };
}

/** The horizon buttons above the two 特徵權重 cards. */
export function renderImportanceHorizons(slots, selected) {
  const { minutes, shown } = importanceHorizons(slots, selected);
  return minutes.map((m) => `<button type="button" class="settings-seg-btn mc-imp-horizon${m === shown ? " is-active" : ""}" data-horizon="${m}">${m} 分</button>`).join("");
}

/** 特徵權重: one card for 上漲 and one for 下跌 at the shown horizon, each the live model's top features by |weight|
 * (api/training_application.py top_importance). Logistic weights are signed (+ raises the probability); LightGBM's
 * gain has no sign. A model trained before the manifest carried it shows that it has none. */
export function renderImportanceCards(slots, selected) {
  const { shown } = importanceHorizons(slots, selected);
  return ["up", "down"].map((direction) => {
    const slot = (slots || []).find((s) => s.direction === direction && Number(s.horizon_minutes) === shown);
    const imp = slot?.feature_importance;
    const title = `<div class="mc-imp-title"><span>${escapeHtml(`${shown ?? "--"} 分${DIRECTION[direction]}`)}</span>`
      + (imp ? `<span class="mc-imp-method">${kindName(imp.kind)} · ${escapeHtml(IMPORTANCE_METHOD[imp.method] || imp.method || "")}</span>` : "")
      + "</div>";
    if (!imp?.top?.length) {
      return `<div class="settings-group">${title}<div class="mc-imp-empty">${slot?.model ? "這個模型訓練時尚未記錄特徵權重，重新訓練後顯示" : "尚未訓練"}</div></div>`;
    }
    const max = Math.max(...imp.top.map((f) => numberOrNull(f.share) ?? 0)) || 1;
    const rows = imp.top.map((f, index) => {
      const value = numberOrNull(f.value);
      const share = numberOrNull(f.share) ?? 0;
      const sign = imp.signed && value !== null ? (value > 0 ? " up" : value < 0 ? " down" : "") : "";
      const shown = imp.signed ? (value === null ? "--" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(3)}`)
        : `${(share * 100).toFixed(1)}%`;
      return `<div class="mc-imp-row${sign}"><span class="mc-imp-rank">${index + 1}</span><span class="mc-imp-name">${escapeHtml(f.name)}</span>`
        + `<span class="job-bar"><i class="mc-imp-fill" style="width:${Math.round((share / max) * 100)}%"></i></span><span class="mc-imp-value">${shown}</span></div>`;
    }).join("");
    const note = imp.signed ? "＋ 提高機率、− 降低機率" : "LightGBM 的 gain 沒有方向";
    return `<div class="settings-group">${title}${rows}<div class="mc-imp-note">前 ${imp.top.length} / ${int(imp.features)} 個特徵 · ${note}</div></div>`;
  }).join("");
}
