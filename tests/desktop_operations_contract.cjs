"use strict";
const assert = require("node:assert/strict");
const { createProductOperations } = require("../ui/main/product_operations");
const { createTradeForm } = require("../ui/main/trade_form");
(async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    // trade_form.js's own fetch() wrapper (its A16 deadline handling) always
    // reads response.text() once and reconstructs .json() from it, and
    // submitGoogleFormTrade() checks response.url plus the confirmation
    // marker in the Google Form response body -- the mock must satisfy all
    // three (url/text/json), not just json(), for that real code path.
    const isFormResponse = String(url).includes("/formResponse");
    return {
      ok: true, status: 200, url,
      text: async () => (isFormResponse
        ? '<div class="freebirdFormviewerViewResponseConfirmationMessage">已收到你的回應。</div>'
        : JSON.stringify({ ok: true })),
      json: async () => ({ ok: true }),
    };
  };
  // Requests are addressed by path through the route table (config/api_routes.json), never to one base URL.
  const { serviceForPath } = require("../config/js/api_routes");
  const ports = { realtime_api: 8000, app_api: 8001 };
  const urlFor = (path) => `http://127.0.0.1:${ports[serviceForPath(path)]}${path}`;
  const disabled = createProductOperations({ fetch, urlFor, productCatalogStore: {}, sourceEnabled: () => false });
  assert.equal((await disabled.refreshFutuProductCatalog()).error, "SOURCE_DISABLED");
  assert.equal(calls.length, 0);
  const enabled = createProductOperations({ fetch, urlFor, productCatalogStore: {}, sourceEnabled: () => true });
  // Shioaji's master is the provider login's to write: the desktop never asks for it (before the login it has no
  // contracts to write it from).
  assert.equal(enabled.refreshShioajiProductCatalog, undefined);
  await enabled.refreshFutuProductCatalog();
  assert.ok(calls[0].url.endsWith("/api/futu/security-master/ensure"));
  const form = createTradeForm({ fetch });
  const mapping = Object.fromEntries(["trade_date", "market", "action", "code", "trade_info", "trade_time"].map((key, index) => [key, `entry.${index + 1}`]));
  const result = await form.submitGoogleFormTrade({
    prefill_url: "https://docs.google.com/forms/d/e/test/viewform?entry.99=fixed", mapping,
    trade: { trade_date: "2026-09-04", market: "台股", action: "買進", code: "2330", trade_info: "1000@100", trade_time: "0912" },
  });
  assert.equal(result.ok, true);
  const submission = calls[1];
  assert.equal(submission.url, "https://docs.google.com/forms/d/e/test/formResponse");
  const params = new URLSearchParams(submission.options.body);
  assert.equal(params.get("entry.6"), "09:12");
  assert.equal(params.get("entry.99"), "fixed");
  // The ledger sync after a new trade is the trade window's own request (trade_window.js), not main's.
  assert.equal(form.syncActualAccountAfterTradeAdd, undefined);
  assert.equal(calls.length, 2);
  console.log("desktop product and form contracts passed (mock transport)");
})().catch(error => { console.error(error); process.exitCode = 1; });
