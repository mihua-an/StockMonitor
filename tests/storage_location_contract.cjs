const { makeTempDir } = require("./support/temp_dirs.cjs");
// 設定 → 資料儲存: a saved history folder is moved to and activated by Health at a full start (across drives, the copy
// runs beside the App: storage_background_move_contract.cjs);
// until then every process keeps reading the active one. The move is one journaled operation that only moves or
// deletes what StockMonitor owns, never merges into another folder, and rolls back on failure or after a crash.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigRevisionStore } = require("../config/js/config_revisions.js");
const { applyPendingLocation, advanceBackgroundMove, historicalRoot, storagePaths, MARKER } = require("../config/js/storage_settings.js");

const quiet = { log() {}, error() {} };
const partition = path.join("source=shioaji", "market=STK", "trading_date=2026-10-07", "session=DAY", "2330", "manifest.json");
const futuPartition = path.join("source=futu", "market=US", "trading_date=2026-10-07", "session=FULL", "US.AAPL", "events.jsonl");

async function setup() {
  const tmp = makeTempDir("storage-location-");
  const configRoot = path.join(tmp, "config"), dataRoot = path.join(tmp, "data");
  for (const [rel, text] of [[partition, "{}"], [futuPartition, "x".repeat(1000)]]) {
    fs.mkdirSync(path.dirname(path.join(dataRoot, "historical", rel)), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "historical", rel), text);
  }
  const store = new ConfigRevisionStore(configRoot, "storage_location");
  await store.save({ historical_root: null }, { source: "seed", activate: true });
  return { tmp, configRoot, dataRoot, store, source: path.join(dataRoot, "historical") };
}

const sourcesOf = (from, names) => Object.fromEntries(names.map((name) => [name, path.join(from, name)]));

function journal(store) { return JSON.parse(fs.readFileSync(path.join(store.directory, "apply_operation.json"), "utf8")); }

