"use strict";

// One-shot jobs (Rust B's --materialize, --export-features, --gap-report, --verify-partitions) run from a copy of
// the executable, never from the release file itself: Windows keeps a running .exe locked, so a training job that
// folds dates for an hour held native\analysis_runtime\target\release\analysis_runtime.exe and a new B could not be
// deployed until it ended. The copy is named by its content (`analysis_runtime-<sha256 16>.exe` under
// <STATE_ROOT>/native_jobs), so every job started after a deploy runs the new build and a job already running keeps
// the build it started with. service/platform/native_binaries.py follows the same rule for the Python callers.
//
// Copies are removed only by `pruneJobBinaries`, which Health runs at its start before any job: a copy a job still
// runs cannot be deleted (Windows refuses) and is kept for the next start.

const crypto = require("crypto");

const DIGEST_CHARS = 16;
// path -> {size, mtimeMs, digest}: the release file is hashed again only when it changed.
const digests = new Map();

function contentDigest(fs, source) {
  const stat = fs.statSync(source);
  const known = digests.get(source);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.digest;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, DIGEST_CHARS);
  digests.set(source, { size: stat.size, mtimeMs: stat.mtimeMs, digest });
  return digest;
}

function copyName(path, source, digest) {
  const ext = path.extname(source);
  return `${path.basename(source, ext)}-${digest}${ext}`;
}

/** The job copy of `source` in `dir`, made when absent. Throws when the source is missing or the copy fails. */
function jobBinary({ fs, path, source, dir }) {
  const digest = contentDigest(fs, source);
  const target = path.join(dir, copyName(path, source, digest));
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(dir, { recursive: true });
  const staged = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.copyFileSync(source, staged);
  try {
    fs.renameSync(staged, target);
  } catch (error) {
    // not an error: another process made the same copy first (the content is the same) and that one is used; any
    // other failure is thrown to the job's starter, which records it as the job's failure.
    fs.rmSync(staged, { force: true });
    if (!fs.existsSync(target)) throw error;
  }
  return target;
}

/** Removes every job copy of `source` in `dir` except the current one. Returns {removed, kept, failed}. */
function pruneJobBinaries({ fs, path, source, dir }) {
  const result = { removed: [], kept: [], failed: [] };
  let names;
  try { names = fs.readdirSync(dir); } catch (error) {
    if (error?.code === "ENOENT") return result; /* not an error: no job has run yet, so there is nothing to prune */
    throw error;
  }
  const ext = path.extname(source);
  const stem = `${path.basename(source, ext)}-`;
  let current = null;
  try { current = copyName(path, source, contentDigest(fs, source)); } catch (error) {
    // not an error: without a release file every copy is old; the caller records `failed` (Health logs it)
    result.failed.push({ name: path.basename(source), error: String(error?.message || error) });
  }
  for (const name of names) {
    if (!name.startsWith(stem) || name === current) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      result.removed.push(name);
    } catch (error) {
      // not an error: a copy that is in use is kept, any other failure goes into `failed`, which Health logs.
      // A job still runs that copy (Windows refuses the delete: EPERM/EACCES/EBUSY): kept, the next start removes it.
      if (["EPERM", "EACCES", "EBUSY"].includes(error?.code)) result.kept.push(name);
      else result.failed.push({ name, error: String(error?.message || error) });
    }
  }
  return result;
}

module.exports = { jobBinary, pruneJobBinaries, DIGEST_CHARS };
