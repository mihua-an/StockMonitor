"use strict";

// Node half of config/config_revisions.py: same layout, same pointer semantics, same lock-file protocol, so Health
// (Node) and settings_api (Python) can share one store. Health is the only writer of the network domain's `active`
// pointer; settings_api is the only writer of saved revisions. Bootstrap (Electron main) only reads.
//
//   <config_root>/<domain>/revisions/r000007.json   immutable ConfigRevision documents
//   <config_root>/<domain>/pointer.json             {"latest": 7, "active": 6, "last_good": 6}
//
// Store state and the writer lock follow config/config_revisions.py exactly: ABSENT /
// OK / CORRUPT / INCONSISTENT, a damaged store fails closed (StoreUnreadable); `.lock` holds {token, pid, created_ms},
// appears atomically (hard link), is removed only by its token, and is taken over only when its owner process is gone
// -- each takeover a `config.lock_takeover` remediation.
//
// The writers (save, setActive, restoreActive) are async: Health runs them on its event loop, so waiting for the lock
// is a timer and an owner's creation time is the async CIM query (cached briefly), never a blocking sleep or a
// synchronous PowerShell that stopped the control API and every service start while the lock was contended.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { processAliveFast, processCreatedMsAsync } = require("../../service/platform/js/process_utils.js");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files.js");
const { secretPaths } = require("./secret_scrub.js");

const REVISION_SCHEMA = "stock-monitor-config-revision-v1";
const POINTER_SCHEMA = "stock-monitor-config-pointer-v1";
const DOMAIN = /^[a-z][a-z0-9_]{0,40}$/;
// The only secret-looking keys a revision may hold: a reference to a stored credential, and whether one is configured.
const SECRET_ALLOWED = new Set(["credential_ref", "credential_configured", "credentials_configured"]);
const CREATED_TOLERANCE_MS = 10_000;
const OWNER_CHECK_AFTER_MS = 1000;
// Lock wait: a timer, from LOCK_POLL_MIN_MS doubling to LOCK_POLL_MAX_MS.
const LOCK_POLL_MIN_MS = 20;
const LOCK_POLL_MAX_MS = 200;
// A pid's creation time is asked once per this long: it is ~0.5 s of PowerShell, and a contended lock asks each poll.
const CREATED_CACHE_MS = 5000;
// This process's start: Node's time origin (it trails the OS creation time by well under the tolerance above).
const OWN_CREATED_MS = Math.round(require("perf_hooks").performance.timeOrigin);

// Where takeovers are recorded: Health, the only Node writer, hands its ledger emitter in at startup.
let remediationEmitter = null;
function setRemediationEmitter(emitter) { remediationEmitter = emitter || null; }

class StoreUnreadable extends Error {
  constructor(domain, state, reason) {
    super(`config domain ${domain} is ${state}: ${reason}`);
    this.code = "CONFIG_STORE_UNREADABLE";
    this.domain = domain;
    this.state = state;
    this.reason = reason;
  }
}

class RevisionConflict extends Error {
  constructor(expected, current, diff) {
    super(`expected revision ${expected}, latest is ${current ? current.revision : null}`);
    this.code = "REVISION_CONFLICT";
    this.expected = expected;
    this.current = current;
    this.diff = diff;
  }
}

class RevisionRejected extends Error {
  constructor(problems) {
    super(`revision rejected: ${JSON.stringify(problems)}`);
    this.code = "REVISION_REJECTED";
    this.problems = problems;
  }
}

const now = () => new Date().toISOString();
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Every path of value that holds a secret, by key or by value (config/secret_scrub.json); empty when it may be stored.
function secretKeys(value, prefix = "") {
  return secretPaths(value, prefix, { allowedNames: SECRET_ALLOWED });
}

function valueDiff(before, after, prefix = "") {
  if (isObject(before) && isObject(after)) {
    const out = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const at = prefix ? `${prefix}.${key}` : key;
      if (!(key in before)) out.push({ path: at, change: "added", after: after[key] });
      else if (!(key in after)) out.push({ path: at, change: "removed", before: before[key] });
      else out.push(...valueDiff(before[key], after[key], at));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: prefix, change: "changed", before, after }];
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

