import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// api.js's apiGet/apiPost/apiJsonPost/apiJsonPut/apiDelete previously called
// fetch() with no timeout at all -- a hung backend/daemon connection left the
// returned promise pending forever. This drives the real exported functions
// (mocked fetch, real AbortController/signal wiring) through: (1) the
// internal timeout actually aborts a hanging fetch and the caller sees an
// AbortError rather than an eternal hang, (2) a caller-supplied signal keeps
// working exactly as before (relayed, not replaced) and its own abort still
// propagates, (3) the internal timer is always cleared (no timer leak) on
// both success and failure, (4) a request that times out never resolves
// stale data into the caller -- the underlying fetch promise itself rejects,
// it does not just lose a race.

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const { apiGet, apiJsonPost } = await import("../ui/renderer/js/core/api.js");

// Fetch stand-in that mimics real fetch's abort contract: it never settles on
// its own, only ever via the signal firing.
function hangingFetch(_url, options) {
  return new Promise((_resolve, reject) => {
    const abortError = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return err;
    };
    if (options.signal.aborted) { reject(abortError()); return; }
    options.signal.addEventListener("abort", () => reject(abortError()));
  });
}

async function withPatchedTimeout(run) {
  const real = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => {
    const id = { fn, ms, cleared: false };
    scheduled.push(id);
    return id;
  };
  const realClear = globalThis.clearTimeout;
  const cleared = [];
  globalThis.clearTimeout = (id) => { if (id && typeof id === "object") id.cleared = true; cleared.push(id); };
  try {
    return await run({
      scheduled,
      cleared,
      fireAll: () => scheduled.forEach((id) => { if (!id.cleared) id.fn(); }),
      // Yield past the disabledRequest()/fetch-setup microtask chain (using the
      // REAL timer, not the patched one) so apiGet() has actually reached
      // withRequestTimeout()'s setTimeout call before a test fires/inspects it.
      flush: () => new Promise((resolve) => real(resolve, 0)),
    });
  } finally {
    globalThis.setTimeout = real;
    globalThis.clearTimeout = realClear;
  }
}

// --- 1. Internal timeout aborts a hanging request; caller sees AbortError,
// not an eternal hang. ---
{
  globalThis.fetch = hangingFetch;
  await withPatchedTimeout(async ({ fireAll, flush }) => {
    const pending = apiGet("/api/market-daemon/slow-endpoint").then(
      () => { throw new Error("must not resolve"); },
      (error) => error,
    );
    await flush(); // let apiGet() actually reach withRequestTimeout()'s setTimeout call
    fireAll(); // simulate the timeout elapsing
    const error = await pending;
    assert.equal(error.name, "AbortError");
  });
}

// --- 2. A caller-supplied signal still works (relayed into the internal
// controller, not clobbered) and its own abort propagates the same way. ---
{
  globalThis.fetch = hangingFetch;
  const controller = new AbortController();
  const pending = apiGet("/api/market-daemon/slow-endpoint", { signal: controller.signal }).then(
    () => { throw new Error("must not resolve"); },
    (error) => error,
  );
  controller.abort();
  const error = await pending;
  assert.equal(error.name, "AbortError");
}

// --- 3. The internal timer is cleared on a normal successful response (no
// leaked timer holding the process open). ---
{
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await withPatchedTimeout(async ({ scheduled, cleared }) => {
    const body = await apiGet("/api/market-daemon/fast-endpoint");
    assert.deepEqual(body, { ok: true });
    assert.equal(scheduled.length, 1, "one internal timer should have been scheduled");
    assert.equal(cleared.includes(scheduled[0]), true, "the internal timer must be cleared after a successful response");
  });
}

// --- 4. The internal timer is also cleared when the request errors (not
// just on the happy path) -- apiJsonPost exercised here for coverage of a
// second call site, not just apiGet. ---
{
  globalThis.fetch = async () => { throw new Error("network down"); };
  await withPatchedTimeout(async ({ scheduled, cleared }) => {
    await assert.rejects(() => apiJsonPost("/api/market-daemon/thing", { x: 1 }), /network down/);
    assert.equal(scheduled.length, 1);
    assert.equal(cleared.includes(scheduled[0]), true, "the internal timer must be cleared even when fetch itself rejects");
  });
}

console.log("api.js request timeout contract passed");
