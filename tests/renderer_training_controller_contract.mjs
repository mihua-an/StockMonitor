import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// The model center's training controller owns the job's state and the 重新訓練 button. /api/training/models and the
// runtime poll both carry the job; an answer to an older read must not move the job back, and while a run command is
// being submitted no answer re-enables the button (a second click sent a second run request).
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {}, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const button = { disabled: false, textContent: "重新訓練" };
globalThis.document = { getElementById: (id) => (id === "manualTrainBtn" ? button : null), querySelectorAll: () => [], addEventListener() {} };

// Every request waits until the test answers it, in the order the test chooses.
const pending = [];
globalThis.fetch = (url) => new Promise((resolve) => {
  pending.push({ url: String(url), answer: (body) => resolve({ ok: true, json: async () => body }) });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function answer(part, body) {
  const index = pending.findIndex((request) => request.url.includes(part));
  assert.ok(index >= 0, `a request to ${part} is waiting`);
  pending.splice(index, 1)[0].answer(body);
  await settle();
}
const RUNNING = { running: true, pending_request: null, job: { state: "RUNNING", started_at: "2026-11-02T01:00:00Z" } };
const DONE = { running: false, pending_request: null, job: { state: "SUCCEEDED" } };

const { refreshTrainingStatus, refreshTrainingRuntimeOnly, runManualTraining } = await import("../ui/renderer/js/pages/training.js");

// 1. A runtime reply sent before a full load lands after it: the job stays as the newer answer says.
{
  const poll = refreshTrainingRuntimeOnly();
  await settle();
  const load = refreshTrainingStatus();
  await settle();
  await answer("/api/training/models", { ...DONE, slots: [] });
  await load;
  assert.equal(button.textContent, "重新訓練");
  await answer("/api/training/runtime", RUNNING);
  await poll;
  assert.equal(button.disabled, false, "an older runtime reply does not bring the finished job back to running");
  assert.equal(button.textContent, "重新訓練");
}

// 2. A full load sent before a runtime reply lands after it: the newer runtime reply's running job stays.
{
  const load = refreshTrainingStatus();
  await settle();
  const poll = refreshTrainingRuntimeOnly();
  await settle();
  await answer("/api/training/runtime", RUNNING);
  await poll;
  assert.equal(button.textContent, "訓練中...");
  await answer("/api/training/models", { ...DONE, slots: [] });
  await load;
  assert.equal(button.disabled, true, "an older models answer does not end the running job");
  assert.equal(button.textContent, "訓練中...");
  // The job ends: the newer runtime reply says so, and the models answer it asks for brings what it trained.
  const end = refreshTrainingRuntimeOnly();
  await settle();
  await answer("/api/training/runtime", DONE);
  await answer("/api/training/models", { ...DONE, slots: [] });
  await end;
  assert.equal(button.disabled, false);
}

// 3. While the run command is being submitted, a running=false answer keeps the button busy and a second click sends
// nothing; once the command is answered the status read after it decides.
{
  const posts = () => pending.filter((request) => request.url.includes("/api/training/run")).length;
  const run = runManualTraining();
  await settle();
  assert.equal(posts(), 1);
  assert.equal(button.disabled, true);
  const load = refreshTrainingStatus();
  await settle();
  await answer("/api/training/models", { ...DONE, slots: [] });
  await load;
  assert.equal(button.disabled, true, "an answer read while the command is submitted does not re-enable the button");
  assert.equal(button.textContent, "訓練中...");
  await runManualTraining();
  await settle();
  assert.equal(posts(), 1, "a second click while the command is submitted sends no second run request");
  await answer("/api/training/run", { ok: true, job_id: "manual-1", state: "QUEUED" });
  await answer("/api/training/models", { ...DONE, pending_request: "manual-1", slots: [] });
  await run;
  assert.equal(button.disabled, true, "the queued request keeps the button busy");
  assert.equal(button.textContent, "訓練中...");
}
assert.equal(pending.length, 0);
console.log("training controller contract passed");
