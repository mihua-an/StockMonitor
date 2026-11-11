import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// R04-12: the watch pages, the holdings stream and the first load can each ask for a new Futu product universe. The
// store sends the writes one at a time in call order and only the newest list: an older answer arriving late can
// never put an older list back.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { desktopAPI: { waitForFutuProvider: async () => ({ status: "ready", detail: "" }), networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["futu"], sources: {} } }, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const puts = [];
let watchlist = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/futu/watchlist" && options.method === "PUT") {
    const items = JSON.parse(options.body).items;
    return new Promise((resolve) => puts.push({ items, answer: () => { watchlist = items; resolve({ ok: true, status: 200, json: async () => ({ ok: true, items }) }); } }));
  }
  const body = path === "/api/futu/watchlist" ? { ok: true, items: watchlist } : path === "/api/futu/status" ? { ok: true, readiness: { connected: true } } : { ok: true };
  return { ok: true, status: 200, json: async () => body };
};
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

const { moomooQuoteStore } = await import("../ui/renderer/js/features/realtime/moomoo_quote_store.js");
const first = moomooQuoteStore.replaceWatchlist([{ code: "US.AAA" }]);
const second = moomooQuoteStore.replaceWatchlist([{ code: "US.BBB" }]);
const third = moomooQuoteStore.replaceWatchlist([{ code: "US.CCC" }]);
await flush();
assert.equal(puts.length, 1, "one write at a time");
assert.deepEqual(puts[0].items.map((item) => item.code), ["US.AAA"]);
puts[0].answer();
await first;
await flush();
assert.equal(puts.length, 2, "the queued writes collapse to the newest list");
assert.deepEqual(puts[1].items.map((item) => item.code), ["US.CCC"]);
puts[1].answer();
await Promise.all([second, third]);
assert.deepEqual(moomooQuoteStore.watchlist.map((item) => item.code), ["US.CCC"], "the newest list is the committed one");
assert.equal(moomooQuoteStore.pendingWatchlist, null);

// Asking again for the committed list sends nothing.
await moomooQuoteStore.replaceWatchlist([{ code: "US.CCC" }]);
assert.equal(puts.length, 2);
console.log("renderer futu watchlist write order contract passed");
