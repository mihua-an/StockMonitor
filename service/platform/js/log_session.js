"use strict";

// Node side of the per-run log directory contract. service/platform/log_session.py is the Python
// half; both resolve LOG_ROOT from config/var_layout.json and agree on the id format, so a run's
// Electron/Health logs and its Python daemon logs land in the same var/logs/<startup_timestamp>/.
//
// Electron is the App-run boundary: it mints the id before spawning Health, and every service
// Health spawns inherits it through the environment. A process started without one mints its own,
// so a log file always has a home and two unrelated runs never share a directory.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../../config/js/var_paths.js");

const LOG_SESSION_ENV = "STOCK_MONITOR_LOG_SESSION";
const SESSION_PATTERN = /^\d{8}_\d{6}-[0-9a-f]{6}$/;

function newLogSessionId(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// Mints and exports on first call so every child process spawned afterwards inherits it. A value that is set but not
// an id is refused: minting a new one would split one App run's logs across directories.
function logSessionId(env = process.env) {
  const configured = String(env[LOG_SESSION_ENV] || "").trim();
  if (configured) {
    if (!SESSION_PATTERN.test(configured)) {
      throw new Error(`${LOG_SESSION_ENV}=${JSON.stringify(configured)} is not a run id (YYYYmmdd_HHMMSS-xxxxxx)`);
    }
    return configured;
  }
  const minted = newLogSessionId();
  env[LOG_SESSION_ENV] = minted;
  return minted;
}

function logSessionDir({ env = process.env } = {}) {
  const directory = path.join(resolveVarPaths({ env }).logs, logSessionId(env));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function logSessionPath(name, { env = process.env } = {}) {
  const safe = String(name || "").trim();
  if (!safe || safe.includes("/") || safe.includes("\\") || safe.startsWith(".")) {
    throw new Error(`invalid log file name: ${name}`);
  }
  return path.join(logSessionDir({ env }), safe);
}

// Electron main's error log of the run: each process has its own (Python providers write error-<source>.log,
// service/platform/error_logging.py), so one writer appends to and rotates each file.
const MAIN_ERROR_LOG = "error-electron.log";

// Keep a bounded history of run directories. Mirrors service/platform/log_session.py's
// RETAINED_SESSIONS so the two halves cannot disagree about what survives. Best-effort: a
// directory a surviving process still holds open must never stop a new run from starting.
const RETAINED_SESSIONS = 30;

// Asynchronous: Health runs it once its control API listens, beside the service starts, never in front of them.
async function pruneOldLogSessions({ keep = RETAINED_SESSIONS, env = process.env, fsImpl = fs } = {}) {
  const current = logSessionId(env);
  const root = resolveVarPaths({ env }).logs;
  let names = [];
  try {
    names = (await fsImpl.promises.readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory() && SESSION_PATTERN.test(item.name))
      .map((item) => item.name)
      .sort()
      .reverse();
  } catch (error) { /* absent is not an error: no log root yet */ if (error?.code !== "ENOENT") console.warn("[listing log sessions] failed", error); return { removed: [], failed: [] }; }
  const removed = [], failed = [];
  for (const name of names.slice(Math.max(0, keep))) {
    if (name === current) continue;
    try {
      await fsImpl.promises.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      failed.push({ session: name, error: String(error?.message || error).slice(0, 200) });
      console.warn("[removing an expired log session (still in use)] failed", error);
    }
  }
  return { removed, failed };
}

module.exports = {
  LOG_SESSION_ENV, SESSION_PATTERN, RETAINED_SESSIONS, MAIN_ERROR_LOG,
  newLogSessionId, logSessionId, logSessionDir, logSessionPath, pruneOldLogSessions,
};