function atomicWrite(file, document) {
  writeJsonAtomic(file, sortKeys(document), { durable: true });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createdCache = new Map();   // pid -> { at, value: Promise<number|null> }
function createdMsOf(pid, query = processCreatedMsAsync) {
  const hit = createdCache.get(pid);
  if (hit && Date.now() - hit.at < CREATED_CACHE_MS) return hit.value;
  const value = query(pid);
  createdCache.set(pid, { at: Date.now(), value });
  for (const [key, entry] of createdCache) if (Date.now() - entry.at >= CREATED_CACHE_MS) createdCache.delete(key);
  return value;
}

async function ownerState(owner) {
  if (!processAliveFast(owner.pid)) return "gone";
  const created = Number.isInteger(owner.created_ms) ? await createdMsOf(owner.pid) : null;
  if (created !== null && Math.abs(created - owner.created_ms) > CREATED_TOLERANCE_MS) return "replaced";
  return "alive";
}

// How deep takeover claims are followed (a claimant that died while taking over a lock, then one taking over its claim).
const TAKEOVER_DEPTH = 3;

// Create `claim` exclusively, whole with this process's owner record: its token, or null when it exists. Only EEXIST
// is contention; any other failure (no space, no access) is the I/O error it is and is thrown -- never retried until
// it reads as "locked".
function makeClaim(claim) {
  const token = crypto.randomUUID().replace(/-/g, "");
  const aside = `${claim}.${token}.aside`;
  fs.writeFileSync(aside, JSON.stringify({ token, pid: process.pid, created_ms: OWN_CREATED_MS, at_ms: Date.now() }));
  try {
    fs.linkSync(aside, claim);
    return token;
  } catch (error) {
    if (error?.code === "EEXIST") return null;   // not an error: the claim is someone else's
    throw error;
  } finally {
    try { fs.unlinkSync(aside); } catch (error) { /* absent is not an error: already removed */ if (error?.code !== "ENOENT") console.warn("[removing a set-aside takeover claim] failed", error); }
  }
}

function readLock(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(owner) ? owner : null;
  } catch (error) { /* absent is not an error: no lock held */ if (error?.code !== "ENOENT") console.warn("[reading the config lock] failed", error); return null; }
}

function recordTakeover(domain, lockPath, owner, trigger, outcome, result) {
  try {
    remediationEmitter?.emit({ component: "config_store", mechanismId: "config.lock_takeover", triggerReason: trigger, outcome,
      identity: {}, detail: { domain, path: lockPath, stored_pid: owner.pid ?? null, contender_pid: process.pid,
        age_ms: Math.max(0, Date.now() - Number(owner.at_ms || 0)), result } });
  } catch (error) { console.warn("[recording the config lock takeover] failed", error); }
}

class ConfigRevisionStore {
  constructor(root, domain) {
    if (!DOMAIN.test(domain)) throw new Error(`invalid config domain ${domain}`);
    this.root = root;
    this.domain = domain;
    this.directory = path.join(root, domain);
    this.revisions = path.join(this.directory, "revisions");
    this.pointerPath = path.join(this.directory, "pointer.json");
  }

  revisionNumbers() {
    try {
      return fs.readdirSync(this.revisions).map((name) => /^r(\d+)\.json$/.exec(name)).filter(Boolean)
        .map((m) => Number(m[1])).sort((a, b) => a - b);
    } catch (error) { /* absent is not an error: no revisions yet */ if (error?.code !== "ENOENT") console.warn("[listing config revisions] failed", error); return []; }
  }