(async () => {
// Same drive: entries renamed; only owned entries leave; the user's own file in the old folder stays.
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  assert.equal((await applyPendingLocation({ configRoot, dataRoot, logger: quiet })).applied, false, "nothing pending");
  fs.writeFileSync(path.join(source, "my_notes.txt"), "mine");
  const target = path.join(tmp, "D", "StockMonitorHistory");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  assert.equal(historicalRoot({ configRoot, dataRoot }), source, "saved is not active");
  const result = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet }));
  assert.equal(result.applied, true);
  assert.ok(fs.existsSync(path.join(target, partition)) && fs.existsSync(path.join(target, futuPartition)));
  assert.ok(fs.existsSync(path.join(target, MARKER)), "the new folder is marked as a StockMonitor store");
  assert.ok(!fs.existsSync(path.join(source, "source=shioaji")), "owned entries left the old folder");
  assert.equal(fs.readFileSync(path.join(source, "my_notes.txt"), "utf8"), "mine", "a file StockMonitor does not own stays");
  assert.equal(historicalRoot({ configRoot, dataRoot }), target);
  assert.equal(journal(store).state, "done");

  // A folder inside the current one is refused and the active one stays.
  await store.save({ historical_root: path.join(target, "nested") }, { expectedRevision: 2, source: "test" });
  assert.equal((await applyPendingLocation({ configRoot, dataRoot, logger: quiet })).applied, false);
  assert.equal(historicalRoot({ configRoot, dataRoot }), target);
  assert.equal(journal(store).state, "refused");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A non-empty folder that is not a StockMonitor store is refused, and nothing in it is touched.
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const target = path.join(tmp, "D", "Data");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "photo.jpg"), "p");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  const refused = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet }));
  assert.equal(refused.applied, false);
  assert.match(refused.error, /not empty/);
  assert.deepEqual(fs.readdirSync(target), ["photo.jpg"]);
  assert.ok(fs.existsSync(path.join(source, partition)), "the active store is whole");
  // A StockMonitor folder that already holds history is not merged into either.
  fs.rmSync(path.join(target, "photo.jpg"));
  fs.writeFileSync(path.join(target, MARKER), "{}");
  fs.mkdirSync(path.join(target, "source=futu"));
  assert.match((await applyPendingLocation({ configRoot, dataRoot, logger: quiet })).error, /already holds/);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A failure part way rolls the moved entries back; the old folder stays active and whole.
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const target = path.join(tmp, "D", "History");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  let renames = 0;
  const failing = { ...fs, renameSync(a, b) {
    if (String(a).includes("source=shioaji")) { renames += 1; throw Object.assign(new Error("sharing violation"), { code: "EBUSY" }); }
    return fs.renameSync(a, b);
  } };
  const failed = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet, fsImpl: failing, renameRetryDelaysMs: [] }));
  assert.equal(failed.applied, false);
  assert.equal(renames, 1);
  assert.equal(journal(store).state, "rolled_back");
  assert.ok(fs.existsSync(path.join(source, futuPartition)), "moved entries came back");
  assert.equal(historicalRoot({ configRoot, dataRoot }), source);
  // The next start tries again and succeeds.
  assert.equal((await applyPendingLocation({ configRoot, dataRoot, logger: quiet })).applied, true);
  assert.equal(historicalRoot({ configRoot, dataRoot }), target);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A crash mid-move (journal still "moving") is rolled back at the next start, then the move runs again.
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const target = path.join(tmp, "D", "History");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  fs.mkdirSync(target, { recursive: true });
  fs.renameSync(path.join(source, "source=futu"), path.join(target, "source=futu"));
  fs.writeFileSync(path.join(store.directory, "apply_operation.json"), JSON.stringify({ schema: "storage-location-apply-v2",
    operation_id: "crashed", revision: 2, from: source, to: target, mode: "rename", state: "moving",
    entries: ["source=futu", "source=shioaji"],
    sources: sourcesOf(source, ["source=futu", "source=shioaji"]), moved: ["source=futu"], staging: null }));
  const result = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet }));
  assert.equal(result.applied, true);
  assert.ok(fs.existsSync(path.join(target, futuPartition)) && fs.existsSync(path.join(target, partition)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A crash after the pointer was written but before the journal said "activated": the pointer is the commit
// point, so the next start finishes the move instead of moving the data back under a pointer that names the target.
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const target = path.join(tmp, "D", "History");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  fs.mkdirSync(target, { recursive: true });
  const entries = ["source=futu", "source=shioaji"];
  for (const name of entries) fs.renameSync(path.join(source, name), path.join(target, name));
  fs.writeFileSync(path.join(target, MARKER), "{}");
  await store.setActive(2, { verified: true, expectedActive: 1 });
  fs.writeFileSync(path.join(store.directory, "apply_operation.json"), JSON.stringify({ schema: "storage-location-apply-v2",
    operation_id: "crashed-after-pointer", revision: 2, from: source, to: target, mode: "rename", state: "moving",
    entries, sources: sourcesOf(source, entries), moved: entries, staging: null }));
  const result = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet }));
  assert.equal(result.applied, false, "nothing left to apply");
  assert.equal(result.root, target);
  assert.equal(journal(store).state, "done");
  assert.ok(fs.existsSync(path.join(target, partition)), "data stays in the target");
  assert.ok(!fs.existsSync(path.join(source, "source=shioaji")), "nothing moved back");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// setActive throws after it wrote the pointer: the move stands (no rollback under an active pointer).
{
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const target = path.join(tmp, "D", "History");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  const original = ConfigRevisionStore.prototype.setActive;
  ConfigRevisionStore.prototype.setActive = async function (...args) { await original.apply(this, args); throw new Error("injected after pointer write"); };
  let result;
  try { result = (await applyPendingLocation({ configRoot, dataRoot, logger: quiet })); }
  finally { ConfigRevisionStore.prototype.setActive = original; }
  assert.equal(result.applied, true);
  assert.equal(historicalRoot({ configRoot, dataRoot }), target);
  assert.ok(fs.existsSync(path.join(target, partition)));
  assert.ok(!fs.existsSync(path.join(source, "source=shioaji")));
  assert.equal(journal(store).state, "done");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Everything config/var_layout.json "storage" puts under the location moves with it -- B's events and the model
// datasets / registry beside the raw history -- across drives (copy) as well as on one (rename).
for (const sameDrive of [true, false]) {
  const { tmp, configRoot, dataRoot, store, source } = await setup();
  const children = storagePaths({ configRoot, dataRoot });
  for (const [dir, file] of [[children.analysis_events, "2026-10-27.jsonl"], [children.model_datasets, path.join("shards", "2026-10-27", "f.parquet")],
    [children.model_registry, "champions.json"]]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "y".repeat(300));
  }
  const target = path.join(tmp, "D", "Store");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  const options = { configRoot, dataRoot, logger: quiet, sameVolumeImpl: () => sameDrive };
  if (!sameDrive) assert.equal((await advanceBackgroundMove(options)).status, "synced");
  const result = await applyPendingLocation(options);
  assert.equal(result.applied, true, result.error);
  if (!sameDrive) await advanceBackgroundMove(options);
  const moved = storagePaths({ configRoot, dataRoot });
  assert.equal(moved.root, target);
  assert.ok(fs.existsSync(path.join(moved.analysis_events, "2026-10-27.jsonl")), "B's events moved");
  assert.ok(fs.existsSync(path.join(moved.model_datasets, "shards", "2026-10-27", "f.parquet")), "training data moved");
  assert.ok(fs.existsSync(path.join(moved.model_registry, "champions.json")), "registry moved");
  assert.ok(fs.existsSync(path.join(target, partition)), "raw history moved");
  assert.ok(!fs.existsSync(children.analysis_events) && !fs.existsSync(path.dirname(children.model_registry)), "nothing left in the old folder");
  assert.deepEqual(journal(store).entries, ["analysis-events", "model", "source=futu", "source=shioaji"]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("storage location contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
