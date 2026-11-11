import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// 10-29 13:49:48: the Futu product list read /api/futu/watchlist and /api/futu/status while Health was still starting
// the Futu provider (port 8101 not listening yet); quote_api's proxy answered FUTU_PROVIDER_UNAVAILABLE ~2 s later and
// the page logged a failed bootstrap, then was rescued by whichever caller asked next. The store now asks Electron
// main for Health's provider_futu start outcome first: nothing reaches /api/futu/* before the provider serves, the
// wait shows as "starting", and only a start that failed is an error.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let releaseProvider;
let providerWaits = 0;
let providerOutcome = new Promise((resolve) => { releaseProvider = resolve; });
globalThis.window = {
  desktopAPI: {
    networkManifest: rendererNetworkManifest(),
    sourceSettings: { enabled_sources: ["futu"], sources: {} },
    waitForFutuProvider: () => { providerWaits += 1; return providerOutcome; },
  },
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url)).pathname;
  requests.push(`${options.method || "GET"} ${path}`);
  const body = path === "/api/futu/watchlist"
    ? { ok: true, items: options.method === "PUT" ? JSON.parse(options.body).items : [{ code: "US.AAA", name: "A" }] }
    : path === "/api/futu/status" ? { ok: true, readiness: { connected: true, state: "READY" } } : { ok: true };
  return { ok: true, status: 200, json: async () => body };
};
const errors = [];
const consoleError = console.error;
console.error = (...args) => { errors.push(args); };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

const { moomooQuoteStore } = await import("../ui/renderer/js/features/realtime/moomoo_quote_store.js");
const seen = [];
const unsubscribe = moomooQuoteStore.subscribe((state) => seen.push(state));
const write = moomooQuoteStore.replaceWatchlist([{ code: "US.BBB", name: "B" }]);
await flush();
assert.deepEqual(requests, [], "no /api/futu/* request while Health is still starting the provider");
assert.equal(seen.at(-1).status?.readiness?.state, "PROVIDER_STARTING", "the wait is shown as the provider starting");
assert.equal(seen.at(-1).initialized, false);

releaseProvider({ status: "ready", detail: "" });
await write;
await flush();
assert.ok(requests.includes("GET /api/futu/status") && requests.includes("GET /api/futu/watchlist"), "bootstraps once the provider serves");
assert.ok(requests.includes("PUT /api/futu/watchlist"), "the pending product universe is written once the provider serves");
assert.equal(moomooQuoteStore.snapshot().initialized, true);
assert.deepEqual(errors, [], "a provider still starting is not an error");
unsubscribe();

// A start Health reports as failed is an error, recorded once with its reason, and shown as such; no API read is made.
requests.length = 0;
providerOutcome = Promise.resolve({ status: "failed", detail: "provider_futu: exited with code 1" });
moomooQuoteStore.initialized = false;
const failed = await moomooQuoteStore.bootstrap({ force: true });
assert.deepEqual(requests, []);
assert.equal(failed.initialized, false);
assert.equal(failed.status.readiness.state, "DISCONNECTED");
assert.match(failed.status.last_error, /provider_futu: exited with code 1/);
assert.equal(errors.length, 1);
assert.match(String(errors[0][0]), /Futu quotes: bootstrap/);
assert.ok(providerWaits >= 2);
console.error = consoleError;
console.log("renderer futu provider ready gate contract passed");
