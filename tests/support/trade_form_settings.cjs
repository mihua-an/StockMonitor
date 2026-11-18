"use strict";
// trade_form.js reads the saved Google Form settings from app_api before it sends a trade. formSettings(transport)
// answers that read with `config` and hands every other request to `transport`, so a test of the form submission
// itself mocks only Google's side.
const CONFIG_URL = "http://127.0.0.1:8001/api/actual-account/config";
const urlFor = (pathname) => `http://127.0.0.1:8001${pathname}`;
const FIELDS = ["trade_date", "market", "action", "code", "trade_info", "trade_time"];

function savedFormConfig(prefillUrl = "https://docs.google.com/forms/d/e/fake/viewform", placeholders = null) {
  const config = { google_form_prefill_url: prefillUrl };
  FIELDS.forEach((key, index) => { config[`google_form_param_${key}`] = placeholders?.[key] ?? `entry.${index}`; });
  return config;
}

function formSettings(transport, config = savedFormConfig(), reads = []) {
  return async (url, options) => {
    if (String(url) !== CONFIG_URL) return transport(url, options);
    reads.push({ url, options });
    const text = JSON.stringify(config);
    return { ok: true, status: 200, url, text: async () => text, json: async () => JSON.parse(text) };
  };
}

module.exports = { CONFIG_URL, urlFor, savedFormConfig, formSettings };
