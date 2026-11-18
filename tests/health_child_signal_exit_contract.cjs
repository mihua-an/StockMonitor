"use strict";
// A child ended by a signal has signalCode and no exitCode -- what kill() leaves on Windows too. Health's hosts judge
// "still ours and running" with forced_termination's childExited, never with exitCode alone: a signal-ended Python
// service was still reported as an owned process, and a signal-ended market_runtime held its stop until the timeout.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PythonServiceHost } = require("../health/services/python_service_host.js");
const { AnalysisRuntimeHost } = require("../health/services/analysis_runtime_host.js");

(async () => {
  const signalled = { pid: 4242, exitCode: null, signalCode: "SIGTERM" };
  const running = { pid: 4243, exitCode: null, signalCode: null };

  const python = new PythonServiceHost({ serviceId: "app_api", effective: { services: { app_api: { host: "127.0.0.1", port: 1 } } }, pythonExecutable: "python",
    projectRoot: ".", logDir: ".", managementToken: "t", fs, path, logger: { log() {}, warn() {}, error() {} } });
  python.portPresent = async () => false;
  python.identity = async () => ({ answered: false, verified: false, reason: "port closed" });
  python.child = signalled;
  assert.equal((await python.supervisorProbe()).owned, false, "a signal-ended child is not an owned, running process");
  python.child = running;
  assert.equal((await python.supervisorProbe()).owned, true);

  const analysis = new AnalysisRuntimeHost({ fs, path, projectRoot: ".", dataRoot: ".", eventsDir: ".", configRoot: ".", logDir: ".",
    effective: { services: {} }, tokenFile: "t", logger: { log() {}, warn() {}, error() {} } });
  analysis.child = signalled;
  assert.equal(analysis.running(), false);
  analysis.child = running;
  assert.equal(analysis.running(), true);

  console.log("health child signal exit contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
