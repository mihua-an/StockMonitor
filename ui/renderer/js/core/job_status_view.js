// job-status (styles/components/job-status.css): how a background job's state reads on every page that shows one --
// 模型中心's 訓練狀態 (pages/training/model_center_view.js) and 資料中心's 收盤整理 (features/data_center/
// closing_progress_view.js). Pure HTML; every caller passes text already escaped.
import { numberOrNull } from "./numbers.js";

export function formatSpan(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} 小時 ${m} 分`;
  if (m) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

/** Seconds as h:mm:ss. */
export function clockSpan(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** A whole count with thousands separators: 1,234 ("--" when missing, never 0). Every 資料中心 / 模型中心 count. */
export const int = (v) => (numberOrNull(v) === null ? "--" : Math.round(numberOrNull(v)).toLocaleString("en-US"));

/** A count the way a command line shows it (decisions.md 筆數: k, never 萬): 980, 9.8k, 123k, 2.41M. */
export function compactCount(n) {
  const v = numberOrNull(n);
  if (v === null) return "--";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** A local time of day, hh:mm:ss ("--" for no time). */
export function clockTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One step on the step bar: `state` done / now / todo, `pct` the running step's own bar. Its dot carries its number,
 * a check mark once done. A step not started, or one given no text, shows only its name. */
export function stepCard(index, title, text, state, pct) {
  const body = state === "todo" || !text ? "" : `<div class="job-step-v">${text}</div>`;
  return `<div class="job-step ${state}"><div class="job-step-n">${state === "done" ? "✓" : index + 1}</div><div class="job-step-h">${title}</div>${body}`
    + `<div class="job-step-bar"><i style="width:${pct}%"></i></div></div>`;
}

/** The progress bar under the steps. */
export function progressBar(pct) {
  return `<div class="job-bar"><i class="job-bar-fill" style="width:${pct}%"></i></div>`;
}

/** One figure: a settings-item row, its name on the left and its value at the end. */
export function figure(label, value, valueClass = "") {
  return `<div class="settings-item"><small>${label}</small><b${valueClass ? ` class="${valueClass}"` : ""}>${value}</b></div>`;
}

/** 進度 / 已花時間 / 預估剩餘 of a running job: the remaining time from the share done so far, unless the caller knows
 * it better (`remainingSeconds`). */
export function runningFigures(pct, elapsedSeconds, remainingSeconds) {
  const remaining = remainingSeconds !== undefined ? remainingSeconds
    : elapsedSeconds && pct > 3 ? elapsedSeconds * (100 - pct) / pct : null;
  return figure("進度", `${pct}%`) + figure("已花時間", elapsedSeconds == null ? "--" : formatSpan(elapsedSeconds))
    + figure("預估剩餘", remaining == null ? "--" : `約 ${formatSpan(remaining)}`);
}

/** One 執行紀錄 line; `state` done / now / warn / error / todo, `below` what shows under it (a phase pip). */
export function logRow(key, state, icon, time, text, took, below = "") {
  return `<div class="job-log-row ${state}" data-morph-key="${key}">`
    + `<span class="job-log-time">${time}</span><span class="job-log-icon">${icon}</span>`
    + `<span class="job-log-text">${text}</span><span class="job-log-dur">${took}</span>${below}</div>`;
}

/** A step's lines under its head (步驟 n, its name, how long it took). */
export function logGroup(index, name, state, took, rows) {
  return `<div class="job-log-group ${state}" data-morph-key="step-${index}"><div class="job-log-head">`
    + `<span class="job-log-step">步驟 ${index + 1}</span><span class="job-log-name">${name}</span>`
    + `<span class="job-log-dur">${took}</span></div>${rows.join("")}</div>`;
}

/** The 執行紀錄 list: one child, so the log box (column-reverse) opens, and stays, scrolled to the newest line. */
export function logList(html) {
  return `<div class="job-log-list">${html.join("")}</div>`;
}

export function logEmpty(text) {
  return `<div class="job-log-empty">${text}</div>`;
}

// A phase's { done, total, elapsed_ms } as numbers, and its rate (none before it has done anything).
function phaseFigures(figures) {
  const done = numberOrNull(figures?.done) ?? 0;
  const total = numberOrNull(figures?.total) ?? 0;
  const seconds = (numberOrNull(figures?.elapsed_ms) ?? 0) / 1000;
  return { done, total, seconds, rate: seconds > 0 && done > 0 ? done / seconds : null };
}

/** Seconds left of one phase at the rate it has gone so far (null before it has a rate). */
export function phaseRemaining(figures) {
  const { done, total, rate } = phaseFigures(figures);
  return rate ? Math.max(0, total - done) / rate : null;
}

/** The pip-style lines under a running item: its phases (done ✓, current ▸), then the current phase's bar, percent,
 * done/total, rate, time spent and `left`, the time left as the caller's job estimates it (seconds, null unknown).
 * `figures` is the phase's { done, total, elapsed_ms }. */
export function phasePip(phases, phase, figures, left) {
  const at = phases.indexOf(phase);
  if (at < 0) return "";
  const { done, total, seconds, rate } = phaseFigures(figures);
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  const marks = phases.map((name, index) => `<span class="job-log-phase${index < at ? " done" : index === at ? " now" : ""}">${name}</span>`).join("");
  const pct = Math.floor(fraction * 100);
  return `<div class="job-log-pip"><div class="job-log-phases">${marks}</div>`
    + `<div class="job-log-bar-line"><span>${phase}</span><span class="job-log-bar"><i style="width:${pct}%"></i></span>`
    + `<span class="job-log-figs"><b>${pct}%</b>  ${compactCount(done)}/${compactCount(total)}  ${rate === null ? "--" : `${compactCount(rate)}/s`}`
    + `  ${clockSpan(seconds)}  eta ${left == null ? "--" : clockSpan(left)}</span></div></div>`;
}
