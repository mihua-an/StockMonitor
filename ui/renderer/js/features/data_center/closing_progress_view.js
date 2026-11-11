// 資料中心's 收盤整理 card (user 10-29, 10-30): the next close to be materialized, as /api/data-center/closing
// (service/market/lifecycle/closing_progress.py) reports it, drawn with the job-status component like 模型中心's 訓練狀態:
// four steps named by the close (期貨夜盤 收盤 -> 封存 -> 整理 -> 完成), the progress bar while the materializer runs, the
// 執行紀錄 under each step, and beside it 下次物化 (what, when, countdown) over the 上次物化 rows. Pure HTML: every value
// from the payload is escaped here.
import { escapeHtml } from "../../core/utility.js";
import { numberOrNull } from "../../core/numbers.js";
import { compactCount, clockTime, int, formatSpan, figure, logEmpty, logGroup, logList, logRow, phasePip, progressBar, runningFigures,
  stepCard } from "../../core/job_status_view.js";

const NAME = { "STK:DAY": "股票", "IDX:DAY": "指數", "FUT:DAY": "期貨日盤", "FUT:NIGHT": "期貨夜盤", "US:FULL": "美股", "HK:FULL": "港股" };
// A close is named by its first session; 台股 is STK and IDX, sealed together; a Futu market is one close of its own.
const CLOSE_NAME = { "FUT:DAY": "期貨日盤", "STK:DAY": "台股", "FUT:NIGHT": "期貨夜盤", "US:FULL": "美股", "HK:FULL": "港股" };
const STEP_NAMES = ["收盤", "封存", "整理", "完成"];
// The job's phases (native/analysis_runtime/src/materialize.rs). Only Shioaji STK and IDX write a daily summary.
const PHASES = ["scan", "read", "write", "summary"];
const SUMMARIZED = new Set(["STK", "IDX"]);
const FINISHED = new Set(["succeeded", "no_input", "failed_terminal"]);
// Which step each stage stands on (closing_progress.py _stage).
const STAGE_STEP = { waiting_close: 0, waiting_seal: 1, materializing: 2, retry_wait: 2, failed: 2, done: 4 };

