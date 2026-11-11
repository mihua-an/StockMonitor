import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// sharedStatusGet shares one in-flight read and reuses a fulfilled one for maxAgeMs; a rejected read is not
// cached, so the next caller after a failure asks the service again.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const { sharedStatusGet } = await import("../ui/renderer/js/core/api.js");

let calls = 0;
let failNext = true;
globalThis.fetch = async () => {
  calls += 1;
  if (failNext) {
    failNext = false;
    throw new TypeError("fetch failed");
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, n: calls }) };
};

const first = sharedStatusGet("/api/status", 60_000);
const joined = sharedStatusGet("/api/status", 60_000);
assert.equal(first, joined, "a second caller joins the in-flight read");
await assert.rejects(first, /fetch failed/);
assert.equal(calls, 1);

const second = await sharedStatusGet("/api/status", 60_000);
assert.equal(calls, 2, "the read after a failure goes to the service instead of reusing the rejection");
assert.deepEqual(second, { ok: true, n: 2 });

const third = await sharedStatusGet("/api/status", 60_000);
assert.equal(calls, 2, "a fulfilled read is reused within maxAgeMs");
assert.deepEqual(third, second);

await sharedStatusGet("/api/status", 0);
assert.equal(calls, 3, "an expired result is read again");

// A refusal body (the Futu provider not started yet: 503 FUTU_PROVIDER_UNAVAILABLE, resolved by apiGet) is handed to
// the caller that asked, never to the next one: the dock read it before Health started the provider, and the product
// list's first poll after the provider served got that refusal (11-04).
let refuse = true;
globalThis.fetch = async () => {
  calls += 1;
  return refuse
    ? { ok: false, status: 503, json: async () => ({ ok: false, error: "FUTU_PROVIDER_UNAVAILABLE" }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, n: calls }) };
};
const refused = await sharedStatusGet("/api/futu/status", 60_000);
assert.equal(refused.ok, false, "the caller that asked gets the refusal");
refuse = false;
const served = await sharedStatusGet("/api/futu/status", 60_000);
assert.equal(calls, 5, "the read after a refusal goes to the service");
assert.equal(served.ok, true);
console.log("renderer sharedStatusGet contract passed");
