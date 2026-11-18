"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomic_files");

// Health's endpoint record (CONFIG_ROOT/bootstrap/health_endpoint.json): where the running Health's control API
// listens and which process it is. Health writes it once its control API listens and removes it on exit while it
// still names that process; Electron main's bootstrap (ui/main/health_bootstrap.js) reads it to find, attach to
// or wait for that Health -- never by scanning ports. Only Health writes.
//
// Exit code PLANNED_RESTART_EXIT is Health's planned restart: a network operation changed Health's or settings_api's
// own endpoint, Health already ran the full ordered shutdown, and the bootstrap starts the next Health at once.
const SCHEMA = "stock-monitor-health-endpoint-v1";
const PLANNED_RESTART_EXIT = 75;

function recordPath(configRoot) {
  return path.join(configRoot, "bootstrap", "health_endpoint.json");
}

function validRecord(record) {
  return Boolean(record && typeof record === "object" && record.schema === SCHEMA
    && Number.isInteger(record.pid) && record.pid > 0 && typeof record.host === "string" && record.host
    && Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
}

function createHealthEndpointStore(configRoot, { fsImpl = fs } = {}) {
  const file = recordPath(configRoot);

  // Health: the record of this process, written atomically and durably (a reader never sees half of it).
  function write(fields) {
    writeJsonAtomic(file, { schema: SCHEMA, ...fields }, { fsImpl, durable: true });
  }

  // The record, or null when there is none (no Health has written one, or the last one removed it on exit). A record
  // that cannot be read or does not match the schema is damage, not absence: it throws, and is never read as "no
  // Health running" (which would start a second one).
  function read() {
    let text;
    try { text = fsImpl.readFileSync(file, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;   // not an error: no Health has written a record, or the last one removed it
      throw new Error(`the Health endpoint record ${file} cannot be read: ${error?.message || error}`);
    }
    let record;
    try { record = JSON.parse(text); } catch (error) {
      throw new Error(`the Health endpoint record ${file} is not valid JSON: ${error?.message || error}`);
    }
    if (!validRecord(record)) throw new Error(`the Health endpoint record ${file} does not match ${SCHEMA}`);
    return record;
  }

  // Health on exit: the record outlived the process, so the next UI probed a dead (or a stopping) Health before
  // starting a new one. Removed only while it still names process `pid`.
  function removeIfOwnedBy(pid, { logger = console } = {}) {
    try {
      if (Number(JSON.parse(fsImpl.readFileSync(file, "utf8"))?.pid) === Number(pid)) fsImpl.unlinkSync(file);
    } catch (error) {
      /* absent is not an error: no record of ours to remove */
      if (error?.code !== "ENOENT") logger.warn?.("[removing the Health endpoint record] failed", error);
    }
  }

  return { file, write, read, removeIfOwnedBy };
}

module.exports = { SCHEMA, PLANNED_RESTART_EXIT, recordPath, createHealthEndpointStore };