const sessionName = (s) => escapeHtml(NAME[s?.id] || `${s?.market || ""} ${s?.session || ""}`);
const closeName = (id) => escapeHtml(CLOSE_NAME[id] || id || "--");
const shortDate = (date) => escapeHtml(String(date || "").slice(5).replace("-", "/"));
// A step's title carries the close it is about; 完成 alone.
const stepTitle = (payload, index) => (index < 3 && payload?.id ? `${closeName(payload.id)} ${STEP_NAMES[index]}` : STEP_NAMES[index]);
const epochIso = (seconds) => (numberOrNull(seconds) === null ? null : new Date(numberOrNull(seconds) * 1000).toISOString());
const ms = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const hhmm = (iso) => clockTime(iso).slice(0, 5);
// A local MM/DD of a time ("--" for none).
const localDay = (iso) => { const t = ms(iso); if (t === null) return "--"; const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`; };
const span = (from, to) => { const a = ms(from), b = ms(to); return a !== null && b !== null && b >= a ? formatSpan((b - a) / 1000) : ""; };

/** The close's materialization done, 0..100: the provider's estimate while it runs (closing_progress.py, the same one
 * 預估剩餘 shows); without one, the sessions finished, weighted by the events they hold. */
export function closingPercent(payload) {
  const fraction = numberOrNull(payload?.estimate?.fraction);
  if (fraction !== null) return Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
  const sessions = payload?.sessions || [];
  const weight = (s) => Math.max(1, numberOrNull(s.accepted) ?? 0);
  const total = sessions.reduce((sum, s) => sum + weight(s), 0);
  if (!total) return 0;
  return Math.floor((sessions.reduce((sum, s) => sum + (FINISHED.has(s.state) ? weight(s) : 0), 0) / total) * 100);
}

function stepAt(payload) {
  return STAGE_STEP[payload?.stage] ?? 0;
}

export function renderClosingSteps(payload, now = Date.now()) {
  const sessions = payload?.sessions || [];
  const at = stepAt(payload);
  const due = sessions.filter((s) => ms(s.seal_due_at) !== null);
  const past = due.filter((s) => ms(s.seal_due_at) <= now).length;
  const sealed = sessions.filter((s) => s.sealed).length;
  const finished = sessions.filter((s) => FINISHED.has(s.state)).length;
  const running = sessions.find((s) => s.state === "running");
  const totals = sessions.reduce((sum, s) => ({ codes: sum.codes + (numberOrNull(s.result?.codes) ?? 0), events: sum.events + (numberOrNull(s.result?.events) ?? 0) }), { codes: 0, events: 0 });
  const times = [...new Set(due.map((s) => hhmm(s.seal_due_at)))].sort().join("、");
  const texts = [
    times ? `${escapeHtml(times)} 封存` : "--",
    `${sealed} / ${sessions.length} 個交易時段已封存`,
    running ? `${sessionName(running)} · ${escapeHtml(running.job?.phase || "等待開始")}（${finished}/${sessions.length}）`
      : at === 2 && payload?.stage === "retry_wait" ? "等待重試" : at === 2 && payload?.stage === "failed" ? "整理失敗"
        : `${int(totals.codes)} 檔 · ${compactCount(totals.events)} 筆`,
    payload?.settled_at ? `${hhmm(payload.settled_at)} 完成，交給自動訓練` : `${shortDate(payload?.trading_date)} 已整理`,
  ];
  const inner = [due.length ? past / due.length : 0, sessions.length ? sealed / sessions.length : 0, closingPercent(payload) / 100, 0];
  return texts.map((text, index) => {
    const state = index < at ? "done" : index === at ? "now" : "todo";
    const pct = state === "done" ? 100 : state === "now" ? Math.round(inner[index] * 100) : 0;
    return stepCard(index, stepTitle(payload, index), text, state, pct);
  }).join("");
}

/** The bar under the steps, while the materializer runs. */
export function renderClosingBar(payload) {
  return payload?.stage === "materializing" ? progressBar(closingPercent(payload)) : "";
}

const COMPLETENESS = { complete: "完整", gap_detected: "有缺口" };

/** 「N 筆」: the market events written -- the WAL's accepted, plus what a fill added from the broker's history. */
export function eventsText(events, backfilled) {
  const filled = numberOrNull(backfilled) ?? 0;
  return `${compactCount(events)} 筆${filled > 0 ? `（含補回 ${compactCount(filled)} 筆）` : ""}`;
}

/** 進度 / 已花時間 / 預估剩餘 while the materializer runs (the provider's estimate), then 下次物化: what, when it
 * starts (its seal time) and the countdown to it. */
export function renderClosingNext(payload, now = Date.now()) {
  const estimate = payload?.estimate;
  const running = payload?.stage === "materializing"
    ? runningFigures(closingPercent(payload), numberOrNull(estimate?.elapsed_s), numberOrNull(estimate?.remaining_s)) : "";
  const next = payload?.next;
  const at = ms(next?.seal_due_at);
  const when = at === null ? "--" : `${localDay(next.seal_due_at)} ${escapeHtml(hhmm(next.seal_due_at))}`;
  const left = at === null ? "--" : at > now ? formatSpan((at - now) / 1000) : "時間已到";
  return running + figure("下次物化", next ? closeName(next.id) : "--") + figure("時間", when) + figure("倒數", left);
}

const STATE_TEXT = { done: "完成", failed: "失敗" };

/** 上次物化: the closes that ended, newest first, one of each kind -- 狀態, 歷史資料, 完整性, 完成時間. */
export function renderClosingHistory(payload) {
  const rows = payload?.history || [];
  const body = rows.length ? rows.map((row) => {
    const gaps = (row.gaps || []).map((id) => escapeHtml(NAME[id] || id));
    const ended = ms(row.ended_at) === null ? "--" : `${localDay(row.ended_at)} ${escapeHtml(hhmm(row.ended_at))}`;
    return `<tr data-morph-key="${escapeHtml(`${row.id}:${row.trading_date}`)}"><td>${closeName(row.id)} ${shortDate(row.trading_date)}</td>`
      + `<td${row.stage === "failed" ? ' class="error"' : ""}>${STATE_TEXT[row.stage] || escapeHtml(row.stage)}</td>`
      + `<td>${int(row.codes)} 檔 · ${eventsText(row.events, row.backfilled)}</td>`
      + `<td>${gaps.length ? `<span class="settings-badge is-warn">有缺口：${gaps.join("、")}</span>` : '<span class="settings-badge is-pass">完整</span>'}</td><td>${ended}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty">還沒有物化紀錄</td></tr>`;
  return `<table class="data-table dc-closing-history-table">`
    + `<thead><tr><th>物化</th><th>狀態</th><th>歷史資料</th><th>完整性</th><th>完成時間</th></tr></thead><tbody>${body}</tbody></table>`;
}

