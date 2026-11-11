"use strict";

// Electron main's errors before the application's own error log exists. The regular tee
// (desktop_application.js teeMainConsole -> renderer_health's error log) is installed only once the application is
// created; a runtime contract that fails to load or a Health that never becomes healthy ended the process before
// that, with its error in a console nobody sees. From the first line of main.js every console.warn / console.error
// is also appended -- synchronously, the volume before startup is small and the process may exit right after -- to
// this run's error.log (var/logs/<run>/error.log); when even that directory cannot be resolved (a broken var layout
// is one of the failures this catches), to a fixed startup-errors file in userData, which the next run that starts
// properly finds next to its own logs. handOff() stops it once the regular tee is in place.

const fs = require("fs");
const path = require("path");

function installEarlyErrorSink({ resolvePrimary, fallbackFile, fsImpl = fs, consoleRef = console, now = Date.now } = {}) {
  let file = null;
  let resolveError = null;
  try { file = resolvePrimary(); }
  catch (error) { resolveError = error; file = fallbackFile; }
  let active = true;
  let failures = 0;
  const originals = { warn: consoleRef.warn.bind(consoleRef), error: consoleRef.error.bind(consoleRef) };
  const text = (args) => args.map((arg) => (arg instanceof Error ? `${arg.message}${arg.stack ? ` ${arg.stack.split("\n").slice(1, 3).map((s) => s.trim()).join(" ")}` : ""}`
    : typeof arg === "string" ? arg : (() => { try { return JSON.stringify(arg); } catch (_error) { /* not an error: an argument that cannot be serialised is written with String() */ return String(arg); } })())).join(" ");
  function append(tag, line) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.appendFileSync(file, `[${new Date(now()).toISOString()}] [${tag}] ${line.replace(/[\r\n]+/g, " ").slice(0, 2000)}\n`, "utf8");
    } catch (error) {
      failures += 1;
      // the console line itself is still written; this states that the file copy is missing
      // not an error: a failure after the first repeats the one already logged
      if (failures === 1) originals.error(`[MAIN STARTUP] error log ${file} not writable`, error);
    }
  }
  for (const level of ["warn", "error"]) {
    consoleRef[level] = (...args) => {
      originals[level](...args);
      if (active) append(level === "error" ? "MAIN STARTUP" : "MAIN STARTUP WARN", text(args));
    };
  }
  if (resolveError) append("MAIN STARTUP", `this run's log directory could not be resolved (${resolveError?.message || resolveError}); startup errors go to ${file}`);
  return {
    file,
    /** The application's error log takes over: the console is restored before the regular tee wraps it. */
    handOff() {
      active = false;
      consoleRef.warn = originals.warn;
      consoleRef.error = originals.error;
    },
  };
}

module.exports = { installEarlyErrorSink };
