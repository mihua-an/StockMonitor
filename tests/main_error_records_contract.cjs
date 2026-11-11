"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Electron main's error records:
// - errors before the application's error log exists are in this run's error.log (or the fixed fallback);
// - a rotation that fails is recorded apart from the appends, and only ENOENT means "no file yet";
// - a repeat count is written when its minute ends and at close, not only with the next occurrence.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installEarlyErrorSink } = require("../ui/main/early_error_sink.js");
const { createErrorLogWriter, createRendererHealthRegistry } = require("../ui/main/renderer_health.js");

async function main() {
  const dir = makeTempDir("main-error-records-");
  try {
    // errors before the application's error log exists
    const quiet = { warn() {}, error() {} };
    const run = path.join(dir, "logs", "run1", "error.log");
    const early = installEarlyErrorSink({ resolvePrimary: () => run, fallbackFile: path.join(dir, "fallback.log"), consoleRef: quiet });
    quiet.error("[STARTUP] runtime configuration failed", new Error("bad contract"));
    assert.match(fs.readFileSync(run, "utf8"), /\[MAIN STARTUP\] \[STARTUP\] runtime configuration failed bad contract/);
    early.handOff();
    quiet.error("after the hand-off");
    assert.doesNotMatch(fs.readFileSync(run, "utf8"), /after the hand-off/, "the application's own log takes over");
    const broken = { warn() {}, error() {} };
    const fallback = path.join(dir, "fallback.log");
    installEarlyErrorSink({ resolvePrimary: () => { throw new Error("var layout unreadable"); }, fallbackFile: fallback, consoleRef: broken });
    broken.error("Health did not become healthy");
    const text = fs.readFileSync(fallback, "utf8");
    assert.match(text, /could not be resolved \(var layout unreadable\)/);
    assert.match(text, /Health did not become healthy/);

    // a rotation that fails
    const file = path.join(dir, "rot", "error.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x".repeat(500));
    const lockedFs = { ...fs, promises: { ...fs.promises, rename: async () => { const e = new Error("locked"); e.code = "EBUSY"; throw e; } } };
    const writer = createErrorLogWriter(lockedFs, file, { maxBytes: 100 });
    writer.write("still appended\n");
    const health = await writer.flush();
    assert.strictEqual(health.rotation.failures, 1);
    assert.strictEqual(health.rotation.last_error.code, "EBUSY");
    assert.strictEqual(health.state, "OK", "the append itself succeeded");
    assert.match(fs.readFileSync(file, "utf8"), /still appended/);

    // a repeat count written when its minute ends
    let clock = 1_000_000;
    const out = path.join(dir, "out");
    const errorLog = path.join(dir, "rep", "error.log");
    fs.mkdirSync(path.dirname(errorLog), { recursive: true });
    const registry = createRendererHealthRegistry({ fs, path, outputDir: out, electronPid: 1, now: () => clock, errorLogPath: errorLog });
    registry.reportRendererError?.("boom") ?? registry.reportMain("error", ["boom"]);
    registry.reportMain("error", ["boom"]);
    registry.reportMain("error", ["boom"]);
    await registry.close();
    const lines = fs.readFileSync(errorLog, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 2, lines.join("\n"));
    assert.match(lines[1], /boom \(repeated 2 more time\(s\) in the minute after the record above\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("main error records contract ok");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
