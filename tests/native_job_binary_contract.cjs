"use strict";
// 11-06: the after-close training job ran `analysis_runtime.exe --export-features` from
// native\analysis_runtime\target\release for two and a half hours, Windows kept that file locked, and a new B could
// not be deployed until the job ended. One-shot jobs now run a copy named by its content
// (service/platform/js/native_job_binary.js); the Python resolver (service/platform/native_binaries.py) names it the
// same way, which tests/test_native_job_binary.py checks.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { jobBinary, pruneJobBinaries } = require("../service/platform/js/native_job_binary.js");

const root = makeTempDir("native-job-binary-");
const release = path.join(root, "release", "analysis_runtime.exe");
const dir = path.join(root, "state", "native_jobs");
fs.mkdirSync(path.dirname(release), { recursive: true });
fs.writeFileSync(release, "build one");
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

const first = jobBinary({ fs, path, source: release, dir });
assert.equal(first, path.join(dir, `analysis_runtime-${digest("build one")}.exe`), "named by its content");
assert.equal(fs.readFileSync(first, "utf8"), "build one", "a byte copy of the release build");
assert.equal(jobBinary({ fs, path, source: release, dir }), first, "the same build reuses its copy");

// The release file is replaced while a job still runs the first copy: the deploy is not held, the next job gets the
// new build and the running one keeps its own.
const held = fs.openSync(first, "r");
fs.writeFileSync(release, "build two, a little longer");
const second = jobBinary({ fs, path, source: release, dir });
assert.notEqual(second, first, "a new build gets a copy of its own");
assert.equal(fs.readFileSync(second, "utf8"), "build two, a little longer");
assert.ok(fs.existsSync(first), "the copy a job runs is left alone");
fs.closeSync(held);

// Health's start: every copy but the current build's goes; a missing directory is nothing to prune.
fs.writeFileSync(path.join(dir, "analysis_runtime-0123456789abcdef.exe.999.deadbeef.tmp"), "half a copy");
fs.writeFileSync(path.join(dir, "unrelated.txt"), "kept");
const pruned = pruneJobBinaries({ fs, path, source: release, dir });
assert.deepEqual(pruned.removed.sort(), [path.basename(first), "analysis_runtime-0123456789abcdef.exe.999.deadbeef.tmp"].sort());
assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(second), "unrelated.txt"].sort());
assert.deepEqual(pruneJobBinaries({ fs, path, source: release, dir: path.join(root, "absent") }), { removed: [], kept: [], failed: [] });

// A copy Windows refuses to delete (a job still runs it) is kept for the next start, not reported as a failure.
const refusing = { ...fs, rmSync: () => { const e = new Error("busy"); e.code = "EPERM"; throw e; } };
fs.writeFileSync(path.join(dir, "analysis_runtime-ffffffffffffffff.exe"), "old");
assert.deepEqual(pruneJobBinaries({ fs: refusing, path, source: release, dir }).kept, ["analysis_runtime-ffffffffffffffff.exe"]);

assert.throws(() => jobBinary({ fs, path, source: path.join(root, "missing.exe"), dir }), /ENOENT/, "no release build: the job is not started");
console.log("native job binary contract: ok");
