"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A console line written after the stdout/stderr reader went away is recorded once, never an uncaught exception.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const guard = path.join(__dirname, "..", "service", "platform", "js", "stdio_guard.js");

// The child keeps writing to stderr after the parent destroyed its end of the pipe.
function runChild(withGuard, recordFile) {
  const code = `
    ${withGuard ? `require(${JSON.stringify(guard)}).installStdioGuard({ onLost: (s, e) => require("fs").appendFileSync(${JSON.stringify(recordFile)}, s + " " + (e && e.code) + "\\n") });` : ""}
    process.stdout.write("ready\\n");
    let n = 0;
    const timer = setInterval(() => { console.error("line " + (n++)); if (n > 200) { clearInterval(timer); process.stdout.write("done\\n"); setTimeout(() => process.exit(0), 50); } }, 2);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("ready")) child.stderr.destroy(); });
    child.on("exit", (exitCode) => resolve({ exitCode, out }));
  });
}

async function main() {
  const dir = makeTempDir("stdio-guard-");
  const recordFile = path.join(dir, "lost.log");
  try {
    const unguarded = await runChild(false, recordFile);
    assert.notStrictEqual(unguarded.exitCode, 0, "without the guard the lost stderr crashes the process (the bug being guarded)");
    const guarded = await runChild(true, recordFile);
    assert.strictEqual(guarded.exitCode, 0, "with the guard the process keeps running");
    assert.ok(guarded.out.includes("done"), "stdout still works after stderr was lost");
    const lines = fs.readFileSync(recordFile, "utf8").trim().split("\n");
    assert.deepStrictEqual(lines, ["stderr EPIPE"], "the loss is recorded exactly once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("stdio_guard_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
