import assert from "node:assert/strict";

// 特徵權重: two cards (上漲, 下跌) for one horizon; signed logistic weights, unsigned LightGBM gain, old models without.
const view = await import("../ui/renderer/js/pages/training/model_center_view.js");
const evil = "<img src=x onerror=alert(1)>";
const slots = [
  { horizon_minutes: 3, direction: "up", model: "m1", feature_importance: { kind: "logistic", method: "standardized_coefficient", signed: true, features: 193,
    top: [{ name: "ret_1m", value: 0.42, share: 0.3 }, { name: evil, value: -0.21, share: 0.15 }] } },
  { horizon_minutes: 3, direction: "down", model: "m2", feature_importance: { kind: "lightgbm", method: "gain", signed: false, features: 193,
    top: [{ name: "spread", value: 0.25, share: 0.25 }] } },
  { horizon_minutes: 10, direction: "up", model: "m3", feature_importance: null },
  { horizon_minutes: 10, direction: "down", model: null, feature_importance: null },
];

assert.deepEqual(view.importanceHorizons(slots, null), { minutes: [3, 10], shown: 3 });
assert.equal(view.importanceHorizons(slots, 7).shown, 3, "an unknown horizon falls back to the shortest");
const buttons = view.renderImportanceHorizons(slots, 10);
assert.match(buttons, /class="settings-seg-btn mc-imp-horizon is-active" data-horizon="10"/);

const cards = view.renderImportanceCards(slots, 3);
assert.doesNotMatch(cards, /<img/, "feature names are data, never markup");
assert.equal((cards.match(/class="mc-imp-title"/g) || []).length, 2, "one card per direction");
assert.match(cards, /3 分上漲/);
assert.match(cards, /3 分下跌/);
assert.match(cards, /mc-imp-row up[^]*\+0\.420/, "a positive logistic weight raises the probability");
assert.match(cards, /mc-imp-row down[^]*−0\.210/);
assert.match(cards, /25\.0%/, "LightGBM gain shown as its share, no sign");
assert.match(cards, /前 2 \/ 193 個特徵/);

const old = view.renderImportanceCards(slots, 10);
assert.match(old, /尚未記錄特徵權重/, "a model trained before 特徵權重 says so");
assert.match(old, /尚未訓練/);
console.log("renderer model center importance contract passed");
