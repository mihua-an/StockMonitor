import assert from "node:assert/strict";

// 資料中心's 收盤整理 card (features/data_center/closing_progress_view.js): /api/data-center/closing drawn with the
// job-status component -- steps named by the next close, bar, 執行紀錄, and beside them 下次物化 over the 上次物化
// rows -- with every value escaped.

const view = await import("../ui/renderer/js/features/data_center/closing_progress_view.js");
const at = (h, m, s = 0, day = 29) => new Date(2026, 9, day, h, m, s).getTime();
const iso = (h, m, s = 0, day = 29) => new Date(at(h, m, s, day)).toISOString();
const epoch = (h, m, s = 0) => at(h, m, s) / 1000;

const session = (id, accepted, extra = {}) => {
  const [market, sess] = id.split(":");
  return { id, market, session: sess, seal_due_at: market === "FUT" ? iso(13, 45) : iso(14, 40), accepted, sealed: false,
    state: "none", attempts: null, max_attempts: 5, next_attempt_at: null, last_error: null, submitted_at: null, updated_at: null,
    result: null, job: null, ...extra };
};
const futDay = { id: "FUT:DAY", trading_date: "2026-10-29", stage: "done", ended_at: iso(13, 46), codes: 1, events: 169257, gaps: ["FUT:DAY"] };

// 台股 before its seal time: step 1 runs, each step is named by the close, 下次物化 counts down to 14:40.
const waiting = { id: "STK:DAY", trading_date: "2026-10-29", stage: "waiting_close", settled_at: null,
  sessions: [session("STK:DAY", 1000), session("IDX:DAY", 100)],
  next: { id: "STK:DAY", trading_date: "2026-10-29", seal_due_at: iso(14, 40) }, history: [futDay] };
