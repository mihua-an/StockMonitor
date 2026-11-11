import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// A16 -- ui/renderer/trade_window.js.
//
// Two behaviors are characterized here against the REAL submitTrade()/
// applyPayload() flow (mocked fetch/desktopAPI, minimal DOM -- no browser):
//
// 1. apiJson() (trade_window.js's own fetch wrapper, separate from
//    js/core/api.js's withRequestTimeout) has its own 20s deadline. A hung
//    fetch must time out with a clear message and must NOT leave the submit
//    button permanently disabled.
// 2. The ledger sync after a new trade (/api/actual-account/sync) can answer
//    {ok:false, error} (a business failure, not a network error): the window
//    shows a visible failure state, not "背景同步中" forever. It is waited for
//    as long as the server says a sync can take (sync_deadline_s), not the
//    common 20 s: a ~22 s sync that completed was reported as failed.
//
// Also exercises retry-safety: after an uncertain Google Form submission,
// resubmitting must require an explicit confirm() before firing again.

const timers = new Map();
let nextTimer = 1;
const delaysSet = [];
globalThis.setTimeout = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); delaysSet.push(delay); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
function fireTimersMatching(predicate) {
  for (const [id, entry] of [...timers]) {
    if (predicate(entry)) { timers.delete(id); entry.fn(); }
  }
}
async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

function makeElement(id) {
  return {
    id, value: "", textContent: "", disabled: false, hidden: false,
    dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, select() {}, closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    _innerHTML: "",
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) { this._innerHTML = value; },
    scrollWidth: 0, scrollHeight: 0,
  };
}
const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

// A single valid fill row (1000 shares @ 100) for every scenario below --
// buildTradeBody()'s own validation is not what this test is about.
function makeFillRow(qty, price) {
  const fields = {
    "[data-trade-fill-qty]": { value: String(qty), dataset: {}, addEventListener() {} },
    "[data-trade-fill-price]": { value: String(price), dataset: {}, addEventListener() {} },
  };
  return { querySelector: (selector) => fields[selector] || null };
}
let fillRows = [makeFillRow(1000, 100)];
// The form finds its elements under its host (the shell): [id="..."] lookups and the fill rows box's rows.
const shell = el("tradeWindowShell");
shell.querySelector = (selector) => {
  const id = /^\[id="([^"]+)"\]$/.exec(selector)?.[1];
  return id ? el(id) : null;
};
el("tradeWindowFillRows").querySelectorAll = (selector) => (selector === ".account-trade-fill-row" ? fillRows : []);

globalThis.document = {
  title: "",
  getElementById: (id) => el(id),
  querySelector: (selector) => (selector === ".trade-window-shell" ? el("tradeWindowShell") : null),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

globalThis.requestAnimationFrame = () => 1; // captured but never auto-fired; fit/focus scheduling is irrelevant here
globalThis.cancelAnimationFrame = () => {};
const notified = [];
globalThis.window = {
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} },
    confirm: async () => true,
    submitGoogleFormTrade: async () => ({ ok: true }),
    fitTradeWindow: async () => ({}),
    notifyTradeWindowChanged: async (payload) => { notified.push(payload); return {}; },
    closeTradeWindow() {},
    onTradeWindowPayload: () => () => {},
  },
};

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}
const validGoogleFormConfig = {
  google_form_prefill_url: "https://docs.google.com/forms/d/e/x/viewform",
  google_form_param_trade_date: "entry.1", google_form_param_market: "entry.2",
  google_form_param_action: "entry.3", google_form_param_code: "entry.4",
  google_form_param_trade_info: "entry.5", google_form_param_trade_time: "entry.6",
  sync_deadline_s: 385,
};

const { submitTrade, applyPayload } = await import("../ui/renderer/trade_window.js");

// --- Scenario 1: edit-mode submit hits a hung fetch (server never
// responds). The common request deadline (js/core/api.js, 20 s) must fire,
// reject with a clear "逾時" message, and the submit button must recover to
// enabled/"儲存", not stay stuck disabled/"儲存中…". ---
{
  await applyPayload({
    mode: "edit",
    trade: { trade_id: "T1", date: "2026-09-04", market: "台股", action: "買進", code: "2330", time: "", fills: [{ qty: 1000, price: 100 }] },
  });
  el("tradeWindowDate").value = "2026-09-04";
  el("tradeWindowMarket").value = "台股";
  el("tradeWindowAction").value = "買進";
  el("tradeWindowCode").value = "2330";

  let abortedReason = null;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      abortedReason = "aborted";
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

  const submitPromise = submitTrade();
  await flushMicrotasks(2);
  const button = el("tradeWindowSubmitBtn");
  assert.equal(button.disabled, true, "button must be disabled while the request is in flight");
  assert.equal(button.textContent, "儲存中…");

  const deadlineTimer = [...timers.values()].find((entry) => entry.delay === 20000);
  assert.ok(deadlineTimer, "the request is sent with the common 20 s deadline");
  fireTimersMatching((entry) => entry.delay === 20000);
  await submitPromise;

  assert.equal(abortedReason, "aborted", "timing out must actually abort the hung fetch");
  assert.equal(button.disabled, false, "submit button must not be left permanently disabled after a timeout");
  assert.equal(button.textContent, "儲存", "submit button must recover to its normal label");
  assert.match(el("tradeWindowMessage").textContent, /逾時/, "message must clearly state the request timed out");
}

