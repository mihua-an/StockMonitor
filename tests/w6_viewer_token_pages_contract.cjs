"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The market_runtime viewer credential goes only to the pages that open a live view (index, workspace_view,
// detached_view); trade_window and watch_pages_window get none. Electron main reads the token, never mints it.
// A detached window's componentId must be one of the known components.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createIpcAuthorizer, DETACHED_COMPONENT_IDS } = require("../ui/main/ipc_security");

const root = "file:///C:/fixture/renderer/";
const sender = { mainFrame: { url: "" }, isDestroyed: () => false };
const win = { webContents: sender, isDestroyed: () => false };
const authorize = createIpcAuthorizer({
  // startup_error.html is a page main loads, but not one any channel allows.
  trustedRendererPage: (url) => ["index.html", "startup_error.html", "trade_window.html", "watch_pages_window.html", "workspace_view.html",
    "detached_view.html"].find((p) => url === root + p) || null,
  fromWebContents: (wc) => (wc === sender ? win : null),
});
// The viewer connection is part of the one preload snapshot (runtime:get-bootstrap): any trusted page may read the
// snapshot, but only a live-view page's snapshot carries the connection.
const runtimeCredentials = require("../service/platform/js/runtime_credentials");
let viewerToken = "viewer-secret";
const realReadToken = runtimeCredentials.readToken;
runtimeCredentials.readToken = (role) => (role === "viewer" ? viewerToken : null);
const { createRendererBootstrap } = require("../ui/main/desktop_application");
const trustedRendererPage = (url) => ["index.html", "startup_error.html", "trade_window.html", "watch_pages_window.html",
  "workspace_view.html", "detached_view.html"].find((p) => url === root + p) || null;
const bootstrap = createRendererBootstrap({
  runtime: { backend: { rendererProtocolVersion: 2 } },
  apiEndpoints: { serviceUrl: () => "ws://127.0.0.1:8010", projection: () => ({ revision: 3 }), served: () => ({ revision: 3, services: {} }),
    authority: () => "effective", routes: () => ({}) },
  desktopWindows: { trustedRendererPage },
  colorPreferenceStore: { current: () => ({}) },
});
const connectionFor = (page) => bootstrap({ senderFrame: { url: root + page } }).liveEngineConnection;
const askFrom = (page) => {
  sender.mainFrame.url = page.includes(":") ? page : root + page;
  return authorize({ sender, senderFrame: sender.mainFrame }, "runtime:get-bootstrap", undefined);
};
for (const page of ["index.html", "workspace_view.html", "detached_view.html"]) {
  assert.equal(askFrom(page), true, page);
  assert.deepEqual(connectionFor(page), { url: "ws://127.0.0.1:8010/live", revision: 3, expected: { service_id: "market_runtime", protocol: 2 } }, `${page} needs the viewer connection`);
}
for (const page of ["trade_window.html", "watch_pages_window.html"]) {
  assert.equal(askFrom(page), true, page);
  assert.equal(connectionFor(page), null, `${page} must not get the viewer connection`);
}
for (const page of ["startup_error.html", "https://evil.example/index.html", "file:///C:/elsewhere/index.html"]) {
  assert.equal(askFrom(page), false, `${page} gets no snapshot at all`);
}
// A sub-frame of a trusted page is not the page.
sender.mainFrame.url = root + "index.html";
assert.equal(authorize({ sender, senderFrame: { url: root + "index.html" } }, "runtime:get-bootstrap", undefined), false);
viewerToken = null;
assert.equal(connectionFor("index.html"), null, "no connection while Health has not minted the token");

