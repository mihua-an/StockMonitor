"use strict";
// On a start timeout or a stop past its grace period the host called child.kill() -- the direct process
// only -- and never checked that it exited, so orphans could keep the port. killOwned() ends the whole tree of an
// owned child (taskkill /T /F on Windows) and reports whether it really exited.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PythonServiceHost } = require("../health/services/python_service_host.js");

function host(execFileImpl) {
  return new PythonServiceHost({
    serviceId: "quote_api", effective: { revision: 1, services: { quote_api: { host: "127.0.0.1", port: 1 } } },
    pythonExecutable: "python", projectRoot: ".", logDir: ".", managementToken: "m", clientToken: "c", fs, path,
    logger: { log() {}, warn() {}, error() {} }, platform: "win32", execFileImpl,
  });
}

function child(pid) {
  const value = new EventEmitter();
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  return value;
}

(async () => {
  const calls = [];
  const obedient = child(4321);
  const exited = await host((file, args, _options, done) => {
    calls.push([file, ...args]);
    setTimeout(() => { obedient.exitCode = 1; obedient.emit("exit", 1, null); done(null); }, 20);
  }).killOwned(obedient);
  assert.equal(exited, true);
  assert.deepEqual(calls, [["taskkill.exe", "/PID", "4321", "/T", "/F"]], "the whole tree, forced");

  const stubborn = child(4322);
  const started = Date.now();
  const gone = await host((_file, _args, _options, done) => done(null)).killOwned(stubborn);
  assert.equal(gone, false, "a child that never exits is reported, not assumed gone");
  assert.ok(Date.now() - started < 8000);

  assert.equal(await host(() => { throw new Error("must not be called"); }).killOwned(Object.assign(child(1), { exitCode: 0 })), true,
    "an already exited child needs no kill");
  console.log("health host kill tree contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