  // {state: ABSENT | OK | CORRUPT | INCONSISTENT, reason, pointer} -- the same classification as the Python store.
  state() {
    const empty = { schema: POINTER_SCHEMA, domain: this.domain, latest: null, active: null, last_good: null };
    let text;
    try {
      text = fs.readFileSync(this.pointerPath, "utf8");
    } catch (error) {
      // not an error: answered as the ABSENT / CORRUPT state, which the caller reports
      if (error.code === "ENOENT") {
        if (this.revisionNumbers().length) return { state: "CORRUPT", reason: "pointer missing while revisions exist", pointer: null };
        return { state: "ABSENT", reason: null, pointer: empty };
      }
      return { state: "CORRUPT", reason: `pointer unreadable: ${error.code || "error"}`, pointer: null };
    }
    let pointer;
    try { pointer = JSON.parse(text); } catch (_error) { /* not an error: answered as the CORRUPT state, which the caller reports */ return { state: "CORRUPT", reason: "pointer is not JSON", pointer: null }; }
    if (!isObject(pointer) || pointer.schema !== POINTER_SCHEMA) return { state: "CORRUPT", reason: "pointer schema", pointer: null };
    // Every field is stated (null when there is none) and names this domain, as in the Python store.
    const missing = ["domain", "latest", "active", "last_good"].filter((name) => !(name in pointer));
    if (missing.length) return { state: "CORRUPT", reason: `pointer lacks ${missing.join(", ")}`, pointer: null };
    if (pointer.domain !== this.domain) return { state: "CORRUPT", reason: `pointer names domain ${JSON.stringify(pointer.domain)}`, pointer: null };
    for (const name of ["latest", "active", "last_good"]) {
      const value = pointer[name] ?? null;
      if (value !== null && !(Number.isInteger(value) && value >= 1)) {
        return { state: "CORRUPT", reason: `pointer ${name} is not a revision number`, pointer: null };
      }
      if (value !== null && !this.get(value)) {
        return { state: "INCONSISTENT", reason: `pointer ${name}=${value} names no loadable revision`, pointer: null };
      }
    }
    const latest = pointer.latest ?? null;
    // No latest over revisions on disk is the damage of a missing pointer (a file past a stated latest is a save that
    // crashed before its pointer moved).
    if (latest === null && this.revisionNumbers().length) {
      return { state: "CORRUPT", reason: "pointer names no latest while revisions exist", pointer: null };
    }
    for (const name of ["active", "last_good"]) {
      const value = pointer[name] ?? null;
      if (value !== null && (latest === null || value > latest)) {
        return { state: "INCONSISTENT", reason: `pointer ${name}=${value} is beyond latest=${latest}`, pointer: null };
      }
    }
    return { state: "OK", reason: null, pointer };
  }

  // The pointer (an empty one for an ABSENT store); throws StoreUnreadable for a CORRUPT / INCONSISTENT one.
  pointer() {
    const state = this.state();
    if (!state.pointer) throw new StoreUnreadable(this.domain, state.state, state.reason);
    return state.pointer;
  }

  get(revision) {
    if (revision === null || revision === undefined) return null;
    try {
      const file = path.join(this.revisions, `r${String(Number(revision)).padStart(6, "0")}.json`);
      const document = JSON.parse(fs.readFileSync(file, "utf8"));
      return document.schema === REVISION_SCHEMA && document.revision === Number(revision) ? document : null;
    } catch (error) { console.warn("[reading a config revision] failed", error); return null; }
  }

  latest() { return this.get(this.pointer().latest); }
  active() { return this.get(this.pointer().active); }
  lastGood() { return this.get(this.pointer().last_good); }

  async withLock(run, timeoutMs = 5000) {
    fs.mkdirSync(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, ".lock");
    const token = crypto.randomUUID().replace(/-/g, "");
    const aside = path.join(this.directory, `.lock.${token}`);
    const started = Date.now();
    const deadline = started + timeoutMs;
    let pause = LOCK_POLL_MIN_MS;
    try {
      fs.writeFileSync(aside, JSON.stringify({ token, pid: process.pid, created_ms: OWN_CREATED_MS, at_ms: Date.now() }));
      for (;;) {
        try {
          fs.linkSync(aside, lockPath);
          break;
        } catch (error) {
          // not an error: EEXIST is another writer holding the domain lock; wait (a dead owner's lock is taken over)
          if (error.code !== "EEXIST") throw error;
          if (Date.now() - started >= OWNER_CHECK_AFTER_MS && await this.takeOver(lockPath)) continue;
          if (Date.now() > deadline) throw new Error(`config domain ${this.domain} is locked`);
          await delay(Math.min(pause, Math.max(1, deadline - Date.now())));
          pause = Math.min(LOCK_POLL_MAX_MS, pause * 2);
        }
      }
    } finally {
      try { fs.unlinkSync(aside); } catch (error) { /* absent is not an error: already removed */ if (error?.code !== "ENOENT") console.warn("[removing a set-aside config file] failed", error); }
    }
    try { return await run(); } finally {
      // Only the token that made the lock removes it.
      if (readLock(lockPath)?.token === token) { try { fs.unlinkSync(lockPath); } catch (error) { /* absent is not an error: already removed */ if (error?.code !== "ENOENT") console.warn("[releasing the config lock] failed", error); } }
    }
  }

  // Remove the lock when its owner process is gone. True when the lock was removed.
  takeOver(lockPath) { return this.removeDead(lockPath, 0); }

