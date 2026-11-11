import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

import { makeTempDir } from "./support/temp_dirs.cjs";
// A failure that a UI path answers with {ok:false} (or shows on the page) is also a record naming its operation and
// path -- the renderer's and Electron main's console warnings/errors are the run's error.log (error_record_contract).
// And a network apply rediscovers the endpoints at once, through Health's held effective-endpoint read, not after a
// fixed delay.
const require = createRequire(import.meta.url);
const records = [];
const realWarn = console.warn, realError = console.error;
const capture = () => {
  records.length = 0;
  console.warn = (...args) => records.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  console.error = console.warn;
};
const release = () => { console.warn = realWarn; console.error = realError; };
const has = (pattern) => records.some((line) => pattern.test(line));

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { id, textContent: "", className: "", disabled: false, value: "", classList: { toggle() {}, remove() {}, add() {} },
    addEventListener() {}, setAttribute() {} });
  return elements.get(id);
};
globalThis.document = { hidden: true, getElementById: element, querySelectorAll: () => [], querySelector: () => null, activeElement: null,
  addEventListener() {} };
globalThis.window = { dispatchEvent() {}, addEventListener() {},
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } } };

// --- api.js: an answered non-2xx is returned to the caller AND recorded with method, route and status
let answer = null;
globalThis.fetch = async () => answer();
const { apiGet } = await import("../ui/renderer/js/core/api.js");
answer = () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: "REVISION_CONFLICT" }) });
capture();
try {
  assert.deepEqual(await apiGet("/api/config/network?x=1"), { ok: false, error: "REVISION_CONFLICT" });
} finally { release(); }
assert.ok(has(/\[api: GET \/api\/config\/network\] HTTP 409 REVISION_CONFLICT/), records.join("\n"));

// --- status.js: a Futu status read that fails is recorded, not only drawn as 未連線
answer = () => { throw new Error("connection refused"); };
const status = await import("../ui/renderer/js/core/status.js");
capture();
try { await assert.rejects(status.refreshStatus()); } finally { release(); }
assert.ok(has(/\[status: GET \/api\/futu\/status\] failed connection refused/), records.join("\n"));
assert.equal(element("moomooStatusText").textContent, "Futu 未連線（FastAPI 無回應）");

// --- settings_storage.js: a settings read answered {ok:false} is recorded with its path
answer = () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: "SETTINGS_UNAVAILABLE" }) });
const storage = await import("../ui/renderer/js/pages/settings_storage.js");
capture();
try {
  storage.initStorageSettings();
  await new Promise((resolve) => setTimeout(resolve, 10));
} finally { release(); }
assert.ok(has(/\[settings\/storage: reading GET \/api\/config\/storage_retention\] failed SETTINGS_UNAVAILABLE/), records.join("\n"));
assert.ok(has(/\[settings\/storage: reading GET \/api\/config\/storage_location\] failed/), records.join("\n"));
assert.match(element("storageMessage").textContent, /讀取失敗/);
storage.disposeStorageSettings();

// --- watch_page_store.js (Electron main, read only): a failed read is recorded with the file it touched
const { createWatchPageStore } = require("../ui/main/watch_page_store.js");
const root = makeTempDir("ui-failure-records-");
const savedRoot = process.env.STOCK_MONITOR_DATA_ROOT;
process.env.STOCK_MONITOR_DATA_ROOT = root;
try {
  const store = createWatchPageStore(root, { catalog: { withMetadata: (pages) => ({ revision: null, pages }) } });
  fs.mkdirSync(path.join(root, "preferences"), { recursive: true });
  fs.writeFileSync(path.join(root, "preferences", "watch_pages.csv"), "pgid,name\r\na,b\r\n", "utf8");
  capture();
  try { assert.equal(store.load().ok, false); } finally { release(); }
  assert.ok(has(/\[WATCH PAGES reading .*watch_pages\.csv\] failed/), records.join("\n"));
} finally {
  if (savedRoot === undefined) delete process.env.STOCK_MONITOR_DATA_ROOT; else process.env.STOCK_MONITOR_DATA_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
}

// --- desktop_application.js: settings IPC failures are recorded; a network apply rediscovers at once
const { registerSettingsIpc } = require("../ui/main/ipc_registration.js");
const handlers = {};
const router = { handle: (channel, fn) => { handlers[channel] = (payload) => fn({}, payload); } };
const refreshes = [];
let applyAnswer = { ok: true, operation: { state: "APPLIED" } };
const controllerClient = {
  getOperations: async () => { throw new Error("controller unreachable"); },
  applyNetwork: async () => (applyAnswer instanceof Error ? Promise.reject(applyAnswer) : applyAnswer),
};
const apiEndpoints = { refreshFromHealth: async (client, reason) => { refreshes.push(reason); return true; } };
registerSettingsIpc(router, { controllerClient, apiEndpoints });

capture();
try { assert.deepEqual(await handlers["network:operations"](), { ok: false, error: "controller unreachable" }); } finally { release(); }
assert.ok(has(/\[SETTINGS network:operations: reading Health's network operations\] failed controller unreachable/), records.join("\n"));

const realSetTimeout = globalThis.setTimeout;
let timers = 0;
globalThis.setTimeout = (...args) => { timers += 1; return realSetTimeout(...args); };
try {
  assert.equal((await handlers["network:apply"]({ candidate_revision: 4, expected_active_revision: 3 })).ok, true);
} finally { globalThis.setTimeout = realSetTimeout; }
assert.deepEqual(refreshes, ["network_apply"], "the rediscovery starts when the apply answers");
assert.equal(timers, 0, "no fixed delay before the rediscovery");

applyAnswer = { ok: true, pending_restart: true };
await handlers["network:apply"]({ candidate_revision: 5, expected_active_revision: 4 });
assert.equal(refreshes.length, 1, "a self-endpoint apply is rediscovered by the Health bootstrap listener instead");

applyAnswer = new Error("Health closed the connection");
capture();
try { assert.equal((await handlers["network:apply"]({ candidate_revision: 6, expected_active_revision: 4 })).ok, false); } finally { release(); }
assert.ok(has(/\[SETTINGS network:apply: applying revision 6 .*\] failed Health closed the connection/), records.join("\n"));
assert.equal(refreshes.length, 1);

const source = fs.readFileSync(new URL("../ui/main/ipc_registration.js", import.meta.url), "utf8");
assert.ok(!/setTimeout\([^)]*refreshFromHealth/.test(source), "no timer in front of the endpoint rediscovery");
console.log("ui failure records contract passed");
