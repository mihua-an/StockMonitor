"use strict";

const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../../config/js/var_paths");
const { writeJsonAtomic, readJsonObject } = require("./atomic_files");

// Cross-process, cross-launch handoff: what Health reported about its own service shutdown (scope, duration, whether
// it was clean). Health writes it on every shutdown; Health reads it at startup and Electron main reads it for
// diagnostics and to tell a completed full shutdown from a crash. Only Health writes.
function createShutdownHandoffStore(projectRoot, { logger = console, env = process.env } = {}) {
  const handoffPath = path.join(resolveVarPaths({ projectRoot, env }).output, "app_shutdown_handoff.json");

  function load() {
    return readJsonObject(handoffPath, { fsImpl: fs, label: "the shutdown handoff" });
  }

  function persist(payload) {
    try {
      writeJsonAtomic(handoffPath, payload, { fsImpl: fs, indent: 2 });
      return true;
    } catch (error) {
      logger.error(`[Shutdown] handoff write failed: ${error?.message || error}`);
      return false;
    }
  }

  return { load, persist };
}

module.exports = { createShutdownHandoffStore };
