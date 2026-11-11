import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// 設定 > 券商 永豐金鑰: one controller is the only writer of the status. Reads, saves and clears run one after another
// in the order asked for, and after every mutation the controller reads the backend's status again; so the status shows
// what the store holds after the last operation, whatever order the backend answers arrive in. Keys here are fakes.
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) {
    const listeners = {};
    elements.set(id, { id, value: "", disabled: false, textContent: "", className: "", listeners,
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } });
  }
  return elements.get(id);
};
const click = (id) => { for (const fn of element(id).listeners.click || []) fn(); };
globalThis.console.error = () => {};
globalThis.console.warn = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.document = { hidden: true, getElementById: (id) => element(id), querySelectorAll: () => [] };
globalThis.window = {
  dispatchEvent() {},
  matchMedia: () => ({ matches: true }),
  desktopAPI: { confirm: async () => true, networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
};

// The fake backend: a store, and every request held until the test answers it.
let stored = false;
const pending = [];
const sent = [];
globalThis.fetch = (url, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  assert.match(String(url), /\/api\/settings\/shioaji\/credentials$/);
  sent.push(method);
  return new Promise((resolve) => {
    // The store changes when the backend handles the request; the answer reaches the page whenever the test says.
    let body;
    if (method === "PUT") { stored = true; body = { ok: true, configured: true, reconnect_ok: true }; }
    else if (method === "DELETE") { stored = false; body = { ok: true, configured: false, reconnect_ok: true }; }
    else body = { ok: true, backend_available: true, configured: stored };
    pending.push({ method, answer: () => resolve({ ok: true, status: 200, json: async () => body }) });
  });
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const answer = async (method) => {
  await settle();
  const index = pending.findIndex((request) => request.method === method);
  assert.notEqual(index, -1, `a ${method} request is waiting (waiting: ${pending.map((r) => r.method).join(",") || "none"})`);
  pending.splice(index, 1)[0].answer();
  await settle();
};
const status = () => element("shioajiCredentialsStatus").textContent;

const page = await import("../ui/renderer/js/pages/settings_shioaji_credentials.js");
page.initShioajiCredentialSettings();
const type = (id, value) => { element(id).value = value; for (const fn of element(id).listeners.input || []) fn(); };

// 儲存並重新連線 (user 11-06): pressable only with a new pair typed in.
assert.equal(element("shioajiCredentialsSaveBtn").disabled, true, "nothing typed: nothing to save");
type("shioajiApiKey", "fake-api-key");
assert.equal(element("shioajiCredentialsSaveBtn").disabled, true, "the secret key is still empty");
type("shioajiSecretKey", "fake-secret-key");
assert.equal(element("shioajiCredentialsSaveBtn").disabled, false, "both typed");
type("shioajiApiKey", "   ");
assert.equal(element("shioajiCredentialsSaveBtn").disabled, true, "blank is not a key");

// --- a GET answered after a save it was overtaken by: the late "未設定" must not be drawn over the saved key.
const firstRefresh = page.refreshShioajiCredentialSettings();
element("shioajiApiKey").value = "fake-api-key";
element("shioajiSecretKey").value = "fake-secret-key";
click("shioajiCredentialsSaveBtn");
await settle();
assert.deepEqual(sent, ["GET"], "the save waits for the read already in flight");
await answer("GET");
await firstRefresh;
assert.equal(status(), "未設定");
await answer("PUT");
assert.equal(status(), "未設定", "the save's own answer is not drawn as the status");
await answer("GET");
assert.equal(status(), "已儲存", "after the save the controller reads the stored state again");
assert.equal(element("shioajiApiKey").value, "", "the typed key is taken out of the page after it is saved");
assert.deepEqual(sent, ["GET", "PUT", "GET"]);

// --- 清除 pressed while a save is in flight: the clear runs after the save, and the status ends at the clear.
sent.length = 0;
element("shioajiApiKey").value = "fake-api-key-2";
element("shioajiSecretKey").value = "fake-secret-key-2";
click("shioajiCredentialsSaveBtn");
await settle();
click("shioajiCredentialsClearBtn");
await settle();
assert.deepEqual(sent, ["PUT"], "the clear waits for the save");
assert.equal(element("shioajiCredentialsClearBtn").disabled, true, "the clear button shows it is waiting");
await answer("PUT");
await answer("GET");
assert.equal(status(), "已儲存");
await answer("DELETE");
await answer("GET");
assert.equal(status(), "未設定", "the last operation was the clear");
assert.equal(stored, false);
assert.deepEqual(sent, ["PUT", "GET", "DELETE", "GET"]);
assert.equal(element("shioajiCredentialsSaveBtn").disabled, true, "saved: the typed keys are gone, nothing new to save");
assert.equal(element("shioajiCredentialsClearBtn").disabled, false);

// --- a page refresh asked for during a mutation reads after it, so it cannot draw the state from before it.
sent.length = 0;
element("shioajiApiKey").value = "fake-api-key-3";
element("shioajiSecretKey").value = "fake-secret-key-3";
click("shioajiCredentialsSaveBtn");
await settle();
const midRefresh = page.refreshShioajiCredentialSettings();
await answer("PUT");
await answer("GET");
await answer("GET");
await midRefresh;
assert.equal(status(), "已儲存");
assert.deepEqual(sent, ["PUT", "GET", "GET"]);

// --- a refused save still ends with the status the backend holds, and says why it failed.
sent.length = 0;
element("shioajiApiKey").value = "";
element("shioajiSecretKey").value = "";
click("shioajiCredentialsSaveBtn");
await answer("GET");
assert.deepEqual(sent, ["GET"], "an empty pair is not sent");
assert.equal(element("shioajiCredentialsMessage").textContent, "API Key 與 Secret Key 都必須輸入");
assert.equal(status(), "已儲存");

// --- after the page is left, an answer still on its way draws nothing.
page.refreshShioajiCredentialSettings();
page.disposeShioajiCredentialSettings();
element("shioajiCredentialsStatus").textContent = "left";
stored = false;
await answer("GET");
assert.equal(status(), "left");
assert.equal(pending.length, 0);

console.log("shioaji credential controller contract passed");
