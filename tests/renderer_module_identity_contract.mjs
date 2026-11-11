import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const renderer = new URL("../ui/renderer/", import.meta.url);
const imports = new Map();
function inspect(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) { inspect(filename); continue; }
    if (!item.name.endsWith(".js")) continue;
    const owner = pathToFileURL(filename);
    const source = fs.readFileSync(filename, "utf8");
    const targets = [];
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith("."), `Unexpected renderer module scheme: ${specifier}`);
      const target = new URL(specifier, owner);
      assert.equal(target.search + target.hash, "", `Module identity must be canonical: ${owner} -> ${specifier}`);
      assert.ok(target.href.startsWith(renderer.href), `Module escaped its release: ${target}`);
      assert.ok(fs.existsSync(target), `Missing module: ${target}`);
      targets.push(target.href);
    }
    imports.set(owner.href, targets);
  }
}
inspect(fileURLToPath(renderer));
// Feature modules must never depend on pages, directly or through a cycle.
for (const owner of imports.keys()) {
  if (!owner.includes('/js/features/')) continue;
  const visiting=new Set(),visited=new Set();
  function visit(url) {
    assert.ok(!url.includes('/js/pages/'), `Feature depends on a page: ${owner} -> ${url}`);
    assert.ok(!visiting.has(url), `Cyclic feature dependency: ${owner} -> ${url}`);
    if(visited.has(url))return;
    visiting.add(url);for(const target of imports.get(url)||[])visit(target);
    visiting.delete(url);visited.add(url);
  }
  visit(owner);
}
// core/ -> features/ is forbidden except two narrow, explicitly enumerated
// exceptions: a status/diagnostics aggregator reading a feature's public,
// read-only stats accessors, and the dashboard component registry
// instantiating a feature's component classes for registration. Neither
// exception may reach into feature internal state, mutate it, or import
// anything beyond the exact named symbols listed here -- a new target file,
// a new symbol, or a new core importer must fail loudly rather than let the
// exception surface silently grow.
const CORE_FEATURE_EXCEPTIONS = {};
for (const owner of imports.keys()) {
  if (!owner.includes("/js/core/")) continue;
  const featureTargets = (imports.get(owner) || []).filter(url => url.includes("/js/features/"));
  if (featureTargets.length === 0) continue;
  const ownerRelative = owner.slice(renderer.href.length);
  const allowed = CORE_FEATURE_EXCEPTIONS[ownerRelative];
  assert.ok(allowed, `core file imports features/ without a declared contract exception: ${ownerRelative} -> ${featureTargets.join(", ")}`);
  for (const target of featureTargets) {
    const targetRelative = target.slice(renderer.href.length);
    assert.ok(Object.hasOwn(allowed, targetRelative), `${ownerRelative} imports an undeclared feature target: ${targetRelative}`);
  }
}
// A declared exception nobody imports anymore is a stale, silently-widening
// surface -- the contract itself must stay in sync with real usage.
for (const [ownerRelative, targets] of Object.entries(CORE_FEATURE_EXCEPTIONS)) {
  const actualTargets = new Set(imports.get(new URL(ownerRelative, renderer).href) || []);
  for (const targetRelative of Object.keys(targets)) {
    assert.ok(actualTargets.has(new URL(targetRelative, renderer).href), `stale contract exception: ${ownerRelative} no longer imports ${targetRelative}`);
  }
}
// Symbol-level lock: each exception may only import the exact named symbols
// declared above; a broader import of the same target must fail loudly.
for (const [ownerRelative, targets] of Object.entries(CORE_FEATURE_EXCEPTIONS)) {
  const source = fs.readFileSync(fileURLToPath(new URL(ownerRelative, renderer)), "utf8");
  for (const [targetRelative, allowedSymbols] of Object.entries(targets)) {
    const targetFilename = targetRelative.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importLine = source.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["'][^"']*${targetFilename}["']`));
    assert.ok(importLine, `${ownerRelative}: expected a named import statement for ${targetRelative}`);
    const importedSymbols = importLine[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const undeclared = importedSymbols.filter(symbol => !allowedSymbols.includes(symbol));
    assert.equal(undeclared.length, 0,
      `${ownerRelative} imports undeclared symbols from ${targetRelative}: ${undeclared.join(", ")} ` +
      "(update CORE_FEATURE_EXCEPTIONS in this contract if this expansion is intentional)");
  }
}

const targetFrom = (owner, suffix) => imports.get(new URL(owner, renderer).href).find(url => url.endsWith(suffix));
const appRealtime = targetFrom("app.js", "/market_data/realtime.js");
const pageRealtime = targetFrom("js/pages/realtime.js", "/market_data/realtime.js");
assert.equal(appRealtime, pageRealtime);
assert.equal(appRealtime, targetFrom("js/features/realtime/live_monitor_events.js", "/market_data/realtime.js"));

const live = installRealtimeHarness();
const { sockets, timers } = live;
const app = await import(appRealtime), page = await import(pageRealtime);
assert.strictEqual(app, page);
// One shared Futu quote store across every importer. This used to also assert the same for a
// separate moomoo_focused_store.js, but that module was deleted in 9af09a0 and its role folded
// into the Futu components' focusedProduct() (components/futu/futu_product.js), which reads this same store -- so there is
// no second instance left to diverge, and asserting on the removed module only crashed the scan.
const quoteImporters = ["app.js", "js/features/realtime/components/futu/futu_product.js"];
const quoteModules = await Promise.all(quoteImporters.map(async (owner) => {
  const target = targetFrom(owner, "/features/realtime/moomoo_quote_store.js");
  assert.ok(target, `${owner} no longer imports moomoo_quote_store.js`);
  return import(target);
}));
for (const module of quoteModules) {
  assert.strictEqual(module.moomooQuoteStore, quoteModules[0].moomooQuoteStore);
}
assert.ok(!fs.existsSync(new URL("js/features/realtime/moomoo_focused_store.js", renderer)),
  "moomoo_focused_store.js is back: restore the singleton assertion it used to have");

for (let i = 0; i < 20; i++) { app.startRealtimeStream(() => {}); page.notifyBackendReadyForRealtime(); page.requestRealtimeReconnect(); }
assert.equal(sockets.length, 1, "Repeated init must reuse the connecting socket");
sockets[0].ready();
const spec = { market: "STK", code: "2330", trading_date: "2026-09-05", channels: ["trades"] };
const count = (socket, type) => socket.sent.filter(message => message.type === type).length;
for (let cycle = 0; cycle < 10; cycle++) {
  const oldCount = count(sockets[0], "view.subscribe");
  const releaseApp = app.subscribeRealtimeView(spec, () => {});
  const releasePage = page.subscribeRealtimeView(spec, () => {});
  assert.equal(count(sockets[0], "view.subscribe"), oldCount + 1);
  assert.equal(app.getRealtimeViewStats().client_subscription_count, 1);
  const request = sockets[0].sent.filter(message => message.type === "view.subscribe").at(-1).payload;
  const identity = { request_id: request.request_id, subscription_id: `sub-${cycle}`, stream_id: "STK|2330|DAY|2026-09-05", watermark: 0 };
  sockets[0].emit("message", { data: JSON.stringify({ type: "view.subscription.accepted", payload: identity }) });
  sockets[0].emit("message", { data: JSON.stringify({ type: "view.snapshot", payload: { ...identity, session_generation: 1, summary: {}, trend: [], trades: [] } }) });
  assert.deepEqual(app.getRealtimeViewSnapshot(spec), page.getRealtimeViewSnapshot(spec));
  const oldUnsubscribes = count(sockets[0], "view.unsubscribe");
  releaseApp();
  assert.equal(count(sockets[0], "view.unsubscribe"), oldUnsubscribes);
  releasePage();
  assert.equal(count(sockets[0], "view.unsubscribe"), oldUnsubscribes + 1);
  const releaseNewPage = page.subscribeRealtimeView(spec, () => {});
  releasePage(); // a late/repeated destroy must not close the remounted page
  assert.equal(page.getRealtimeViewStats().client_subscription_count, 1);
  releaseNewPage();
  assert.equal(app.getRealtimeViewStats().client_subscription_count, 0);
}
// The callback map deduplicates repeated init with the same callback. A second
// handle for that old entry must not delete a later entry when it is released.
const sameCallback = () => {};
const oldHandleA = page.subscribeRealtimeView(spec, sameCallback);
const oldHandleB = page.subscribeRealtimeView(spec, sameCallback);
oldHandleA();
const newHandle = page.subscribeRealtimeView(spec, () => {});
oldHandleB();
assert.equal(page.getRealtimeViewStats().client_subscription_count, 1);
newHandle();
const release = page.subscribeRealtimeView(spec, () => {});
sockets[0].drop();
for (let i = 0; i < 20; i++) page.requestRealtimeReconnect();
assert.equal(sockets.length, 2, "Reconnect has one successor socket");
sockets[1].ready();
assert.equal(count(sockets[1], "view.subscribe"), 1, "Reconnect restores one subscription");
for (let i = 0; i < 20; i++) { app.startRealtimeStream(() => {}); page.notifyBackendReadyForRealtime(); }
assert.equal(sockets.length, 2);
assert.equal(count(sockets[1], "view.subscribe"), 1);
release();
timers.clear();
console.log(`renderer canonical module graph (${imports.size} modules), stores and lifecycle passed`);
