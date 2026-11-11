"use strict";
// The IPC domains install exactly the renderer -> main channels of ui/main/ipc_contract.js: the router refuses a
// channel the contract does not list (or lists with another kind), refuses a second handler, and assertComplete()
// names a listed channel nobody installed. preload.js uses exactly the contract's channels.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CHANNELS, PUSH_CHANNELS } = require("../ui/main/ipc_contract");
const { createIpcRouter } = require("../ui/main/ipc_router");
const { installAllDomains } = require("./support/ipc_domains.cjs");

const { handlers, router } = installAllDomains({ authorize: () => true });
router.assertComplete();
const rendererChannels = Object.entries(CHANNELS).filter(([, rule]) => rule.kind !== "push").map(([name]) => name).sort();
assert.deepEqual([...handlers.keys()].sort(), rendererChannels, "every listed channel, and only those, has a handler");
// No renderer ever called these; each was an authorised surface without a user.
for (const channel of ["detached-view:validate", "detached-view:close", "product-catalog:status-local",
  "security-master:search-local", "moomoo-security-master:search-local", "market-daemon:trade-detail-page",
  // folded into runtime:get-bootstrap (one synchronous read per preload)
  "sources:get-settings", "runtime:get-isolated-mode", "live-engine:get-connection", "network:get-manifest", "preferences:get-colors"]) {
  assert.ok(!handlers.has(channel), `${channel} is not exposed`);
}

// The router installs nothing outside the contract.
const bare = createIpcRouter({ transport: { on() {}, handle() {} }, authorize: () => true });
assert.throws(() => bare.handle("unknown:channel", () => {}), /not a invoke channel/);
assert.throws(() => bare.handle("renderer:health", () => {}), /not a invoke channel/, "a send channel is not an invoke");
assert.throws(() => bare.send("preferences:colors-changed", () => {}), /not a send channel/, "a push is never a renderer channel");
bare.handle("startup:get-state", () => {});
assert.throws(() => bare.handle("startup:get-state", () => {}), /installed twice/);
assert.throws(() => bare.assertComplete(), /IPC channels without a handler: .*runtime:get-bootstrap/);

// preload.js: every channel it sends on is a renderer -> main channel of that kind, every one it listens on is a push.
const preload = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "preload.js"), "utf8");
const used = (method) => [...preload.matchAll(/ipcRenderer\.(\w+)\("([^"]+)"/g)].filter((m) => m[1] === method).map((m) => m[2]);
const kindOf = { invoke: "invoke", send: "send", sendSync: "sync" };
const sent = new Set();
for (const [method, kind] of Object.entries(kindOf)) {
  for (const channel of used(method)) { assert.equal(CHANNELS[channel]?.kind, kind, `preload ${method}("${channel}")`); sent.add(channel); }
}
assert.deepEqual([...sent].sort(), rendererChannels, "preload exposes every renderer -> main channel of the contract");
for (const channel of used("on")) assert.ok(PUSH_CHANNELS.includes(channel), `preload listens on ${channel}, not a push of the contract`);

// The product catalog answers SOURCE_DISABLED for a disabled source on the one path.
const { handlers: gated } = installAllDomains({ authorize: () => true, overrides: { sourceEnabled: (source) => source === "shioaji" } });
gated.get("product-catalog:search-local")({ sender: {} }, { source: "futu" }).then((value) => {
  assert.equal(value.error, "SOURCE_DISABLED");
  assert.deepEqual(value.items, []);
  console.log("desktop IPC composition contract passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
