import { describeError } from "./console_text.js";

const flights = new WeakMap();

export function userFacingMessage(error, fallback, { context = "UI action", logger = console } = {}) {
  try { logger?.error?.(`[${context}] ${describeError(error)}`, error); } catch (_error) { /* not an error: the logger itself failed; nothing further can record it */ }
  const explicit = String(error?.userMessage || "").trim();
  return explicit || String(fallback || "操作失敗，請稍後再試");
}

// One run of `action` per key at a time (a button, a component): a call while one is out returns that run instead of
// starting another. It only dedupes and never touches the key: whoever owns a button decides its `disabled` from its
// own state, with inFlight(key) for "a run is out", and redraws it when the returned promise settles (the key is
// already released then).
export function runSingleFlight(key, action) {
  if (!key) return Promise.resolve().then(action);
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = Promise.resolve()
    .then(action)
    .finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
  flights.set(key, flight);
  return flight;
}

/** Whether a runSingleFlight run of `key` is out. */
export function inFlight(key) {
  return Boolean(key) && flights.has(key);
}
