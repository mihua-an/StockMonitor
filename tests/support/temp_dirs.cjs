"use strict";
// Temporary directories and environment changes a Node / Electron test makes, undone however the test ends.
//
// makeTempDir() registers each directory; when the process exits -- passed, failed by an assertion, or ended with
// process.exit / app.exit -- every one still there is removed. A directory that cannot be removed is reported on
// stderr and fails the run (exit code 1): a test that leaves data behind in %TEMP% is not a clean pass. Only
// directories this helper created under the OS temp root are ever removed.
//
// Electron is the exception: Chromium holds files in userData until its processes are gone, and app.exit() ends the
// main process without an exit event. So under Electron the first makeTempDir starts a small detached process that
// waits for this one to end -- however it ends -- and then removes every directory listed in this process's manifest.
// What it cannot remove is written to LEFTOVERS, reported (console.error) and removed by the next test that loads
// this helper.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// .native: a %TEMP% given in 8.3 form (RUNNER~1 on CI) expands to its long name, the form Python and fs.watch report.
const TEMP_ROOT = fs.realpathSync.native(os.tmpdir());
const LEFTOVERS = path.join(TEMP_ROOT, "stockmonitor-test-leftovers.log");
const created = new Set();

// Removes the directories listed in <manifest> after process <pid> has ended (its Chromium children let go of files
// shortly after).
const AFTER_EXIT = `
const fs = require("node:fs");
const [pid, manifest, leftovers] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  while (alive()) await sleep(50);
  const dirs = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : [];
  fs.rmSync(manifest, { force: true });
  for (const dir of dirs) {
    let failure = null;
    for (let i = 0; i < 100; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); failure = null; break; } catch (error) { failure = error; await sleep(100); }
    }
    if (failure) fs.appendFileSync(leftovers, JSON.stringify({ dir, pid: Number(pid), error: String(failure.message) }) + "\\n");
  }
})();
`;

function reportLeftovers() {
  if (!fs.existsSync(LEFTOVERS)) return;
  const lines = fs.readFileSync(LEFTOVERS, "utf8").split(/\r?\n/).filter(Boolean);
  fs.rmSync(LEFTOVERS, { force: true });
  for (const line of lines) {
    const { dir, pid, error } = JSON.parse(line);
    console.error(`[test cleanup] an earlier Electron test (pid ${pid}) left ${dir} behind: ${error}; removing it now`);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
reportLeftovers();

let manifest = null;

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  created.add(dir);
  if (process.versions.electron) {
    if (!manifest) {
      manifest = path.join(TEMP_ROOT, `stockmonitor-test-cleanup-${process.pid}.json`);
      spawn(process.execPath, ["-e", AFTER_EXIT, String(process.pid), manifest, LEFTOVERS],
        { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }).unref();
    }
    fs.writeFileSync(manifest, JSON.stringify([...created]));
  }
  return dir;
}

function removeTempDir(dir) {
  if (!created.has(dir)) throw new Error(`${dir} was not made by makeTempDir`);
  const relative = path.relative(TEMP_ROOT, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${dir} is not under ${TEMP_ROOT}`);
  // A process this test ended (TerminateProcess) can keep the directory busy for a moment after it is gone, so a
  // refused removal is tried again for up to 10 s before it counts as a leftover.
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code) || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  created.delete(dir);
}

process.on("exit", () => {
  if (process.versions.electron) return;   // the detached process started by makeTempDir removes them
  for (const dir of [...created]) {
    try {
      removeTempDir(dir);
    } catch (error) {
      console.error(`[test cleanup] ${dir} was not removed`, error);
      process.exitCode = 1;
    }
  }
});

// Runs fn with the given variables set (undefined removes one) and puts every one back afterwards, also when fn
// throws or its promise rejects.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

module.exports = { TEMP_ROOT, makeTempDir, removeTempDir, withEnv };
