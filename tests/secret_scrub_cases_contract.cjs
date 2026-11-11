"use strict";
// Secret scrubbing by key and by value (config/secret_scrub.json): the shared cases Python
// (tests/test_secret_scrub_cases.py) and Rust (native/market_runtime/src/remediation.rs) run too, plus the Node users --
// remediation detail (client and writer) and saved config revisions.
const assert = require("node:assert/strict");
const scrub = require("../config/js/secret_scrub.js");
const contract = require("../config/js/remediation_contract.js");
const { secretKeys } = require("../config/js/config_revisions.js");
const cases = require("./fixtures/secret_scrub_cases.json");

for (const [text, scrubbed] of cases.text) {
  assert.equal(scrub.scrubText(text), scrubbed, text);
  assert.deepEqual(scrub.secretSpans(scrubbed), [], `scrubbing is final: ${scrubbed}`);
}
for (const [name, secret] of cases.names) assert.equal(scrub.secretName(name), secret, name);
for (const value of cases.values) {
  assert.deepEqual(scrub.scrubValue(value.in), value.scrubbed);
  assert.deepEqual(scrub.secretPaths(value.in), value.secret_paths);
}
for (const detail of cases.detail) assert.deepEqual(contract.sanitizeDetail(detail.in), detail.out);

// The writer refuses an event whose detail still carries a secret value; a scrubbed one passes.
const event = contract.createEvent({ process: { service_id: "t", instance_id: "t-1", pid: 1, runtime: "node" }, component: "c",
  mechanismId: "sink.client_loss", triggerReason: "queue_full", outcome: "failed", detail: { url: "https://h/?token=abc" } });
assert.equal(event.detail.url, "https://h/?token=[redacted]");
assert.equal(contract.validateEvent(event), null);
assert.match(contract.validateEvent({ ...event, detail: { url: "https://h/?token=abc" } }), /credential value/);
assert.match(contract.validateEvent({ ...event, detail: { list: ["ok", "Bearer abc"] } }), /credential value/);
assert.match(contract.validateEvent({ ...event, detail: { list: [{ a: 1 }] } }), /scalars only/);

// Config revisions: credential references pass, secret values anywhere are refused.
assert.deepEqual(secretKeys({ credential_ref: "win:broker", credentials_configured: true }), []);
assert.deepEqual(secretKeys({ sync: { url: "https://script.google.com/exec?token=abc" }, headers: ["Authorization: Bearer x"] }),
  ["sync.url", "headers[0]"]);
console.log("secret scrub shared cases passed");
