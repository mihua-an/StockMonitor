"use strict";
// Health registered SIGINT/SIGTERM only after `await supervisor.startAll()` (minutes, worst case), so a
// signal during startup ran no performShutdown and left the started children and their ports behind.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");
const startAll = source.indexOf("supervisor.startAll(\"startup\"");
assert.ok(startAll > 0, "health/main.js still starts its services with supervisor.startAll()");
for (const signal of ["SIGINT", "SIGTERM"]) {
  const registration = source.indexOf(`process.on("${signal}"`);
  assert.ok(registration > 0 && registration < startAll, `${signal} is handled before startAll() is awaited`);
}
assert.ok(source.indexOf("let shuttingDown") < source.indexOf('process.on("SIGTERM"'), "the handler's state exists when it is registered");
console.log("health signal handlers before start contract ok");
