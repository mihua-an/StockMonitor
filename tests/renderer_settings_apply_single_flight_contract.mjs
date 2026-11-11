import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// 系統設定「套用」is single-flight: the lock is taken before the preview round trip, so a double click starts one
// operation, the button is disabled while it runs, and the lock is released however the apply ends. Every failure the
// page shows is also a record naming its operation.
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) {
    const listeners = {};
    elements.set(id, { id, disabled: false, textContent: "", className: "", listeners, classList: { toggle() {} },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } });
  }
  return elements.get(id);
};
const click = (id) => { for (const fn of element(id).listeners.click || []) fn(); };
const warnings = [];
globalThis.console.warn = (...args) => warnings.push(args.map(String).join(" "));
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
// The service rows are morphed markup (a real DOM's job, not this fake's): the page has none here.
globalThis.document = { hidden: true, getElementById: (id) => (id === "systemServiceRows" ? null : element(id)), querySelectorAll: () => [] };

let previews = 0;
let applies = 0;
let releasePreview = null;
let previewAnswer = { ok: true, plan: { affected: ["app_api"], self: [] } };
let applyAnswer = { ok: true, operation: { state: "SUCCEEDED" } };
globalThis.window = {
  dispatchEvent() {},
  matchMedia: () => ({ matches: true }),
  desktopAPI: {
    confirm: async () => true,
    networkManifest: rendererNetworkManifest(),
    sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} },
    previewNetworkApply: () => { previews += 1; return new Promise((resolve) => { releasePreview = () => resolve(previewAnswer); }); },
    applyNetworkRevision: async () => { applies += 1; return applyAnswer; },
    getNetworkOperations: async () => ({ operations: [] }),
    getMonitoringSnapshot: async () => ({ ok: false, error: "no snapshot" }),
    requestMonitoringDetail: async () => ({}),
    getAutostart: async () => ({ available: true, enabled: false }),
  },
};
globalThis.fetch = async () => ({ ok: true, status: 200,
  json: async () => ({ pointer: { latest: 3, active: 2 }, manifest: { services: [] }, latest: { values: { services: {} } } }) });

const page = await import("../ui/renderer/js/pages/settings_system.js");
page.initSystemSettings();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
await settle();
const apply = element("systemPortsApplyBtn");
assert.equal(apply.disabled, false, "a saved revision waits to be applied");

// --- a double click while the preview is in flight: one preview, one operation
click("systemPortsApplyBtn");
click("systemPortsApplyBtn");
await settle();
assert.equal(previews, 1, "the second click found the lock taken");
assert.equal(apply.disabled, true, "the button shows the apply in progress");
assert.equal(element("systemPortsSaveBtn").disabled, true);
releasePreview();
await settle();
await settle();
assert.equal(applies, 1, "one operation");
assert.equal(apply.disabled, false, "the lock is released when the apply ends");

// --- a failed preview releases the lock and is recorded
previewAnswer = { ok: false, error: "PORT_IN_USE" };
warnings.length = 0;
click("systemPortsApplyBtn");
await settle();
releasePreview();
await settle();
assert.equal(applies, 1, "a failed preview applies nothing");
assert.equal(apply.disabled, false, "the lock is released after a failed preview");
assert.ok(warnings.some((line) => line.includes("[settings/system: previewing network revision 3] failed") && line.includes("PORT_IN_USE")), warnings.join("\n"));

// --- a failed apply is recorded with its state
previewAnswer = { ok: true, plan: { affected: ["app_api"], self: [] } };
applyAnswer = { ok: false, operation: { state: "ROLLED_BACK", history: [{ reason: "bind failed" }] } };
warnings.length = 0;
click("systemPortsApplyBtn");
await settle();
releasePreview();
await settle();
await settle();
assert.equal(applies, 2);
assert.ok(warnings.some((line) => line.includes("[settings/system: applying network revision 3] failed")), warnings.join("\n"));
assert.equal(apply.disabled, false);
page.disposeSystemSettings();
console.log("renderer settings apply single-flight contract passed");
