import assert from "node:assert/strict";

// 模型中心 執行紀錄: the job's `log` (online_training/job.py) under the four step cards, oldest first (newest at the
// bottom), one line per step naming the data it works on; a step left open by a job that is gone is marked, and its
// time stops at the last update.

const view = await import("../ui/renderer/js/pages/training/model_center_view.js");
const jobView = await import("../ui/renderer/js/core/job_status_view.js");
const at = (m, s) => `2026-10-28T07:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;
const log = [
  { step: "checking", started_at: at(0, 4), ended_at: at(0, 6) },
  { step: "features 2026-10-27", started_at: at(0, 6), ended_at: at(2, 0), detail: { reused: true } },
  { step: "features 2026-10-28", started_at: at(2, 0), ended_at: at(5, 0), detail: { reused: false } },
  { step: "dataset", started_at: at(5, 0), ended_at: at(5, 10) },
  { step: "split", started_at: at(5, 10), ended_at: at(5, 12), detail: { kind: "by_date" } },
  { step: "train 3m_up", started_at: at(5, 12), ended_at: at(5, 14) },
  { step: "train 3m_up lightgbm", started_at: at(5, 14), ended_at: null },
];
const job = { state: "RUNNING", mode: "manual", step: "train 3m_up lightgbm", started_at: at(0, 4), updated_at: at(5, 14), log,
  window: ["2026-10-21", "2026-10-22", "2026-10-27", "2026-10-28"] };

const running = view.renderLog({ running: true, job }, Date.parse(at(5, 44)));
const order = [...running.matchAll(/class="job-log-text">([^<]*)</g)].map((m) => m[1]);
assert.equal(order.length, log.length + 1, "every step plus the start line");
assert.equal(order.at(-1), "3 分上漲 訓練集 → LightGBM 模型", "the newest at the bottom");
assert.equal(order[0], "開始（手動）");
const groups = running.split('class="job-log-group ').slice(1);
// A step the job has not reached is not listed (user 10-28): no 上線 group while training runs.
assert.deepEqual(groups.map((g) => g.match(/job-log-name">([^<]*)</)[1]), ["檢查", "計算特徵與標籤", "訓練模型"]);
assert.deepEqual(groups.map((g) => g.split('"')[0]), ["done", "done", "now"], "the groups follow the step cards");
assert.doesNotMatch(running, /job-log-group todo/);
assert.match(groups[1], /10\/28 原始行情 → 特徵檔/);
assert.match(groups[2], /資料集 → 訓練/);
assert.ok(order.includes("10/27 已整理的特徵檔"));
assert.ok(order.includes("10/28 原始行情 → 特徵檔"));
assert.ok(order.includes("資料集 → 訓練 10/21–10/22、驗證 10/27、測試 10/28"), "the split names its dates");
assert.ok(order.includes("10/21–10/28 特徵檔 → 資料集"));
assert.match(running, /job-log-row now[^>]*>.*?30 秒/, "the running step counts up to now");

const gone = view.renderLog({ running: false, job: { ...job, state: "INTERRUPTED", reason: "the job process ended without a result" } }, Date.parse(at(29, 0)));
assert.match(gone, /job-log-row warn[^>]*><span class="job-log-time">[^<]*<\/span><span class="job-log-icon">!<\/span><span class="job-log-text">中斷</, "the job's end is a line of its own, without the English reason");
assert.doesNotMatch(gone, /job-log-row now/);
assert.match(gone, /LightGBM 模型[^<]*<\/span><span class="job-log-dur">0 秒</, "the open step stops at the last update");

assert.match(view.renderLog({ running: false, job: { state: "SUCCEEDED" } }), /還沒有執行紀錄/, "a job from before the log");

// The date being computed shows B's phases pip-style below its line; once done, only events → samples stays.
assert.equal(jobView.compactCount(980), "980");
assert.equal(jobView.compactCount(9800), "9.8k");
assert.equal(jobView.compactCount(19_300), "19.3k");
assert.equal(jobView.compactCount(123_456), "123k");
assert.equal(jobView.compactCount(2_410_000), "2.41M");
assert.equal(jobView.clockSpan(127), "0:02:07");
assert.equal(jobView.clockSpan(3725), "1:02:05");
const phases = {
  verify: { done: 49, total: 49, elapsed_ms: 3000 },
  replay: { done: 1_250_000, total: 2_410_000, elapsed_ms: 127_551 },
};
const computing = { step: "features 2026-10-28", started_at: at(2, 0), ended_at: null,
  detail: { reused: false, export: { phase: "replay", phases } } };
const live = view.renderLog({ running: true, job: { ...job, step: computing.step, log: [...log.slice(0, 2), computing] } }, Date.parse(at(4, 31)));
const pip = live.match(/<div class="job-log-pip">.*?<\/div><\/div><\/div>/)?.[0] || "";
assert.ok(pip, "the running date has a progress block");
assert.match(live, /job-log-row now[^>]*>.*?10\/28 原始行情 → 特徵檔.*?<div class="job-log-pip">/, "inside the running date's line");
assert.deepEqual([...pip.matchAll(/class="job-log-phase( \w+)?">(\w+)</g)].map((m) => `${m[2]}${m[1] ? `:${m[1].trim()}` : ""}`),
  ["verify:done", "replay:now", "labels", "write", "load"]);
assert.match(pip, /<i style="width:51%"><\/i>/);
const figs = pip.match(/class="job-log-figs">(.*?)<\/span>/)[1].replace(/<\/?b>/g, "");
assert.equal(figs, "51%  1.25M/2.41M  9.8k/s  0:02:08  eta 0:01:58");
assert.doesNotMatch(running, /job-log-pip/, "no progress block on a line that is not computing a date");

// A stored shard only loads.
const loading = { ...computing, detail: { reused: true, export: { phase: "load", phases: { load: { done: 0, total: 19_300, elapsed_ms: 0 } } } } };
const loadOnly = view.renderLog({ running: true, job: { ...job, log: [loading] } });
assert.deepEqual([...loadOnly.matchAll(/class="job-log-phase[^"]*">(\w+)</g)].map((m) => m[1]), ["load"]);
assert.match(loadOnly, /0\/19\.3k  --  0:00:00  eta --/, "no rate before any work");

// Done: the block is gone, the line names what it became.
const doneEntry = { ...computing, ended_at: at(6, 5), detail: { reused: false, export: { phase: "load", phases: {
  ...phases, replay: { done: 2_410_000, total: 2_410_000, elapsed_ms: 200_000 }, labels: { done: 19_300, total: 19_300, elapsed_ms: 900 },
  write: { done: 19_300, total: 19_300, elapsed_ms: 400 }, load: { done: 19_300, total: 19_300, elapsed_ms: 1200 } } } } };
const finished = view.renderLog({ running: true, job: { ...job, log: [doneEntry, log.at(-1)] } }, Date.parse(at(6, 30)));
assert.doesNotMatch(finished, /job-log-pip/);
assert.match(finished, /10\/28 原始行情 → 特徵檔 <span class="job-log-count">2\.41M → 19\.3k<\/span><\/span><span class="job-log-dur">4 分 5 秒/);
// Phase names come from a fixed list: anything else shows nothing.
const odd = { ...computing, detail: { export: { phase: "<img src=x>", phases: {} } } };
assert.doesNotMatch(view.renderLog({ running: true, job: { ...job, log: [odd] } }), /job-log-pip|<img/);
const evil = "<img src=x onerror=alert(1)>";
assert.doesNotMatch(view.renderLog({ running: true, job: { log: [{ step: evil, started_at: at(0, 0) }], mode: evil } }), /<img/);
console.log("renderer model center log contract passed");
