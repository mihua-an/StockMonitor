import assert from "node:assert/strict";

// 模型中心 step cards: the step bar shows only each step's name and state (user 11-02) -- no grey line under any step,
// running or finished; what a step did reads in 執行紀錄 and the figures below.

const view = await import("../ui/renderer/js/pages/training/model_center_view.js");
const cards = (html) => html.split('<div class="job-step ').slice(1).map((card) => ({
  state: card.slice(0, card.indexOf('"')), title: (card.match(/<div class="job-step-h">([^<]*)<\/div>/) || [])[1],
  text: (card.match(/<div class="job-step-v">([^<]*)<\/div>/) || [])[1] ?? null,
}));
const NAMES = ["檢查", "計算特徵與標籤", "訓練模型", "上線"];

// Step 2 running: 1 done, 2 now, 3 and 4 not started.
const running = cards(view.renderSteps({ running: true, job: { step: "features 2026-10-27", current: 3, total: 5 }, dataset: {} }));
assert.deepEqual(running.map((c) => c.state), ["done", "now", "todo", "todo"]);
assert.deepEqual(running.map((c) => c.title), NAMES);
assert.ok(running.every((c) => c.text === null), JSON.stringify(running));

// No job running and none finished: every step is still to come.
const idle = cards(view.renderSteps({ running: false, job: { state: "INTERRUPTED", step: "features 2026-10-27" }, dataset: {} }));
assert.ok(idle.every((c) => c.state === "todo" && c.text === null), JSON.stringify(idle));

// A finished run: every step done, names only.
const done = cards(view.renderSteps({ running: false, job: { state: "SUCCEEDED", step: "succeeded" },
  dataset: { trading_dates: ["2026-10-27"] }, last_success: { trained: ["a", "b"], promoted: ["a"], below_baseline: ["b"] } }));
assert.ok(done.every((c) => c.state === "done" && c.text === null), JSON.stringify(done));

console.log("renderer model center steps contract passed");

// The right column (user 10-28): no "開始 HH:MM" while a job runs nor under the retry countdown; 訓練資料 before 完成時間.
const progress = view.renderProgress({ running: true, job: { started_at: "2026-10-28T13:31:03Z", step: "checking" } },
  Date.parse("2026-10-28T13:33:00Z"));
assert.doesNotMatch(progress, /開始/);
const retry = view.renderToday({ trading_date: "2026-10-28", phase: "RETRY_WAIT", window: {}, next_run_at: "2026-10-28T15:00:03+08:00",
  seconds_until_next_run: 60 }, 60);
assert.match(retry, /距離重試/);
assert.doesNotMatch(retry, /開始/);
const summary = view.renderSummary({ job: { state: "SUCCEEDED", started_at: "2026-10-28T13:31:03Z", finished_at: "2026-10-28T13:39:08Z" },
  dataset: { samples: 90706, codes: 76, trading_dates: ["a", "b"] } });
assert.deepEqual([...summary.matchAll(/<small>([^<]*)<\/small>/g)].map((m) => m[1]), ["訓練資料", "完成時間"]);
console.log("renderer model center right column contract passed");
