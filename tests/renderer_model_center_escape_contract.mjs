import assert from "node:assert/strict";

// 模型中心 renders /api/training/models: model metadata and job counters are data, never markup.
const view = await import("../ui/renderer/js/pages/training/model_center_view.js");
const evil = "<img src=x onerror=alert(1)>";
const slot = { horizon_minutes: evil, direction: "up", kind: evil, validation_auc: 0.7,
  candidates: [{ kind: evil, validation_auc: 0.7, validation_log_loss: 0.5, winner: true }] };
for (const html of [view.renderLiveCards([slot]), view.renderPairCards([slot]),
  view.renderSteps({ running: true, job: { step: `train ${evil}`, current: evil, total: evil }, dataset: {} }),
  view.renderSteps({ running: true, job: { step: `features ${evil}`, current: 1, total: 2 }, dataset: {} }),
  view.renderToday({ trading_date: `2026-10-14${evil}`, phase: evil, window: {}, today_data: { instruments: evil } })]) {
  assert.doesNotMatch(html, /<img/, html);
}
console.log("renderer model center escape contract passed");
