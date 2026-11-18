"use strict";
// A new trade goes to the Google Form named in the saved account settings, which main reads itself with the client
// credential; the renderer's IPC payload carries the trade only. A link that is not a Google Form prefilled link (a
// value saved before the check, or a forms.gle link leading elsewhere) sends nothing.
const assert = require("node:assert/strict");
const { createTradeForm } = require("../ui/main/trade_form");
const { CHANNELS } = require("../ui/main/ipc_contract");
const { CONFIG_URL, urlFor, savedFormConfig, formSettings } = require("./support/trade_form_settings.cjs");

const trade = { trade_date: "2026-11-16", market: "台股", action: "買進", code: "2330", trade_info: "1@100", trade_time: "" };
const confirmed = (url) => ({ ok: true, status: 200, url,
  text: async () => '<div class="freebirdFormviewerViewResponseConfirmationMessage">ok</div>' });

(async () => {
  // The IPC schema takes the trade and nothing else.
  const schema = CHANNELS["google-form:submit-trade"].schema;
  assert.equal(schema({ trade }), true);
  assert.equal(schema({ trade, prefill_url: "https://docs.google.com/forms/d/e/X/viewform" }), false);
  assert.equal(schema({ trade, mapping: {} }), false);

  // The saved link and mapping decide where the trade goes; the read is the authenticated app_api request.
  const sent = [];
  const reads = [];
  const form = createTradeForm({ urlFor, fetch: formSettings(async (url, options) => { sent.push({ url, options }); return confirmed(url); },
    savedFormConfig("https://docs.google.com/forms/d/e/SAVED/viewform?usp=pp_url&entry.7=fixed"), reads) });
  const answer = await form.submitGoogleFormTrade({ trade, prefill_url: "https://evil.example/forms/d/e/X/viewform" });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].url, CONFIG_URL);
  assert.deepEqual(sent.map((item) => item.url), ["https://docs.google.com/forms/d/e/SAVED/formResponse"]);
  const body = new URLSearchParams(sent[0].options.body);
  assert.equal(body.get("entry.3"), "2330");
  assert.equal(body.get("entry.7"), "fixed");

  // A saved link outside Google Forms, or a short link leading elsewhere, sends nothing.
  for (const [link, redirect] of [
    ["https://evil.example/forms/d/e/X/viewform", null],
    ["https://docs.google.com@evil.example/forms/d/e/X/viewform", null],
    ["https://docs.google.com/spreadsheets/d/X/edit", null],
    ["https://forms.gle/AbC", "https://evil.example/forms/d/e/X/viewform"],
  ]) {
    const requests = [];
    const refused = createTradeForm({ urlFor, fetch: formSettings(async (url) => {
      requests.push(url);
      return redirect ? { ok: true, status: 200, url: redirect, text: async () => "" } : confirmed(url);
    }, savedFormConfig(link)) });
    const result = await refused.submitGoogleFormTrade({ trade });
    assert.equal(result.ok, false, link);
    assert.equal(result.uncertain, false, link);
    assert.ok(requests.every((url) => !String(url).includes("formResponse")), link);
  }

  // Settings that are not complete send nothing either.
  const incomplete = savedFormConfig();
  incomplete.google_form_param_code = "";
  const none = [];
  const unset = createTradeForm({ urlFor, fetch: formSettings(async (url) => { none.push(url); return confirmed(url); }, incomplete) });
  const unsetAnswer = await unset.submitGoogleFormTrade({ trade });
  assert.equal(unsetAnswer.ok, false);
  assert.match(unsetAnswer.error, /尚未設定完成/);
  assert.deepEqual(none, []);
  console.log("trade form saved-settings contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
