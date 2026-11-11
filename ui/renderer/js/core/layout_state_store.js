/* Canonical renderer layout persistence.
 *
 * Data refresh code must not own presentation geometry.  Column widths,
 * splitters and panel geometry all go through this one localStorage-backed
 * adapter so page rerenders/reconnects cannot silently reapply defaults.
 *
 * It is the one owner of each key: tables in every window (the main window and
 * any number of detached views) share a column-width key, so a table never
 * writes its whole record -- it commits the columns it changed, this store
 * merges them into the record and tells every subscriber of the key, in this
 * window directly and in the other windows through the `storage` event.
 */
const LISTENERS = new Map();
let storageEventsBound = false;

function keyOf(key) { return String(key || "").trim(); }

function notify(storageKey, source) {
  const listeners = LISTENERS.get(storageKey);
  if (!listeners) return;
  const value = layoutStateStore.read(storageKey, null);
  for (const listener of [...listeners]) {
    try { listener(value, { source }); } catch (error) { console.warn("[layout state: notifying a subscriber] failed", error); }
  }
}

// Another window changed a key: localStorage raises `storage` only in the windows that did not write.
function bindStorageEvents() {
  if (storageEventsBound || typeof globalThis.addEventListener !== "function") return;
  storageEventsBound = true;
  globalThis.addEventListener("storage", (event) => {
    if (event.key === null) { for (const key of LISTENERS.keys()) notify(key, null); return; }
    if (LISTENERS.has(event.key)) notify(event.key, null);
  });
}

// The one stored column-width shape: { schema_version: 2, columns: { <column id>: px }, available } -- px fitted to
// a table `available` px wide. Anything else is refused (logged once: the record is removed).
function readColumnWidthRecord(storageKey) {
  const raw = layoutStateStore.read(storageKey, null);
  if (raw == null) return null;
  if (raw.schema_version !== 2 || !raw.columns || typeof raw.columns !== "object" || Array.isArray(raw.columns)) {
    console.warn(`[layout state] stored widths ${storageKey} refused: not the schema_version 2 shape`);
    layoutStateStore.remove(storageKey);
    return null;
  }
  const available = Number(raw.available);
  return { columns: { ...raw.columns }, available: available > 0 ? available : 0 };
}

export const layoutStateStore = Object.freeze({
  read(key, fallback = null) {
    const storageKey = keyOf(key);
    if (!storageKey) return fallback;
    try {
      const raw = globalThis.localStorage?.getItem?.(storageKey);
      if (raw == null || raw === "") return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (error) { console.warn("[layout state: reading] failed", error); return fallback; }
  },

  write(key, value, { source = null } = {}) {
    const storageKey = keyOf(key);
    if (!storageKey) return false;
    try {
      globalThis.localStorage?.setItem?.(storageKey, JSON.stringify(value));
    } catch (error) { console.warn("[layout state: saving] failed", error); return false; }
    notify(storageKey, source);
    return true;
  },

  remove(key, { source = null } = {}) {
    const storageKey = keyOf(key);
    if (!storageKey) return false;
    try {
      globalThis.localStorage?.removeItem?.(storageKey);
    } catch (error) { console.warn("[layout state: removing] failed", error); return false; }
    notify(storageKey, source);
    return true;
  },

  /**
   * `listener(value, { source })` runs after every change of `key`: a write, commit or remove in this window (with
   * the writer's `source`) or in another window (source null). Returns the unsubscribe function.
   */
  subscribe(key, listener) {
    const storageKey = keyOf(key);
    if (!storageKey || typeof listener !== "function") return () => {};
    bindStorageEvents();
    if (!LISTENERS.has(storageKey)) LISTENERS.set(storageKey, new Set());
    LISTENERS.get(storageKey).add(listener);
    return () => {
      const listeners = LISTENERS.get(storageKey);
      listeners?.delete(listener);
      if (listeners && !listeners.size) LISTENERS.delete(storageKey);
    };
  },

  /** The saved column widths of `key` as `{ columns, available }`, or null. */
  readColumnWidths(key) {
    const storageKey = keyOf(key);
    return storageKey ? readColumnWidthRecord(storageKey) : null;
  },

  /**
   * Merge one table's column-width change into `key`. `changed` ({ <column id>: px }) is what the user set; `shown`
   * is every width the table shows, saved only for columns the record has no width for yet. Both are px of a table
   * `available` px wide (0: not fitted) and are scaled to the record's own `available`, so a table in a window of
   * another width changes only those columns and keeps every other column's proportion.
   */
  commitColumnWidths(key, { changed = {}, shown = {}, available = 0 } = {}, { source = null } = {}) {
    const storageKey = keyOf(key);
    if (!storageKey) return false;
    const record = readColumnWidthRecord(storageKey) || { columns: {}, available: 0 };
    const width = Math.round(Number(available) || 0);
    const recordAvailable = record.available || (Object.keys(record.columns).length ? 0 : width);
    const scale = recordAvailable > 0 && width > 0 ? recordAvailable / width : 1;
    const columns = record.columns;
    const put = (id, px, always) => {
      const value = Number(px);
      if (!Number.isFinite(value) || value <= 0) return;
      if (always || !(Number(columns[id]) > 0)) columns[id] = Math.round(value * scale);
    };
    for (const [id, px] of Object.entries(shown || {})) put(id, px, false);
    for (const [id, px] of Object.entries(changed || {})) put(id, px, true);
    const next = { schema_version: 2, columns };
    if (recordAvailable > 0) next.available = recordAvailable;
    return layoutStateStore.write(storageKey, next, { source });
  },
});
