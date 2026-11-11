"use strict";
const assert = require("node:assert/strict");
const { installAllDomains } = require("./support/ipc_domains.cjs");
const { createIpcAuthorizer } = require("../ui/main/ipc_security");
const root = "file:///C:/fixture/renderer/";
const sender = { mainFrame: { url: root + "trade_window.html" }, isDestroyed: () => false };
const event = { sender, senderFrame: sender.mainFrame };
const win = { webContents: sender, isDestroyed: () => false };
const authorizeEvent = createIpcAuthorizer({
  trustedRendererPage: (url) => ["index.html", "trade_window.html", "watch_pages_window.html", "workspace_view.html", "detached_view.html"].find((p) => url === root + p) || null,
  fromWebContents: (wc) => wc === sender ? win : null,
});
const form = {
  prefill_url: "https://docs.google.com/forms/d/e/TEST/viewform",
  mapping: Object.fromEntries(["trade_date", "market", "action", "code", "trade_info", "trade_time"].map((k, i) => [k, `entry.${i}`])),
  trade: { trade_date: "2026-09-19", market: "台股", action: "買進", code: "2330", trade_info: "1@100", trade_time: "12:00", trade_id: null },
};
let counter = { effects: 0 };
const quiet = { warn() {}, error() {}, log() {} };
function setup(auth) {
  const installed = installAllDomains({ authorize: auth, logger: quiet, overrides: {
    submitGoogleFormTrade: () => ++counter.effects,
    watchPageStore: { load: () => ++counter.effects },
    reportRendererHealth: () => ++counter.effects,
  } });
  installed.router.assertComplete();
  return installed.handlers;
}
const handlers = setup(authorizeEvent);
const submit = (payload = form, e = event) => handlers.get("google-form:submit-trade")(e, payload);
assert.equal(submit(), 1);
function denied(fn) { const before = counter.effects; assert.throws(fn, /IPC_UNAUTHORIZED/); assert.equal(counter.effects, before); }
denied(() => submit(form, { sender, senderFrame: { url: sender.mainFrame.url } }));
denied(() => submit(form, { sender }));
for (const url of ["https://evil.example/", root + "trade_window.html?fake", root + "workspace_view.html", "file:///C:/other/trade_window.html"]) {
  sender.mainFrame.url = url; denied(() => submit());
}
sender.mainFrame.url = root + "trade_window.html";
for (const payload of [null, [], {}, { ...form, trade: { ...form.trade, code: "<b>" } },
  { ...form, prefill_url: "http://docs.google.com/forms/test" }, { ...form, mapping: [] },
  { ...form, trade: { ...form.trade, trade_date: "2026-02-30" } },
  { ...form, prefill_url: "https://docs.google.com@evil.example/forms/test" }]) denied(() => submit(payload));
sender.isDestroyed = () => true; denied(() => submit()); sender.isDestroyed = () => false;
win.webContents = {}; denied(() => submit()); win.webContents = sender;
win.isDestroyed = () => true; denied(() => submit()); win.isDestroyed = () => false;
denied(() => handlers.get("google-form:submit-trade")(event, form, "extra"));
sender.mainFrame.url = root + "watch_pages_window.html";
// The product pages are written by settings_api only (POST /api/subscriptions/ops): main has no write channel.
assert.equal(handlers.has("watch-pages:save-local") || handlers.has("watch-pages:reorder-local"), false);
// Every channel of ipc_contract.js fails closed by its kind: an invoke rejects, a send is dropped, a sync answers
// {ok:false, error:"IPC_UNAUTHORIZED"} -- with zero side effects.
const { CHANNELS } = require("../ui/main/ipc_contract");
let refusedChannels = 0;
for (const auth of [undefined, () => { throw Error("private detail"); }, () => Promise.resolve(true), () => 1]) {
  const blocked = setup(auth);
  for (const [channel, handler] of blocked) {
    const e = { ...event };
    const before = counter.effects;
    if (CHANNELS[channel].kind === "sync") { handler(e, {}); assert.equal(e.returnValue.error, "IPC_UNAUTHORIZED"); }
    else if (CHANNELS[channel].kind === "send") { handler(e, {}); assert.equal(e.returnValue, undefined); }
    else denied(() => handler(e, {}));
    assert.equal(counter.effects, before, channel);
    refusedChannels += 1;
  }
}
assert.equal(createIpcAuthorizer()(event, "startup:get-state"), false);
assert.equal(authorizeEvent(event, "unknown-channel"), false);
console.log(`A17 IPC security contract passed: ${refusedChannels / 4} channels fail closed; rejected sources/payloads cause zero side effects`);
