"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Every renderer / Electron-main warning and error is a record in the run's error.log, the same text
// within a minute is one line plus a count.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createRendererHealthRegistry } = require("../ui/main/renderer_health.js");

async function main() {
  const dir = makeTempDir("error-record-");
  const errorLogPath = path.join(dir, "error.log");
  let clock = 1_000_000;
  const registry = createRendererHealthRegistry({ fs, path, outputDir: dir, electronPid: 1,
    now: () => clock, errorLogPath });
  try {
    const contents = new EventEmitter();
    contents.id = 7;
    registry.observe(contents);
    const message = (level, text) => contents.emit("console-message", { level, message: text, lineNumber: 3, sourceId: "page.js" });
    message("warning", "[TRADE PAGE] load failed");
    message("warning", "[TRADE PAGE] load failed");   // same text in the same minute: counted, not written
    message("info", "not a failure");
    message("error", "boom");
    registry.reportMain("warn", ["[WINDOWS] reload failed", new Error("gone")]);
    clock += 61_000;
    message("warning", "[TRADE PAGE] load failed");
    await registry.flush();
    const lines = fs.readFileSync(errorLogPath, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 4, lines.join("\n"));
    assert.match(lines[0], /\[RENDERER WARN\] \[TRADE PAGE\] load failed \(page\.js:3\)$/);
    assert.match(lines[1], /\[RENDERER\] boom/);
    assert.match(lines[2], /\[MAIN WARN\] \[WINDOWS\] reload failed gone/);
    assert.match(lines[3], /\[RENDERER WARN\] \[TRADE PAGE\] load failed .*also 1 more time\(s\) in the minute before/);
    assert.ok(!lines.some((line) => line.includes("not a failure")), "info messages are not records");
  } finally {
    await registry.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("error record contract passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
