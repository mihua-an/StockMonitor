"use strict";

// One bounded HTTP call for Node: call sites each built an AbortController, armed a timer and cleared it
// in finally. `withTimeout(ms, run)` hands `run` the signal and always clears the timer; `fetchJson` is the common
// case -- the response and its JSON body (null when the body is not JSON).

async function withTimeout(timeoutMs, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 2000) {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetchImpl(url, { ...options, signal });
    const payload = await response.json().catch(() => /* not an error: a body that is not JSON is a null payload; the caller checks the response status */ null);
    return { response, payload };
  });
}

module.exports = { withTimeout, fetchJson };
