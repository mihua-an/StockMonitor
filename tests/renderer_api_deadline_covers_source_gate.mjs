import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// A browser client has no preloaded source settings, so the first request waits for /api/sources
// behind the source gate. The caller's timeoutMs must cover that wait: the deadline starts before the gate.

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest() }, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const sourcesRequests = [];
globalThis.fetch = (url, options) => new Promise((_resolve, reject) => {
  if (String(url).includes("/api/sources")) sourcesRequests.push(options.signal);
  options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
});

const { apiGet } = await import("../ui/renderer/js/core/api.js");

const started = Date.now();
const error = await apiGet("/api/market-daemon/status", { timeoutMs: 300 }).then(() => null, (e) => e);
const elapsed = Date.now() - started;
assert.equal(error?.name, "AbortError", "the caller's deadline fires while the source gate is still loading");
assert.ok(elapsed < 2000, `gave up after ${elapsed} ms, not after the bootstrap's own cap`);
assert.equal(sourcesRequests.length, 1);
assert.equal(sourcesRequests[0].aborted, false, "the shared settings load keeps running for the other waiters");

// A second caller joins the same load instead of starting another.
const second = await apiGet("/api/market-daemon/status", { timeoutMs: 100 }).then(() => null, (e) => e);
assert.equal(second?.name, "AbortError");
assert.equal(sourcesRequests.length, 1);
console.log("api deadline covers the source gate: caller timeout honoured, shared load kept");
process.exit(0);
