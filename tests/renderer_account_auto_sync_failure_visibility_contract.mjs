// Behavioral test for Account page auto-sync failure visibility
// (ui/renderer/js/pages/account.js). Before this fix, a background
// auto-sync (config.auto_sync_on_page_open, on page open) that succeeded
// called setMessage() and was visible; a failed one only did
// console.warn(), leaving the user with no indication anything went wrong
// -- they would only notice via the dashboard silently not reflecting new
// trades. The fix reuses the same setMessage(text, isError) primitive, so
// failure is exactly as visible as success. Since 10-22 (R14-24) that is the
// page's notice line under its header, never a modal window.alert: a failed
// background sync must not block the page.
//
// Driven through the real page (pages/account.js refreshAccountLedgerPage): the backend's answers are the test's
// (config, dashboard, sync), and what the user sees is read off the page's notice line.
import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

installRealtimeHarness();
// In a browser globalThis is the window: the page schedules its frames on it.
Object.assign(globalThis, { requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame });
const alertCalls = [];
globalThis.window.alert = (text) => alertCalls.push(text);
// The notice line of pages/account.html: its text, its error class and whether it shows.
const noticeText = { textContent: "" };
const errorClass = new Set();
const notice = {
  hidden: true,
  classList: { toggle: (name, on) => (on ? errorClass.add(name) : errorClass.delete(name)) },
  querySelector: (selector) => (selector === "[data-account-notice-text]" ? noticeText : { onclick: null }),
};
globalThis.document = { getElementById: (id) => (id === "actualAccountNotice" ? notice : null),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  body: { dataset: {} } };
let backend = {};
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url)).pathname;
  // A function is an answer the test hands out when it chooses (a sync still running).
  const answer = typeof backend[path] === "function" ? await backend[path]() : backend[path];
  if (answer instanceof Error) throw answer;
  return new Response(JSON.stringify(answer ?? { ok: false, error: `no answer for ${path}` }),
    { status: 200, headers: { "content-type": "application/json" } });
};
const { account } = await import("../ui/renderer/js/features/account/account_state.js");
const { refreshAccountLedgerPage } = await import("../ui/renderer/js/pages/account.js");

// The auto-sync runs in the background of the page (it is not part of the navigation that shows it): its outcome is
// read once the page's notice line has it.
async function until(condition, what) {
  for (let i = 0; i < 2000 && !condition(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), `timed out waiting for ${what}`);
}

function makeHarness({ syncResult, dashboardResult = { ok: true, positions: [], trades: [] } } = {}) {
  backend = {
    "/api/actual-account/config": { auto_sync_on_page_open: true, gas_url: "https://script.google.com/x" },
    "/api/actual-account/dashboard": dashboardResult,
    "/api/actual-account/sync": syncResult,
  };
  Object.assign(account, { initialized: true, autoSyncAttempted: false, currentView: "home", mode: "actual" });
  notice.hidden = true;
  noticeText.textContent = "";
  errorClass.clear();
  alertCalls.length = 0;
  const warnCalls = [];
  const errorCalls = [];
  console.warn = (...args) => warnCalls.push(args);
  console.error = (...args) => errorCalls.push(args);
  const shown = () => (notice.hidden ? null : { text: noticeText.textContent, error: errorClass.has("account-notice-error") });
  return { refreshAccountPage: (_mode, allowAutoSync) => refreshAccountLedgerPage(allowAutoSync), alertCalls, warnCalls, errorCalls, shown };
}

// 1. Auto-sync failure (backend returns ok:false) must be visible on the
//    page's notice line as an error -- not just a console.warn nobody sees,
//    and never a modal alert that blocks the page.
{
  const h = makeHarness({ syncResult: { ok: false, error: "GAS unreachable" } });
  await h.refreshAccountPage("actual", true);
  await until(() => h.shown()?.error, "the failed sync on the notice line");
  assert.equal(h.alertCalls.length, 0, "a failed auto-sync never blocks the page with an alert");
  assert.equal(h.shown()?.error, true, "a failed auto-sync shows as an error on the notice line");
  assert.match(h.shown().text, /自動同步失敗/);
  assert.doesNotMatch(h.shown().text, /GAS unreachable/);
  assert.ok(h.errorCalls.length >= 1, "the failure is recorded");
  assert.equal(h.warnCalls.length, 1, "the existing console.warn diagnostic must still fire too");
  assert.match(String(h.warnCalls[0]), /GAS unreachable/, "technical detail must remain in diagnostics");
}

// 2. Auto-sync failure via a thrown/rejected apiPost (network error, not
//    just an {ok:false} body) must be visible the same way.
{
  const h = makeHarness({ syncResult: new Error("network down") });
  await h.refreshAccountPage("actual", true);
  await until(() => h.shown()?.error, "the failed sync on the notice line");
  assert.equal(h.alertCalls.length, 0);
  assert.match(h.shown()?.text || "", /自動同步失敗/);
  assert.doesNotMatch(h.shown().text, /network down/);
  assert.match(String(h.warnCalls[0]), /network down/);
}

// 3. A successful auto-sync must be unaffected -- still shows its own
//    success message, no failure alert.
{
  const h = makeHarness({ syncResult: { ok: true, remote_rows: 12 } });
  await h.refreshAccountPage("actual", true);
  await until(() => /同步完成/.test(h.shown()?.text || ""), "the sync result on the notice line");
  assert.equal(h.alertCalls.length, 0, "a successful sync must not trigger an error alert");
  assert.equal(h.shown()?.error, false, "a successful sync shows its result, not an error");
  assert.match(h.shown().text, /同步完成：12/);
}

// 4. allowAutoSync=false must still skip auto-sync entirely (unrelated
//    behavior, must not regress from this change).
{
  const h = makeHarness({ syncResult: { ok: false, error: "should never be called" } });
  await h.refreshAccountPage("actual", false);
  assert.equal(h.alertCalls.length, 0);
  assert.equal(h.warnCalls.length, 0);
}

// 5. Showing the page does not wait for the sync (user 10-28): entering 帳務 is a navigation and navigations run one at
//    a time, so a refresh that awaited a 21-82 s Google Sheet sync held every other page the user clicked meanwhile.
//    The refresh is done while the sync is still running; the sync's result arrives on the page afterwards.
{
  let release;
  const running = new Promise((resolve) => { release = resolve; });
  const h = makeHarness({ syncResult: () => running });
  let refreshed = false;
  await h.refreshAccountPage("actual", true).then(() => { refreshed = true; });
  assert.equal(refreshed, true, "the page refresh returns while the sync is still running");
  assert.match(h.shown()?.text || "", /正在從 Google Sheet 同步/, "the sync shows it is running");
  release({ ok: true, remote_rows: 3 });
  await until(() => /同步完成：3/.test(h.shown()?.text || ""), "the sync result after it ended");
}

console.log("account auto-sync failure visibility contract passed");