// Electron main only READS the viewer token, and what the bootstrap hands a live page -- every nested field -- is the
// URL, never the token; preload passes that bootstrap to the page unchanged.
{
  const Module = require("node:module");
  const { createRendererBootstrap } = require("../ui/main/desktop_application");
  const credentialDir = makeTempDir("w6-viewer-token-");
  const previous = process.env.STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR;
  const stubbedReadToken = runtimeCredentials.readToken;
  process.env.STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR = credentialDir;
  runtimeCredentials.readToken = realReadToken;   // the real file read, not the stub the checks above use
  try {
    let page = "index.html";
    const bootstrap = createRendererBootstrap({
      runtime: { backend: { rendererProtocolVersion: 2 } },
      apiEndpoints: { served: () => ({ revision: 7, services: {} }), authority: () => "effective", routes: () => ({}),
        serviceUrl: (id) => (id === "market_runtime" ? "ws://127.0.0.1:8010" : null), projection: () => ({ revision: 7 }) },
      desktopWindows: { trustedRendererPage: () => page },
      colorPreferenceStore: { current: () => ({}) },
    });
    const snapshot = () => bootstrap({ senderFrame: { url: root + page } });
    // Health has not minted the token: no connection, and Electron does not mint one either.
    assert.equal(snapshot().liveEngineConnection, null);
    assert.deepEqual(fs.readdirSync(credentialDir), [], "Electron must never mint the viewer token");
    const secret = "viewer-secret-".padEnd(48, "x");
    fs.writeFileSync(require("../service/platform/js/runtime_credentials").tokenPath("viewer"), secret, "ascii");
    const answer = snapshot();
    assert.deepEqual(answer.liveEngineConnection, { url: "ws://127.0.0.1:8010/live", revision: 7,
      expected: { service_id: "market_runtime", protocol: 2 } });
    const leaks = (value) => (typeof value === "string" ? value.includes(secret)
      : value && typeof value === "object" ? Object.entries(value).some(([k, v]) => k.includes(secret) || leaks(v)) : false);
    assert.equal(leaks(answer), false, "Codex O5: the page is given the URL, never the viewer token");
    page = "trade_window.html";
    assert.equal(snapshot().liveEngineConnection, null, "a page without a live view gets no connection");
    // preload exposes exactly what the bootstrap carried.
    const exposed = {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
      ipcRenderer: { sendSync: (channel) => (channel === "runtime:get-bootstrap" ? answer : null), on: () => {}, invoke: async () => null } };
    const load = Module._load;
    const previousDocument = globalThis.document;
    Module._load = function (request, ...rest) { return request === "electron" ? electron : load.call(this, request, ...rest); };
    globalThis.document = { documentElement: null };
    try {
      const file = require.resolve("../ui/main/preload.js");
      delete require.cache[file];
      require(file);
    } finally {
      Module._load = load;
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
    assert.equal(exposed.desktopAPI.liveEngineConnection, answer.liveEngineConnection);
  } finally {
    runtimeCredentials.readToken = stubbedReadToken;
    if (previous === undefined) delete process.env.STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR;
    else process.env.STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR = previous;
    fs.rmSync(credentialDir, { recursive: true, force: true });
  }
}
// realtime.js treats a missing connection as idle.
const realtime = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "js", "market_data", "realtime.js"), "utf8");
assert.match(realtime, /window\.desktopAPI\?\.liveEngineConnection\?\.url \|\| ""/);
// The two refused pages really load no realtime module (otherwise refusing them would break them).
for (const page of ["trade_window.html", "watch_pages_window.html"]) {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", page), "utf8");
  assert.doesNotMatch(html, /realtime/i, `${page} loads realtime code`);
}

// Detached-view:open accepts only the components of detached_windows.json, the list windows are opened from.
const DETACHED_WINDOWS = require("../ui/main/detached_windows.json");
assert.deepEqual([...DETACHED_COMPONENT_IDS].sort(), Object.keys(DETACHED_WINDOWS).sort());
sender.mainFrame.url = root + "index.html";
const open = (componentId) => authorize({ sender, senderFrame: sender.mainFrame }, "detached-view:open",
  { version: 1, componentId, contextMode: "live", contextId: "main", symbolMode: "follow" });
for (const id of DETACHED_COMPONENT_IDS) assert.equal(open(id), true, id);
for (const id of ["<img src=x onerror=alert(1)>", "unknownPanel", "", "orderbook ", "__proto__", 42]) assert.equal(open(id), false, String(id));
// Electron main attaches the viewer credential to the /live handshake, only for a live-view page's main frame.
{
  const { createClientAuthentication } = require("../ui/main/client_auth");
  let handler;
  const session = { webRequest: { onBeforeSendHeaders: (_filter, fn) => { handler = fn; } } };
  const auth = createClientAuthentication({ apiOrigins: () => ["http://127.0.0.1:8001"], liveUrl: () => "ws://127.0.0.1:8010/live",
    viewerToken: () => "viewer-secret", env: { STOCK_MONITOR_CLIENT_TOKEN_FILE: path.join(require("node:os").tmpdir(), `w6-client-token-${process.pid}`) } });
  let page = "index.html";
  auth.secureSession(session, () => true, () => ["index.html", "workspace_view.html", "detached_view.html"].includes(page));
  const send = (url, headers = {}) => { let out; handler({ url, requestHeaders: headers }, (r) => { out = r.requestHeaders; }); return out; };
  assert.equal(send("ws://127.0.0.1:8010/live").Authorization, "Bearer viewer-secret");
  assert.equal(send("ws://127.0.0.1:8010/live", { authorization: "Bearer forged" }).Authorization, "Bearer viewer-secret");
  assert.equal(send("ws://127.0.0.1:8010/other").Authorization, undefined, "only the /live socket");
  assert.equal(send("ws://127.0.0.1:8099/live").Authorization, undefined, "only the current market_runtime origin");
  page = "trade_window.html";
  assert.equal(send("ws://127.0.0.1:8010/live").Authorization, undefined, "not for a page without a live view");
}
console.log("W6 viewer credential page scope and detached component allowlist contract passed");
