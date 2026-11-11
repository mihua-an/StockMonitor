// The ONE place the renderer decides what NAME to show for an instrument.
//
// The product list, the stock trend header, the order book, the workspace and the event feed all take
// their name from here. A live analysis row must not win: its `name` can be the code itself (a producer
// filling a missing name with `key.code`), and 台積電 on the watch page would become "2330" the moment the
// first signal arrived.
//
// A product's name has one owner, the product catalog (service/market/projection/product_catalog_service.py).
// This module keeps the renderer's only copy of it: { source, code, revision, name } per instrument, written only
// from the catalog's answers (Electron main's copy, product-catalog:names). Every other module passes a code. When
// the catalog holds another revision, catalogRevisionChanged() -- told by Electron main's product-catalog:changed --
// is the one entry that moves the cache to it and asks again for the codes it named.
//
// Priority, highest first:
//   1. the catalog's name at the current revision;
//   2. the caller's candidates, in the order given (put catalog-joined names before live ones);
//   3. the code, only when nothing better is known.
// A Shioaji "name" equal to its code is not a name and never counts. That rule is Shioaji-only on
// purpose: a Futu product's ticker is a legitimate display name.

import { beginRemediation } from "./remediation.js";

// key -> { source, code, revision, name }; name "" is the catalog's answer that it does not name the code at that
// revision (not asked again until the revision changes).
const CATALOG = new Map();
let REVISION = null;

function keyOf(source, code) {
  return `${String(source || "shioaji").trim().toLowerCase()}:${String(code || "").trim().toUpperCase()}`;
}

export function isUsableInstrumentName(source, code, name) {
  const text = String(name ?? "").trim();
  if (!text) return false;
  if (String(source || "shioaji").trim().toLowerCase() === "shioaji"
      && text.toUpperCase() === String(code || "").trim().toUpperCase()) return false;
  return true;
}

/** The catalog's name of the instrument at the current revision; "" when not known (yet). */
export function catalogInstrumentName(source, code) {
  const entry = CATALOG.get(keyOf(source, code));
  return entry && entry.revision === REVISION && isUsableInstrumentName(source, code, entry.name) ? entry.name : "";
}

// Names the catalog does not hold but a product page gives: a futures month is named by its product (台玻 ->
// 台玻期, 台指期 -> 台指期), registered by the realtime page's product sides (features/realtime/product_sides.js).
const PRODUCT_NAMES = new Map();
export function setProductDerivedNames(source, names) {
  for (const key of [...PRODUCT_NAMES.keys()]) if (key.startsWith(`${String(source).toLowerCase()}:`)) PRODUCT_NAMES.delete(key);
  for (const [code, name] of names) PRODUCT_NAMES.set(keyOf(source, code), String(name));
}

export function resolveInstrumentDisplayName(source, code, ...candidates) {
  const known = catalogInstrumentName(source, code) || PRODUCT_NAMES.get(keyOf(source, code));
  if (known) return known;
  for (const candidate of candidates) {
    if (isUsableInstrumentName(source, code, candidate)) return String(candidate).trim();
  }
  return String(code || "").trim();
}

// The catalog lookup: (source, codes) -> { revision, items: [{ source, code, name }] }. Electron main's
// productCatalogNames by default; tests hand in their own.
let NAMES = null;
let BOUND = false;
// Codes asked and not answered yet.
const ASKED = new Set();
// A lookup that FAILED (the catalog unreachable) is asked again only after a backoff, per code: it was asked again on
// every render that showed the code, a steady stream of failing requests nobody saw. Each code's retries are one
// recorded `renderer.instrument_name_retry` (source, code, attempts, the error), started by its first failure and
// finished by the lookup that answers (a page closed meanwhile records it abandoned).
const FAILED = new Map();   // key -> { until, delayMs, attempts, operation }
const RETRY_FIRST_MS = 60_000, RETRY_MAX_MS = 30 * 60_000;
let recordRetry = beginRemediation;
const LEARNED_LISTENERS = new Set();

/** Tests hand in their own recorder. */
export function setInstrumentNameRetryRecorder(recorder) {
  recordRetry = typeof recorder === "function" ? recorder : beginRemediation;
}

/** Tests hand in their own catalog lookup (the page uses Electron main's). */
export function setCatalogNameSource(lookup) {
  NAMES = typeof lookup === "function" ? lookup : null;
}

// Electron main's catalog copy, once per window: its lookup and its revision push.
function bind() {
  if (BOUND) return;
  BOUND = true;
  const api = globalThis.window?.desktopAPI;
  if (!NAMES && typeof api?.productCatalogNames === "function") NAMES = (source, codes) => api.productCatalogNames(source, codes);
  api?.onProductCatalogChanged?.((change) => catalogRevisionChanged(change?.revision ?? null));
}

export function onInstrumentNamesLearned(listener) {
  LEARNED_LISTENERS.add(listener);
  return () => LEARNED_LISTENERS.delete(listener);
}

