import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// Characterizes the fix for: clicking "重新訓練" (POST /api/training/run) set
// the button to disabled/"訓練中...", then relied entirely on the finally
// block's refreshTrainingStatus() to restore it from real server state. If
// EITHER the trigger POST or that follow-up status refresh failed (e.g. the
// backend is unreachable for both calls), refreshTrainingStatus() threw
// before ever reaching renderAll() -- the button's disabled/"訓練中..." state
// was never re-derived, and it stayed stuck that way indefinitely with no
// way for the user to retry short of a page reload. This test drives the
// real runManualTraining() end to end (mocked fetch, minimal DOM) through
// every combination of trigger/refresh success and failure.

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
  setInterval: () => 0,
  clearInterval() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

function makeButton() {
  return { disabled: false, textContent: "重新訓練" };
}
let elements;
globalThis.document = {
  getElementById: (id) => elements.get(id) || null,
  querySelectorAll: () => [],
  addEventListener() {},
};

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

const { runManualTraining, refreshTrainingStatus } = await import("../ui/renderer/js/pages/training.js");

// --- Scenario A: trigger POST rejects (network error), follow-up status
// refresh ALSO rejects -- this is the exact stuck-button bug. ---
{
  elements = new Map([["manualTrainBtn", makeButton()]]);
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  await runManualTraining();
  const button = elements.get("manualTrainBtn");
  assert.equal(button.disabled, false, "button must not be stuck disabled when server state is unconfirmed");
  assert.equal(button.textContent, "重新訓練", "button must not be stuck claiming 訓練中... when unconfirmed");
}

// --- Scenario B: trigger POST returns {ok:false} (backend rejected it),
// follow-up refresh ALSO fails. Same recovery must apply. ---
{
  elements = new Map([["manualTrainBtn", makeButton()]]);
  let call = 0;
  globalThis.fetch = () => {
    call += 1;
    if (call === 1) return Promise.resolve(jsonResponse({ ok: false, error: "busy" }));
    return Promise.reject(new Error("still down"));
  };
  await runManualTraining();
  const button = elements.get("manualTrainBtn");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新訓練");
}

// --- Scenario D: trigger POST succeeds, follow-up refresh succeeds and
// reports completion -- button must return to the enabled default. ---
{
  elements = new Map([["manualTrainBtn", makeButton()]]);
  globalThis.fetch = (url) => {
    if (String(url).includes("/api/training/run")) return Promise.resolve(jsonResponse({ ok: true }));
    return Promise.resolve(jsonResponse({ running: false, job: { state: "SUCCEEDED" } }));
  };
  await runManualTraining();
  const button = elements.get("manualTrainBtn");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新訓練");
}

// --- Scenario C: trigger POST succeeds, follow-up refresh succeeds and
// reports the training job genuinely running -- button SHOULD show 訓練中...
// disabled (this must keep working; the fix must not defeat a real running
// state). ---
{
  elements = new Map([["manualTrainBtn", makeButton()]]);
  globalThis.fetch = (url) => {
    if (String(url).includes("/api/training/run")) return Promise.resolve(jsonResponse({ ok: true }));
    return Promise.resolve(jsonResponse({ running: true, job: { state: "RUNNING" } }));
  };
  await runManualTraining();
  const button = elements.get("manualTrainBtn");
  assert.equal(button.disabled, true, "a genuinely running tournament must keep the button disabled");
  assert.equal(button.textContent, "訓練中...");
}

// --- Scenario E: a click while the job runs is a no-op (must not
// re-trigger a second POST). The running state is the training
// controller's, read from the server. ---
{
  elements = new Map([["manualTrainBtn", makeButton()]]);
  globalThis.fetch = () => Promise.resolve(jsonResponse({ running: true, job: { state: "RUNNING" } }));
  await refreshTrainingStatus();
  let posted = false;
  globalThis.fetch = (url) => {
    if (String(url).includes("/api/training/run")) posted = true;
    return Promise.resolve(jsonResponse({ ok: true }));
  };
  await runManualTraining();
  assert.equal(posted, false, "must not issue a second trigger while already running/disabled");
}

console.log("training run-button recovery contract passed");
