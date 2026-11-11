"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Renderer errors were appended to error.log synchronously in Electron main, one by one, with no rate,
// size or retention limit -- an error per frame blocked main on the disk and grew the log without bound.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createErrorLogWriter } = require("../ui/main/renderer_health.js");

async function main() {
  const dir = makeTempDir("renderer-error-log-");
  const file = path.join(dir, "error.log");
  let clock = 1_000_000;
  const writer = createErrorLogWriter(fs, file, { now: () => clock, perMinute: 3, maxBytes: 200 });
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error("no synchronous write on Electron main"); };
  try {
    for (let i = 0; i < 10; i += 1) writer.write(`line ${i}\n`);
    const health = await writer.flush();
    // The 7 lines past the limit are dropped records of the sink -- counted in its health and stated in the
    // file by a loss marker -- not a local count a close could lose.
    const [marker, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.match(marker, /LOSS MARKER: 7 record\(s\) lost .*rate_limited=7/);
    assert.deepStrictEqual(lines, ["line 0", "line 1", "line 2"]);
    assert.strictEqual(health.lost_records, 7);
    clock += 60_000;
    writer.write("after a minute\n");
    await writer.flush();
    assert.match(fs.readFileSync(file, "utf8"), /after a minute/);
    clock += 60_000;
    writer.write(`${"x".repeat(300)}\n`);
    await writer.flush();                      // now past 200 bytes
    writer.write("next\n");
    await writer.flush();                      // the next write rotates first
    assert.strictEqual(fs.readdirSync(dir).filter((n) => /^error\.log\.\d{8}T/.test(n)).length, 1, "a log past its size is rotated to a unique generation");
    assert.strictEqual(fs.readFileSync(file, "utf8"), "next\n");
  } finally {
    fs.appendFileSync = realAppend;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("renderer error log bound contract passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
