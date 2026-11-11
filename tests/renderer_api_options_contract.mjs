import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// Every api.js method takes the same options -- the JSON methods keep the caller's headers (they used to
// replace them) and every method honours timeoutMs (only GET did).
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const { apiJsonPost, apiDelete } = await import("../ui/renderer/js/core/api.js");

const seen = [];
globalThis.fetch = async (url, options) => {
  seen.push(options);
  if (options.method === "DELETE") {
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

assert.deepEqual(await apiJsonPost("/api/actual-account/sync", { a: 1 }, { headers: { "X-Trace": "t1" } }), { ok: true });
assert.equal(seen[0].headers["Content-Type"], "application/json");
assert.equal(seen[0].headers["X-Trace"], "t1", "the caller's header is kept");
assert.equal(seen[0].body, JSON.stringify({ a: 1 }));

const started = Date.now();
await assert.rejects(apiDelete("/api/settings/shioaji/credentials", { timeoutMs: 30 }), (error) => error?.name === "AbortError");
assert.ok(Date.now() - started < 5000, "DELETE honours timeoutMs");
console.log("renderer api options contract passed");
