"use strict";

// The version of the on-disk data layout. VAR_ROOT carries
// layout_version.json; config/var_layout.json "data_layout_version" is the version this program writes and reads.
//
// * No marker: version 1 is written only when the root is provably version 1 -- missing or empty (a first
//   start), or holding nothing but version-1 entries (the children config/var_layout.json names) because it was written
//   before markers existed. Anything unrecognised in the root refuses the start: it is never stamped as version 1
//   and read as if it were.
// * The same version: nothing to do.
// * A newer version: data written by a newer StockMonitor. This program would misread it, so Health refuses to start.
// * An older version: there is no migration yet (none is needed before a layout change ships); refused the same way.
//   The next layout change adds its migration here, one step per version.

const fs = require("fs");
const path = require("path");
const { loadVarLayout } = require("../../../config/js/var_paths.js");
const { writeJsonAtomic } = require("./atomic_files.js");

const MARKER_SCHEMA = "stock-monitor-data-layout-v1";

class DataLayoutVersionError extends Error {}

/** Why a root without a marker is not provably version 1, or null when it is (missing, empty, or only v1 entries). */
function unmarkedRootProblem(fsImpl, varRoot, layout) {
  let entries = [];
  try { entries = fsImpl.readdirSync(varRoot); }
  catch (error) {
    if (error?.code === "ENOENT") return null;   // absent is not an error: a first start
    throw new DataLayoutVersionError(`${varRoot} cannot be listed (${error?.message || error}); the data layout cannot be told`);
  }
  const known = new Set(Object.values(layout.children || {}).map((child) => String(child.dir || "").split(/[\\/]/)[0]).filter(Boolean));
  const unknown = entries.filter((name) => !known.has(name));
  return unknown.length ? `${varRoot} holds entries that are not part of data layout version 1 (${unknown.slice(0, 8).join(", ")})` : null;
}

function ensureDataLayoutVersion(varRoot, { fsImpl = fs, now = () => new Date(), logger = console } = {}) {
  const layout = loadVarLayout();
  const supported = Number(layout.data_layout_version);
  const file = path.join(varRoot, "layout_version.json");
  let marker = null;
  try {
    marker = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch (error) {
    // not an error: ENOENT is an unmarked root, proven version 1 (or refused) below
    if (error?.code !== "ENOENT") {
      throw new DataLayoutVersionError(`${file} cannot be read (${error?.message || error}); the data layout version is unknown`);
    }
  }
  if (marker === null) {
    const problem = unmarkedRootProblem(fsImpl, varRoot, layout);
    if (problem) throw new DataLayoutVersionError(`${file} is missing and the data layout is not provably version ${supported}: ${problem}`);
    writeJsonAtomic(file, { schema: MARKER_SCHEMA, version: supported, created_at: now().toISOString() }, { fsImpl, durable: true });
    logger.log?.(`[HEALTH] data layout version ${supported} recorded in ${file}`);
    return { version: supported, created: true };
  }
  const version = Number(marker?.version);
  if (marker?.schema !== MARKER_SCHEMA || !Number.isInteger(version) || version < 1) {
    throw new DataLayoutVersionError(`${file} is not a data layout marker: ${JSON.stringify(marker).slice(0, 200)}`);
  }
  if (version > supported) {
    throw new DataLayoutVersionError(`the data in ${varRoot} has layout version ${version}, written by a newer StockMonitor; `
      + `this version reads layout ${supported}. Install the newer version (or point STOCK_MONITOR_VAR_ROOT elsewhere).`);
  }
  if (version < supported) {
    throw new DataLayoutVersionError(`the data in ${varRoot} has layout version ${version} and no migration to ${supported} exists`);
  }
  return { version, created: false };
}

module.exports = { ensureDataLayoutVersion, DataLayoutVersionError, MARKER_SCHEMA };
