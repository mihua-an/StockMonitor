#!/usr/bin/env node
"use strict";

// Thin dev source launcher: starts Electron and nothing else. Health
// bootstrap (spawn Health, wait for it to report healthy, restart it if it
// crashes unexpectedly) is Electron's own responsibility
// (ui/main/health_bootstrap.js, wired from ui/main/main.js) -- see
// docs/system-architecture/README.md: "Electron -> bootstrap Health -> Health
// starts/manages services". A launcher that spawned Health itself would be a
// second Health bootstrap owner beside Electron.
//
// Usage (dev): `node scripts/launch_desktop.js` from the project root, or
// `npm run launch` from the project root (see package.json). The installed
// shortcut uses packaging/launch_stock_monitor.ps1, which is the same kind of
// thin "just start Electron" shim for a packaged install.
//
// The launcher's exit code is Electron's: a failed spawn and an Electron ended by a signal are failures (non-zero,
// with a record on stderr), never a 0. Ctrl+C / termination of the launcher is passed on to Electron.
const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.join(__dirname, "..");
// A conventional shell code for "ended by a signal" when Electron reports no exit code of its own.
const SIGNAL_EXIT_CODE = 128;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

/** The launcher's exit code for Electron's exit (code, signal). */
function exitCodeFor(code, signal) {
  if (Number.isInteger(code)) return code;
  return SIGNAL_EXIT_CODE + (signal ? 1 : 0);
}

function report(event) {
  process.stderr.write(`${JSON.stringify({ component: "launch_desktop", at: new Date().toISOString(), ...event })}\n`);
}

function launch({ spawnImpl = spawn, exit = (code) => process.exit(code), signals = process,
  electronBinary = () => require(path.join(projectRoot, "node_modules", "electron")) } = {}) {
  let binary;
  try {
    binary = electronBinary();
  } catch (error) {
    report({ event: "electron_not_found", error: String(error?.message || error) });
    exit(1);
    return null;
  }
  let child;
  try {
    child = spawnImpl(binary, ["."], { cwd: projectRoot, stdio: "inherit" });
  } catch (error) {
    report({ event: "spawn_failed", binary, error: String(error?.message || error) });
    exit(1);
    return null;
  }
  const forward = {};
  for (const name of FORWARDED_SIGNALS) {
    forward[name] = () => {
      try { child.kill(name); } catch (error) { report({ event: "signal_forward_failed", signal: name, error: String(error?.message || error) }); }
    };
    signals.on?.(name, forward[name]);
  }
  let ended = false;
  const end = (code) => {
    if (ended) return;
    ended = true;
    for (const name of FORWARDED_SIGNALS) signals.removeListener?.(name, forward[name]);
    exit(code);
  };
  child.once("error", (error) => {
    report({ event: "spawn_failed", binary, error: String(error?.message || error) });
    end(1);
  });
  child.once("exit", (code, signal) => {
    if (!Number.isInteger(code) || code !== 0) report({ event: "electron_exited", code: code ?? null, signal: signal ?? null });
    end(exitCodeFor(code, signal));
  });
  return child;
}

if (require.main === module) launch();

module.exports = { launch, exitCodeFor };
