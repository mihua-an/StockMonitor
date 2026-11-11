import { apiGet, apiJsonPut, sharedStatusGet } from "../../core/api.js";
import { sourceEnabled } from "../../core/source_settings.js";
import { canonicalMoomooCode, futuCanonicalViewSpec } from "../../market_data/moomoo_symbol.js";
import { realtimeRenderScheduler } from "./realtime_render_scheduler.js";
import { registerRealtimeDiagnostics, subscribeRealtimeView, selectRealtimeView, setRealtimeFocusSymbol } from "../../market_data/realtime.js";
import { viewStateToMoomooProductFields } from "./moomoo_view_adapter.js";
import { callListener, notifyEach } from "../../core/listeners.js";

// apiGet() resolves rather than throws for a classified non-2xx body (futu-disabled 409 / daemon-unavailable 503):
// both Futu control reads go through this, so a refusal fails the read like a transport error does.
function assertOk(endpoint, payload) {
  if (payload?.ok === false) {
    const error = new Error(payload?.error || `${endpoint} refused`);
    error.endpoint = endpoint;
    throw error;
  }
  return payload;
}

// Health's start outcome for the Futu provider ({ status, detail }), through Electron main. Every /api/futu/* call is a
// proxy to that provider: until Health says it serves, a call only waits for the OS to refuse the connection.
async function futuProviderStarted() {
  const outcome = await window.desktopAPI.waitForFutuProvider();
  if (outcome?.status === "ready") return;
  const error = new Error(`Futu provider ${outcome?.status || "unknown"}${outcome?.detail ? `: ${outcome.detail}` : ""}`);
  error.endpoint = "startup:futu-provider";
  throw error;
}

function marketFromDottedCode(code) {
  const dot = String(code || "").indexOf(".");
  return dot > 0 ? code.slice(0, dot) : "";
}

// Market Runtime (via RealtimeViewStore) is the only live authority for product
// rows. This store owns only the static catalog (watchlist names/order from the
// Futu daemon control API) and provider status; it has no snapshot/sequence/gap
// handling of its own -- RealtimeViewStore is the sole resync coordinator.
const PRODUCT_STATUS_REFRESH_MS = 10000;

// The saved selection's storage name, kept as users already have it (AGENTS.md 0.3).
const SELECTED_CODE_STORAGE_KEY = "moomooSelectedCodeV1:live";

function selectedCodeStorageKey() {
  return SELECTED_CODE_STORAGE_KEY;
}

function readPersistedSelectedCode() {
  try {
    return localStorage.getItem(selectedCodeStorageKey()) || "";
  } catch (error) { console.warn("[Futu quotes: reading the selected code] failed", error); return ""; }
}

function persistSelectedCode(code) {
  try {
    localStorage.setItem(selectedCodeStorageKey(), code);
  } catch (error) { console.warn("[Futu quotes: saving the selected code] failed", error); }
}

// Two live-field projections show the same thing when every field holds the same scalar.
function sameScalarFields(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  for (const key of keys) if (!Object.is(a[key], b[key])) return false;
  return true;
}

class MoomooQuoteStore {
  #realtimeUnsubscribers;

  constructor() {
    // The catalog: code, name, sort order -- never a live field. Live fields are each code's
    // projection of its own view, held apart in `liveFields` and replaced whole on every view update, so a field the
    // view no longer carries (a cleared signal) cannot linger on the row. `snapshot().products` joins the two.
    this.products = [];
    this.liveFields = new Map();
    // code -> { row, fields, merged }: the joined product row, rebuilt only when its catalog row or live fields changed.
    this.mergedRows = new Map();
    this.watchlist = [];
    this.status = {};
    this.selectedCode = canonicalMoomooCode(readPersistedSelectedCode());
    if (this.selectedCode) persistSelectedCode(this.selectedCode);
    this.listeners = new Set();
    this.loading = null;
    this.statusLoading = null;
    this.watchlistLoaded = false;
    this.initialized = false;
    this.pendingWatchlist = null;
    // Watchlist writes run one at a time in call order; only the newest desired list is sent and committed.
    this.watchlistIntent = 0;
    this.watchlistWrite = null;
    this.timer = 0;
    this.generation = 0;
    this.lastRealtimeAt = 0;
    this.pendingDirtyCodes = new Set();
    // One Market Runtime view.subscribe per watchlist code, reconciled whenever this.products changes: the native
    // WebSocket frames are the live authority (#syncRealtimeSubscriptions()).
    this.#realtimeUnsubscribers = new Map();
  }

