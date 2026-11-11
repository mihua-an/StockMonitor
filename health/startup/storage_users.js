"use strict";

// Which processes may still read or write the raw-history store: every process Health spawns that
// opens it (Market Runtime, analysis_runtime, the API services, the provider daemons) is recorded here -- pid and spawn time -- in a
// durable file under var/state, and stays recorded until that exact process is gone. A closed port is not an exit
// (a service closes its listener before it flushes); the record is what a later Health checks before it moves the
// store. A pid that is alive is matched to the recorded spawn by its OS creation time, so a reused pid is not mistaken
// for ours; a creation time that cannot be read counts as alive (fail closed), and so does an unreadable registry.

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files.js");
const { processAliveFast } = require("../../service/platform/js/process_utils.js");

const SCHEMA = "storage-users-v1";
// spawn time is taken in Health just before or after the OS creates the process
const CREATED_BEFORE_MS = 60_000, CREATED_AFTER_MS = 10_000;

let installed = null;

/** Creation times (ms) of the given pids, one OS query for all of them; a pid missing from the answer is gone.
 * null when the times cannot be read. */
function creationTimes(pids, spawnSyncImpl = spawnSync) {
  if (!pids.length) return new Map();
  if (process.platform !== "win32") return null;
  const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(" OR ");
  const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { '{0} {1}' -f $_.ProcessId, [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }`],
  { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result?.status !== 0) return null;
  const out = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const [pid, created] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && created > 0) out.set(pid, created);
  }
  return out;
}

function createStorageUserRegistry({ file, fsImpl = fs, now = Date.now, alive = processAliveFast, created = creationTimes, logger = console } = {}) {
  // A spawn the registry could not take is appended to <file>.pending as "service pid spawned_at" lines and read back
  // with it, so a failed write never hides a live process.
  const pendingFile = `${file}.pending`;
  function readPending() {
    try {
      return fsImpl.readFileSync(pendingFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
        const [service_id, pid, spawned_at] = line.trim().split(/\s+/);
        return { service_id, pid: Number(pid), spawned_at: Number(spawned_at) };
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];   // absent is not an error: every spawn was recorded
      throw error;
    }
  }
  function read() {
    try {
      let entries = [];
      try {
        const value = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        if (value?.schema !== SCHEMA || !Array.isArray(value.entries)) throw new Error(`not a ${SCHEMA} file`);
        entries = value.entries;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;   // absent is not an error: nothing was ever spawned
      }
      const pending = readPending();
      return { entries: [...entries.filter((e) => !pending.some((p) => p.pid === e.pid)), ...pending], pending: pending.length > 0 };
    } catch (error) {
      // not an error: recorded -- every caller logs it (record) or reports it in the alive list (alive), which is logged
      return { error: String(error?.message || error) };
    }
  }
  function write(entries, { clearPending = false } = {}) {
    writeJsonAtomic(file, { schema: SCHEMA, entries }, { fsImpl, durable: true, indent: 2 });
    if (clearPending) fsImpl.rmSync(pendingFile, { force: true });
  }

  return {
    file,
    /** A process that opens the store was spawned. */
    spawned(serviceId, pid) {
      if (!(Number(pid) > 0)) return;
      const entry = { service_id: serviceId, pid: Number(pid), spawned_at: now() };
      try {
        const current = read();
        if (current.error) throw new Error(current.error);
        write([...current.entries.filter((e) => e.pid !== entry.pid), entry], { clearPending: current.pending });
      } catch (error) {
        logger.error?.(`[HEALTH] storage users: recording ${serviceId} pid ${pid} failed: ${error?.message || error}; kept in ${pendingFile}`);
        try { fsImpl.appendFileSync(pendingFile, `${entry.service_id} ${entry.pid} ${entry.spawned_at}\n`); }
        catch (inner) { logger.error?.(`[HEALTH] storage users: ${pendingFile} not written either: ${inner?.message || inner}`); }
      }
    },
    /** The recorded processes still running ("service pid N"), or why the answer is unknown. Gone ones are dropped. */
    alive() {
      const current = read();
      if (current.error) return [`storage users registry unreadable: ${current.error}`];
      const running = current.entries.filter((entry) => alive(entry.pid));
      const times = created(running.map((entry) => entry.pid));
      const kept = [], out = [];
      for (const entry of running) {
        const at = times?.get(entry.pid);
        if (times && at === undefined) continue;   // exited between the two checks
        if (at !== undefined && (at < entry.spawned_at - CREATED_BEFORE_MS || at > entry.spawned_at + CREATED_AFTER_MS)) continue;   // pid reused
        kept.push(entry);
        out.push(`${entry.service_id} pid ${entry.pid}${times ? "" : " (creation time unreadable)"}`);
      }
      if (kept.length !== current.entries.length || current.pending) {
        try { write(kept, { clearPending: current.pending }); }
        catch (error) { logger.error?.(`[HEALTH] storage users: pruning exited processes failed: ${error?.message || error}`); }
      }
      return out;
    },
  };
}

/** Health installs the registry of its var root once; hosts report spawns through spawnedStorageUser(). */
function installStorageUserRegistry(options) { installed = createStorageUserRegistry(options); return installed; }
function spawnedStorageUser(serviceId, pid) { installed?.spawned(serviceId, pid); }

module.exports = { createStorageUserRegistry, installStorageUserRegistry, spawnedStorageUser, creationTimes, SCHEMA };
