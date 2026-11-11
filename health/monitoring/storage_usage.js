"use strict";

// 連線診斷 儲存空間 (user 10-20): how much of the disk StockMonitor holds, split the way a user reads it, and how much is
// left on the disk of the storage location (user 10-28: what keeps growing is there, so that is the disk that can run
// out and stop the history from being stored; VAR_ROOT's disk holds data of steady size). Walked by Health at most
// once a minute and only while a monitoring page asks for detail -- a few thousand files, about half a second of
// directory I/O, never anything on the market path.
//
//   歷史資料  the raw history at the storage location's root (設定 → 資料儲存, config/var_layout.json "storage")
//   分析事件  Analysis Runtime's rule events (storage location)
//   模型訓練  the training data (feature shards, daily summaries), datasets and model registry (storage location)
//   WAL       Market Runtime's write-ahead log (data/live-engine)
//   分析      Analysis Runtime's state (data/analysis-runtime)
//   行情      session caches and market files (data/market)
//   其他      everything else under VAR_ROOT (logs, output, accounts, config, ...)

const fs = require("node:fs");
const path = require("node:path");

const REFRESH_MS = 60_000;

// A file or folder removed while it is walked (a WAL segment pruned, a cache rewritten) is simply not counted: it is no
// longer on the disk. Every other failure is the walk's own and is reported.
const gone = (error) => error?.code === "ENOENT";

// `skip`: folders (resolved, lower-case) counted on their own and left out of this total.
async function treeBytes(fsp, target, skip = new Set()) {
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) return 0;   // not an error: removed while walked, no longer on the disk
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(path.resolve(full).toLowerCase())) bytes += await treeBytes(fsp, full, skip);
    } else if (entry.isFile()) {
      try {
        bytes += (await fsp.stat(full)).size;
      } catch (error) {
        if (!gone(error)) throw error;   // not an error: removed while walked, no longer on the disk
      }
    }
  }
  return bytes;
}

// The disk a folder is on and its size: statfs of the folder, or of its nearest existing parent while it does not exist
// yet (a storage location saved but not created yet).
async function diskOf(fsp, dir) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      const stat = await fsp.statfs(at);
      return { root: path.parse(at).root, total_bytes: stat.bsize * stat.blocks, free_bytes: stat.bsize * stat.bavail };
    } catch (error) {
      if (!gone(error) || path.dirname(at) === at) throw error;   // not an error: absent yet, its parent is on the same disk
    }
  }
}

class StorageUsage {
  // storagePaths: () => the active storage location and its children (config/js/storage_settings.js storagePaths).
  // moveStatus: () => the storage move under way or null (config/js/storage_settings.js storageMoveStatus).
  constructor({ varRoot, dataRoot, storagePaths, moveStatus = () => null, fsImpl = fs, now = Date.now, logger = console, refreshMs = REFRESH_MS }) {
    this.varRoot = varRoot;
    this.dataRoot = dataRoot;
    this.storagePaths = storagePaths;
    this.moveStatus = moveStatus;
    this.fsImpl = fsImpl;
    this.fsp = fsImpl.promises;
    this.now = now;
    this.logger = logger;
    this.refreshMs = refreshMs;
    this.last = null;
    this.walking = null;
    this.walkedAt = -Infinity;
  }

  // Starts a walk when the last one is older than a minute; the snapshot carries the last finished one meanwhile.
  refreshIfDue() {
    if (this.walking || this.now() - this.walkedAt < this.refreshMs) return;
    this.walkedAt = this.now();
    this.walking = this.walk()
      .then((result) => { this.last = result; })
      .catch((error) => {
        this.logger.warn(`[HEALTH] storage usage walk failed: ${error?.stack || error?.message || error}`);
        this.last = { availability: "TEMPORARILY_UNAVAILABLE", reason: String(error?.message || error), sampled_at: new Date(this.now()).toISOString() };
      })
      .finally(() => { this.walking = null; });
  }

  current() {
    return { ...(this.last || { availability: "NO_SAMPLE", reason: "not walked yet" }), move: this.move() };
  }

  // Read at every snapshot, unlike the minute's walk: a small journal file and one statfs. What is left on the target
  // disk changes as the copy goes.
  move() {
    try {
      const status = this.moveStatus();
      if (!status) return null;
      let at = path.resolve(status.to);
      while (!this.fsImpl.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
      const disk = this.fsImpl.statfsSync(at);
      return { ...status, target_root: path.parse(at).root, target_free_bytes: disk.bsize * disk.bavail };
    } catch (error) {
      this.logger.warn(`[HEALTH] storage move status failed: ${error?.stack || error?.message || error}`);
      return null;
    }
  }

  async walk() {
    const started = Date.now();
    const storage = this.storagePaths();
    const model = path.dirname(storage.model_registry);
    const key = (dir) => path.resolve(dir).toLowerCase();
    const parts = [
      // The raw history is the storage location's root less its children.
      { id: "historical", label: "歷史資料", dir: storage.root, skip: [storage.analysis_events, model] },
      { id: "events", label: "分析事件", dir: storage.analysis_events },
      { id: "model", label: "模型訓練", dir: model },
      { id: "wal", label: "WAL", dir: path.join(this.dataRoot, "live-engine") },
      { id: "analysis", label: "分析", dir: path.join(this.dataRoot, "analysis-runtime") },
      { id: "market", label: "行情", dir: path.join(this.dataRoot, "market") },
    ];
    for (const part of parts) part.bytes = await treeBytes(this.fsp, part.dir, new Set((part.skip || []).map(key)));
    // 其他 is VAR_ROOT without the parts' folders (a storage location elsewhere is not under VAR_ROOT anyway).
    parts.push({ id: "other", label: "其他", dir: this.varRoot,
      bytes: await treeBytes(this.fsp, this.varRoot, new Set(parts.flatMap((part) => [part.dir, ...(part.skip || [])]).map(key))) });
    return {
      availability: "OK", sampled_at: new Date(this.now()).toISOString(), walk_ms: Date.now() - started,
      parts: parts.map(({ id, label, bytes }) => ({ id, label, bytes })),
      total_bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      // The disk the storage location is on.
      disk: await diskOf(this.fsp, storage.root),
    };
  }
}

module.exports = { StorageUsage, treeBytes, REFRESH_MS };
