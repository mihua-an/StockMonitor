"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A failed spawn emits "error" and never "exit". With no listener it was an uncaught exception in
// Health, and the start loop (watching exitCode) waited out its whole timeout. It now fails at once.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { PythonServiceHost } = require("../health/services/python_service_host.js");

function failingSpawn() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = undefined;
  child.kill = () => {};
  setTimeout(() => child.emit("error", Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" })), 10);
  return child;
}

(async () => {
  const uncaught = [];
  process.on("uncaughtException", (error) => uncaught.push(error));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));   // a free port: nothing answers, nothing is occupied

  const errors = [];
  const host = new PythonServiceHost({
    serviceId: "quote_api", effective: { revision: 1, services: { quote_api: { host: "127.0.0.1", port } } },
    pythonExecutable: "missing-python.exe", projectRoot: os.tmpdir(), logDir: makeTempDir("spawn-err-"),
    managementToken: "m".repeat(40), clientToken: "c".repeat(40), fs, path,
    logger: { log() {}, warn() {}, error: (line) => errors.push(line) }, spawnImpl: failingSpawn,
  });
  const started = Date.now();
  await assert.rejects(host.ensure(), /could not be started: spawn python ENOENT/);
  assert.ok(Date.now() - started < 5000, "fails at once instead of waiting out the start timeout");
  assert.equal(host.child, null);
  assert.equal(uncaught.length, 0, "no uncaught exception");
  assert.ok(errors.some((line) => line.includes("ENOENT")));
  console.log("health host spawn error contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
