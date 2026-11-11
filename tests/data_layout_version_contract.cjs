const { makeTempDir } = require("./support/temp_dirs.cjs");
// VAR_ROOT carries its data layout version. A new root is marked with the current
// version; the same version passes; a newer or older one is refused before anything opens the data.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureDataLayoutVersion, DataLayoutVersionError, MARKER_SCHEMA } = require("../service/platform/js/data_layout_version.js");
const { loadVarLayout } = require("../config/js/var_paths.js");

const quiet = { log() {} };
const root = makeTempDir("layout-version-");
const marker = path.join(root, "layout_version.json");
const current = loadVarLayout().data_layout_version;
try {
  assert.equal(current, 1);
  assert.deepEqual(ensureDataLayoutVersion(root, { logger: quiet }), { version: 1, created: true });
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).schema, MARKER_SCHEMA);
  assert.deepEqual(ensureDataLayoutVersion(root, { logger: quiet }), { version: 1, created: false });

  fs.writeFileSync(marker, JSON.stringify({ schema: MARKER_SCHEMA, version: 2 }));
  assert.throws(() => ensureDataLayoutVersion(root, { logger: quiet }), (e) => e instanceof DataLayoutVersionError && /newer StockMonitor/.test(e.message));
  fs.writeFileSync(marker, JSON.stringify({ schema: MARKER_SCHEMA, version: 0 }));
  assert.throws(() => ensureDataLayoutVersion(root, { logger: quiet }), DataLayoutVersionError);
  fs.writeFileSync(marker, "{broken");
  assert.throws(() => ensureDataLayoutVersion(root, { logger: quiet }), /cannot be read/);
  assert.equal(fs.readFileSync(marker, "utf8"), "{broken", "an unreadable marker is never overwritten");

  // no marker is version 1 only when the root provably is
  fs.rmSync(marker);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  assert.deepEqual(ensureDataLayoutVersion(root, { logger: quiet }), { version: 1, created: true }, "only version-1 entries: adopted");
  fs.rmSync(marker);
  fs.writeFileSync(path.join(root, "market_cache.sqlite"), "?");
  assert.throws(() => ensureDataLayoutVersion(root, { logger: quiet }), /not part of data layout version 1 \(market_cache\.sqlite\)/);
  assert.ok(!fs.existsSync(marker), "never stamped");
  fs.rmSync(path.join(root, "market_cache.sqlite"));
  const fresh = path.join(root, "never-created");
  assert.deepEqual(ensureDataLayoutVersion(fresh, { logger: quiet }), { version: 1, created: true }, "a first start");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("data layout version contract ok");
