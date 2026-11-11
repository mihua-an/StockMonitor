// One request deadline for every renderer fetch: api.js, the source-settings bootstrap and the
// watch-pages window used three copies with different caps, and a caller's `timeoutMs` stopped at the first.
//
// A caller-supplied signal is relayed into the internal controller, never replaced, so a cancel-in-flight pattern
// keeps working; the timeout is a cap on top. On timeout the fetch is genuinely aborted (not just raced), so a late
// response can never resolve after the caller moved on.
export const DEFAULT_API_TIMEOUT_MS = 20000;

export function withRequestTimeout(callerSignal, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(callerSignal.reason);
  const timer = setTimeout(() => {
    controller.abort(typeof DOMException !== "undefined" ? new DOMException("Request timed out", "AbortError") : new Error("Request timed out"));
  }, timeoutMs);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  return { signal: controller.signal, cleanup: () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", relayAbort);
  } };
}

// Waits for a shared promise, but gives up when `signal` aborts (the shared work itself keeps running for others).
export function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