function notify(codes) {
  if (!codes.length) return;
  for (const listener of [...LEARNED_LISTENERS]) {
    for (const code of codes) { try { listener(code); } catch (error) { console.warn("[instrument names: a learned-name listener] failed", error); } }
  }
}

function retryAnswered(key, outcome) {
  const failed = FAILED.get(key);
  FAILED.delete(key);
  try { failed?.operation?.finish(outcome, { attempt: failed.attempts, detail: { delay_ms: failed.delayMs } }); } catch (error) { console.warn("[instrument names: finishing a retry record] failed", error); }
}

function failed(source, code, error) {
  const key = keyOf(source, code);
  const previous = FAILED.get(key);
  const delayMs = Math.min(RETRY_MAX_MS, (previous?.delayMs || RETRY_FIRST_MS / 2) * 2);
  let operation = previous?.operation || null;
  if (!operation) {
    try {
      operation = recordRetry({ component: "instrument_names", mechanismId: "renderer.instrument_name_retry", triggerReason: "lookup_failed",
        identity: { source, code }, detail: { error: String(error?.message || error).slice(0, 300), delay_ms: delayMs } });
    } catch (recordError) { console.warn("[instrument names: recording a retry] failed", recordError); }
  }
  FAILED.set(key, { until: Date.now() + delayMs, delayMs, attempts: (previous?.attempts || 0) + 1, operation });
}

/** The one entry for a catalog revision change: the names of other revisions are dropped and the codes they named
 *  asked again; views redraw as the answers arrive (onInstrumentNamesLearned). */
export function catalogRevisionChanged(revision) {
  if (revision == null || revision === REVISION) return;
  REVISION = revision;
  const stale = new Map();
  for (const entry of CATALOG.values()) {
    if (entry.revision === revision) continue;
    if (!stale.has(entry.source)) stale.set(entry.source, []);
    stale.get(entry.source).push(entry.code);
  }
  for (const [source, codes] of stale) requestInstrumentNames(source, codes);
}

function learn(source, answer, codes) {
  const revision = answer?.revision ?? null;
  // The window's first revision is its first answer's; after that only Electron main's push moves it. An answer of
  // another revision (one replaced while it was asked) is kept under its own revision: not shown, and asked again.
  if (REVISION == null) catalogRevisionChanged(revision);
  const named = new Map((Array.isArray(answer?.items) ? answer.items : []).map((item) => [String(item?.code || "").trim().toUpperCase(), String(item?.name || "").trim()]));
  const changed = [];
  for (const code of codes) {
    const key = keyOf(source, code);
    const before = catalogInstrumentName(source, code);
    CATALOG.set(key, { source, code, revision, name: named.get(code) || "" });
    if (catalogInstrumentName(source, code) !== before) changed.push(code);
  }
  return changed;
}

/** Asks the catalog for the names of these codes, those not known at the current revision. Only Shioaji: a Futu
 *  view passes its ticker, already a name. */
export function requestInstrumentNames(source, codes) {
  bind();
  const wanted = String(source || "shioaji").trim().toLowerCase();
  if (!NAMES || wanted !== "shioaji") return;
  const now = Date.now();
  const ask = [...new Set((Array.isArray(codes) ? codes : [codes]).map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))]
    .filter((code) => {
      const key = keyOf(wanted, code);
      const entry = CATALOG.get(key);
      return !(REVISION != null && entry?.revision === REVISION) && !ASKED.has(key) && !((FAILED.get(key)?.until || 0) > now);
    });
  if (!ask.length) return;
  for (const code of ask) ASKED.add(keyOf(wanted, code));
  Promise.resolve().then(() => NAMES(wanted, ask)).then((answer) => {
    for (const code of ask) ASKED.delete(keyOf(wanted, code));
    if (answer?.ok === false) throw new Error(String(answer.error || "the catalog refused the lookup"));
    for (const code of ask) retryAnswered(keyOf(wanted, code), "succeeded");
    notify(learn(wanted, answer, ask));
  }).catch((error) => {
    console.warn(`[instrument names] catalog lookup of ${ask.join(", ")} failed; asked again after a backoff`, error);
    for (const code of ask) {
      ASKED.delete(keyOf(wanted, code));
      failed(wanted, code, error);
    }
  });
}

/** resolveInstrumentDisplayName, asking the catalog when it has not named the code at the current revision. */
export function displayInstrumentName(source, code, ...candidates) {
  if (code && !catalogInstrumentName(source, code)) requestInstrumentNames(source, [code]);
  return resolveInstrumentDisplayName(source, code, ...candidates);
}

// Tests only.
export function _resetInstrumentNamesForTest() {
  CATALOG.clear();
  REVISION = null;
  ASKED.clear();
  FAILED.clear();
  LEARNED_LISTENERS.clear();
  NAMES = null;
  BOUND = false;
  recordRetry = beginRemediation;
}
