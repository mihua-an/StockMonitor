import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// The Futu product list's persisted selection (localStorage "moomooSelectedCodeV1:live", the name users already
// have): a persisted code is validated against the catalog bootstrap() just fetched before it is ever used, so a
// code the catalog no longer lists never reaches a broker API.
//
// Each scenario dynamic-imports a fresh module instance (cache-busted via a query string): the store reads the
// persisted selection once, at construction.

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
}

async function freshStore({ localStorage, fetchImpl }) {
  globalThis.localStorage = localStorage;
  globalThis.window = { desktopAPI: { waitForFutuProvider: async () => ({ status: "ready", detail: "" }), networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["futu"], sources: {} } }, dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
  globalThis.fetch = fetchImpl;
  const module = await import(`../ui/renderer/js/features/realtime/moomoo_quote_store.js?scenario=${Math.random()}`);
  return module.moomooQuoteStore;
}

function jsonFetch(handler) {
  return async (url, options) => {
    const response = await handler(String(url), options);
    return { ok: true, json: async () => response };
  };
}

// --- 1. A persisted code the catalog does not list is dropped and replaced by the catalog's first product. ---
{
  const storage = makeLocalStorage();
  storage.setItem("moomooSelectedCodeV1:live", "US.GONE");
  const focusCalls = [];
  const store = await freshStore({
    localStorage: storage,
    fetchImpl: jsonFetch((url) => {
      if (url.includes("/api/futu/watchlist")) return { items: [{ code: "US.AAPL", name: "", sort_order: 0 }] };
      if (url.includes("/api/futu/status")) return { status_ok: true };
      if (url.includes("/api/futu/focus")) { focusCalls.push(url); return { ok: true, code: "US.AAPL" }; }
      throw new Error(`unexpected fetch ${url}`);
    }),
  });
  await store.bootstrap();
  assert.equal(store.snapshot().selectedCode, "US.AAPL", "a code absent from the catalog is replaced by a listed product");
  assert.equal(focusCalls.length, 0, "restoring a product does not call Python focus in the Rust live architecture");
  assert.equal(storage.getItem("moomooSelectedCodeV1:live"), "US.AAPL", "the corrected selection is persisted");
}

// --- 2. A persisted code the catalog lists is restored. ---
{
  const storage = makeLocalStorage();
  storage.setItem("moomooSelectedCodeV1:live", "US.TSLA");
  const store = await freshStore({
    localStorage: storage,
    fetchImpl: jsonFetch((url) => {
      if (url.includes("/api/futu/watchlist")) return { items: [{ code: "US.AAPL", sort_order: 0 }, { code: "US.TSLA", sort_order: 1 }] };
      if (url.includes("/api/futu/status")) return { status_ok: true };
      throw new Error(`unexpected fetch ${url}`);
    }),
  });
  await store.bootstrap();
  assert.equal(store.snapshot().selectedCode, "US.TSLA");
}

// --- 3. A catalog not ready yet (classified non-2xx -> payload.ok === false) posts nothing and does not crash. ---
{
  const storage = makeLocalStorage();
  storage.setItem("moomooSelectedCodeV1:live", "US.AAPL");
  const focusCalls = [];
  const store = await freshStore({
    localStorage: storage,
    fetchImpl: jsonFetch((url) => {
      if (url.includes("bootstrap")) return { ok: false, error: "PRODUCTS_BOOTSTRAP_NOT_READY" };
      if (url.includes("focus")) { focusCalls.push(url); return { ok: true, code: "US.AAPL" }; }
      throw new Error(`unexpected fetch ${url}`);
    }),
  });
  await store.bootstrap();
  assert.equal(focusCalls.length, 0, "a not-ready catalog never triggers a focus post of the persisted code");
  assert.equal(store.snapshot().initialized, false, "a not-ready bootstrap leaves the store uninitialized");
}

// --- 4. A throwing localStorage never crashes construction. ---
{
  const throwingStorage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
  };
  await assert.doesNotReject(async () => {
    await freshStore({ localStorage: throwingStorage, fetchImpl: jsonFetch(() => { throw new Error("should not be called"); }) });
  }, "a throwing localStorage does not crash module construction");
}

console.log("moomoo selected-code contract passed");
