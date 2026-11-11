import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// The training runtime poll fired every 1.2 s with a 20 s timeout and no single-flight, so a busy
// backend piled requests up and their late replies moved 訓練中 / progress backwards.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {}, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const button = { disabled: false, textContent: "重新訓練" };
globalThis.document = { getElementById: (id) => (id === "manualTrainBtn" ? button : null), querySelectorAll: () => [], addEventListener() {} };

const pending = [];
let calls = 0;
globalThis.fetch = (url) => {
  calls += 1;
  return new Promise((resolve) => pending.push(() => resolve({ ok: true, json: async () => ({ running: true, job: { state: "RUNNING" } }) })));
};
const { refreshTrainingRuntimeOnly, disposeTrainingPage } = await import("../ui/renderer/js/pages/training.js");

const first = refreshTrainingRuntimeOnly();
await refreshTrainingRuntimeOnly();
await refreshTrainingRuntimeOnly();
await new Promise((r) => setTimeout(r, 0));
assert.equal(calls, 1, "a poll waits for the one in flight");
pending.shift()();
await first;
assert.equal(button.textContent, "訓練中...");

// A reply that arrives after the page was left is dropped.
const late = refreshTrainingRuntimeOnly();
await new Promise((r) => setTimeout(r, 0));
disposeTrainingPage();
button.textContent = "untouched";
pending.shift()();
await late;
assert.equal(button.textContent, "untouched");
console.log("training poll single-flight contract passed");