  #syncRealtimeSubscriptions() {
    const desired = new Set(this.products
      .map((row) => canonicalMoomooCode(row?.code || ""))
      .filter(Boolean));
    for (const [code, unsubscribe] of this.#realtimeUnsubscribers) {
      if (!desired.has(code)) {
        unsubscribe();
        this.#realtimeUnsubscribers.delete(code);
        this.liveFields.delete(code);
        this.mergedRows.delete(code);
      }
    }
    for (const code of desired) {
      if (this.#realtimeUnsubscribers.has(code)) continue;
      const market = marketFromDottedCode(code);
      if (!market) continue;
      // stateDelivery "snapshot-only" -- the callback still fires on every delta, it just does not
      // receive a state copy. The default ("always") made RealtimeViewStore structuredClone the
      // ENTIRE view state (full minute trend + the 100-row trade window) once per delta per symbol,
      // to hand it to #applyViewState, which reads six summary scalars and the trend tail out of
      // it. Read those directly off the live state instead; see RealtimeViewStore.select().
      // The SAME canonical view the product-list row uses.
      const spec = futuCanonicalViewSpec(code);
      const unsubscribe = subscribeRealtimeView(spec, () => {
        this.#applyViewFields(code, spec);
      }, { stateDelivery: "snapshot-only" });
      this.#realtimeUnsubscribers.set(code, unsubscribe);
    }
  }