let steps = view.renderClosingSteps(waiting, at(14, 0));
assert.equal((steps.match(/job-step now/g) || []).length, 1);
assert.match(steps, /job-step-h">台股 收盤<\/div><div class="job-step-v">14:40 封存/);
assert.match(steps, /job-step-h">台股 封存</);
assert.match(steps, /job-step-h">台股 整理</);
assert.match(steps, /job-step todo"><div class="job-step-n">4<\/div><div class="job-step-h">完成</);
assert.equal(view.renderClosingBar(waiting), "", "no bar before the materializer runs");
let log = view.renderClosingLog(waiting, at(14, 0));
assert.match(log, /job-log-name">台股 收盤</);
assert.match(log, /指數 封存時間/);
assert.doesNotMatch(log, /步驟 2/, "a step not reached is not listed");
assert.equal(view.closingPollMs(waiting), 30000);
let next = view.renderClosingNext(waiting, at(14, 0));
assert.match(next, /<small>下次物化<\/small><b>台股<\/b>/);
assert.match(next, /<small>時間<\/small><b>10\/29 14:40<\/b>/);
assert.match(next, /<small>倒數<\/small><b>40 分 0 秒<\/b>/);
assert.doesNotMatch(next, /已花時間/, "nothing runs yet");
let history = view.renderClosingHistory(waiting);
assert.doesNotMatch(history, /上次物化/, "no title over the rows: the room is theirs");
assert.match(history, /<td>期貨日盤 10\/29<\/td><td>完成<\/td><td>1 檔 · 169k 筆<\/td><td><span class="settings-badge is-warn">有缺口：期貨日盤<\/span><\/td><td>10\/29 13:46<\/td>/);

// STK running (in `write`, counted in events), IDX done; 下次 is the night. The time left and the share done are the
// provider's one estimate (closing_progress.py): the card's 預估剩餘 and the job's eta are that same number.
const running = { id: "STK:DAY", trading_date: "2026-10-29", stage: "materializing", settled_at: null, sessions: [
  session("STK:DAY", 3_113_766, { sealed: true, state: "running", attempts: 1, submitted_at: epoch(14, 40, 2), remaining_s: 61,
    job: { job_id: "s1", status: "running", started_at: iso(14, 40, 5), phase: "write",
      phases: { scan: { done: 87, total: 87, elapsed_ms: 3282 }, read: { done: 7_086_938, total: 7_086_938, elapsed_ms: 49_260 },
        write: { done: 1_500_000, total: 3_113_766, elapsed_ms: 34_000 } } } }),
  session("IDX:DAY", 48_000, { sealed: true, state: "succeeded", attempts: 2, submitted_at: epoch(14, 40, 2), updated_at: epoch(14, 40, 50),
    result: { codes: 15, events: 49276, completeness: "complete", completed_at: iso(14, 40, 50) } }),
], estimate: { elapsed_s: 90, remaining_s: 61, fraction: 90 / 151 },
next: { id: "FUT:NIGHT", trading_date: "2026-10-29", seal_due_at: iso(5, 0, 0, 30) }, history: [futDay] };
const pct = view.closingPercent(running);
assert.equal(pct, 59, "the estimate's share done");
assert.match(view.renderClosingBar(running), new RegExp(`width:${pct}%`));
steps = view.renderClosingSteps(running, at(14, 41));
assert.match(steps, /股票 · write（1\/2）/);
next = view.renderClosingNext(running, at(14, 41, 35));
assert.match(next, /已花時間<\/small><b>1 分 30 秒/);
assert.match(next, /預估剩餘<\/small><b>約 1 分 1 秒/);
assert.match(next, /<small>下次物化<\/small><b>期貨夜盤<\/b>.*<small>時間<\/small><b>10\/30 05:00<\/b>/s);
assert.match(next, /<small>倒數<\/small><b>14 小時 18 分<\/b>/);
log = view.renderClosingLog(running, at(14, 41, 35));
assert.match(log, /股票 WAL 3\.11M 筆 → 歷史資料/);
assert.match(log, /job-log-phase done">read<\/span><span class="job-log-phase now">write/, "the running job's phases");
assert.match(log, /1\.50M\/3\.11M  44\.1k\/s  0:00:34  eta 0:01:01/, "write's rate in events a second; eta = the card's 預估剩餘");
// No estimate yet (no rate to go by): both say so.
const unknown = { ...running, estimate: { elapsed_s: 2, remaining_s: null, fraction: null },
  sessions: [{ ...running.sessions[0], remaining_s: null, job: { ...running.sessions[0].job, phase: "scan",
    phases: { scan: { done: 0, total: 0, elapsed_ms: 1000 } } } }, running.sessions[1]] };
assert.match(view.renderClosingNext(unknown), /預估剩餘<\/small><b>--/);
assert.match(view.renderClosingLog(unknown), /0\/0  --  0:00:01  eta --/, "a phase that has done nothing has no rate yet");
assert.match(log, /指數 15 檔 · 49\.3k 筆 · 完整（第 2 次）/);
assert.equal(view.closingPollMs(running), 2000);

// A failure waiting for its retry, and an error that is markup.
const retry = { ...waiting, stage: "retry_wait", sessions: [
  session("STK:DAY", 10, { sealed: true, state: "failed_retryable", attempts: 1, next_attempt_at: epoch(14, 50),
    last_error: "<b>disk</b>", submitted_at: epoch(14, 40) }) ]};
log = view.renderClosingLog(retry, at(14, 45));
assert.match(log, /股票 第 1 次失敗：&lt;b&gt;disk&lt;\/b&gt;，14:50 重試/);
assert.match(view.renderClosingSteps(retry), /等待重試/);

// Done: every step done, the settlement listed; 上次物化 lists each kind once, a failure in the error colour.
const done = { ...running, stage: "done", settled_at: iso(14, 43, 26), estimate: null, sessions: running.sessions.map((s) => s.id === "STK:DAY"
  ? { ...s, state: "succeeded", remaining_s: null, job: { ...s.job, status: "materialized", ended_at: iso(14, 43, 20) },
      result: { codes: 76, events: 2_895_390, completeness: "complete", completed_at: iso(14, 43, 20) } } : s),
  history: [{ id: "STK:DAY", trading_date: "2026-10-29", stage: "done", ended_at: iso(14, 43, 26), codes: 91, events: 2_944_666, gaps: [] },
    futDay, { id: "FUT:NIGHT", trading_date: "2026-10-28", stage: "failed", ended_at: null, codes: 0, events: 0, gaps: [] }] };
steps = view.renderClosingSteps(done, at(15, 0));
assert.equal((steps.match(/job-step done/g) || []).length, 4);
assert.match(steps, /14:43 完成，交給自動訓練/);
assert.equal(view.renderClosingBar(done), "");
log = view.renderClosingLog(done, at(15, 0));
assert.match(log, /收盤資料已就緒，自動訓練從這裡開始/);
assert.match(log, /股票 76 檔 · 2\.90M 筆 · 完整<\/span><span class="job-log-dur">3 分 15 秒/);
history = view.renderClosingHistory(done);
assert.equal((history.match(/<tr data-morph-key/g) || []).length, 3);
assert.match(history, /<td>台股 10\/29<\/td><td>完成<\/td><td>91 檔 · 2\.94M 筆<\/td><td><span class="settings-badge is-pass">完整<\/span><\/td><td>10\/29 14:43<\/td>/);
assert.match(history, /<td>期貨夜盤 10\/28<\/td><td class="error">失敗<\/td>/);

// 執行紀錄 keeps the last close until the next one reaches its seal time; the steps and 下次物化 are the next one's.
const night = { id: "FUT:NIGHT", trading_date: "2026-10-29", stage: "waiting_close", settled_at: null,
  sessions: [session("FUT:NIGHT", 50, { seal_due_at: iso(5, 0, 0, 30) })], last: done,
  next: { id: "FUT:NIGHT", trading_date: "2026-10-29", seal_due_at: iso(5, 0, 0, 30) }, history: done.history };
assert.equal(view.loggedClose(night), done);
log = view.renderClosingLog(night, at(16, 0));
assert.match(log, /job-log-name">台股 整理</);
assert.match(log, /收盤資料已就緒，自動訓練從這裡開始/);
assert.doesNotMatch(log, /期貨夜盤/, "the next close's lines wait for its seal time");
assert.match(view.renderClosingSteps(night, at(16, 0)), /job-step now"><div class="job-step-n">1<\/div><div class="job-step-h">期貨夜盤 收盤/);
log = view.renderClosingLog({ ...night, stage: "waiting_seal" }, at(5, 1, 0, 30));
assert.match(log, /期貨夜盤 等待封存/, "past its seal time the log is the next close's");

// 美股 (Futu US, one session, no daily summary): named in the steps, the log and 上次物化.
const us = { id: "US:FULL", source: "futu", trading_date: "2026-10-29", stage: "materializing", settled_at: null, sessions: [
  { ...session("US:FULL", 1_691_282), source: "futu", seal_due_at: iso(12, 10, 0, 30), sealed: true, state: "running", attempts: 1,
    submitted_at: epoch(12, 10), job: { job_id: "u1", status: "running", started_at: iso(12, 10, 2, 30), phase: "write",
      phases: { scan: { done: 3, total: 3 }, read: { done: 1, total: 1 }, write: { done: 20, total: 40 } } } }],
  next: { id: "FUT:DAY", trading_date: "2026-10-30", seal_due_at: iso(13, 45, 0, 30) },
  history: [{ id: "US:FULL", trading_date: "2026-10-28", stage: "done", ended_at: iso(12, 14, 0, 29), codes: 12, events: 1_500_000, backfilled: 2_839, gaps: ["US:FULL"] }] };
assert.match(view.renderClosingSteps(us, at(12, 11, 0, 30)), /job-step-h">美股 整理</);
log = view.renderClosingLog(us, at(12, 11, 0, 30));
assert.match(log, /美股 WAL 1\.69M 筆 → 歷史資料/);
assert.doesNotMatch(log, /summary/, "Futu writes no daily summary");
assert.match(view.renderClosingHistory(us), /<td>美股 10\/28<\/td><td>完成<\/td><td>12 檔 · 1\.50M 筆（含補回 2\.8k 筆）<\/td><td><span class="settings-badge is-warn">有缺口：美股<\/span><\/td>/);

// Nothing recorded yet.
assert.match(view.renderClosingLog({ sessions: [] }), /還沒有收盤紀錄/);
assert.match(view.renderClosingHistory({}), /還沒有物化紀錄/);
assert.match(view.renderClosingNext({ next: null }), /<small>下次物化<\/small><b>--<\/b>/);

console.log("renderer closing progress contract passed");
