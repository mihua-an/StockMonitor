let firstApiResponseReported = false;
let lastApiSuccessAt = 0;
export function getApiHealth() { return { last_success_at: lastApiSuccessAt }; }

import { apiUrl } from "./state.js";
import { disabledRequest } from "./source_settings.js";
import { withRequestTimeout } from "./request_deadline.js";

// 後端 API 共用函式

// Every request is capped by one deadline that starts before the source gate (request_deadline.js).

// Historically any non-2xx response threw a generic, contentless Error and
// the JSON body (the project's `{"ok": false, "error": ...}` convention) was
// never read. That discarded real detail from routes that already return a
// classified status code (403/409/503/...). Now: on a non-2xx response we
// still try to parse the JSON body first; if it parses, we return it just
// like the success path so every call site's existing `result?.ok` /
// `result?.error` handling keeps working regardless of HTTP status. We only
// throw when the body genuinely can't be read as JSON (opaque failure, e.g.
// a proxy/500 HTML error page) or when the fetch itself fails (network
// error, unchanged from before).
// The answered failure is recorded here, once for every caller, with the method, path and status: a caller that only
// reads `result.ok` would otherwise leave no trace of it.
async function readErrorResponse(method, path, response) {
  const route = String(path).split("?")[0];
  let body = null;
  let unreadable = null;
  try {
    body = await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    unreadable = error;
  }
  if (body && typeof body === "object") {
    console.warn(`[api: ${method} ${route}] HTTP ${response.status}`, body.error ?? body.detail ?? body.message ?? "");
    return body;
  }
  throw new Error(`${method} ${route} failed: ${response.status}${unreadable ? ` (body unreadable: ${unreadable.message || unreadable})` : ""}`);
}

// Status reads shared by every renderer consumer (dock lights, session lifecycle, Futu product list). Each used
// to poll the same endpoint on its own timer -- /api/status every 2 s + 5 s, /api/futu/status every 2 s + 10 s,
// and every /api/futu/status is proxied to the Futu daemon. One in-flight request per path, and a result younger
// than the caller's maxAgeMs is reused, so the request rate is set by the slowest real need, not by the number of
// readers. Only an answer from a serving service is cached: a rejected read, or a refusal body (`ok: false` -- the
// Futu provider not started yet, a daemon not attached), is dropped as it settles, so the next caller asks again
// instead of being handed the same failure until the cache age runs out (a refusal read before the provider served
// failed the product list's first poll after it did).
const sharedInFlight = new Map();
const sharedResults = new Map();
export function sharedStatusGet(path, maxAgeMs) {
  const pending = sharedInFlight.get(path);
  if (pending) return pending;
  const cached = sharedResults.get(path);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.promise;
  const promise = apiGet(path);
  sharedInFlight.set(path, promise);
  promise.then(
    (payload) => {
      sharedInFlight.delete(path);
      if (payload?.ok === false) sharedResults.delete(path);
      else sharedResults.set(path, { at: Date.now(), promise });
    },
    () => {
      // The caller that receives this promise handles and records the rejection; here it only leaves the cache.
      sharedInFlight.delete(path);
      sharedResults.delete(path);
    },
  );
  return promise;
}

// One request path for every method: the five helpers were copies of each other and had drifted -- only
// GET honoured `timeoutMs`, and the JSON methods replaced any headers the caller passed. Every method now takes the
// same options: `timeoutMs`, `signal`, `headers` (merged over the JSON content type), and the rest of fetch's.
async function request(method, path, { body, json = false, options = {} } = {}) {
  const started = performance.now();
  const { timeoutMs, headers, ...fetchOptions } = options && typeof options === "object" ? options : {};
  // The deadline covers the whole path: the source-settings bootstrap behind the gate included.
  const { signal, cleanup } = withRequestTimeout(fetchOptions.signal, Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined);
  try {
    const disabled = await disabledRequest(path, json ? body : undefined, signal);
    if (disabled) return disabled;
    const response = await fetch(apiUrl(path), {
      ...fetchOptions,
      method,
      headers: json ? { "Content-Type": "application/json", ...(headers || {}) } : headers,
      ...(json ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    if (method === "GET" && !firstApiResponseReported) {
      firstApiResponseReported = true;
      window.dispatchEvent(new CustomEvent("stock-monitor:first-api-response", {
        detail: { duration_ms: performance.now() - started, path },
      }));
    }
    if (!response.ok) {
      return await readErrorResponse(method, path, response);
    }
    const result = await response.json();
    lastApiSuccessAt = Date.now();
    return result;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally { cleanup(); }
}

export function apiGet(path, options = {}) {
  return request("GET", path, { options });
}

// An answered failure (`{ ok: false, error, message }`, any HTTP status) as an exception: a page that reads a
// result as data calls requireOk (or apiGetOk) first, so the failure reaches its error path instead of being drawn as
// empty settings, zero dates or "no quote". A success without an `ok` field passes through; legitimately empty data is
// a success that says so.
export class ApiAnswerError extends Error {
  constructor(what, body) {
    const code = String(body?.error ?? body?.code ?? "failed");
    super(`${what} answered ok: false (${code})${body?.message ? `: ${body.message}` : ""}`);
    this.name = "ApiAnswerError";
    this.code = code;
    this.body = body;
    if (typeof body?.message === "string" && body.message.trim()) this.userMessage = body.message.trim();
  }
}

export function requireOk(result, what) {
  if (result && typeof result === "object" && result.ok === false) throw new ApiAnswerError(what, result);
  return result;
}

export async function apiGetOk(path, options = {}) {
  return requireOk(await apiGet(path, options), `GET ${String(path).split("?")[0]}`);
}

export function apiPost(path, options = {}) {
  return request("POST", path, { options });
}

export function apiJsonPost(path, body, options = {}) {
  return request("POST", path, { body, json: true, options });
}

export function apiJsonPut(path, body, options = {}) {
  return request("PUT", path, { body, json: true, options });
}

export function apiDelete(path, options = {}) {
  return request("DELETE", path, { options });
}
