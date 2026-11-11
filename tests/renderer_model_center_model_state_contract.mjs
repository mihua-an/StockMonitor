import assert from "node:assert/strict";

// 模型中心 tells a slot without a model from one whose records could not be read: a damaged or unreadable champions
// file, an unusable model or a missing run file used to look exactly like "no model yet".
const view = await import("../ui/renderer/js/pages/training/model_center_view.js");
const slot = (extra) => ({ horizon_minutes: 3, direction: "up", candidates: [], ...extra });

const live = (extra) => view.renderLiveCards([slot(extra)]);
assert.match(live({ model: null, champion_state: "NONE", champion_reason: "no champion" }), /mc-live-kind">無模型</);
assert.match(live({ model: "m1", kind: "lightgbm", champion_state: "OK", validation_auc: 0.71 }), /LightGBM/);
for (const [state, text] of [["CHAMPIONS_DAMAGED", "上線紀錄損毀"], ["CHAMPIONS_IO_ERROR", "上線紀錄讀取失敗"],
  ["MODEL_UNUSABLE", "模型無法使用"]]) {
  const html = live({ model: state === "MODEL_UNUSABLE" ? "m1" : null, champion_state: state, champion_reason: `why ${state}` });
  assert.match(html, new RegExp(`mc-live-kind mc-weak">${text}<`), html);
  assert.doesNotMatch(html, /無模型/, "a record that could not be read is not shown as no model");
}

// A slot whose winner did not beat the constant baseline and that had no model has none, with why -- not a damaged
// record. One that had a model keeps it, and says it is the previous one and why.
const below = live({ model: null, champion_state: "BELOW_BASELINE", champion_reason: "not below the constant baseline" });
assert.match(below, /mc-live-kind">無模型 · 沒贏過常數基準</, below);
const kept = live({ model: "m0", kind: "logistic", champion_state: "OK", kept: "BELOW_BASELINE", kept_reason: "run r: ..." });
assert.match(kept, /mc-live-kind">Logistic · <span>沿用上一個<\/span><\/div>/, kept);
assert.doesNotMatch(live({ model: "m1", kind: "lightgbm", champion_state: "OK", kept: null }), /沿用/);

const pair = (extra) => view.renderPairCards([slot(extra)]);
assert.match(pair({}), /mc-pair-note">尚未訓練</);
assert.doesNotMatch(pair({ baseline_log_loss: 0.7 }), /常數基準/, "no baseline row without candidates");
const withBaseline = pair({ baseline_log_loss: 0.69812, candidates: [
  { kind: "logistic", winner: false, validation_auc: 0.6, validation_log_loss: 0.75 },
  { kind: "lightgbm", winner: true, validation_auc: 0.7, validation_log_loss: 0.72 }] });
assert.match(withBaseline, /mc-pair-row baseline"><span class="mc-pair-kind">常數基準<\/span><span>--<\/span><span>0\.6981<\/span>/, withBaseline);
assert.ok(withBaseline.indexOf("常數基準") > withBaseline.indexOf("LightGBM"), "the baseline row comes after the candidates");
for (const [kind, text] of [["RUN_MISSING", "訓練紀錄不存在"], ["RUN_DAMAGED", "訓練紀錄損毀"], ["RUN_IO_ERROR", "訓練紀錄讀取失敗"]]) {
  const html = pair({ candidates_error: { kind, detail: "d" } });
  assert.match(html, new RegExp(`mc-pair-note mc-weak">${text}<`), html);
  assert.doesNotMatch(html, /尚未訓練/);
}

// The run's slots go live in one step after the last one trained.
assert.equal(view.logStepText({ step: "promote" }), "各時段勝出的模型 → 一起上線");
assert.equal(view.logStepCard("promote"), 2);
console.log("renderer model center model state contract passed");
