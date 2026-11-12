"use strict";
// Electron main's copy of the product catalog follows app_api's /api/product-catalog/events (BACKLOG 1t, 10-20: the
// copy was loaded once at start, so a security master written by the 08:05 relogin reached searches only after a
// restart). A new revision reads the catalog again; the same revision reads nothing; a break reconnects.
const assert = require("node:assert/strict");
const { createProductCatalogStore } = require("../ui/main/product_catalog_store");

function streamOf(chunks, signal) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) { // stays open until aborted, like fetch's body
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        let chunk = chunks[index++];
        if (typeof chunk === "function") { chunk(); chunk = chunks[index++]; }
        if (chunk instanceof Error) throw chunk;
        return { value: encoder.encode(chunk), done: false };
      },
    }),
  };
}

async function settle(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), "condition not reached");
}

(async () => {
  let revision = "r1";
  const items = { r1: [{ source: "shioaji", code: "2330", name: "台積電" }],
    r2: [{ source: "shioaji", code: "2330", name: "台積電" }, { source: "shioaji", code: "2454", name: "聯發科" }] };
  const calls = [];
  const streams = [
    // first connection: the revision now (already loaded), a heartbeat, then a master written (r2), then a reset
    [`event: catalog.changed\ndata: {"revision": "r1"}\n\n`, ": heartbeat\n\n",
      () => { revision = "r2"; }, // the provider wrote its master; app_api rebuilt the catalog
      `event: catalog.changed\ndata: {"revis`, `ion": "r2"}\n\n`, new Error("socket reset")],
    // reconnect: the same revision: nothing is read again
    [`event: catalog.changed\ndata: {"revision": "r2"}\n\n`],
  ];
  const warnings = [];
  // Codex 1022-ST-09: a break was only a console warning. It is one remediation operation from the break to the
  // stream answering again.
  const records = [];
  const remediation = { begin: (start) => { records.push({ started: start }); return { finish: (outcome, result) => records.push({ outcome, ...result }) }; } };
  const store = createProductCatalogStore({
    remediation: () => remediation,
    urlFor: (path) => `http://127.0.0.1:8001${path}`,
    logger: { warn: (message) => warnings.push(message) },
    wait: async () => {},
    fetchImpl: async (url, options) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/api/product-catalog/bootstrap")) {
        return { ok: true, json: async () => ({ ok: true, items: items[revision], status: { revision, last_error: null } }) };
      }
      return { ok: true, body: streamOf(streams.shift() || [], options.signal) };
    },
  });

  await store.bootstrap();
  assert.equal(store.snapshot().status.revision, "r1");
  // A source the catalog lists nothing for (Futu before OpenD first connected) answers listed 0, so the search can say
  // its list was never fetched instead of "no match"; a source with products answers how many.
  assert.deepEqual([store.search({ source: "futu", query: "AAPL" }).listed, store.search({ source: "shioaji", query: "zzz" }).listed], [0, 1]);
  await settle(() => store.search({ source: "shioaji", query: "2454" }).count === 1);
  await settle(() => calls.filter((path) => path === "/api/product-catalog/events").length === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((path) => path === "/api/product-catalog/bootstrap").length, 2,
    "read once at start and once for r2; the heartbeat and the reconnect's same revision read nothing");
  assert.ok(warnings.some((message) => message.includes("socket reset")), "the break is logged");
  assert.equal(records.length, 2, JSON.stringify(records));
  assert.equal(records[0].started.mechanismId, "ui.catalog_stream_reconnect");
  assert.equal(records[0].started.triggerReason, "stream_failed");
  assert.equal(records[1].outcome, "succeeded");
  assert.equal(records[1].attempt, 1, "the one reconnect it took");
  store.stop();

  // Codex 1020-R04-01: a read of a new revision that failed was swallowed and the stream read on; the heartbeat never
  // repeats the revision, so the copy stayed at the old one until the next catalog change. The failure breaks the
  // stream instead: the reconnect announces the revision now and it is read again.
  {
    let current = "r1";
    let failNext = false;
    const reads = [];
    const records = [];
    const remediation = { begin: (start) => { records.push({ started: start }); return { finish: (outcome, result) => records.push({ outcome, ...result }) }; } };
    const streams = [
      [`data: {"revision": "r1"}\n\n`, () => { current = "r2"; failNext = true; }, `data: {"revision": "r2"}\n\n`, ": heartbeat\n\n"],
      [`data: {"revision": "r2"}\n\n`, ": heartbeat\n\n"],
    ];
    const store = createProductCatalogStore({
      remediation: () => remediation,
      urlFor: (path) => `http://127.0.0.1:8001${path}`,
      logger: { warn: () => {} },
      wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url.endsWith("/api/product-catalog/bootstrap")) {
          reads.push(current);
          if (failNext) {
            failNext = false;
            return { ok: false, status: 503, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({ ok: true, items: items[current], status: { revision: current, last_error: null } }) };
        }
        return { ok: true, body: streamOf(streams.shift() || [], options.signal) };
      },
    });
    await store.bootstrap();
    await settle(() => store.snapshot().status.revision === "r2");
    assert.deepEqual(reads, ["r1", "r2", "r2"], "r2 is read again after the failed read, without waiting for another change");
    assert.equal(store.search({ source: "shioaji", query: "2454" }).count, 1);
    await settle(() => records.length === 2);
    assert.equal(records[0].started.triggerReason, "reload_failed");
    assert.equal(records[0].started.detail.revision, "r2");
    assert.equal(records[0].started.detail.loaded_revision, "r1");
    assert.equal(records[1].outcome, "succeeded");
    assert.equal(records[1].detail.revision, "r2", "it ends when the announced revision is loaded");
    store.stop();
  }
  console.log("product_catalog_store_follow: ok");
})().catch((error) => { console.error(error); process.exit(1); });
