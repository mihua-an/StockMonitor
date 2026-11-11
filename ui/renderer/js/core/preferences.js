// One read/write path for the per-viewer preferences this window keeps in localStorage (layouts, display
// choices, toggles). Storage can refuse a read or a write (SecurityError when site data is blocked, a full quota):
// every failure is logged here with the key and what the caller was doing, and a write reports whether it was
// kept, so a setter tells its listeners and the user "applied" only when the value will still be there next time.
// Stored names of a user setting never change (AGENTS.md section 0); this module only reads and writes them.

function storageOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
}

/** The stored string for `key`, or null when nothing is stored or storage cannot be read (logged). */
export function readPreference(key, { context = "", storage = null } = {}) {
  const target = storageOf(storage);
  if (!target?.getItem) return null;
  try {
    return target.getItem(String(key));
  } catch (error) {
    console.warn(`[preferences: reading ${key}${context ? ` (${context})` : ""}] failed`, error);
    return null;
  }
}

/** The stored JSON for `key` parsed, or null when absent, unreadable or not JSON (both logged). */
export function readJsonPreference(key, options = {}) {
  const text = readPreference(key, options);
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn(`[preferences: parsing ${key}${options.context ? ` (${options.context})` : ""}] failed`, error);
    return null;
  }
}

/**
 * Store `value` (a string) under `key`. `{ ok: true }` once it is kept; `{ ok: false, error: "persist_failed" }`
 * (logged, with the cause) when there is no storage or it refused the write.
 */
export function writePreference(key, value, { context = "", storage = null } = {}) {
  const target = storageOf(storage);
  const where = `${key}${context ? ` (${context})` : ""}`;
  if (!target?.setItem) {
    console.warn(`[preferences: saving ${where}] failed: no storage in this window`);
    return { ok: false, error: "persist_failed", key: String(key), cause: null };
  }
  try {
    target.setItem(String(key), String(value));
    return { ok: true, key: String(key) };
  } catch (error) {
    console.warn(`[preferences: saving ${where}] failed`, error);
    return { ok: false, error: "persist_failed", key: String(key), cause: error };
  }
}

export function writeJsonPreference(key, value, options = {}) {
  return writePreference(key, JSON.stringify(value), options);
}

export function removePreference(key, { context = "", storage = null } = {}) {
  const target = storageOf(storage);
  const where = `${key}${context ? ` (${context})` : ""}`;
  if (!target?.removeItem) {
    console.warn(`[preferences: removing ${where}] failed: no storage in this window`);
    return { ok: false, error: "persist_failed", key: String(key), cause: null };
  }
  try {
    target.removeItem(String(key));
    return { ok: true, key: String(key) };
  } catch (error) {
    console.warn(`[preferences: removing ${where}] failed`, error);
    return { ok: false, error: "persist_failed", key: String(key), cause: error };
  }
}

/** Thrown by a setter whose value could not be stored: nothing was applied or announced. */
export class PreferencePersistError extends Error {
  constructor(key, cause = null) {
    super("設定無法保存（瀏覽器儲存空間拒絕寫入），未套用");
    this.name = "PreferencePersistError";
    this.code = "persist_failed";
    this.key = String(key);
    this.cause = cause;
    this.userMessage = this.message;
  }
}

/** writePreference that throws PreferencePersistError instead of returning a failure. */
export function writePreferenceOrThrow(key, value, options = {}) {
  const result = writePreference(key, value, options);
  if (!result.ok) throw new PreferencePersistError(key, result.cause);
  return result;
}

/**
 * Listen for `storage` events (another window of this origin changed a key): one window listener for the module,
 * dispatched by key, each listener isolated so one that throws (logged) does not stop the others.
 */
const storageListeners = new Map();
let storageBound = false;
function onStorage(event) {
  const set = storageListeners.get(String(event?.key ?? ""));
  if (!set) return;
  for (const listener of [...set]) {
    try { listener(event); } catch (error) { console.warn(`[preferences: storage listener for ${event.key}] failed`, error); }
  }
}
export function subscribePreferenceStorage(key, listener) {
  const name = String(key);
  if (!storageListeners.has(name)) storageListeners.set(name, new Set());
  storageListeners.get(name).add(listener);
  if (!storageBound && globalThis.addEventListener) {
    globalThis.addEventListener("storage", onStorage);
    storageBound = true;
  }
  return () => {
    const set = storageListeners.get(name);
    set?.delete(listener);
    if (set && !set.size) storageListeners.delete(name);
    if (storageBound && !storageListeners.size) {
      globalThis.removeEventListener?.("storage", onStorage);
      storageBound = false;
    }
  };
}