  // Remove `file` -- the lock, or a takeover claim -- when the process that wrote it is gone, as in the Python store:
  // the takeover is claimed first (`<file>.takeover.<its token>`, made exclusively with the claimant's own owner
  // record), so one contender alone removes it; a claim whose claimant died is itself removed the same way, up to
  // TAKEOVER_DEPTH levels. True when removed.
  async removeDead(file, depth) {
    const owner = readLock(file);
    if (!owner || !owner.token) return false;
    const trigger = { gone: "owner_process_gone", replaced: "owner_process_replaced" }[await ownerState(owner)];
    if (!trigger) return false;
    const claim = `${file}.takeover.${String(owner.token).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
    const claimToken = makeClaim(claim);
    if (claimToken === null) {
      // Another contender is taking it over -- or one that died doing so left its claim behind.
      if (depth + 1 < TAKEOVER_DEPTH) await this.removeDead(claim, depth + 1);
      else console.error(`[taking over a config lock] failed: takeover claims ${TAKEOVER_DEPTH} deep at ${claim}`);
      return false;
    }
    try {
      const current = readLock(file) || {};
      if (current.token !== owner.token) return false;   // already removed and replaced: nothing of ours to take over
      fs.unlinkSync(file);
    } finally {
      if (readLock(claim)?.token === claimToken) {
        try { fs.unlinkSync(claim); } catch (error) { if (error?.code !== "ENOENT") console.warn("[removing the config lock takeover claim] failed", error); }
      }
    }
    recordTakeover(this.domain, file, owner, trigger, "succeeded", depth === 0 ? "lock removed" : "takeover claim removed");
    return true;
  }

  async save(values, { expectedRevision = null, source, summary = "", activate = false, validator = null } = {}) {
    const leaks = secretKeys(values);
    if (leaks.length) throw new RevisionRejected([{ code: "SECRET_IN_CONFIG", paths: leaks }]);
    if (validator) {
      const problems = validator(values) || [];
      if (problems.length) throw new RevisionRejected(problems);
    }
    return this.withLock(() => {
      const pointer = this.pointer();
      const latest = this.get(pointer.latest);
      const current = latest ? latest.revision : null;
      if ((expectedRevision || null) !== (current || null)) {
        throw new RevisionConflict(expectedRevision, latest, valueDiff((latest && latest.values) || {}, values));
      }
      const number = (current || 0) + 1;
      const document = {
        schema: REVISION_SCHEMA, domain: this.domain, revision: number, previous_revision: current,
        created_at: now(), source: String(source), summary: String(summary || ""), values: JSON.parse(JSON.stringify(values)),
      };
      atomicWrite(path.join(this.revisions, `r${String(number).padStart(6, "0")}.json`), document);
      Object.assign(pointer, { latest: number, updated_at: now() });
      if (activate) Object.assign(pointer, { active: number, last_good: number });
      atomicWrite(this.pointerPath, pointer);
      return document;
    });
  }

  // `expectedActive` (a revision, or null for "the defaults") makes the move conditional; undefined does not check.
  async setActive(revision, { verified, expectedActive } = {}) {
    return this.withLock(() => {
      if (!this.get(revision)) throw new RevisionRejected([{ code: "UNKNOWN_REVISION", revision }]);
      const pointer = this.pointer();
      if (expectedActive !== undefined && (pointer.active ?? null) !== expectedActive) {
        throw new RevisionConflict(expectedActive, this.get(pointer.active), []);
      }
      pointer.active = Number(revision);
      if (verified) pointer.last_good = Number(revision);
      pointer.updated_at = now();
      atomicWrite(this.pointerPath, pointer);
      return pointer;
    });
  }

  // A rollback puts the pointer back to the revision it replaced -- null is "no saved revision, the defaults" -- and
  // only while it still names the one being rolled back; that revision is no longer the last good one.
  async restoreActive(revision, { expectedActive }) {
    return this.withLock(() => {
      if (revision !== null && revision !== undefined && !this.get(revision)) throw new RevisionRejected([{ code: "UNKNOWN_REVISION", revision }]);
      const pointer = this.pointer();
      if (pointer.active !== expectedActive) throw new RevisionConflict(expectedActive, this.get(pointer.active), []);
      const restored = revision === null || revision === undefined ? null : Number(revision);
      pointer.active = restored;
      if (pointer.last_good === expectedActive) pointer.last_good = restored;
      pointer.updated_at = now();
      atomicWrite(this.pointerPath, pointer);
      return pointer;
    });
  }
}

module.exports = { ConfigRevisionStore, RevisionConflict, RevisionRejected, StoreUnreadable, setRemediationEmitter, REVISION_SCHEMA, POINTER_SCHEMA, secretKeys, valueDiff };
