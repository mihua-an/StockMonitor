"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Before Health moves the raw-history store, every process an earlier Health spawned that opens it must be
// gone -- the exact process (pid + creation time), not its port. Unknown answers keep the move pending.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageUserRegistry } = require("../health/startup/storage_users.js");

const tmp = makeTempDir("storage-users-");
const file = path.join(tmp, "state", "health", "storage_users.json");
const quiet = { error() {} };
let clock = 1_000_000;
const live = new Map();   // pid -> creation time
const registry = (over = {}) => createStorageUserRegistry({ file, now: () => clock, logger: quiet,
  alive: (pid) => live.has(pid), created: (pids) => new Map(pids.filter((p) => live.has(p)).map((p) => [p, live.get(p)])), ...over });

// a spawned process with its port long closed is still a storage user until the process itself is gone
live.set(101, clock); registry().spawned("market_runtime", 101);
live.set(202, clock + 500); registry().spawned("realtime_api", 202);
assert.deepEqual(registry().alive(), ["market_runtime pid 101", "realtime_api pid 202"]);
live.delete(101);
assert.deepEqual(registry().alive(), ["realtime_api pid 202"]);
assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 1, "gone processes are dropped from the registry");

// a reused pid (created long after the recorded spawn) is not ours
live.set(202, clock + 3_600_000);
assert.deepEqual(registry().alive(), []);

// creation times unreadable: alive (fail closed)
live.set(303, clock); registry().spawned("provider_futu", 303);
assert.deepEqual(registry({ created: () => null }).alive(), ["provider_futu pid 303 (creation time unreadable)"]);

// an unreadable registry blocks the move
fs.writeFileSync(file, "{not json");
assert.match(registry().alive()[0], /unreadable/);

// a spawn the registry could not take is kept in the pending file and still counts
fs.writeFileSync(file, JSON.stringify({ schema: "storage-users-v1", entries: [] }));
const failing = { ...fs, renameSync() { throw new Error("disk full"); } };
live.set(404, clock); registry({ fsImpl: failing }).spawned("provider_shioaji", 404);
assert.ok(fs.existsSync(`${file}.pending`));
assert.deepEqual(registry().alive(), ["provider_shioaji pid 404"]);
assert.ok(!fs.existsSync(`${file}.pending`), "folded back into the registry once it can be written");
assert.deepEqual(registry().alive(), ["provider_shioaji pid 404"]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("storage users contract ok");