// --- Scenario 2: add-mode submit succeeds, background account sync
// resolves SUCCESSFULLY with {ok:false, error} (not a network rejection).
// The renderer must inspect the resolved value and show a visible failure
// state, not leave the user stuck on "...背景同步中". ---
{
  applyPayload({ mode: "add", market: "台股" });
  el("tradeWindowDate").value = "2026-09-05";
  el("tradeWindowMarket").value = "台股";
  el("tradeWindowAction").value = "買進";
  el("tradeWindowCode").value = "2330";
  fillRows = [makeFillRow(1000, 100)];

  const syncs = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/actual-account/config")) return jsonResponse(validGoogleFormConfig);
    if (String(url).includes("/api/actual-account/sync")) { syncs.push(delaysSet.at(-1)); return jsonResponse({ ok: false, error: "同步失敗" }); }
    return jsonResponse({ ok: true });
  };
  window.desktopAPI.submitGoogleFormTrade = async () => ({ ok: true });

  await submitTrade();
  // Immediately after submitTrade() resolves, the transient "syncing"
  // message is expected -- the background sync promise is intentionally
  // not awaited by submitAddTrade().
  assert.match(el("tradeWindowMessage").textContent, /背景同步中/, "sanity: transient syncing message shown first");

  await flushMicrotasks(6);
  const finalMessage = el("tradeWindowMessage").textContent;
  assert.doesNotMatch(finalMessage, /^交易已送出，帳務同步完成$/, "must not report sync success when it actually failed");
  assert.doesNotMatch(finalMessage, /背景同步中$/, "must not stay stuck on the syncing message forever");
  assert.match(finalMessage, /同步失敗/, "a resolved {ok:false} sync must produce a visible failure message");
  assert.equal(el("tradeWindowSubmitBtn").disabled, false, "submit button must be usable again after the add completed");
  assert.deepEqual(syncs, [385 * 1000 + 15000], "the sync is waited for the server's sync deadline plus the reply's grace, not 20 s");
  assert.equal(notified.filter((p) => p.kind === "add-synced").length, 0, "a failed sync does not tell the main window the ledger has the trade");

  // The same sync answering ok: the window says so and the main window refreshes once.
  globalThis.fetch = async (url) => (String(url).includes("/api/actual-account/config")
    ? jsonResponse(validGoogleFormConfig) : jsonResponse({ ok: true, remote_rows: 1209 }));
  el("tradeWindowCode").value = "2330";
  fillRows = [makeFillRow(1000, 100)];
  await submitTrade();
  await flushMicrotasks(8);
  assert.equal(el("tradeWindowMessage").textContent, "交易已送出，帳務同步完成");
  assert.deepEqual(notified.filter((p) => p.kind === "add-synced"), [{ kind: "add-synced" }]);
}

// --- Scenario 3 (retry safety): an uncertain Google Form result (timeout
// during the actual POST) must require an explicit confirm() before the
// next submit fires -- proving the "勿直接重送" guard is wired into the
// renderer's real submit path, not just present in an unread error string.
{
  applyPayload({ mode: "add", market: "台股" });
  el("tradeWindowDate").value = "2026-09-06";
  el("tradeWindowMarket").value = "台股";
  el("tradeWindowAction").value = "買進";
  el("tradeWindowCode").value = "2330";
  fillRows = [makeFillRow(1000, 100)];

  globalThis.fetch = async (url) => (String(url).includes("/api/actual-account/config")
    ? jsonResponse(validGoogleFormConfig)
    : jsonResponse({ ok: true }));
  // The Google Form submission itself reports uncertain:true, mirroring
  // ui/main/trade_form.js's `submitted = true` before an ambiguous
  // failure (e.g. a timeout mid-POST).
  window.desktopAPI.submitGoogleFormTrade = async () => ({ ok: false, uncertain: true, error: "請求逾時，結果待確認；請先核對帳務再操作" });

  await submitTrade();
  assert.match(el("tradeWindowMessage").textContent, /請求逾時|待確認/);

  let confirmCalled = false;
  let secondSubmitFired = false;
  window.desktopAPI.confirm = async () => { confirmCalled = true; return false; }; // user declines to confirm
  window.desktopAPI.submitGoogleFormTrade = async () => { secondSubmitFired = true; return { ok: true }; };

  await submitTrade();
  assert.equal(confirmCalled, true, "resubmitting after an uncertain result must prompt for confirmation");
  assert.equal(secondSubmitFired, false, "declining the confirmation must not fire a second submission");
}

// --- Scenario 4: a new trade starts in the market the opener sent (Rust A's US session, trade_entry.js); an edit
// payload shows its own trade's market. ---
{
  assert.equal(applyPayload({ mode: "add", action: "賣出", market: "美股" }), true);
  assert.equal(el("tradeWindowMarket").value, "美股");
  assert.equal(applyPayload({ mode: "edit", trade: { trade_id: "T9", date: "2026-09-04", market: "台股", action: "買進", code: "2603", fills: [{ qty: 1000, price: 50 }] } }), true);
  assert.equal(el("tradeWindowId").value, "T9", "the form shows the edit");
  assert.equal(el("tradeWindowMarket").value, "台股");
  assert.equal(el("tradeWindowCode").value, "2603");
}

console.log("A16 trade_window deadline + background-sync-failure + retry-safety contract passed");
