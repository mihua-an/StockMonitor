"use strict";

// How this platform compares paths. Windows file names are case-insensitive, so two spellings of one folder are one
// folder there; elsewhere a different case is a different folder. Whether two paths are on one volume (a rename
// works, no copy needed) is the file system's device id, never the path's root: POSIX mounts all share the root "/".

const fs = require("node:fs");
const path = require("node:path");

/** The comparable form of `p`: resolved, and case-folded only where the file system ignores case. */
function pathKey(p, platform = process.platform) {
  const resolved = path.resolve(String(p));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a, b, platform = process.platform) {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** True when `inner` is strictly inside `outer`. */
function isInside(inner, outer, platform = process.platform) {
  return pathKey(inner, platform).startsWith(`${pathKey(outer, platform)}${path.sep}`);
}

// The nearest existing folder of `p` (a target folder may not exist yet; its volume is its parent's).
function existingAncestor(p, fsImpl) {
  let current = path.resolve(String(p));
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function sameVolume(a, b, { fsImpl = fs } = {}) {
  return fsImpl.statSync(existingAncestor(a, fsImpl)).dev === fsImpl.statSync(existingAncestor(b, fsImpl)).dev;
}

module.exports = { pathKey, samePath, isInside, sameVolume };
