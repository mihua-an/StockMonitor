import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// R04-09 / R04-10: a screen listener that throws is recorded and does not stop the other listeners or the store; a
// Futu control read that is refused leaves the store uninitialized, with the endpoint and generation recorded.
const errors = [];
const warnings = [];
console.error = (...args) => errors.push(args);
console.warn = (...args) => warnings.push(args);

function storage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}
globalThis.localStorage = storage();
globalThis.window = { desktopAPI: { waitForFutuProvider: async () => ({ status: "ready", detail: "" }), networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["futu"], sources: {} } }, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.dispatchEvent = () => true;

// The Taiwan list store: the first listener throws, the second still gets the rows, and a late subscriber's first
// value goes through the same guard.
{
  const { publishTaiwanProductListView, subscribeTaiwanProductListView } = await import("../ui/renderer/js/features/realtime/taiwan_product_list_store.js");
  const seen = [];
  subscribeTaiwanProductListView(() => { throw new Error("broken screen"); });
  subscribeTaiwanProductListView((view) => seen.push(view.rows.length));
  publishTaiwanProductListView({ rows: [{ code: "2330" }] });
  assert.deepEqual(seen, [1]);
  assert.doesNotThrow(() => subscribeTaiwanProductListView(() => { throw new Error("late"); }));
  assert.equal(errors.filter((args) => String(args[0]).includes("Taiwan product list: rows")).length, 2);
}

// The Futu quote store: a listener throwing on its first snapshot does not stop polling from starting; a refused
// status read fails the bootstrap (never initialized with a stale status), recorded with endpoint and generation.
{
  const reads = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    const body = path === "/api/futu/watchlist" ? { ok: true, items: [{ code: "US.AAPL", name: "Apple" }] }
      : path === "/api/futu/status" ? { ok: false, error: "daemon unavailable" } : { ok: true };
    return { ok: true, status: 200, json: async () => body };
  };
  const { moomooQuoteStore } = await import(`../ui/renderer/js/features/realtime/moomoo_quote_store.js?r=${Math.random()}`);
  const seen = [];
  const stopA = moomooQuoteStore.subscribe(() => { throw new Error("broken first snapshot"); });
  const stopB = moomooQuoteStore.subscribe((value) => seen.push(value.initialized));
  await moomooQuoteStore.loading;
  assert.ok(reads.includes("/api/futu/watchlist") && reads.includes("/api/futu/status"), "polling started despite the throwing listener");
  assert.equal(moomooQuoteStore.initialized, false, "a refused status read leaves the store uninitialized");
  assert.equal(moomooQuoteStore.snapshot().status.readiness.state, "DISCONNECTED");
  const failure = errors.find((args) => String(args[0]).includes("Futu quotes: bootstrap"));
  assert.ok(failure, "the bootstrap failure is recorded");
  assert.equal(failure[1].endpoint, "/api/futu/status");
  assert.equal(typeof failure[1].generation, "number");
  assert.ok(seen.length >= 2, "the second listener still gets every emit");
  stopA(); stopB();
}
console.log("renderer store listener isolation contract passed");