function jobRow(s, now) {
  const name = sessionName(s);
  const job = s.job;
  const start = job?.started_at || epochIso(s.submitted_at);
  const key = escapeHtml(`job:${s.id}:${job?.job_id || s.attempts || ""}`);
  const attempt = numberOrNull(s.attempts) > 1 ? `（第 ${int(s.attempts)} 次）` : "";
  if (s.state === "running" || s.state === "pending" || s.state === "intent_pending") {
    const running = job?.status === "running";
    const below = running ? phasePip(SUMMARIZED.has(s.market) ? PHASES : PHASES.slice(0, 3), job.phase, job.phases?.[job.phase],
      numberOrNull(s.remaining_s)) : "";
    return logRow(key, "now", "●", clockTime(start), `${name} WAL ${compactCount(s.accepted)} 筆 → 歷史資料${attempt}`,
      running ? span(job.started_at, new Date(now).toISOString()) : "", below);
  }
  if (s.state === "succeeded" || s.state === "no_input") {
    const r = s.result || {};
    const text = s.state === "no_input" ? `${name} 沒有資料`
      : `${name} ${int(r.codes)} 檔 · ${eventsText(r.events, r.backfilled)} · ${COMPLETENESS[r.completeness] || escapeHtml(r.completeness || "--")}${attempt}`;
    return logRow(key, "done", "✓", clockTime(start), text, span(start, job?.ended_at || r.completed_at || epochIso(s.updated_at)));
  }
  const error = escapeHtml(s.last_error || job?.error || "");
  if (s.state === "failed_retryable") {
    const retry = epochIso(s.next_attempt_at);
    return logRow(key, "warn", "!", clockTime(start), `${name} 第 ${int(s.attempts)} 次失敗${error ? `：${error}` : ""}${retry ? `，${hhmm(retry)} 重試` : ""}`, "");
  }
  if (s.state === "failed_terminal") {
    return logRow(key, "error", "✕", clockTime(start), `${name} 失敗（${int(s.attempts)}/${int(s.max_attempts)} 次）${error ? `：${error}` : ""}`, "");
  }
  return logRow(key, "todo", "·", "--", `${name} 等待整理`, "");
}

/** The close 執行紀錄 is about: the last one that ended stays until the shown close reaches its seal time. */
export function loggedClose(payload) {
  return payload?.stage === "waiting_close" && payload?.last ? payload.last : payload;
}

/** 執行紀錄: each step's lines -- the seal times, the seals, every session's job, the settlement. */
export function renderClosingLog(payload, now = Date.now()) {
  const close = loggedClose(payload);
  const sessions = close?.sessions || [];
  if (!sessions.length) return logEmpty("還沒有收盤紀錄");
  const at = stepAt(close);
  const groupState = (index) => (index < at ? "done" : index === at ? (close?.stage === "failed" ? "warn" : "now") : "todo");
  const groups = [];
  const due = sessions.map((s) => {
    const passed = ms(s.seal_due_at) !== null && ms(s.seal_due_at) <= now;
    return logRow(escapeHtml(`due:${s.id}`), passed ? "done" : "now", passed ? "✓" : "●", clockTime(s.seal_due_at), `${sessionName(s)} 封存時間`, "");
  });
  groups.push(logGroup(0, stepTitle(close, 0), groupState(0), "", due));
  if (at >= 1) {
    const seals = sessions.map((s) => (s.sealed
      ? logRow(escapeHtml(`seal:${s.id}`), "done", "✓", clockTime(epochIso(s.submitted_at)), `${sessionName(s)} 已封存，送出整理`, "")
      : logRow(escapeHtml(`seal:${s.id}`), "now", "●", "--", `${sessionName(s)} 等待封存`, "")));
    groups.push(logGroup(1, stepTitle(close, 1), groupState(1), "", seals));
  }
  if (at >= 2) {
    const jobs = sessions.filter((s) => s.sealed).map((s) => jobRow(s, now));
    groups.push(logGroup(2, stepTitle(close, 2), groupState(2), "", jobs));
  }
  if (at >= 4 && close?.settled_at) {
    groups.push(logGroup(3, STEP_NAMES[3], "done", "",
      [logRow("settled", "done", "✓", clockTime(close.settled_at), "收盤資料已就緒，自動訓練從這裡開始", "")]));
  } else if (at >= 4) {
    groups.push(logGroup(3, STEP_NAMES[3], "done", "", [logRow("finished", "done", "✓", "--", `${closeName(close.id)} 已整理`, "")]));
  }
  return logList(groups);
}

/** How often the card asks again: every 2 s while something moves, every 30 s while it waits for the clock. */
export function closingPollMs(payload) {
  return ["materializing", "waiting_seal"].includes(payload?.stage) ? 2000 : 30000;
}
