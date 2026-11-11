// 設定 → 券商帳號 → 永豐行情連線 (pages/settings_broker_connections.js), driven through the real api.js against a fake
// fetch:
//  * one save at a time: a second click while a save is on its way sends nothing;
//  * a save started on one visit of the page never writes into the next visit (its message, its reload);
//  * a status that could not be read reads 讀不到永豐連線狀態, never 永豐尚未連線;
//  * the selects are built from the domain's own choices (GET answer `choices`), not a copy in the page.
import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
  matchMedia: () => ({ matches: true }),
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };

class FakeElement {
  constructor(id) { this.id = id; this.listeners = {}; this.dataset = {}; this.textContent = ""; this.className = ""; this.disabled = false; this.options = []; this._value = ""; this.children = []; this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
  get isConnected() { return Boolean(this.parent); }
  replaceChildren(...options) { this.options = options; }
  get value() { return this._value; }
  set value(value) { this._value = this.options.some((option) => option.value === String(value)) ? String(value) : ""; }
  click() { for (const fn of this.listeners.click || []) fn(); }
}
let elements = new Map();
const freshPage = () => {
  elements = new Map(["brokerConnectionsMax", "brokerConnectionsLimit", "brokerConnectionsSaveBtn", "brokerConnectionsMessage", "brokerConnectionsUsage",
    "settingsToast"]
    .map((id) => [id, new FakeElement(id)]));
};
globalThis.document = { getElementById: (id) => elements.get(id) || null, createElement: () => new FakeElement("") };
const toastTexts = () => $("settingsToast").children.map((toast) => toast.children[0].textContent);

const CHOICES = { defaults: { shioaji: { connections: 3, per_connection_limit: 200 } },
  shioaji: { connections: { min: 1, max: 3 }, per_connection_limit: { min: 1, max: 1000, options: [100, 200, 500] } } };
let described = { ok: true, pointer: { latest: 4 }, latest: { values: { shioaji: { connections: 2, per_connection_limit: 200 } } }, choices: CHOICES };
let status = { ok: true, shioaji_connected: true, subscription_connections: { open: [] }, active_subscription_count: 0 };
const puts = [];
const pending = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const answer = (body) => ({ ok: true, status: 200, json: async () => body });
  if (options.method === "PUT") {
    puts.push(JSON.parse(options.body));
    return new Promise((resolve) => pending.push(() => resolve(answer({ ok: true, revision: 5 }))));
  }
  if (path === "/api/config/broker_connections") return answer(described);
  if (path === "/api/shioaji/status") {
    if (status instanceof Error) throw status;
    return answer(status);
  }
  throw new Error(`unexpected ${path}`);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const settleAll = async () => { for (let i = 0; i < 10; i += 1) await settle(); };
const $ = (id) => elements.get(id);

const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
const page = await import("../ui/renderer/js/pages/settings_broker_connections.js");

// The selects are the domain's choices.
freshPage();
page.initBrokerConnectionSettings();
await settleAll();
assert.deepEqual($("brokerConnectionsMax").options.map((o) => o.value), ["1", "2", "3"], "connections 1..max from the domain");
assert.deepEqual($("brokerConnectionsLimit").options.map((o) => o.value), ["100", "200", "500"], "the limits the domain lists");
assert.equal($("brokerConnectionsMax").value, "2", "the saved value is selected");
assert.equal($("brokerConnectionsSaveBtn").disabled, true, "nothing to save yet");

// Single flight: three clicks while the save is on its way send one PUT.
$("brokerConnectionsMax").value = 3;
$("brokerConnectionsMax").listeners.change[0]();
assert.equal($("brokerConnectionsSaveBtn").disabled, false);
$("brokerConnectionsSaveBtn").click();
$("brokerConnectionsSaveBtn").click();
$("brokerConnectionsSaveBtn").click();
await settleAll();
assert.equal(puts.length, 1, "one PUT however often it is clicked");
assert.equal(puts[0].expected_revision, 4);
assert.deepEqual(puts[0].values, { shioaji: { connections: 3, per_connection_limit: 200 } });
// 儲存 has one owner, deciding from "dirty" and "a save is out" (D08-11): a change of the draft while the save is out
// leaves it disabled, and once the save is answered it is written from those two only -- never set back to what it
// was at the click and then corrected.
assert.equal($("brokerConnectionsSaveBtn").disabled, true, "disabled while the save is out");
$("brokerConnectionsLimit").value = 500;
$("brokerConnectionsLimit").listeners.change[0]();
assert.equal($("brokerConnectionsSaveBtn").disabled, true, "a change of the draft while the save is out does not enable 儲存");
$("brokerConnectionsLimit").value = 200;
$("brokerConnectionsLimit").listeners.change[0]();
const saveButton = $("brokerConnectionsSaveBtn");
const writes = [];
let disabledNow = saveButton.disabled;
Object.defineProperty(saveButton, "disabled", { get: () => disabledNow, set: (value) => { writes.push(value); disabledNow = value; }, configurable: true });
described = { ...described, pointer: { latest: 5 }, latest: { values: { shioaji: { connections: 3, per_connection_limit: 200 } } } };
pending.shift()();
await settleAll();
assert.ok(writes.length > 0 && writes.every((value) => value === true), `after the save nothing re-enables 儲存 on the way: ${writes}`);
assert.ok(toastTexts().some((text) => /已儲存並生效/.test(text)), "a success floats at the top");
assert.equal($("brokerConnectionsMessage").textContent, "", "and leaves nothing beside the button");
assert.equal($("brokerConnectionsSaveBtn").disabled, true, "after the reload the saved value is the draft: nothing to save");

// A save started on one visit, answered after the page was left and opened again, writes nothing into the new visit.
$("brokerConnectionsMax").value = 1;
$("brokerConnectionsSaveBtn").click();
await settleAll();
assert.equal(puts.length, 2);
const oldPage = elements;
oldPage.get("brokerConnectionsMessage").textContent = "";
page.disposeBrokerConnectionSettings();
freshPage();
described = { ...described, pointer: { latest: 6 }, latest: { values: { shioaji: { connections: 2, per_connection_limit: 500 } } } };
page.initBrokerConnectionSettings();
await settleAll();
assert.equal($("brokerConnectionsLimit").value, "500");
const messageBefore = $("brokerConnectionsMessage").textContent;
pending.shift()();
await settleAll();
assert.equal($("brokerConnectionsMessage").textContent, messageBefore, "the old visit's save writes no message into the new one");
assert.equal(oldPage.get("brokerConnectionsMessage").textContent, "", "nor into the page it left");
assert.equal($("brokerConnectionsLimit").value, "500", "nor reloads the new visit with its own view");

// A status that could not be read is not "not connected".
assert.equal(page.usageText(null), "讀不到永豐連線狀態");
assert.equal(page.usageText({ ok: false, error: "x" }), "讀不到永豐連線狀態");
assert.equal(page.usageText({ ok: true }), "讀不到永豐連線狀態", "a report without the field is not a broker state");
assert.equal(page.usageText({ ok: true, shioaji_connected: false }), "永豐尚未連線");
status = new Error("connection refused");
freshPage();
page.initBrokerConnectionSettings();
await settleAll();
assert.equal($("brokerConnectionsUsage").textContent, "讀不到永豐連線狀態");
assert.ok(warnings.some((line) => line.includes("[settings/broker connections: reading GET /api/shioaji/status] failed")), "the failed read is recorded");

// No choices in the answer: an error, never a page-made list.
described = { ok: true, pointer: { latest: 6 }, latest: null };
freshPage();
page.initBrokerConnectionSettings();
await settleAll();
assert.deepEqual($("brokerConnectionsMax").options, []);
assert.equal($("brokerConnectionsSaveBtn").disabled, true);
assert.match($("brokerConnectionsMessage").textContent, /沒有提供可選的值/);
console.log("renderer settings broker connections contract passed");
