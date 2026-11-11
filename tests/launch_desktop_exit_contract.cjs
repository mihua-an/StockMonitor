"use strict";
// The dev launcher reports Electron's outcome: a failed spawn and an Electron ended by a signal are non-zero
// exits with a record, never 0; SIGINT/SIGTERM of the launcher reach Electron.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { launch, exitCodeFor } = require("../scripts/launch_desktop.js");

assert.equal(exitCodeFor(0, null), 0);
assert.equal(exitCodeFor(3, null), 3);
assert.notEqual(exitCodeFor(null, "SIGTERM"), 0, "a signal-ended Electron is not a success");

const stderr = process.stderr.write.bind(process.stderr);
const records = [];
process.stderr.write = (line) => { records.push(String(line)); return true; };
try {
  const run = (setup) => {
    const exits = [];
    const signals = new EventEmitter();
    const child = new EventEmitter();
    child.killed = [];
    child.kill = (name) => child.killed.push(name);
    launch({ electronBinary: () => "electron.exe", spawnImpl: () => child, exit: (code) => exits.push(code), signals });
    setup(child, signals);
    return { exits, child, signals };
  };
  const failed = run((child) => child.emit("error", new Error("spawn ENOENT")));
  assert.deepEqual(failed.exits, [1]);
  assert.ok(records.some((line) => line.includes("spawn_failed") && line.includes("ENOENT")));

  const signalled = run((child, signals) => { signals.emit("SIGINT"); child.emit("exit", null, "SIGINT"); });
  assert.deepEqual(signalled.child.killed, ["SIGINT"], "Ctrl+C is passed on");
  assert.equal(signalled.exits.length, 1);
  assert.notEqual(signalled.exits[0], 0);
  assert.equal(signalled.signals.listenerCount("SIGINT"), 0, "forwarders are removed at exit");

  assert.deepEqual(run((child) => child.emit("exit", 0, null)).exits, [0]);
  const thrown = [];
  launch({ electronBinary: () => "x", spawnImpl: () => { throw new Error("EACCES"); }, exit: (c) => thrown.push(c), signals: new EventEmitter() });
  assert.deepEqual(thrown, [1]);
  const missing = [];
  launch({ electronBinary: () => { throw new Error("Cannot find module 'electron'"); }, exit: (c) => missing.push(c), signals: new EventEmitter() });
  assert.deepEqual(missing, [1]);
} finally { process.stderr.write = stderr; }
console.log("launch desktop exit contract passed");
