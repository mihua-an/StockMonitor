import assert from "node:assert/strict";
import fs from "node:fs";
import { inFlight, runSingleFlight, userFacingMessage } from "../ui/renderer/js/core/user_action.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The single-flight only dedupes: a second call joins the run that is out, the key is never written, and inFlight
// says whether a run is out -- released before the returned promise's own handlers run, on either outcome.
for (const outcome of ["success", "error"]) {
  for (const startDisabled of [false, true]) {
    const button = { disabled: startDisabled };
    const gate = deferred();
    let calls = 0;
    const action = () => { calls += 1; return gate.promise; };
    const first = runSingleFlight(button, action);
    const duplicate = runSingleFlight(button, action);
    assert.equal(first, duplicate, "duplicate submit must share the same flight");
    assert.equal(inFlight(button), true, "the run is out from the call on");
    assert.equal(button.disabled, startDisabled, "the single-flight never writes the button");
    await Promise.resolve();
    assert.equal(calls, 1, "duplicate submit must execute the action once");
    const seen = first.then(() => inFlight(button), () => inFlight(button));
    if (outcome === "success") gate.resolve({ ok: true });
    else gate.reject(new Error("raw backend traceback detail"));
    if (outcome === "success") await first;
    else await assert.rejects(first);
    assert.equal(await seen, false, `${outcome}: the key is released before the caller's handlers run`);
    assert.equal(button.disabled, startDisabled, `${outcome}: the single-flight never writes the button`);
    assert.equal(inFlight(button), false);
    // Once settled a new call runs again.
    await runSingleFlight(button, () => { calls += 1; });
    assert.equal(calls, 2);
  }
}

const technical = new Error("ECONNREFUSED 127.0.0.1:8000 internal path");
const logged = [];
assert.equal(
  userFacingMessage(technical, "設定儲存失敗，請稍後再試", { context: "TEST", logger: { error: (...args) => logged.push(args) } }),
  "設定儲存失敗，請稍後再試",
);
assert.equal(logged.length, 1, "technical error must remain available to diagnostics");
assert.equal(logged[0][1], technical);
// The reason is in the text too: the console relay to the error log turned a DOMException into "[object DOMException]".
assert.equal(logged[0][0], "[TEST] Error: ECONNREFUSED 127.0.0.1:8000 internal path");
const timedOut = [];
userFacingMessage(new DOMException("signal timed out", "TimeoutError"), "x", { context: "SYNC", logger: { error: (...args) => timedOut.push(args) } });
assert.equal(timedOut[0][0], "[SYNC] TimeoutError: signal timed out");

// The 設定 categories with buttons (the page itself only switches categories).
const settings = ["settings_shioaji_credentials.js", "settings_actual_account.js", "settings_display.js"]
  .map((name) => fs.readFileSync(new URL(`../ui/renderer/js/pages/${name}`, import.meta.url), "utf8")).join("\n");
for (const id of [
  "shioajiCredentialsSaveBtn",
  "shioajiCredentialsClearBtn",
  "actualAccountSettingsSyncBtn",
  "actualAccountSettingsRebuildBtn",
  "actualAccountSettingsSaveBtn",
]) {
  assert.match(settings, new RegExp(`(?:run\\(\\$\\(\\"${id}\\"\\)|runAction\\(\\"${id}\\")`), `${id} must use its page's single-flight run`);
}
assert.doesNotMatch(settings, /set(?:MoomooStorage|ShioajiCredential|Settings)Message\(error(?:\?\.)?\.message/);
assert.doesNotMatch(settings, /setActionNote\("\w+", error(?:\?\.)?\.message/);

console.log("settings duplicate-submit and stable user-error contract passed");