  #applyViewFields(code, spec) {
    // The catalog, not the subscription map: a cached view answers inside subscribe(), before the map has it.
    if (!this.products.some((row) => canonicalMoomooCode(row?.code || "") === code)) return;
    // The projector only reads numbers out of the live state; nothing of it is retained. Nested
    // under `fields` on purpose: select() also merges the view's presentation flags (stale,
    // loading, view_status, ...) at the top level, and those must not be spread into a product row.
    const view = selectRealtimeView(spec, (state) => ({ fields: viewStateToMoomooProductFields(state) }));
    const fields = view?.fields;
    if (!fields || !Object.keys(fields).length) {
      // A view between a reset and its snapshot says nothing yet: the last facts stay. An authoritative snapshot that
      // is empty (a new session with no quote yet) says there is nothing: the previous session's fields go.
      const authoritative = ["ready", "empty"].includes(view?.presentation_state);
      if (!authoritative || !this.liveFields.delete(code)) return;
    } else {
      // A notice that moved nothing a row shows (a trade window shift, an order-book level) repaints no row. The
      // fields are flat scalars: compared field by field (it was a JSON.stringify per delta per code).
      if (sameScalarFields(this.liveFields.get(code), fields)) return;
      this.liveFields.set(code, fields);
    }
    this.lastRealtimeAt = Date.now();
    this.#scheduleRealtimeEmit(code);
  }

  // A catalog row joined with its view's live fields. The same object until either side changes, so an emit
  // allocates only the rows that moved and a consumer can tell an unchanged row by identity.
  productRow(row) {
    const code = canonicalMoomooCode(row?.code || "");
    const fields = this.liveFields.get(code);
    const known = this.mergedRows.get(code);
    if (known && known.row === row && known.fields === fields) return known.merged;
    const merged = { ...row, ...(fields || {}), code: row.code };
    this.mergedRows.set(code, { row, fields, merged });
    return merged;
  }

  snapshot({ incremental = false } = {}) {
    return {
      products: this.products.map((row) => this.productRow(row)),
      watchlist: [...this.watchlist],
      status: {...this.status},
      selectedCode: this.selectedCode,
      initialized: this.initialized,
      changedCodes: incremental ? [...this.pendingDirtyCodes] : null,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    callListener(listener, "Futu quotes: first snapshot", this.snapshot());
    this.#ensurePolling();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.#stopPolling();
    };
  }

  emit(incremental = false) {
    // The selected product is Market Runtime's Futu focus: the product opened in the Futu pane gets its order book,
    // which the product-page listing (quote + trade only) does not. Unchanged selections send nothing.
    if (!incremental) setRealtimeFocusSymbol(this.initialized ? this.selectedCode : "", { source: "futu" });
    const value = this.snapshot({ incremental });
    this.pendingDirtyCodes.clear();
    notifyEach(this.listeners, "Futu quotes", value);
  }

  #scheduleRealtimeEmit(code) {
    if (code) this.pendingDirtyCodes.add(code);
    realtimeRenderScheduler.scheduleFrame("moomoo-quote-store:emit", () => this.emit(true));
  }

  #ensurePolling() {
    if (!sourceEnabled("futu")) return;
    if (!this.initialized) void this.bootstrap();
    else void this.refreshStatus();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshStatus(), PRODUCT_STATUS_REFRESH_MS);
    }
  }

  #stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    realtimeRenderScheduler.cancel("moomoo-quote-store:emit");
    this.pendingDirtyCodes.clear();
  }

  #statusSignature(status = {}) {
    return [
      Boolean(status?.readiness?.connected),
      String(status?.readiness?.state || ""),
      String(status?.readiness?.market_data_ready ?? ""),
      String(status?.last_error || ""),
      String(status?.context_generation || ""),
      String(status?.worker_alive ?? ""),
    ].join("|");
  }

  #startingStatus() {
    return { ...this.status, last_error:"", readiness:{ ...(this.status?.readiness || {}), state:"PROVIDER_STARTING", connected:false, market_data_ready:false, focused_market_ready:false, focused_book_ready:false } };
  }

  #disconnectedStatus(error) {
    return { ...this.status, last_error:error?.message || String(error), readiness:{ ...(this.status?.readiness || {}), state:"DISCONNECTED", connected:false, market_data_ready:false, focused_market_ready:false, focused_book_ready:false } };
  }

  async bootstrap({ force = false } = {}) {
    if (!sourceEnabled("futu")) return this.snapshot();
    if (this.loading) return this.loading;
    if (this.initialized && !force) return this.snapshot();
    const generation = ++this.generation;
    this.loading = (async () => {
      // Before the first answer Health may still be starting the provider: shown as starting, not as a failed read.
      if (!this.status?.readiness) {
        this.status = this.#startingStatus();
        this.emit();
      }
      await futuProviderStarted();
      if (generation !== this.generation) return this.snapshot();
      // Static catalog + control status only. Live fields arrive through the
      // per-code Market Runtime view subscriptions (#syncRealtimeSubscriptions).
      // Either read failing leaves the store uninitialized (the next poll bootstraps again).
      const [watch, status] = await Promise.all([
        apiGet("/api/futu/watchlist").then((payload) => assertOk("/api/futu/watchlist", payload)),
        apiGet("/api/futu/status").then((payload) => assertOk("/api/futu/status", payload)),
      ]);
      if (generation !== this.generation) return this.snapshot();
      const items = Array.isArray(watch?.items) ? watch.items : [];
      this.watchlist = items;
      this.watchlistLoaded = true;
      this.products = items.map((item, index) => {
        const code = canonicalMoomooCode(item?.code || "");
        return { code, name: String(item?.name || ""), sort_order: Number(item?.sort_order ?? index) };
      }).filter((row) => row.code);
      this.#syncRealtimeSubscriptions();
      this.status = status || {};
      this.initialized = true;
      const productCodes = new Set(this.products.map((row) => canonicalMoomooCode(row?.code || "")).filter(Boolean));
      // A persisted selection is re-validated against the catalog: a selection the catalog does not list
      // is dropped, never posted to the Futu focus/subscription API.
      if (this.selectedCode && !productCodes.has(this.selectedCode)) this.selectedCode = "";
      if (!this.selectedCode && this.products.length) {
        this.selectedCode = String(this.products[0]?.code || "");
        if (this.selectedCode) persistSelectedCode(this.selectedCode);
      }
      this.emit();
      return this.snapshot();
    })().catch((error) => {
      console.error("[Futu quotes: bootstrap] failed", { endpoint: error?.endpoint || "", generation }, error);
      if (generation === this.generation) {
        this.status = this.#disconnectedStatus(error);
        this.initialized = false;
        this.emit();
      }
      return this.snapshot();
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  // Provider status only (connection/readiness/context generation).
  async refreshStatus() {
    if (!sourceEnabled("futu")) return this.snapshot();
    if (!this.listeners.size) return null;
    if (!this.initialized) return this.bootstrap();
    if (this.statusLoading) return this.statusLoading;
    const generation = this.generation;
    // Shared with the dock's Futu light (core/api.js sharedStatusGet): one daemon status read per interval.
    this.statusLoading = sharedStatusGet("/api/futu/status", PRODUCT_STATUS_REFRESH_MS - 1000)
      .then((payload) => {
        assertOk("/api/futu/status", payload);
        if (generation !== this.generation) return;
        if (this.pendingWatchlist) {
          void this.replaceWatchlist(this.pendingWatchlist)
            .catch((error) => console.warn("[MOOMOO WATCHLIST] pending product universe still not applied", error));
        }
        const before = this.#statusSignature(this.status);
        this.status = payload || this.status;
        if (before !== this.#statusSignature(this.status)) this.emit();
      })
      .catch((error) => {
        console.warn("[Futu quotes: status poll] failed", { endpoint: "/api/futu/status", generation }, error);
        if (generation !== this.generation) return;
        const next = this.#disconnectedStatus(error);
        const changed = this.#statusSignature(next) !== this.#statusSignature(this.status);
        this.status = next;
        if (changed) this.emit();
      })
      .finally(() => { this.statusLoading = null; });
    return this.statusLoading;
  }

  async select(code) {
    this.selectedCode = canonicalMoomooCode(code);
    persistSelectedCode(this.selectedCode);
    this.emit();
    return this.selectedCode;
  }

  async replaceWatchlist(items = []) {
    const normalized = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const code = canonicalMoomooCode(item?.code || item || "");
      if (!code) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      normalized.push({ code, name: String(item?.name || "") });
    }
    // The desired list is this store's to deliver: a PUT that fails stays pending and is applied again when the next
    // status read succeeds (the readiness transition), instead of each caller retrying on a timer.
    const intent = ++this.watchlistIntent;
    this.pendingWatchlist = normalized;
    const previous = this.watchlistWrite;
    const write = (async () => {
      // Writes are serialized so the daemon receives them in call order. The previous write's failure belongs to
      // its own caller (it was thrown there); here it only means that write is over.
      if (previous) await previous.catch(() => { /* not an error: that write's caller received its failure */ });
      // A newer list was asked for while this one waited: it is the one to send.
      if (intent !== this.watchlistIntent) return this.watchlist;
      if (this.#isCommittedWatchlist(normalized)) { this.pendingWatchlist = null; return this.watchlist; }
      await futuProviderStarted();
      const result = await apiJsonPut("/api/futu/watchlist", { items: normalized });
      if (result?.ok === false) throw new Error(result?.error || "moomoo watchlist update failed");
      if (this.pendingWatchlist === normalized) this.pendingWatchlist = null;
      this.watchlist = Array.isArray(result?.items) ? result.items : normalized;
      this.watchlistLoaded = true;
      this.initialized = false;
      if (this.loading) await this.loading;
      await this.bootstrap({ force:true });
      return this.watchlist;
    })();
    this.watchlistWrite = write;
    try { return await write; } finally { if (this.watchlistWrite === write) this.watchlistWrite = null; }
  }

  #isCommittedWatchlist(normalized) {
    return this.watchlistLoaded
      && normalized.length === this.watchlist.length
      && normalized.every((item, index) => {
        const current = this.watchlist[index] || {};
        return String(current.code || "").toUpperCase() === item.code
          && String(current.name || "") === item.name;
      });
  }
}

export const moomooQuoteStore = new MoomooQuoteStore();

registerRealtimeDiagnostics("futu", () => ({
  code: moomooQuoteStore.selectedCode,
  applied_at: moomooQuoteStore.lastRealtimeAt,
  revision: null,
  quote_applied_at: moomooQuoteStore.lastRealtimeAt,
}));
