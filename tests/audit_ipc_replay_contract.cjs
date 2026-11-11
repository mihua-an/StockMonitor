"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(require.resolve("../ui/main/preload.js"), "utf8");
function fixture() {
  const ipc = new EventEmitter();
  let resolve, reject, api;
  ipc.sendSync = () => ({});
  ipc.invoke = () => new Promise((a, b) => { resolve = a; reject = b; });
  // A preload script always runs with a document: preload.js applies the saved quote colours to
  // :root before first paint (see its own header comment). The VM context has to model that or
  // the module throws at load and this contract never gets to test the IPC behaviour it is for.
  const style = { setProperty() {} };
  const document = { documentElement: { style } };
  vm.runInNewContext(source, {
    document,
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_, v) => { api = v; } } }),
  });
  return { ipc, api, resolve: (v) => resolve(v), reject: () => reject(Error("fixture")) };
}
(async () => {
  for (const scenario of ["dispose-replay", "dispose-push", "push-replay", "replay-push", "reject"]) {
    const f = fixture(); let calls = 0;
    const dispose = f.api.onBackendReady(() => ++calls);
    if (scenario.startsWith("dispose")) { dispose(); dispose(); }
    if (scenario === "push-replay" || scenario === "dispose-push") f.ipc.emit("backend-ready");
    if (scenario === "reject") f.reject(); else f.resolve({ state: "RUNNING" });
    await new Promise(setImmediate);
    if (scenario === "replay-push") f.ipc.emit("backend-ready");
    assert.equal(calls, ["push-replay", "replay-push"].includes(scenario) ? 1 : 0, scenario);
    dispose(); assert.equal(f.ipc.listenerCount("backend-ready"), 0);
  }
  console.log("A14 IPC replay contract passed: cancel-before-replay/push, both delivery orders, rejection, listener cleanup");
})().catch((error) => { console.error(error); process.exitCode = 1; });
